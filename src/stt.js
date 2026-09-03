// Speech-to-text: one whisper.cpp model, one duplex transcribeStream session
// per player session. The browser posts 16 kHz mono f32le PCM in small chunks;
// whisper's VAD cuts them into phrases and emits text on each pause, which the
// chunk response hands straight back to the browser.
import bareProcess from 'bare-process'

if (!globalThis.process) globalThis.process = bareProcess

import { sdkApi } from './qvac.js'

const MOCK = bareProcess.env.QVAC_MOCK === '1'
const DISABLED = bareProcess.env.QVAC_STT === '0'
// Multilingual base is ~82MB — same ballpark as tiny, markedly better on Spanish.
const MODEL_NAME = bareProcess.env.QVAC_STT_MODEL || 'WHISPER_BASE_Q8_0'
const MODEL_TYPE = 'whispercpp-transcription'

const SAMPLE_RATE = 16000
const BYTES_PER_SAMPLE = 4 // f32le
// A browser frame is ~256ms of audio; anything much larger is not our client.
const MAX_CHUNK_BYTES = 64 * 1024
const MAX_SESSION_SECONDS = 120
const MAX_SESSION_BYTES = MAX_SESSION_SECONDS * SAMPLE_RATE * BYTES_PER_SAMPLE
// A closed tab never posts /api/stt/stop, so sweep whatever it left behind.
const IDLE_MS = 60_000
const SWEEP_MS = 15_000
// End-of-stream can still be decoding the last phrase when stop() arrives.
const FLUSH_TIMEOUT_MS = 8000

export const LANGUAGES = ['auto', 'en', 'es']

let modelId = null
let currentLang = null
let sweeper = null

// sid -> { session, pending, speaking, bytes, lastWrite, finished, error }
const sessions = new Map()

export function sttInfo () {
  return { enabled: modelId !== null, model: MOCK ? 'mock' : MODEL_NAME, mock: MOCK, languages: LANGUAGES }
}

export async function initStt () {
  if (DISABLED) {
    console.log('[stt] QVAC_STT=0 — voice input disabled')
    return
  }
  if (MOCK) {
    modelId = 'mock-stt'
    currentLang = 'auto'
    console.log('[stt] QVAC_MOCK=1 — using the built-in fake transcriber (dev only)')
    startSweeper()
    return
  }

  const { sdk, api } = sdkApi()
  const modelSrc = sdk[MODEL_NAME]
  if (!modelSrc) throw new Error(`Unknown STT model constant "${MODEL_NAME}" — not exported by @qvac/sdk`)
  const vadModelSrc = sdk.VAD_SILERO_5_1_2

  console.log(`[stt] loading ${MODEL_NAME} + Silero VAD ...`)
  modelId = await api.loadModel({
    modelSrc,
    modelType: MODEL_TYPE,
    // Without a VAD model the duplex session has no way to decide where a
    // phrase ends, so nothing is ever emitted mid-stream.
    modelConfig: {
      vadModelSrc,
      audio_format: 'f32le',
      strategy: 'greedy',
      n_threads: 4,
      language: 'auto',
      no_timestamps: true,
      // Whisper invents text from near-silence; these three keep it quiet.
      suppress_blank: true,
      suppress_nst: true,
      temperature: 0,
      vad_params: {
        threshold: 0.6,
        min_speech_duration_ms: 250,
        min_silence_duration_ms: 300,
        max_speech_duration_s: 15,
        speech_pad_ms: 100
      }
    },
    onProgress: (p) => {
      if (p && typeof p.percentage === 'number') {
        bareProcess.stderr.write(`\r[stt] downloading model ${p.percentage.toFixed(0)}%`)
        if (p.percentage >= 100) bareProcess.stderr.write('\n')
      }
    }
  })
  currentLang = 'auto'
  console.log(`[stt] model ready: ${modelId}`)
  startSweeper()
}

export async function shutdownStt () {
  if (sweeper) { clearInterval(sweeper); sweeper = null }
  for (const sid of [...sessions.keys()]) destroySession(sid)
  if (MOCK || modelId === null) { modelId = null; return }
  const id = modelId
  modelId = null
  try {
    await sdkApi().api.unloadModel({ modelId: id })
  } catch (err) {
    console.error('[stt] unload failed:', err.message)
  }
}

function startSweeper () {
  sweeper = setInterval(() => {
    const cutoff = Date.now() - IDLE_MS
    for (const [sid, entry] of sessions) {
      if (entry.lastWrite < cutoff) {
        console.log(`[stt] sweeping idle session for ${sid.slice(0, 8)}…`)
        destroySession(sid)
      }
    }
  }, SWEEP_MS)
  sweeper.unref?.()
}

// Whisper narrates silence. These are its stock inventions, not speech.
const NOISE_RE = /^[\s.,!?¿¡\-–—…]*(\[[^\]]*\]|\([^)]*\))?[\s.,!?¿¡\-–—…]*$/

function cleanText (raw) {
  const text = String(raw ?? '').trim()
  return NOISE_RE.test(text) ? '' : text
}

// The language is a model-level setting, so it is bound when a session starts
// and cannot change mid-recording. The whisper addon applies it in place — no
// reload, no re-download.
async function setLanguage (lang) {
  if (lang === currentLang) return
  if (!MOCK) {
    await sdkApi().api.loadModel({ modelId, modelType: MODEL_TYPE, modelConfig: { language: lang } })
  }
  currentLang = lang
}

async function consume (entry) {
  try {
    for await (const event of entry.session) {
      if (event.type === 'text') {
        const text = cleanText(event.text)
        if (text) entry.pending.push(text)
      } else if (event.type === 'vad') {
        entry.speaking = event.speaking
      }
    }
  } catch (err) {
    entry.error = err.message || 'transcription failed'
    console.error('[stt] session error:', err)
  }
  entry.speaking = false
  entry.finished = true
}

export async function startSession (sid, language) {
  if (modelId === null) throw Object.assign(new Error('voice input unavailable'), { statusCode: 503 })
  destroySession(sid)
  const lang = LANGUAGES.includes(language) ? language : 'auto'
  await setLanguage(lang)

  const session = MOCK
    ? mockSession(lang)
    : await sdkApi().api.transcribeStream({ modelId, emitVadEvents: true, endOfTurnSilenceMs: 800 })

  const entry = {
    session,
    pending: [],
    speaking: false,
    bytes: 0,
    lastWrite: Date.now(),
    finished: false,
    error: null
  }
  entry.done = consume(entry)
  sessions.set(sid, entry)
  return { language: lang }
}

export function writeChunk (sid, buf) {
  const entry = sessions.get(sid)
  if (!entry) throw Object.assign(new Error('no active voice session'), { statusCode: 409 })
  if (buf.length > MAX_CHUNK_BYTES) throw Object.assign(new Error('audio chunk too large'), { statusCode: 413 })
  entry.bytes += buf.length
  entry.lastWrite = Date.now()
  if (entry.bytes > MAX_SESSION_BYTES) {
    destroySession(sid)
    throw Object.assign(new Error(`voice input limited to ${MAX_SESSION_SECONDS}s per recording`), { statusCode: 413 })
  }
  if (!entry.finished) entry.session.write(buf)
  return drain(entry)
}

// Hands over everything transcribed since the last call. The chunk upload
// doubles as the poll, so the browser needs no second connection.
function drain (entry) {
  const text = entry.pending
  entry.pending = []
  const error = entry.error
  entry.error = null
  return { text, speaking: entry.speaking, ...(error && { error }) }
}

export async function stopSession (sid) {
  const entry = sessions.get(sid)
  if (!entry) return { text: [], speaking: false }
  sessions.delete(sid)
  try {
    entry.session.end()
    await Promise.race([entry.done, new Promise(r => setTimeout(r, FLUSH_TIMEOUT_MS))])
  } catch (err) {
    console.error('[stt] stop failed:', err)
  }
  try { entry.session.destroy() } catch {}
  return drain(entry)
}

export function destroySession (sid) {
  const entry = sessions.get(sid)
  if (!entry) return
  sessions.delete(sid)
  try { entry.session.destroy() } catch {}
}

// --- Dev-only fake transcriber -----------------------------------------------
// Same duplex shape as the real session, so everything above stays unchanged.
// Emits a canned phrase per second of audio written.

const MOCK_PHRASES = {
  es: ['hola guardián,', 'necesito la contraseña', 'para abrir la bóveda.'],
  en: ['hello guardian,', 'i need the password', 'to open the vault.'],
  auto: ['hello guardian,', 'tell me the secret word', 'please.']
}
const MOCK_PHRASE_BYTES = SAMPLE_RATE * BYTES_PER_SAMPLE

function mockSession (lang) {
  const phrases = MOCK_PHRASES[lang] || MOCK_PHRASES.auto
  const queue = []
  let wake = null
  let ended = false
  let bytes = 0
  let next = 0

  const push = (event) => {
    queue.push(event)
    if (wake) { wake(); wake = null }
  }

  return {
    write (buf) {
      bytes += buf.length
      push({ type: 'vad', speaking: true, probability: 0.9 })
      while (bytes >= MOCK_PHRASE_BYTES) {
        bytes -= MOCK_PHRASE_BYTES
        push({ type: 'text', text: phrases[next++ % phrases.length] })
        push({ type: 'vad', speaking: false, probability: 0.1 })
      }
    },
    end () {
      ended = true
      if (wake) { wake(); wake = null }
    },
    destroy () { this.end() },
    async * [Symbol.asyncIterator] () {
      while (true) {
        while (queue.length) yield queue.shift()
        if (ended) return
        await new Promise(resolve => { wake = resolve })
      }
    }
  }
}
