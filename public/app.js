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

function renderHint (lvl) {
  const row = $('levelHint')
  $('levelHintText').textContent = lvl.hint || ''
  row.classList.toggle('hidden', !lvl.hint)
}

// The message budget is per level and per run. At zero the chat closes but
// guessing stays open — and Reset closes too, since clearing the transcript
// would destroy the very reply the player still needs to read.
function renderTries (lvl) {
  const left = typeof lvl.messagesLeft === 'number' ? lvl.messagesLeft : (lvl.maxMessages || 0)
  const pill = $('tries')
  $('triesLeft').textContent = left
  pill.className = 'tries' + (left === 0 ? ' out' : (left <= 3 ? ' low' : ''))
  for (const el of ['chatInput', 'sendBtn', 'resetBtn']) $(el).disabled = left === 0
}

function messagesLeft () {
  const lvl = levelById(current)
  return lvl && typeof lvl.messagesLeft === 'number' ? lvl.messagesLeft : 0
}

function setMessagesLeft (levelId, left) {
  const lvl = levelById(levelId)
  if (!lvl || typeof left !== 'number') return
  lvl.messagesLeft = left
}

function selectLevel (id) {
  current = id
  const lvl = levelById(id)
  const n = levelIndex(id) + 1
  setBoardImage(n)
  $('levelCount').textContent = `Level ${n} / ${state.levels.length}`
  $('levelName').textContent = lvl.name
  renderHint(lvl)
  $('msgs').innerHTML = ''
  addSystem(`You face ${lvl.name}. You have ${lvl.maxMessages} messages here. Extract the password through conversation, then submit your guess below.`)
  if (lvl.solved) addSystem('✨ You have already solved this level.')
  for (const el of ['chatInput', 'sendBtn', 'resetBtn', 'guessInput', 'guessBtn']) $(el).disabled = false
  renderTries(lvl)
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
  if (!msg || !current || messagesLeft() === 0) return
  const levelId = current
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
      body: JSON.stringify({ levelId, message: msg })
    })
    if (!res.ok) {
      // The budget and the unlock gate both answer with JSON, not a stream.
      const err = await res.json().catch(() => ({}))
      got = '⚠️ ' + (err.error || 'request refused')
      setMessagesLeft(levelId, err.messagesLeft)
    } else {
      await readSSE(res, (event, data) => {
        if (event === 'token') { got += data.token; bot.innerHTML = formatReply(got) + '<span class="cursor">▍</span>' }
        else if (event === 'message') { got = data.text; bot.innerHTML = formatReply(got) }
        else if (event === 'done') { blockedAt = data.blockedAt; setMessagesLeft(levelId, data.messagesLeft) }
        else if (event === 'error') { got = '⚠️ ' + (data.error || 'error'); setMessagesLeft(levelId, data.messagesLeft) }
      })
    }
  } catch (err) {
    got = '⚠️ connection error'
  }
  bot.classList.remove('pending')
  bot.innerHTML = formatReply(got || '…')
  if (blockedAt === 'output' || blockedAt === 'guardModel' || blockedAt === 'input') bot.classList.add('blocked')

  $('sendBtn').disabled = false
  input.disabled = false
  if (levelId === current) {
    renderTries(levelById(levelId))
    if (messagesLeft() === 0) addSystem('🚪 Out of messages on this door. Your next guess is your last — make it count.')
    else input.focus()
  }
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

// The level to open once the player dismisses the prize popup, or null when
// this was the last door.
let pendingNext = null

function celebrate (solvedId, nextId) {
  pendingNext = nextId
  const lvl = levelById(solvedId)
  const door = levelIndex(solvedId) + 1
  const prize = lvl?.prize
  $('prizeTitle').textContent = `Door ${door} cleared`
  $('prizeText').innerHTML = prize
    ? `Congratulations, you've crossed door number ${door} and have earned <strong>${escapeHtml(prize)}</strong>.`
    : `Congratulations, you've crossed door number ${door} and have earned your prize.`
  $('prizeBtn').textContent = nextId ? 'Continue' : 'See the Vault'
  $('prizeModal').classList.remove('hidden')
  burstConfetti()
  $('prizeBtn').focus()
}

function dismissPrize () {
  if ($('prizeModal').classList.contains('hidden')) return
  $('prizeModal').classList.add('hidden')
  clearConfetti()
  if (pendingNext) {
    selectLevel(pendingNext)
  } else {
    renderProgress()
    if (state.levels.every(l => l.solved)) addSystem('🏆 Every word found. The final Vault swings open — the prize inside is yours.')
  }
  pendingNext = null
}

// The server has already wiped the run by the time this is called; `reached`
// is the only record of how far the player got.
function showGameOver (reached) {
  const { door, name, cleared, total } = reached || {}
  const doors = cleared === 1 ? 'door' : 'doors'
  $('overText').innerHTML = door
    ? `You ran out of messages at door ${door} — <strong>${escapeHtml(name || '')}</strong>. You cleared ${cleared} of ${total} ${doors} this run.`
    : 'You ran out of messages. The vault stays shut.'
  $('overModal').classList.remove('hidden')
  $('overBtn').focus()
}

async function dismissGameOver () {
  if ($('overModal').classList.contains('hidden')) return
  $('overModal').classList.add('hidden')
  try { localStorage.removeItem(WORDS_KEY) } catch {}
  current = null
  pendingNext = null
  $('msgs').innerHTML = ''
  $('guessInput').value = ''
  await refresh()
  $('game').classList.add('hidden')
  $('intro').classList.remove('hidden')
  $('startBtn').textContent = 'Start'
  $('startBtn').disabled = false
}

async function guess () {
  const input = $('guessInput')
  const g = input.value.trim()
  if (!g || !current) return
  $('guessBtn').disabled = true
  const r = await api('/api/guess', { method: 'POST', body: JSON.stringify({ levelId: current, guess: g }) })
  $('guessBtn').disabled = false
  if (r.gameOver) {
    input.value = ''
    return showGameOver(r.reached)
  }
  if (r.correct) {
    saveWord(current, g.toUpperCase())
    input.value = ''
    addSystem(`🎉 "${g.toUpperCase()}" accepted — the word is yours.`)
    const solvedId = current
    await refresh()
    renderProgress()
    const next = nextLevel()
    celebrate(solvedId, next && next.id !== solvedId ? next.id : null)
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
  cornerToast('Conversation reset. The guardian has forgotten what you said — but your spent messages stay spent.')
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
$('prizeBtn').onclick = dismissPrize
$('prizeBackdrop').onclick = dismissPrize
$('overBtn').onclick = dismissGameOver
$('overBackdrop').onclick = dismissGameOver
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return
  dismissPrize()
  dismissGameOver()
})

// Start stays disabled until the level list has arrived, so the first click
// always has a level to open.
refresh().then(() => {
  if (state.levels.some(l => l.solved)) $('startBtn').textContent = 'Continue'
  $('startBtn').disabled = false
})
