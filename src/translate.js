// Player-facing translation, EN -> ES/CA, through the QVAC NMT engine.
//
// The guardian reasons and writes only in English: every guard, classifier and
// coach prompt in this app is English, and keeping generation there is what
// keeps them meaningful. Translation is the last step before text reaches the
// player, so nothing downstream of a guard is ever re-read by one.
//
// Bergamot is a per-direction model of ~32MB, loaded the first time a language
// is actually asked for, so an English run downloads nothing extra.
import bareProcess from 'bare-process'

if (!globalThis.process) globalThis.process = bareProcess

import { sdkApi } from './qvac.js'

const MOCK = bareProcess.env.QVAC_MOCK === '1'
const DISABLED = bareProcess.env.QVAC_TRANSLATE === '0'
const MODEL_TYPE = 'nmtcpp-translation'

// The languages a player can pick. English is the source, so it never needs a
// model of its own.
export const PLAYER_LANGUAGES = ['en', 'es', 'ca']
const TARGETS = { es: 'BERGAMOT_EN_ES', ca: 'BERGAMOT_EN_CA' }

export function isPlayerLanguage (lang) {
  return PLAYER_LANGUAGES.includes(lang)
}

// English is the source language, so "translating" it is a no-op.
function needsModel (lang) {
  return !DISABLED && !!TARGETS[lang]
}

export function translationInfo () {
  return { enabled: !DISABLED, mock: MOCK, languages: PLAYER_LANGUAGES }
}

// lang -> Promise<modelId>. Holding the promise rather than the id means two
// turns racing on the same language share one load instead of starting two.
const models = new Map()

function modelFor (lang) {
  if (!models.has(lang)) {
    models.set(lang, loadFor(lang).catch(err => {
      // A failed load must not poison the language forever.
      models.delete(lang)
      throw err
    }))
  }
  return models.get(lang)
}

async function loadFor (lang) {
  const { sdk, api } = sdkApi()
  const name = TARGETS[lang]
  const modelSrc = sdk[name]
  if (!modelSrc) throw new Error(`Unknown NMT model constant "${name}" — not exported by @qvac/sdk`)

  console.log(`[nmt] loading ${name} ...`)
  const modelId = await api.loadModel({
    modelSrc,
    // The plugin resolves Bergamot's vocab companions from the model itself,
    // so the direction is all it needs from us.
    modelConfig: { engine: 'Bergamot', from: 'en', to: lang },
    onProgress: (p) => {
      if (p && typeof p.percentage === 'number') {
        bareProcess.stderr.write(`\r[nmt] downloading ${name} ${p.percentage.toFixed(0)}%`)
        if (p.percentage >= 100) bareProcess.stderr.write('\n')
      }
    }
  })
  console.log(`[nmt] model ready: ${modelId}`)
  return modelId
}

export async function shutdownTranslators () {
  const pending = [...models.values()]
  models.clear()
  for (const p of pending) {
    try {
      const modelId = await p
      await sdkApi().api.unloadModel({ modelId })
    } catch (err) {
      console.error('[nmt] unload failed:', err.message)
    }
  }
}

// Level names, prizes and static hints are the same handful of strings on every
// request, so caching turns them into one translation per run.
const MAX_CACHE = 500
const cache = new Map()

function cacheGet (key) {
  return cache.get(key)
}

function cacheSet (key, value) {
  cache.set(key, value)
  // Map iterates in insertion order, so the first key is the oldest.
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value)
}

// A second translate call while one is in flight kills the first ("stale job
// replaced by new run"), and a state request alone asks for a dozen strings.
// Like the completion model next door, requests queue.
let chain = Promise.resolve()

function enqueue (fn) {
  const job = chain.then(fn, fn)
  chain = job.catch(() => {})
  return job
}

function run (text, lang) {
  if (MOCK) return Promise.resolve(`[${lang}] ${text}`)
  return enqueue(async () => {
    const modelId = await modelFor(lang)
    const result = sdkApi().api.translate({ modelId, text, modelType: MODEL_TYPE, stream: false })
    return String(await result.text ?? '').trim()
  })
}

function escapeRe (s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// A token NMT has no translation for and copies through untouched. It only has
// to survive one round trip; if it does not, the caller falls back.
const SENTINEL = 'QVACWORD'

function countOf (text, needle) {
  return text.split(new RegExp(escapeRe(needle), 'gi')).length - 1
}

// The password is the one string that must cross unchanged — on level 1 the
// reply *is* the password. Hide it behind a sentinel so the sentence still
// translates as a whole, then put it back.
async function translateKeeping (text, lang, keep) {
  const parts = text.split(new RegExp(`(${escapeRe(keep)})`, 'gi'))
  if (parts.length === 1) return run(text, lang)

  const masked = parts.map((p, i) => (i % 2 ? SENTINEL : p)).join('')
  const translated = await run(masked, lang)
  const hits = countOf(translated, SENTINEL)
  if (hits > 0 && hits === countOf(masked, SENTINEL)) {
    // Odd indices are the matches, in the casing the guardian actually used.
    let n = 0
    return translated.replace(new RegExp(escapeRe(SENTINEL), 'gi'), () => parts[(n++ * 2) + 1])
  }

  // The sentinel did not come back intact. Translate the prose around the word
  // instead: choppier, but the player still reads the password.
  const out = []
  for (let i = 0; i < parts.length; i++) {
    out.push(i % 2 || !parts[i].trim() ? parts[i] : await run(parts[i], lang))
  }
  return out.join('')
}

// The single entry point for everything the player reads. `keep` is a word that
// must survive verbatim (the level password). Falls back to the English source
// on any failure — a readable English sentence beats an error in the chat.
export async function translateForPlayer (text, lang, keep) {
  const source = String(text ?? '')
  if (!source.trim() || !needsModel(lang)) return source

  const key = `${lang}\n${source}`
  const hit = cacheGet(key)
  if (hit !== undefined) return hit

  let out
  try {
    out = keep ? await translateKeeping(source, lang, keep) : await run(source, lang)
  } catch (err) {
    console.error('[nmt] translation failed:', err.message)
    return source
  }
  if (!out.trim()) return source
  cacheSet(key, out)
  return out
}
