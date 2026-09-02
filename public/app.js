// Player SPA. Talks only to the public API; never sees a password.
const $ = (id) => document.getElementById(id)
let state = { levels: [], freeRoam: false }
let current = null

// Words the player has already cracked. The server never sends these back —
// we only know them because the player typed the winning guess here.
const WORDS_KEY = 'vg_words'
function loadWords () {
  try { return JSON.parse(localStorage.getItem(WORDS_KEY)) || {} } catch { return {} }
}
function saveWord (levelId, word) {
  const words = loadWords()
  words[levelId] = word
  try { localStorage.setItem(WORDS_KEY, JSON.stringify(words)) } catch {}
}

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

function cornerToast (msg, kind = 'ok') {
  const t = $('resetToast')
  t.textContent = msg
  t.className = `toast corner show ${kind}`
  clearTimeout(cornerToast._hide)
  cornerToast._hide = setTimeout(() => { t.className = 'toast corner' }, 3000)
}

async function refresh () {
  state = await api('/api/state')
  const m = state.model || {}
  const label = m.mock ? 'MOCK model (dev)' : (m.model || 'local model')
  for (const id of ['modelPill', 'introPill']) {
    const pill = $(id)
    pill.textContent = label
    pill.className = 'pill' + (m.mock ? ' mock' : '')
  }
}

function levelById (id) { return state.levels.find(l => l.id === id) }
function levelIndex (id) { return state.levels.findIndex(l => l.id === id) }

// Linear progression: the furthest level the player has unlocked but not solved.
function nextLevel () {
  const open = state.levels.filter(l => l.unlocked)
  return open.find(l => !l.solved) || open[open.length - 1] || state.levels[0]
}

function renderProgress () {
  const pips = $('pips')
  const words = $('words')
  pips.innerHTML = ''
  words.innerHTML = ''
  const found = loadWords()
  for (const lvl of state.levels) {
    const pip = document.createElement('span')
    pip.className = 'pip' + (lvl.solved ? ' done' : (lvl.id === current ? ' current' : ''))
    pips.appendChild(pip)

    const chip = document.createElement('span')
    chip.className = 'word' + (lvl.solved ? ' found' : '')
    chip.textContent = lvl.solved ? (found[lvl.id] || 'CRACKED') : '?????'
    words.appendChild(chip)
  }
}

function boardImage (n) {
  return `/assets/${n}.jpg`
}

function setBoardImage (n) {
  $('board').style.setProperty('--board-image', `url("${boardImage(n)}")`)
}

function prefetchBoards () {
  for (let i = 1; i <= state.levels.length; i++) {
    const img = new Image()
    img.src = boardImage(i)
  }
}

function selectLevel (id) {
  current = id
  const lvl = levelById(id)
  const n = levelIndex(id) + 1
  setBoardImage(n)
  $('levelCount').textContent = `Level ${n} / ${state.levels.length}`
  $('levelName').textContent = lvl.name
  $('msgs').innerHTML = ''
  addSystem(`You face ${lvl.name}. Extract the password through conversation, then submit your guess below.`)
  if (lvl.solved) addSystem('✨ You have already solved this level.')
  for (const el of ['chatInput', 'sendBtn', 'resetBtn', 'guessInput', 'guessBtn']) $(el).disabled = false
  renderProgress()
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
    saveWord(current, g.toUpperCase())
    input.value = ''
    toast('🎉 Correct! The vault opens.', 'ok')
    addSystem(`🎉 "${g.toUpperCase()}" accepted — the word is yours.`)
    const solvedId = current
    await refresh()
    const next = nextLevel()
    if (next && next.id !== solvedId) {
      selectLevel(next.id)
    } else {
      renderProgress()
      if (state.levels.every(l => l.solved)) addSystem('🏆 Every word found. The final Vault swings open — the prize inside is yours.')
    }
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
  cornerToast('Conversation reset. The guardian has forgotten what you said.')
}

function startGame () {
  $('intro').classList.add('hidden')
  $('game').classList.remove('hidden')
  prefetchBoards()
  const lvl = nextLevel()
  if (lvl) selectLevel(lvl.id)
}

$('startBtn').onclick = startGame
$('sendBtn').onclick = send
$('resetBtn').onclick = resetConv
$('guessBtn').onclick = guess
$('chatInput').addEventListener('keydown', e => { if (e.key === 'Enter') send() })
$('guessInput').addEventListener('keydown', e => { if (e.key === 'Enter') guess() })

// Start stays disabled until the level list has arrived, so the first click
// always has a level to open.
refresh().then(() => {
  if (state.levels.some(l => l.solved)) $('startBtn').textContent = 'Continue'
  $('startBtn').disabled = false
})
