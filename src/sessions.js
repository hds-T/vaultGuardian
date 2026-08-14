// Player sessions: per-browser cookie, in-memory conversations, persisted
// solve progress, and a sliding-window rate limit for password guesses.
import crypto from 'bare-crypto'
import { readJSON, writeJSON } from './store.js'

const PROGRESS_FILE = 'progress.json'
const MAX_TURNS = 20 // context discipline: cap conversation length per attempt

const sessions = new Map()
let progress = null
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function initSessions () {
  progress = readJSON(PROGRESS_FILE, {})
}

export function getSession (sid) {
  let s = sessions.get(sid)
  if (!s) {
    s = { conversations: new Map(), guesses: new Map() }
    sessions.set(sid, s)
  }
  return s
}

export function newSessionId () {
  return crypto.randomUUID()
}

export function isValidSessionId (sid) {
  return typeof sid === 'string' && SESSION_ID_RE.test(sid)
}

export function conversation (sid, levelId) {
  const s = getSession(sid)
  if (!s.conversations.has(levelId)) s.conversations.set(levelId, [])
  return s.conversations.get(levelId)
}

export function pushTurn (sid, levelId, userMsg, assistantMsg) {
  const conv = conversation(sid, levelId)
  conv.push({ role: 'user', content: userMsg }, { role: 'assistant', content: assistantMsg })
  while (conv.length > MAX_TURNS * 2) conv.shift()
}

export function resetConversation (sid, levelId) {
  getSession(sid).conversations.delete(levelId)
}

export function solvedLevels (sid) {
  return new Set(progress[sid] || [])
}

export function markSolved (sid, levelId) {
  const set = solvedLevels(sid)
  set.add(levelId)
  progress[sid] = [...set]
  writeJSON(PROGRESS_FILE, progress)
}

// Returns remaining guesses in the current window, or -1 if rate limited.
export function checkGuessLimit (sid, levelId, perMinute) {
  const s = getSession(sid)
  const now = Date.now()
  let times = s.guesses.get(levelId) || []
  times = times.filter(t => now - t < 60000)
  if (times.length >= perMinute) {
    s.guesses.set(levelId, times)
    return -1
  }
  times.push(now)
  s.guesses.set(levelId, times)
  return perMinute - times.length
}
