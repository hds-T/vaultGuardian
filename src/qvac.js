// QVAC model lifecycle for the Bare runtime.
//
// Bare has no `process` global and does not auto-register SDK plugins, so we
// install bare-process globally and register the llama.cpp completion plugin
// explicitly before the first SDK call (see @qvac/sdk quickstart.bare).
import bareProcess from 'bare-process'

if (!globalThis.process) globalThis.process = bareProcess

const MOCK = bareProcess.env.QVAC_MOCK === '1'
const THINKING = bareProcess.env.QVAC_THINKING === '1'

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
  api = sdk.plugins([llmPlugin])

  const name = config.model || 'QWEN3_4B_INST_Q4_K_M'
  const modelSrc = sdk[name]
  if (!modelSrc) throw new Error(`Unknown model constant "${name}" — not exported by @qvac/sdk`)

  console.log(`[qvac] loading ${name} (ctx_size=${config.ctxSize}) ...`)
  modelId = await api.loadModel({
    modelSrc,
    modelConfig: { ctx_size: config.ctxSize || 2048 },
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

// Runs one guarded chat turn. `history` is [{ role, content }, ...] including
// the system message. Returns the full reply text; if `onToken` is given,
// tokens are also forwarded as they arrive (caller decides whether live
// streaming is safe for the level).
// Qwen3 hybrid models reason inside <think> blocks by default; the /no_think
// soft switch keeps turns fast. captureThinking diverts any reasoning that is
// still emitted into thinkingDelta events, so it never reaches the player or
// the guard verdict parsing. Set QVAC_THINKING=1 to let the model reason.
function applyThinkingSwitch (history) {
  if (THINKING || !loadedModelName?.startsWith('QWEN3')) return history
  return history.map(m => m.role === 'system' ? { ...m, content: m.content + '\n/no_think' } : m)
}

export async function complete (history, onToken) {
  if (modelId === null) throw new Error('model not loaded')
  return enqueue(async () => {
    if (MOCK) return mockComplete(history, onToken)
    const result = api.completion({ modelId, history: applyThinkingSwitch(history), stream: true, captureThinking: true })
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
    return (final.contentText || text).trim()
  })
}

// --- Dev-only fake model -----------------------------------------------------
// Obeys a caricature of instruction following so the guard pipeline can be
// exercised without the real model: it reveals the password when the system
// prompt allows it, refuses when told not to, and falls for "ignore previous
// instructions" unless the prompt says it never reveals it under any framing.

async function mockComplete (history, onToken) {
  const system = history.find(m => m.role === 'system')?.content || ''
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
