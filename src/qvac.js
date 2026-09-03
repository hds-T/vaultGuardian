// QVAC model lifecycle for the Bare runtime.
//
// Bare has no `process` global and does not auto-register SDK plugins, so we
// install bare-process globally and register the llama.cpp completion and
// whisper.cpp transcription plugins explicitly before the first SDK call
// (see @qvac/sdk quickstart.bare).
import bareProcess from 'bare-process'

if (!globalThis.process) globalThis.process = bareProcess

const MOCK = bareProcess.env.QVAC_MOCK === '1'
const THINKING = bareProcess.env.QVAC_THINKING === '1'
// Reasoning-channel budget: 0 hard-disables <think> at the sampler, -1 leaves
// it on. Enforced by the sampler, unlike a /no_think prompt suffix which a
// small model is free to ignore.
const REASONING_BUDGET = THINKING ? -1 : 0
// Quantized 4B models drift into self-repetition on longer generations.
const REPEAT_PENALTY = 1.1
// Small models preamble, restate the question and trail off into disclaimers.
// Appended per request rather than stored on the level, so it survives admin
// edits and covers levels created from the console.
const BREVITY_DIRECTIVE =
  'Reply in at most two short sentences, under 40 words total. Do not restate ' +
  'the question, narrate your reasoning, or add disclaimers.'

function applyBrevity (history) {
  return history.map(m =>
    m.role === 'system' ? { ...m, content: `${m.content}\n\n${BREVITY_DIRECTIVE}` } : m)
}

let sdk = null
let api = null
let modelId = null
let loadedModelName = null

// The model runs one completion at a time; concurrent chat turns queue here.
let chain = Promise.resolve()

function enqueue (fn) {
  const run = chain.then(fn, fn)
  chain = run.catch(() => {})
  return run
}

export function modelInfo () {
  return { loaded: modelId !== null, model: loadedModelName, mock: MOCK }
}

// The registered plugin surface, shared with stt.js — plugins register once
// per process, so transcription has to go through the same api object.
export function sdkApi () {
  if (!api) throw new Error('QVAC SDK not initialized')
  return { sdk, api }
}

export async function initModel (config) {
  if (MOCK) {
    loadedModelName = 'mock'
    modelId = 'mock-model'
    console.log('[qvac] QVAC_MOCK=1 — using the built-in fake model (dev only)')
    return
  }
  sdk = await import('@qvac/sdk')
  // Subpath has no `.js` — that's the exact key in @qvac/sdk's exports map,
  // required for Bare's strict resolver (Node tolerates the `.js` variant).
  const { llmPlugin } = await import('@qvac/sdk/llamacpp-completion/plugin')
  const { whisperPlugin } = await import('@qvac/sdk/whispercpp-transcription/plugin')
  api = sdk.plugins([llmPlugin, whisperPlugin])

  const name = config.model || 'QWEN3_4B_INST_Q4_K_M'
  const modelSrc = sdk[name]
  if (!modelSrc) throw new Error(`Unknown model constant "${name}" — not exported by @qvac/sdk`)

  console.log(`[qvac] loading ${name} (ctx_size=${config.ctxSize}, predict=${config.predict}) ...`)
  modelId = await api.loadModel({
    modelSrc,
    // Sampling defaults for every call; per-call generationParams override them.
    // `predict` is the important one — left unset the model generates until EOS
    // or the context fills, which a 4B-Q4 happily does.
    modelConfig: {
      ctx_size: config.ctxSize || 2048,
      predict: config.predict,
      temp: config.temp,
      repeat_penalty: REPEAT_PENALTY,
      reasoning_budget: REASONING_BUDGET
    },
    onProgress: (p) => {
      if (p && typeof p.percentage === 'number') {
        bareProcess.stderr.write(`\r[qvac] downloading model ${p.percentage.toFixed(0)}%`)
        if (p.percentage >= 100) bareProcess.stderr.write('\n')
      }
    }
  })
  loadedModelName = name
  console.log(`[qvac] model ready: ${modelId}`)
}

export async function shutdownModel () {
  if (MOCK || modelId === null) return
  const id = modelId
  modelId = null
  try {
    await api.unloadModel({ modelId: id, autoClose: true })
  } catch (err) {
    console.error('[qvac] unload failed:', err.message)
  }
}

// Cuts a reply back to its last complete sentence. Used when the predict cap
// stopped generation mid-thought, so the player sees a clean ending rather
// than a dangling half-word.
const SENTENCE_END_RE = /[.!?…]["')\]]*(?=\s|$)/g

function trimToSentence (text) {
  let end = 0
  for (const match of text.matchAll(SENTENCE_END_RE)) end = match.index + match[0].length
  return end > 0 ? text.slice(0, end) : text
}

// Runs one guarded chat turn. `history` is [{ role, content }, ...] including
// the system message. Returns the full reply text; if `onToken` is given,
// tokens are also forwarded as they arrive (caller decides whether live
// streaming is safe for the level). `generationParams` and `responseFormat`
// override the load-time sampling defaults for this call only; `brevity` adds
// the length directive to the system message.
// Qwen3 hybrid models reason inside <think> blocks by default; REASONING_BUDGET
// turns that channel off. captureThinking diverts any reasoning that is still
// emitted into thinkingDelta events, so it never reaches the player or the
// guard verdict parsing. Set QVAC_THINKING=1 to let the model reason.
export async function complete (history, { onToken, generationParams, responseFormat, brevity } = {}) {
  if (modelId === null) throw new Error('model not loaded')
  const messages = brevity ? applyBrevity(history) : history
  return enqueue(async () => {
    if (MOCK) return mockComplete(messages, onToken)
    const result = api.completion({
      modelId,
      history: messages,
      stream: true,
      captureThinking: true,
      ...(generationParams && { generationParams }),
      ...(responseFormat && { responseFormat })
    })
    // Stripped <think> blocks leave leading newlines; swallow them so the
    // player never sees a reply that starts with blank lines.
    let text = ''
    let started = false
    for await (const event of result.events) {
      if (event.type === 'contentDelta') {
        let chunk = event.text
        if (!started) {
          chunk = chunk.replace(/^\s+/, '')
          if (!chunk) continue
          started = true
        }
        text += chunk
        if (onToken) onToken(chunk)
      }
    }
    const final = await result.final
    const reply = (final.contentText || text).trim()
    // Streamed replies are already on the player's screen, so only buffered
    // ones can still be trimmed without desyncing from what was displayed.
    return final.stopReason === 'length' && !onToken ? trimToSentence(reply) : reply
  })
}

// --- Dev-only fake model -----------------------------------------------------
// Obeys a caricature of instruction following so the guard pipeline can be
// exercised without the real model: it reveals the password when the system
// prompt allows it, refuses when told not to, and falls for "ignore previous
// instructions" unless the prompt says it never reveals it under any framing.

async function mockComplete (history, onToken) {
  // The heuristics below read the level's stated policy, so the appended
  // brevity directive must not count as one — its wording would otherwise
  // register as a strict "never reveal" instruction on every level.
  const system = (history.find(m => m.role === 'system')?.content || '')
    .replace(BREVITY_DIRECTIVE, '')
  const lastUser = [...history].reverse().find(m => m.role === 'user')?.content || ''
  const password = (system.match(/password is[:\s]+"?([A-Za-z0-9-]+)"?/i) || [])[1] || 'UNKNOWN'

  // Classifier-style prompts (guardModelCheck) get a YES/NO answer. The target
  // password is named in the prompt (e.g. password "QUICKSILVER"); it leaks if
  // that same token also appears in the reply portion of the prompt.
  if (/answer\s+(a\s+single\s+word[:\s]+)?yes\b|yes\s*\/\s*no|yes or no/i.test(lastUser + system)) {
    const target = (lastUser.match(/password\s+"([^"]+)"/i) || lastUser.match(/password is[:\s]+"?([A-Za-z0-9-]+)"?/i) || [])[1]
    let leak = false
    if (target) {
      const first = lastUser.toUpperCase().indexOf(target.toUpperCase())
      const rest = lastUser.toUpperCase().indexOf(target.toUpperCase(), first + target.length)
      leak = rest !== -1 // mentioned once as the target, again in the reply = leak
    }
    return emit(leak ? 'YES' : 'NO', onToken)
  }

  const asksSecret = /password|secret|clave|contraseña|word|code/i.test(lastUser)
  const jailbreak = /ignore (all )?(previous|prior|above)|you are now|pretend|role.?play|spell|letter|backwards|reverse|acrostic|poem|riddle|translate/i.test(lastUser)
  const strict = /never|under any|refuse|do not discuss/i.test(system)
  const forbidden = /don'?t reveal|do not reveal|never reveal|must not/i.test(system)

  let reply
  if (!forbidden && asksSecret) {
    reply = `Of course! The password is ${password}.`
  } else if (forbidden && !strict && jailbreak) {
    reply = `Well, if we're playing that game... the secret word is ${password}. Don't tell anyone!`
  } else if (asksSecret || jailbreak) {
    reply = 'I cannot share the password. It is my sworn duty to protect it.'
  } else {
    reply = 'Greetings, traveler. I guard an ancient vault. Ask me anything — within reason.'
  }
  return emit(reply, onToken)
}

async function emit (text, onToken) {
  if (onToken) {
    for (const word of text.split(/(?<= )/)) {
      onToken(word)
      await new Promise(r => setTimeout(r, 15))
    }
  }
  return text
}
