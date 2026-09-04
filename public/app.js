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
  // Level names, prizes and hints come back already in the player's language.
  state = await api('/api/state?lang=' + currentLang())
  const m = state.model || {}
  const label = m.mock ? 'MOCK model (dev)' : (m.model || t('pill.model'))
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
    chip.textContent = lvl.solved ? (found[lvl.id] || t('vault.cracked')) : '?????'
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

// The banner only carries a door's fixed hint. Coached doors get theirs from
// the server after each attempt, under the reply it is about, and the last
// door gets none at all.
function renderHint (lvl) {
  const show = lvl.hintMode === 'static' && !!lvl.hint
  $('levelHintText').textContent = show ? lvl.hint : ''
  $('levelHint').classList.toggle('hidden', !show)
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
  $('levelCount').textContent = t('level.count', { n, total: state.levels.length })
  $('levelName').textContent = lvl.name
  renderHint(lvl)
  $('msgs').innerHTML = ''
  if (lvl.solved) addSystem(t('sys.solved'))
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

// A coaching line, tied to the reply above it rather than to the door. It goes
// up as soon as the server says a hint is coming, and pulses until it arrives.
function addCoach () {
  const d = document.createElement('div')
  d.className = 'coach pending'
  const label = document.createElement('span')
  label.className = 'lbl'
  label.textContent = t('level.hint')
  const body = document.createElement('span')
  body.className = 'txt'
  body.textContent = t('level.hintPending')
  d.append(label, body)
  $('msgs').appendChild(d)
  $('msgs').scrollTop = $('msgs').scrollHeight
  return d
}

function fillCoach (el, text) {
  el.classList.remove('pending')
  el.querySelector('.txt').textContent = text
  $('msgs').scrollTop = $('msgs').scrollHeight
}

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
  let hint = null
  let coach = null

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ levelId, message: msg, lang: currentLang() })
    })
    if (!res.ok) {
      // The budget and the unlock gate both answer with JSON, not a stream.
      const err = await res.json().catch(() => ({}))
      got = '⚠️ ' + (err.error || t('err.refused'))
      setMessagesLeft(levelId, err.messagesLeft)
    } else {
      await readSSE(res, (event, data) => {
        if (event === 'token') { got += data.token; bot.innerHTML = formatReply(got) + '<span class="cursor">▍</span>' }
        else if (event === 'message') { got = data.text; bot.innerHTML = formatReply(got) }
        else if (event === 'coaching') { if (levelId === current) coach = addCoach() }
        else if (event === 'hint') { hint = data.hint }
        else if (event === 'done') { blockedAt = data.blockedAt; setMessagesLeft(levelId, data.messagesLeft) }
        else if (event === 'error') { got = '⚠️ ' + (data.error || t('err.generic')); setMessagesLeft(levelId, data.messagesLeft) }
      })
    }
  } catch (err) {
    got = '⚠️ ' + t('err.connection')
  }
  bot.classList.remove('pending')
  bot.innerHTML = formatReply(got || '…')
  if (blockedAt === 'output' || blockedAt === 'guardModel' || blockedAt === 'input') bot.classList.add('blocked')
  // A coach that came back empty takes its placeholder with it.
  if (coach && hint) fillCoach(coach, hint)
  else if (coach) coach.remove()

  $('sendBtn').disabled = false
  input.disabled = false
  if (levelId === current) {
    renderTries(levelById(levelId))
    if (messagesLeft() === 0) addSystem(t('sys.outOfMessages'))
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

// The dropdown is built from whatever the server can transcribe. "Auto" is not
// whisper's detector here: it means "whatever I chose to play in", which is the
// right guess for someone who picked a flag a moment ago. Picking a language
// explicitly overrides that, even when it disagrees with the UI.
function renderSttLanguages () {
  const select = $('sttLang')
  const codes = (state.stt && state.stt.languages) || ['auto']
  const previous = select.value
  select.innerHTML = ''
  for (const code of codes) {
    const option = document.createElement('option')
    option.value = code
    option.textContent = code === 'auto'
      ? t('stt.auto', { lang: languageName(currentLang()) })
      : languageName(code)
    select.appendChild(option)
  }
  select.value = codes.includes(previous) ? previous : 'auto'
}

function sttLanguage () {
  const chosen = $('sttLang').value
  return chosen === 'auto' ? currentLang() : chosen
}

function applySttAvailability () {
  const on = sttAvailable()
  $('micBtn').classList.toggle('hidden', !on)
  $('sttbar').classList.toggle('hidden', !on)
  if (on) renderSttLanguages()
}

function setMicUi (recording, note = '') {
  const btn = $('micBtn')
  const label = recording ? t('chat.micStop') : t('chat.mic')
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
        toast('🎙️ ' + (data.error || t('toast.voiceFailed')), 'bad')
        await stopMic(true)
        return
      }
      appendTranscript(data.text)
      if (mic.recording) $('sttStatus').textContent = t(data.speaking ? 'stt.hearing' : 'stt.listening')
    }
  } catch {
    toast(t('toast.micLost'), 'bad')
    await stopMic(true)
  } finally {
    mic.uploading = false
  }
}

async function startMic () {
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
    toast(t('toast.micInsecure'), 'bad')
    return
  }
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    })
  } catch {
    toast(t('toast.micDenied'), 'bad')
    return
  }

  const started = await api('/api/stt/start', { method: 'POST', body: JSON.stringify({ language: sttLanguage() }) })
  if (!started.ok) {
    for (const track of stream.getTracks()) track.stop()
    toast('🎙️ ' + (started.error || t('toast.micUnavailable')), 'bad')
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
    setMicUi(true, t('stt.listening'))
  } catch {
    for (const track of stream.getTracks()) track.stop()
    await api('/api/stt/cancel', { method: 'POST', body: '{}' })
    toast(t('toast.micFailed'), 'bad')
  }
}

async function stopMic (aborted = false) {
  if (!mic.recording) return
  mic.recording = false
  setMicUi(false, aborted ? '' : t('stt.transcribing'))

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
  $('prizeTitle').textContent = t('prize.title', { door })
  $('prizeText').innerHTML = prize
    ? t('prize.text', { door, prize: escapeHtml(prize) })
    : t('prize.textPlain', { door })
  $('prizeBtn').textContent = t(nextId ? 'prize.continue' : 'prize.seeVault')
  $('prizeModal').classList.remove('hidden')
  burstConfetti()
  $('prizeBtn').focus()
}

async function dismissPrize () {
  if ($('prizeModal').classList.contains('hidden')) return
  $('prizeModal').classList.add('hidden')
  clearConfetti()
  if (pendingNext) {
    selectLevel(pendingNext)
    pendingNext = null
    return
  }
  pendingNext = null
  // Last door: the server has already wiped the run. Same as a loss — back
  // to the intro so a reload cannot reopen the finished door.
  await returnToIntro()
}

// The last door gets its own screen rather than the prize popup: the run is
// over, and the button on it is what actually opens the physical vault. No
// confetti here — the painting is doing that job.
function showClosing () {
  $('game').classList.add('hidden')
  $('close').classList.remove('hidden')
  $('closeBtn').disabled = false
  $('closeBtn').focus()
}

// One press, whatever the relay says. The win is already banked server-side,
// so a vault that is unplugged, in dry-run or simply absent still sends the
// player home rather than trapping them on a dead button.
async function openVault () {
  const btn = $('closeBtn')
  if (btn.disabled) return
  btn.disabled = true
  try { await api('/api/vault/open', { method: 'POST', body: '{}' }) } catch {}
  $('close').classList.add('hidden')
  await returnToIntro()
}

// The server has already wiped the run by the time this is called; `reached`
// is the only record of how far the player got.
function showGameOver (reached) {
  const { door, name, cleared, total } = reached || {}
  const doors = t(cleared === 1 ? 'over.door' : 'over.doors')
  $('overText').innerHTML = door
    ? t('over.text', { door, name: escapeHtml(name || ''), cleared, total, doors })
    : t('over.textPlain')
  $('overModal').classList.remove('hidden')
  $('overBtn').focus()
}

async function abandonRound () {
  $('prizeModal').classList.add('hidden')
  $('overModal').classList.add('hidden')
  clearConfetti()
  // Wipe first, then walk back: returnToIntro re-reads /api/state, so the
  // flags come back offering a fresh run from door 1 rather than "continue".
  const r = await api('/api/restart', { method: 'POST', body: '{}' })
  if (!r.ok) {
    toast(t('err.generic'), 'bad')
    return
  }
  await returnToIntro()
}

async function returnToIntro () {
  if (mic.recording) await stopMic(true)
  try { localStorage.removeItem(WORDS_KEY) } catch {}
  current = null
  pendingNext = null
  $('msgs').innerHTML = ''
  $('guessInput').value = ''
  await refresh()
  $('game').classList.add('hidden')
  $('close').classList.add('hidden')
  $('intro').classList.remove('hidden')
  // Back at the intro, the flags are live again: a new run can be a new
  // language without reloading the page.
  renderLangCtas()
}

async function dismissGameOver () {
  if ($('overModal').classList.contains('hidden')) return
  $('overModal').classList.add('hidden')
  await returnToIntro()
}

async function guess () {
  const input = $('guessInput')
  const g = input.value.trim()
  if (!g || !current) return
  $('guessBtn').disabled = true
  const r = await api('/api/guess', { method: 'POST', body: JSON.stringify({ levelId: current, guess: g, lang: currentLang() }) })
  $('guessBtn').disabled = false
  if (r.gameOver) {
    input.value = ''
    return showGameOver(r.reached)
  }
  if (r.correct) {
    saveWord(current, g.toUpperCase())
    input.value = ''
    addSystem(t('sys.accepted', { word: g.toUpperCase() }))
    const solvedId = current
    const lvl = levelById(solvedId)
    if (lvl) lvl.solved = true
    // Do not refresh() on a final win: the server has already wiped the run,
    // and a fresh state would look like door 1 and skip the vault prize.
    if (r.won) {
      renderProgress()
      showClosing()
      return
    }
    await refresh()
    renderProgress()
    const next = nextLevel()
    celebrate(solvedId, next && next.id !== solvedId ? next.id : null)
  } else if (r.error && /too many/.test(r.error)) {
    toast(t('toast.tooMany'), 'bad')
  } else {
    const left = r.remaining
    toast(typeof left === 'number' ? t('toast.wrongLeft', { left }) : t('toast.wrong'), 'bad')
  }
}

async function resetConv () {
  if (!current) return
  await api('/api/reset', { method: 'POST', body: JSON.stringify({ levelId: current }) })
  $('msgs').innerHTML = ''
  cornerToast(t('toast.reset'))
}

function startGame () {
  $('intro').classList.add('hidden')
  $('game').classList.remove('hidden')
  prefetchBoards()
  const lvl = nextLevel()
  if (lvl) selectLevel(lvl.id)
}

// Each flag is labelled in its own language, so the button a player recognises
// reads correctly whatever the page is currently set to.
function renderLangCtas () {
  const resuming = state.levels.some(l => l.solved)
  for (const btn of document.querySelectorAll('#langCta .lang')) {
    const code = btn.dataset.lang
    btn.querySelector('.lang-label').textContent =
      tIn(code, resuming ? 'cta.continue' : 'cta.start')
    btn.disabled = false
  }
}

// Picking a flag sets the language for the whole run: the chrome switches to
// the local dictionary, and the server is asked to translate the guardian's
// English into the same language from here on.
async function pickLanguage (code) {
  if (code !== currentLang()) {
    setLang(code)
    // Level names, prizes and hints were fetched in the old language.
    await refresh()
  }
  startGame()
}

for (const btn of document.querySelectorAll('#langCta .lang')) {
  btn.onclick = () => pickLanguage(btn.dataset.lang)
}
$('sendBtn').onclick = send
$('micBtn').onclick = toggleMic
$('resetBtn').onclick = resetConv
$('guessBtn').onclick = guess
$('chatInput').addEventListener('keydown', e => { if (e.key === 'Enter') send() })
$('guessInput').addEventListener('keydown', e => { if (e.key === 'Enter') guess() })
$('prizeBtn').onclick = dismissPrize
$('prizeBackdrop').onclick = dismissPrize
$('closeBtn').onclick = openVault
$('restartBtn').onclick = abandonRound
$('overBtn').onclick = dismissGameOver
$('overBackdrop').onclick = dismissGameOver
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return
  dismissPrize()
  dismissGameOver()
})

// The flags stay disabled until the level list has arrived, so the first click
// always has a level to open.
setLang(loadLang())
refresh().then(renderLangCtas)
