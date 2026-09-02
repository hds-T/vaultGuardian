// Player SPA. Talks only to the public API; never sees a password.
const $ = (id) => document.getElementById(id)
let state = { levels: [], freeRoam: false }
let current = null

async function api (path, opts) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts })
  return res.json().catch(() => ({}))
}

function toast (msg, kind = 'ok') {
  const t = $('toast')
  t.textContent = msg
  t.className = `toast show ${kind}`
  setTimeout(() => { t.className = 'toast' }, 2600)
}

async function refresh () {
  state = await api('/api/state')
  const m = state.model || {}
  const pill = $('modelPill')
  pill.textContent = m.mock ? 'MOCK model (dev)' : (m.model || 'local model')
  pill.className = 'pill' + (m.mock ? ' mock' : '')
  renderLevels()
}

function renderLevels () {
  const box = $('levels')
  box.innerHTML = ''
  for (const lvl of state.levels) {
    const b = document.createElement('button')
    b.className = 'lvl' + (current === lvl.id ? ' active' : '')
    b.disabled = !lvl.unlocked
    const ic = lvl.solved ? '✅' : (lvl.unlocked ? '🗝️' : '🔒')
    b.innerHTML = `<span class="ic">${ic}</span><span class="nm">${escapeHtml(lvl.name)}</span>` +
      (lvl.solved ? '<span class="badge">solved</span>' : '')
    b.onclick = () => selectLevel(lvl.id)
    box.appendChild(b)
  }
}

function levelById (id) { return state.levels.find(l => l.id === id) }

function selectLevel (id) {
  current = id
  const lvl = levelById(id)
  $('levelTitle').textContent = lvl.name
  $('hint').textContent = lvl.hint ? '💡 ' + lvl.hint : ''
  $('msgs').innerHTML = ''
  addSystem(`You face ${lvl.name}. Extract the password through conversation, then submit your guess below.`)
  const solved = lvl.solved
  $('chatInput').disabled = false
  $('sendBtn').disabled = false
  $('resetBtn').disabled = false
  $('guessInput').disabled = false
  $('guessBtn').disabled = false
  if (solved) addSystem('✨ You have already solved this level.')
  renderLevels()
  $('chatInput').focus()
}

function addMsg (cls, text) {
  const d = document.createElement('div')
  d.className = 'msg ' + cls
  d.textContent = text
  $('msgs').appendChild(d)
  $('msgs').scrollTop = $('msgs').scrollHeight
  return d
}
function addSystem (text) { return addMsg('system', text) }

function escapeHtml (s) { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])) }

// Escape first, then turn **bold** into real markup so the guardian's
// markdown emphasis actually renders.
function formatReply (s) {
  return escapeHtml(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
}

async function send () {
  const input = $('chatInput')
  const msg = input.value.trim()
  if (!msg || !current) return
  input.value = ''
  addMsg('user', msg)
  $('sendBtn').disabled = true
  input.disabled = true

  const bot = addMsg('bot', '')
  bot.classList.add('pending')
  bot.innerHTML = '<span class="dots"></span>'
  let got = ''
  let blockedAt = null

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ levelId: current, message: msg })
    })
    await readSSE(res, (event, data) => {
      if (event === 'token') { got += data.token; bot.innerHTML = formatReply(got) + '<span class="cursor">▍</span>' }
      else if (event === 'message') { got = data.text; bot.innerHTML = formatReply(got) }
      else if (event === 'done') { blockedAt = data.blockedAt }
      else if (event === 'error') { got = '⚠️ ' + (data.error || 'error'); bot.innerHTML = formatReply(got) }
    })
  } catch (err) {
    bot.textContent = '⚠️ connection error'
  }
  bot.classList.remove('pending')
  bot.innerHTML = formatReply(got || '…')
  if (blockedAt === 'output' || blockedAt === 'guardModel' || blockedAt === 'input') bot.classList.add('blocked')

  $('sendBtn').disabled = false
  input.disabled = false
  input.focus()
}

// Minimal SSE reader over fetch's streaming body.
async function readSSE (res, onEvent) {
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      let ev = 'message'; let data = ''
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event: ')) ev = line.slice(7)
        else if (line.startsWith('data: ')) data += line.slice(6)
      }
      try { onEvent(ev, data ? JSON.parse(data) : {}) } catch {}
    }
  }
}

async function guess () {
  const input = $('guessInput')
  const g = input.value.trim()
  if (!g || !current) return
  $('guessBtn').disabled = true
  const r = await api('/api/guess', { method: 'POST', body: JSON.stringify({ levelId: current, guess: g }) })
  $('guessBtn').disabled = false
  if (r.correct) {
    toast('🎉 Correct! The vault opens.', 'ok')
    input.value = ''
    addSystem('🎉 Correct — password accepted! Next level unlocked.')
    await refresh()
    // keep current selection highlighted
    const lvl = levelById(current)
    if (lvl) renderLevels()
  } else if (r.error && /too many/.test(r.error)) {
    toast('⏳ Too many guesses — wait a moment.', 'bad')
  } else {
    const left = typeof r.remaining === 'number' ? ` (${r.remaining} left this minute)` : ''
    toast('❌ Not the password' + left, 'bad')
  }
}

async function resetConv () {
  if (!current) return
  await api('/api/reset', { method: 'POST', body: JSON.stringify({ levelId: current }) })
  $('msgs').innerHTML = ''
  addSystem('Conversation reset. The guardian has forgotten what you said.')
}

$('sendBtn').onclick = send
$('resetBtn').onclick = resetConv
$('guessBtn').onclick = guess
$('chatInput').addEventListener('keydown', e => { if (e.key === 'Enter') send() })
$('guessInput').addEventListener('keydown', e => { if (e.key === 'Enter') guess() })

refresh().then(() => {
  const first = state.levels.find(l => l.unlocked)
  if (first) selectLevel(first.id)
})
