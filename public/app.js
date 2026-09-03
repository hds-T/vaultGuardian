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
  applySttAvailability()
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
  for (const el of ['chatInput', 'sendBtn', 'resetBtn', 'micBtn']) $(el).disabled = left === 0
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
  if (mic.recording) stopMic(true)
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
  for (const el of ['chatInput', 'sendBtn', 'resetBtn', 'guessInput', 'guessBtn', 'micBtn', 'sttLang']) $(el).disabled = false
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
  // Sending mid-recording flushes what has been said so far into the message.
  if (mic.recording) await stopMic()
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

// ===================== VOICE INPUT =====================
// Mic → 16 kHz mono f32le PCM → /api/stt/chunk → whisper on the server.
// Whisper's VAD cuts the stream into phrases, so text lands in the composer a
// beat after each pause rather than word by word.

const STT_RATE = 16000
// The server caps a chunk at 64KB, which is four 4096-sample frames; stay under.
const FRAMES_PER_POST = 3
const MAX_MSG = 4000

const mic = { recording: false, stream: null, ctx: null, node: null, sink: null, queue: [], uploading: false }

function sttAvailable () { return !!(state.stt && state.stt.enabled) }

function applySttAvailability () {
  const on = sttAvailable()
  $('micBtn').classList.toggle('hidden', !on)
  $('sttbar').classList.toggle('hidden', !on)
}

function setMicUi (recording, note = '') {
  const btn = $('micBtn')
  const label = recording ? 'Stop listening' : 'Speak instead of typing'
  btn.classList.toggle('rec', recording)
  btn.title = label
  btn.setAttribute('aria-label', label)
  $('sttLang').disabled = recording
  $('sttStatus').textContent = note
}

// Float32 samples to little-endian bytes. Written through a DataView rather
// than reusing the buffer so the wire format matches the model's `f32le`
// regardless of the platform's byte order.
function toPcmBytes (frames) {
  let total = 0
  for (const f of frames) total += f.length
  const bytes = new Uint8Array(total * 4)
  const view = new DataView(bytes.buffer)
  let offset = 0
  for (const f of frames) {
    for (let i = 0; i < f.length; i++) { view.setFloat32(offset, f[i], true); offset += 4 }
  }
  return bytes
}

function base64 (bytes) {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  }
  return btoa(s)
}

// Browsers may refuse a 16 kHz AudioContext and hand back their own rate.
function resample (input, from) {
  if (from === STT_RATE) return input
  const ratio = from / STT_RATE
  const out = new Float32Array(Math.floor(input.length / ratio))
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio
    const idx = Math.floor(pos)
    const frac = pos - idx
    const next = input[idx + 1] !== undefined ? input[idx + 1] : input[idx]
    out[i] = input[idx] * (1 - frac) + next * frac
  }
  return out
}

function appendTranscript (parts) {
  if (!parts || !parts.length) return
  const input = $('chatInput')
  const addition = parts.join(' ').replace(/\s+/g, ' ').trim()
  if (!addition) return
  const base = input.value.trim()
  input.value = (base ? base + ' ' : '') + addition
  if (input.value.length > MAX_MSG) input.value = input.value.slice(0, MAX_MSG)
  input.scrollLeft = input.scrollWidth
}

// One POST in flight at a time so the server writes frames in the order they
// were spoken; a backlog is coalesced into the next request.
async function pumpAudio () {
  if (mic.uploading || !mic.queue.length) return
  mic.uploading = true
  try {
    while (mic.queue.length) {
      const frames = mic.queue.splice(0, FRAMES_PER_POST)
      const res = await fetch('/api/stt/chunk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio: base64(toPcmBytes(frames)) })
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast('🎙️ ' + (data.error || 'voice input failed'), 'bad')
        await stopMic(true)
        return
      }
      appendTranscript(data.text)
      if (mic.recording) $('sttStatus').textContent = data.speaking ? 'hearing you…' : 'listening…'
    }
  } catch {
    toast('🎙️ Lost the connection while listening.', 'bad')
    await stopMic(true)
  } finally {
    mic.uploading = false
  }
}

async function startMic () {
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
    toast('🎙️ Voice input needs a microphone on a secure origin (localhost or https).', 'bad')
    return
  }
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    })
  } catch {
    toast('🎙️ Microphone permission denied.', 'bad')
    return
  }

  const started = await api('/api/stt/start', { method: 'POST', body: JSON.stringify({ language: $('sttLang').value }) })
  if (!started.ok) {
    for (const track of stream.getTracks()) track.stop()
    toast('🎙️ ' + (started.error || 'voice input unavailable'), 'bad')
    return
  }

  try {
    const ctx = new AudioContext({ sampleRate: STT_RATE })
    await ctx.audioWorklet.addModule('/mic-worklet.js')
    const source = ctx.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(ctx, 'mic-processor')
    // A worklet is only pulled while it reaches the destination, so route it
    // through a muted gain node instead of playing the mic back at the player.
    const sink = ctx.createGain()
    sink.gain.value = 0
    node.port.onmessage = (e) => {
      if (!mic.recording) return
      mic.queue.push(resample(new Float32Array(e.data), ctx.sampleRate))
      pumpAudio()
    }
    source.connect(node)
    node.connect(sink)
    sink.connect(ctx.destination)

    Object.assign(mic, { recording: true, stream, ctx, node, sink, queue: [] })
    setMicUi(true, 'listening…')
  } catch {
    for (const track of stream.getTracks()) track.stop()
    await api('/api/stt/cancel', { method: 'POST', body: '{}' })
    toast('🎙️ Could not start the microphone.', 'bad')
  }
}

async function stopMic (aborted = false) {
  if (!mic.recording) return
  mic.recording = false
  setMicUi(false, aborted ? '' : 'transcribing…')

  if (mic.node) mic.node.port.onmessage = null
  for (const track of mic.stream?.getTracks() || []) track.stop()
  try { mic.node?.disconnect(); mic.sink?.disconnect() } catch {}
  try { await mic.ctx?.close() } catch {}
  Object.assign(mic, { stream: null, ctx: null, node: null, sink: null })

  if (aborted) {
    mic.queue = []
    await api('/api/stt/cancel', { method: 'POST', body: '{}' })
    return
  }
  // Send the tail of the recording before asking for the final flush.
  await pumpAudio()
  const final = await api('/api/stt/stop', { method: 'POST', body: '{}' })
  appendTranscript(final.text)
  $('sttStatus').textContent = ''
  $('chatInput').focus()
}

function toggleMic () {
  if (mic.recording) stopMic()
  else startMic()
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
  if (mic.recording) await stopMic(true)
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
$('micBtn').onclick = toggleMic
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
