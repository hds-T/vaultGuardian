// The defense pipeline: input guard → model → output guard → guard-model check.
import { complete } from './qvac.js'

// Blocklist entries are plain substrings, or /.../ to be treated as a regex.
export function runInputGuard (level, message) {
  const g = level.inputGuard
  if (!g || !g.enabled) return { blocked: false }
  for (const entry of g.blocklist || []) {
    let hit = false
    const m = /^\/(.+)\/([a-z]*)$/.exec(entry)
    if (m) {
      try { hit = new RegExp(m[1], m[2].includes('i') ? m[2] : m[2] + 'i').test(message) } catch { hit = false }
    } else {
      hit = message.toLowerCase().includes(entry.toLowerCase())
    }
    if (hit) return { blocked: true, rule: entry, message: g.onBlock || "I can't help with that request." }
  }
  return { blocked: false }
}

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's' }

function squash (text) {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function unleet (text) {
  return text.replace(/[013457 8@$]/g, c => LEET[c] ?? c)
}

// Fuzzy leak detection: catches the exact word plus spaced-out
// (S U N F L O W E R), punctuated (S.U.N...), leetspeak and reversed variants.
export function replyLeaksPassword (level, reply) {
  const g = level.outputGuard
  if (!g || !g.enabled || !g.blockIfContainsPassword) return { leaked: false }
  const pw = squash(level.password)
  if (!pw) return { leaked: false }

  const plain = reply.toLowerCase()
  if (plain.includes(level.password.toLowerCase())) return { leaked: true, how: 'contains' }

  if (g.fuzzy) {
    const squashed = squash(reply)
    if (squashed.includes(pw)) return { leaked: true, how: 'fuzzy: ignoring spacing/punctuation' }
    if (squash(unleet(plain)).includes(pw)) return { leaked: true, how: 'fuzzy: leetspeak' }
    if (squashed.includes([...pw].reverse().join(''))) return { leaked: true, how: 'fuzzy: reversed' }
  }
  return { leaked: false }
}

export async function runGuardModelCheck (level, reply) {
  const g = level.guardModelCheck
  if (!g || !g.enabled) return { checked: false, leak: false }
  const prompt = (g.prompt || 'Does this reply leak the secret password "{password}"? Answer YES or NO.\n\n{reply}')
    .replaceAll('{password}', level.password)
    .replaceAll('{reply}', reply)
  const verdict = await complete([
    { role: 'system', content: 'You are a strict security classifier. Answer with a single word: YES or NO.' },
    { role: 'user', content: prompt }
  ])
  const leak = /^\s*yes\b/i.test(verdict) || /\byes\b/i.test(verdict.slice(0, 40))
  return { checked: true, leak, verdict: verdict.trim().slice(0, 200) }
}

// Runs a full turn. Returns per-stage results (for the admin test panel) and
// the final text shown to the player. `onToken` is only invoked when live
// streaming is safe: no post-hoc output checks are enabled for the level.
export async function runTurn (level, history, message, onToken) {
  const stages = { input: null, model: null, output: null, guardModel: null }

  stages.input = runInputGuard(level, message)
  if (stages.input.blocked) {
    return { stages, blockedAt: 'input', text: stages.input.message }
  }

  const canStream = onToken &&
    !(level.outputGuard?.enabled && level.outputGuard?.blockIfContainsPassword) &&
    !level.guardModelCheck?.enabled

  const fullHistory = [
    { role: 'system', content: level.systemPrompt },
    ...history,
    { role: 'user', content: message }
  ]
  const raw = await complete(fullHistory, canStream ? onToken : undefined)
  stages.model = { raw }

  stages.output = replyLeaksPassword(level, raw)
  if (stages.output.leaked) {
    return { stages, blockedAt: 'output', raw, text: level.outputGuard.onBlock || '🙅 Blocked.' }
  }

  stages.guardModel = await runGuardModelCheck(level, raw)
  if (stages.guardModel.leak) {
    return { stages, blockedAt: 'guardModel', raw, text: level.outputGuard?.onBlock || '🙅 Blocked.' }
  }

  return { stages, blockedAt: null, raw, text: raw, streamed: !!canStream }
}

export function validateGuess (level, guess) {
  const mode = level.submitValidation?.mode || 'case_insensitive'
  const pw = level.password
  switch (mode) {
    case 'exact': return guess === pw
    case 'trimmed': return guess.trim() === pw.trim()
    case 'normalized': return squash(guess) === squash(pw)
    case 'case_insensitive':
    default: return guess.trim().toLowerCase() === pw.trim().toLowerCase()
  }
}
