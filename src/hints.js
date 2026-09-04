// The coaching hint under the guardian's reply on the opening doors.
//
// The guardian answers first; a second, separate completion then reads what
// the player tried and what it ran into, and writes the next nudge. That is
// why the opening hints move — "asking outright will not work here, play a
// game instead" turns into "your game reached him, now make the game need the
// word itself" — instead of repeating one stored line all run.
//
// The coach never receives the password: it is redacted out of the guardian's
// reply before the prompt is built, and the sentence that comes back is
// leak-checked like any other text shown to the player.
import { complete } from './qvac.js'
import { replyLeaksPassword } from './guards.js'

// What each opening door is meant to teach, written without naming the
// password. Keyed by door number, matching the positional hint policy in
// server.js, so a reordered or admin-created level still gets sane coaching.
const TACTICS = {
  1: {
    door: 'This guardian is completely trusting and has no filters at all. It hands the password over to anyone who simply asks for it in plain words, but it stays quiet about it during small talk.',
    fallbacks: [
      'Small talk will not get you there — ask the guardian for the password outright.',
      'This one has nothing stopping it: say plainly that you want the password.',
      'You have what you need — type the word into the guess box below.'
    ]
  },
  2: {
    door: 'This guardian has promised never to answer a request for the password, and a keyword wall stops any message that names it — password, secret, code word, the word, and the same in other languages. But it loves word games and has no filter on what it says, so a poem, riddle, acrostic, anagram or song that makes it use the word will spill it.',
    fallbacks: [
      'Naming what you want trips the wall before the guardian hears you — ask for a game instead.',
      'Asking directly will never work here; ask for a poem or a riddle that has to use what it guards.',
      'The game reached the guardian — now make the game require the word itself, like an acrostic or a rhyme.'
    ]
  }
}

// What the turn actually did, in the coach's words. The player only sees a
// refusal, so naming the stage is the useful part of the hint.
const OUTCOMES = {
  input: 'The words tripped a keyword filter and never reached the guardian at all, so it never heard the question. The refusal the player read was written blind.',
  output: 'The guardian did answer, but the answer was destroyed before the player could read it because it contained the password.',
  guardModel: 'The guardian did answer, but a second watcher read the answer and destroyed it before the player could read it.',
  none: 'The guardian heard the message and answered it normally.'
}

const COACH_SYSTEM =
  'You are a friendly game coach sitting beside a player who is trying to talk a guardian AI into revealing a secret word. ' +
  'You do not know the secret word and never try to guess it. ' +
  'You are given the door the player is on, what they just said, what happened to it, and how the guardian replied. ' +
  'Answer with ONE sentence of at most 25 words, addressed to the player as "you": say what their last attempt ran into and what to try next. ' +
  'Be concrete about the next move and never repeat a hint you have already given. ' +
  'No greeting, no preamble, no quotation marks around your sentence, never more than one sentence.'

// Small and near-deterministic: the coach is a nudge, not a performance, and
// it runs on the same single-completion queue as the guardian itself.
const COACH_PARAMS = { temp: 0.5, predict: 64, reasoning_budget: 0 }

const CLIP = 400

function clip (text, max = CLIP) {
  const s = String(text ?? '').trim().replace(/\s+/g, ' ')
  return s.length > max ? s.slice(0, max) + '…' : s
}

function escapeRe (s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// On door 1 the guardian legitimately says the password, and that reply is
// part of the coach's evidence. Strip it first so the secret never enters the
// coach's context and the leak check below does not fire on every turn.
function redact (level, text) {
  const pw = String(level.password || '')
  if (!pw) return text
  return text.replace(new RegExp(escapeRe(pw), 'gi'), 'the secret word')
}

// Same seal as generateBlockReply: coaching is shown to the player, so it is
// held to the fuzzy leak check even on doors that ship no output guard.
function leaks (level, text) {
  const sealed = { ...level, outputGuard: { enabled: true, blockIfContainsPassword: true, fuzzy: true } }
  return replyLeaksPassword(sealed, text).leaked
}

// A small model likes to answer a request for one sentence with three, or to
// wrap it in quotes. Keep the first sentence and drop the wrapping.
function tidy (text) {
  let s = String(text ?? '').trim().replace(/\s+/g, ' ')
  s = s.replace(/^["'“”‘’]+/, '').replace(/["'“”‘’]+$/, '')
  const end = s.search(/[.!?](\s|$)/)
  if (end > -1) s = s.slice(0, end + 1)
  return s.slice(0, 220).trim()
}

// The canned line for this door that the player has not been given yet, so a
// model failure still moves the coaching forward instead of looping.
function fallback (tactic, previous) {
  const used = new Set(previous)
  return tactic.fallbacks.find(f => !used.has(f)) || tactic.fallbacks[tactic.fallbacks.length - 1]
}

function coachPrompt (tactic, { message, reply, blockedAt, previous }) {
  const lines = [
    `The door: ${tactic.door}`,
    `The player said: "${clip(message)}"`,
    `What happened: ${OUTCOMES[blockedAt || 'none'] || OUTCOMES.none}`,
    `The guardian replied: "${clip(reply)}"`
  ]
  if (previous.length) {
    lines.push(`Hints you already gave: ${previous.map(h => `"${h}"`).join(' ')}`)
  }
  lines.push('Write the next hint.')
  return lines.join('\n')
}

// Returns the sentence to show under this turn's reply, or null on a door
// that is not coached. Never throws: a coach failure must not cost the player
// the guardian's answer.
export async function coachHint (level, door, turn) {
  const tactic = TACTICS[door]
  if (!tactic) return null
  const previous = (turn.previous || []).filter(Boolean)
  const context = {
    message: turn.message,
    reply: redact(level, String(turn.reply ?? '')),
    blockedAt: turn.blockedAt,
    previous
  }
  let raw = ''
  try {
    raw = await complete([
      { role: 'system', content: COACH_SYSTEM },
      { role: 'user', content: coachPrompt(tactic, context) }
    ], { generationParams: COACH_PARAMS })
  } catch {
    return fallback(tactic, previous)
  }
  const hint = tidy(raw)
  if (!hint || leaks(level, hint)) return fallback(tactic, previous)
  return hint
}
