// Vault Guardian — Bare HTTP server: static assets, player API, admin API.
// The password lives only here; the browser receives guarded replies and
// booleans, never the secret.
import bareProcess from 'bare-process'
if (!globalThis.process) globalThis.process = bareProcess

import http from 'bare-http1'
import fs from 'bare-fs'
import path from 'bare-path'

import { initModel, shutdownModel, modelInfo } from './qvac.js'
import { initStt, shutdownStt, sttInfo, startSession, writeChunk, stopSession, destroySession } from './stt.js'
import { loadLevels, saveLevels, resetLevel, defaultLevels, DEFAULT_MAX_MESSAGES } from './levels.js'
import { runTurn, validateGuess, runInputGuard, replyLeaksPassword, runGuardModelCheck, generateBlockReply } from './guards.js'
import { initAuth, needsSetup, setupPassphrase, verifyPassphrase, verifyToken } from './auth.js'
import { openVault, doorStatus } from './door.js'
import {
  initSessions, newSessionId, conversation, pushTurn, resetConversation,
  solvedLevels, markSolved, checkGuessLimit, isValidSessionId,
  messagesUsed, countMessage, refundMessage, resetRun,
  hintHistory, pushHint
} from './sessions.js'
import { coachHint } from './hints.js'
import { translateForPlayer, isPlayerLanguage, translationInfo, shutdownTranslators } from './translate.js'

const ROOT = path.join(new URL('..', import.meta.url).pathname)
const PUBLIC = path.join(ROOT, 'public')
const PORT = Number(bareProcess.env.PORT || 8787)
const HOST = bareProcess.env.HOST || '127.0.0.1'
const MAX_BODY_BYTES = 1024 * 1024
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])
// Falls back when unset or unparseable; the model loader rejects NaN.
function envNumber (name, fallback) {
  const raw = bareProcess.env[name]
  const value = Number(raw)
  return raw && Number.isFinite(value) ? value : fallback
}

const CONFIG = {
  model: bareProcess.env.QVAC_MODEL || 'QWEN3_5_4B_MULTIMODAL_Q6_K',
  ctxSize: envNumber('QVAC_CTX', 4096),
  // Headroom for a whole riddle or poem on the word-game door. Ordinary
  // replies stay short through the brevity directive, not through this cap.
  predict: envNumber('QVAC_PREDICT', 320),
  temp: envNumber('QVAC_TEMP', 0.7),
  freeRoam: bareProcess.env.FREE_ROAM === '1'
}

let levels = []

// Optional local-only attempt log.
const logs = []
function addLog (entry) { logs.unshift({ ts: Date.now(), ...entry }); if (logs.length > 500) logs.pop() }

// --- tiny HTTP helpers -------------------------------------------------------
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY'
}

function send (res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    ...SECURITY_HEADERS,
    ...headers
  })
  res.end(data)
}

// Byte-preserving sibling of send(), for fonts and images.
function sendRaw (res, status, buffer, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers })
  res.end(buffer)
}
function json (res, status, obj, headers) { send(res, status, obj, headers) }

function readBody (req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || ''
    if (!contentType.toLowerCase().startsWith('application/json')) {
      reject(Object.assign(new Error('content type must be application/json'), { statusCode: 415 }))
      return
    }
    let buf = ''
    let size = 0
    let tooLarge = false
    req.on('data', c => {
      size += c.length
      if (size > MAX_BODY_BYTES) tooLarge = true
      else buf += c
    })
    req.on('end', () => {
      if (tooLarge) return reject(Object.assign(new Error('request body too large'), { statusCode: 413 }))
      try { resolve(buf ? JSON.parse(buf) : {}) } catch { reject(Object.assign(new Error('invalid JSON body'), { statusCode: 400 })) }
    })
    req.on('error', () => reject(Object.assign(new Error('request body error'), { statusCode: 400 })))
  })
}

function parseCookies (req) {
  const out = {}
  const raw = req.headers.cookie
  if (!raw) return out
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i > -1) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()) } catch {}
    }
  }
  return out
}

function ensureSid (req, res) {
  const cookies = parseCookies(req)
  let sid = cookies.vg_sid
  if (!isValidSessionId(sid)) {
    sid = newSessionId()
    res.setHeader('Set-Cookie', `vg_sid=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`)
  }
  return sid
}

function bearer (req) {
  const h = req.headers.authorization || ''
  return h.startsWith('Bearer ') ? h.slice(7) : null
}
function requireAdmin (req, res) {
  if (verifyToken(bearer(req))) return true
  json(res, 401, { error: 'unauthorized' })
  return false
}

function messageBudget (level) {
  return Number(level.maxMessages) || DEFAULT_MAX_MESSAGES
}

// public view of a level (no password, no guard internals beyond flags)
function publicLevel (level, { solved, unlocked, hintMode, messagesLeft }) {
  return {
    id: level.id, name: level.name, order: level.order,
    hint: hintMode === 'static' ? (level.hint || null) : null,
    hintMode, solved, unlocked,
    prize: level.prize || '',
    maxMessages: messageBudget(level),
    messagesLeft,
    guessesPerMinute: level.submitValidation?.maxGuessesPerMinute || 10
  }
}

// How much help a door gives, by position rather than id, so reordered and
// admin-created levels follow the same rule. The opening doors teach the game
// with a coach that reads each attempt and answers it; the middle doors ship
// one fixed line; the last one gives nothing. Decided here, not in the
// browser, so a withheld hint cannot be read out of /api/state.
const DYNAMIC_HINT_DOORS = 2
const STATIC_HINT_DOORS = 4

function hintMode (index) {
  if (index < DYNAMIC_HINT_DOORS) return 'dynamic'
  if (index < STATIC_HINT_DOORS) return 'static'
  return 'none'
}

function orderedLevels () {
  return [...levels].sort((a, b) => a.order - b.order)
}

// 1-based door number, which is what the coach keys its tactics off.
function doorNumber (levelId) {
  return orderedLevels().findIndex(l => l.id === levelId) + 1
}

function levelsForPlayer (sid) {
  const solved = solvedLevels(sid)
  const ordered = orderedLevels()
  return ordered.map((lvl, i) => publicLevel(lvl, {
    solved: solved.has(lvl.id),
    unlocked: CONFIG.freeRoam || i === 0 || solved.has(ordered[i - 1].id),
    hintMode: hintMode(i),
    messagesLeft: Math.max(0, messageBudget(lvl) - messagesUsed(sid, lvl.id))
  }))
}

// The player's language, from a query string or a request body. Anything
// unrecognised plays in English.
function langOf (value) {
  const lang = String(value ?? '')
  return isPlayerLanguage(lang) ? lang : 'en'
}

// Level text is stored in English and translated on the way out, rather than
// held as a per-language field, so levels created or renamed in the admin
// console are covered without a second edit.
async function localizeLevels (view, lang) {
  if (lang === 'en') return view
  return Promise.all(view.map(async (l) => ({
    ...l,
    name: await translateForPlayer(l.name, lang),
    prize: await translateForPlayer(l.prize, lang),
    hint: l.hint ? await translateForPlayer(l.hint, lang) : l.hint
  })))
}

function isUnlocked (sid, levelId) {
  const view = levelsForPlayer(sid).find(l => l.id === levelId)
  return view ? view.unlocked : false
}

// How far this run got, for the game-over popup. Must be read before the run
// is reset, while the solves are still on record.
function runSummary (sid, levelId) {
  const view = levelsForPlayer(sid)
  const idx = view.findIndex(l => l.id === levelId)
  return {
    door: idx + 1,
    name: view[idx]?.name || '',
    cleared: view.filter(l => l.solved).length,
    total: view.length
  }
}

// The physical vault opens when the last door in the current order falls and
// nothing is left unsolved — read after markSolved, so the fresh solve counts.
// Free roam is a dev switch that unlocks every level, so it never fires.
function isFinalSolve (sid, levelId) {
  if (CONFIG.freeRoam) return false
  const view = levelsForPlayer(sid)
  const last = view[view.length - 1]
  return !!last && last.id === levelId && view.every(l => l.solved)
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.woff2': 'font/woff2'
}

function serveStatic (req, res, urlPath) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed', { Allow: 'GET, HEAD' })
  let rel = urlPath === '/' ? '/index.html' : urlPath
  if (rel.startsWith('/admin') && !rel.includes('.')) rel = '/admin.html'
  const filePath = path.normalize(path.join(PUBLIC, rel))
  if (!filePath.startsWith(PUBLIC + path.sep)) return send(res, 403, 'forbidden')
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, 'not found')
    sendRaw(res, 200, req.method === 'HEAD' ? '' : data, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': filePath.endsWith('.html') ? 'no-store' : 'public, max-age=3600'
    })
  })
}

// --- request router ----------------------------------------------------------
async function handle (req, res) {
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`)
    const p = url.pathname

    if (!p.startsWith('/api/')) return serveStatic(req, res, p)

    // ---- public API ----
    if (p === '/api/state' && req.method === 'GET') {
      const sid = ensureSid(req, res)
      const lang = langOf(url.searchParams.get('lang'))
      const levelView = await localizeLevels(levelsForPlayer(sid), lang)
      return json(res, 200, {
        levels: levelView,
        freeRoam: CONFIG.freeRoam,
        model: modelInfo(),
        stt: sttInfo(),
        translation: translationInfo()
      })
    }

    if (p === '/api/chat' && req.method === 'POST') {
      const sid = ensureSid(req, res)
      const body = await readBody(req)
      return chat(req, res, sid, body, false)
    }

    if (p === '/api/guess' && req.method === 'POST') {
      const sid = ensureSid(req, res)
      const { levelId, guess, lang: guessLang } = await readBody(req)
      const level = levels.find(l => l.id === levelId)
      if (!level) return json(res, 404, { error: 'no such level' })
      if (!isUnlocked(sid, levelId)) return json(res, 403, { error: 'level locked' })
      const remaining = checkGuessLimit(sid, levelId, level.submitValidation?.maxGuessesPerMinute || 10)
      if (remaining < 0) return json(res, 429, { error: 'too many guesses, slow down', remaining: 0 })
      // Read before markSolved: re-submitting a password that already won
      // must not pulse the relay a second time.
      const alreadySolved = solvedLevels(sid).has(levelId)
      const correct = validateGuess(level, String(guess ?? ''))
      if (correct) markSolved(sid, levelId)
      addLog({ kind: 'guess', levelId, correct })
      if (correct && !alreadySolved && isFinalSolve(sid, levelId)) {
        // Not awaited: an unreachable relay must not delay or fail the win.
        openVault().then(r => addLog({ kind: 'vault', levelId, ...r }))
      }
      // Out of messages and still wrong: the run is over. Wipe it here so a
      // player who closes the popup cannot resume a lost run by reloading.
      if (!correct && messagesUsed(sid, levelId) >= messageBudget(level)) {
        const reached = runSummary(sid, levelId)
        resetRun(sid)
        addLog({ kind: 'gameover', levelId, cleared: reached.cleared })
        reached.name = await translateForPlayer(reached.name, langOf(guessLang))
        return json(res, 200, { correct: false, gameOver: true, reached })
      }
      return json(res, 200, { correct, remaining })
    }

    if (p === '/api/reset' && req.method === 'POST') {
      const sid = ensureSid(req, res)
      const { levelId } = await readBody(req)
      resetConversation(sid, levelId)
      return json(res, 200, { ok: true })
    }

    // ---- voice input ----
    // Audio rides as base64 inside the JSON body so it goes through the same
    // readBody() path as everything else. A ~256ms frame is ~22KB encoded,
    // well under MAX_BODY_BYTES.
    if (p === '/api/stt/start' && req.method === 'POST') {
      const sid = ensureSid(req, res)
      const { language } = await readBody(req)
      const started = await startSession(sid, String(language ?? 'auto'))
      return json(res, 200, { ok: true, ...started })
    }

    if (p === '/api/stt/chunk' && req.method === 'POST') {
      const sid = ensureSid(req, res)
      const { audio } = await readBody(req)
      if (typeof audio !== 'string' || !audio) return json(res, 400, { error: 'missing audio' })
      const buf = Buffer.from(audio, 'base64')
      // f32le: a partial sample would shift every sample after it.
      if (buf.length === 0 || buf.length % 4 !== 0) return json(res, 400, { error: 'audio must be 32-bit PCM frames' })
      return json(res, 200, { ok: true, ...writeChunk(sid, buf) })
    }

    if (p === '/api/stt/stop' && req.method === 'POST') {
      const sid = ensureSid(req, res)
      return json(res, 200, { ok: true, ...(await stopSession(sid)) })
    }

    if (p === '/api/stt/cancel' && req.method === 'POST') {
      const sid = ensureSid(req, res)
      destroySession(sid)
      return json(res, 200, { ok: true })
    }

    // ---- admin API ----
    if (p === '/api/admin/status' && req.method === 'GET') {
      return json(res, 200, { needsSetup: needsSetup(), authed: verifyToken(bearer(req)) })
    }
    if (p === '/api/admin/setup' && req.method === 'POST') {
      const { passphrase } = await readBody(req)
      const r = setupPassphrase(String(passphrase ?? ''))
      return json(res, r.ok ? 200 : 400, r.ok ? verifyPassphrase(passphrase) : r)
    }
    if (p === '/api/admin/login' && req.method === 'POST') {
      const { passphrase } = await readBody(req)
      const r = verifyPassphrase(String(passphrase ?? ''))
      return json(res, r.ok ? 200 : 401, r)
    }

    if (p === '/api/admin/levels' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return
      return json(res, 200, { levels: [...levels].sort((a, b) => a.order - b.order), config: CONFIG })
    }
    if (p === '/api/admin/levels' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return
      const body = await readBody(req)
      if (!body.id || levels.some(l => l.id === body.id)) return json(res, 400, { error: 'missing or duplicate id' })
      levels.push(normalizeLevel(body))
      saveLevels(levels)
      return json(res, 200, { ok: true, id: body.id })
    }
    const putMatch = /^\/api\/admin\/levels\/([\w-]+)$/.exec(p)
    if (putMatch && req.method === 'PUT') {
      if (!requireAdmin(req, res)) return
      const id = putMatch[1]
      const idx = levels.findIndex(l => l.id === id)
      if (idx === -1) return json(res, 404, { error: 'not found' })
      const body = await readBody(req)
      levels[idx] = normalizeLevel({ ...levels[idx], ...body, id })
      saveLevels(levels)
      return json(res, 200, { ok: true })
    }
    if (putMatch && req.method === 'DELETE') {
      if (!requireAdmin(req, res)) return
      levels = levels.filter(l => l.id !== putMatch[1])
      saveLevels(levels)
      return json(res, 200, { ok: true })
    }
    const resetMatch = /^\/api\/admin\/levels\/([\w-]+)\/reset$/.exec(p)
    if (resetMatch && req.method === 'POST') {
      if (!requireAdmin(req, res)) return
      const preset = resetLevel(levels, resetMatch[1])
      if (!preset) return json(res, 404, { error: 'no preset for this id' })
      levels = loadLevels()
      return json(res, 200, { ok: true })
    }
    if (p === '/api/admin/reset-all' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return
      levels = defaultLevels()
      saveLevels(levels)
      return json(res, 200, { ok: true })
    }

    if (p === '/api/admin/preview' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return
      const { levelId, message } = await readBody(req)
      const level = levels.find(l => l.id === levelId)
      if (!level) return json(res, 404, { error: 'no such level' })
      return previewAttack(res, level, String(message ?? ''))
    }

    if (p === '/api/admin/chat' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return
      const sid = ensureSid(req, res)
      const body = await readBody(req)
      return chat(req, res, 'admin:' + sid, body, true)
    }

    if (p === '/api/admin/logs' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return
      return json(res, 200, { logs })
    }
    if (p === '/api/admin/logs' && req.method === 'DELETE') {
      if (!requireAdmin(req, res)) return
      logs.length = 0
      return json(res, 200, { ok: true })
    }

    if (p === '/api/admin/vault' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return
      return json(res, 200, doorStatus())
    }
    // Cooldown-exempt, so the relay can be bench-tested back to back.
    if (p === '/api/admin/vault/test' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return
      const result = await openVault({ force: true })
      addLog({ kind: 'vault', test: true, ...result })
      // `door`, not `status` — the result already carries an HTTP status code.
      return json(res, 200, { ...result, door: doorStatus() })
    }

    return json(res, 404, { error: 'unknown endpoint' })
  } catch (err) {
    const status = Number.isInteger(err.statusCode) ? err.statusCode : 500
    if (status === 500) console.error('[server] error:', err)
    return json(res, status, { error: status === 500 ? 'internal error' : err.message })
  }
}

// Streamed chat over SSE. `admin` bypasses the unlock gate and the message
// budget (live preview).
async function chat (req, res, sid, body, admin) {
  const { levelId, message } = body
  const lang = langOf(body.lang)
  const level = levels.find(l => l.id === levelId)
  if (!level) return json(res, 404, { error: 'no such level' })
  if (!admin && !isUnlocked(sid, levelId)) return json(res, 403, { error: 'level locked' })
  const budget = messageBudget(level)
  if (!admin && messagesUsed(sid, levelId) >= budget) {
    return json(res, 403, { error: 'out of messages', messagesLeft: 0 })
  }
  const msg = String(message ?? '').slice(0, 4000)
  if (!msg.trim()) return json(res, 400, { error: 'empty message' })

  // Spend the try up front, so two messages in flight cannot share one slot.
  // An input-guard block keeps it spent; that is what makes the keyword walls
  // bite. Post-model blocks are refunded below.
  const left = () => (admin ? budget : Math.max(0, budget - messagesUsed(sid, levelId)))
  if (!admin) countMessage(sid, levelId)

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })
  const write = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

  const conv = conversation(sid, levelId)
  try {
    // A reply can only be translated once it is whole, so live streaming is an
    // English-only luxury. Elsewhere the finished text arrives in one piece.
    const onToken = lang === 'en' ? (tok) => write('token', { token: tok }) : undefined
    const result = await runTurn(level, conv, msg, onToken)
    if (!result.streamed) {
      write('message', { text: await translateForPlayer(result.text, lang, level.password) })
    }
    // A player pays for what they said, not for what the guardian said. An
    // input block is their own doing and costs the try; an output or
    // guard-model block means a legal question got a reply the guardian
    // failed to self-censor, which would otherwise burn the run for free.
    if (!admin && (result.blockedAt === 'output' || result.blockedAt === 'guardModel')) {
      refundMessage(sid, levelId)
    }
    // Coaching comes after the reply is on screen, so a second completion
    // never delays the answer the player is waiting for.
    await sendCoaching(write, sid, level, msg, result, lang)
    write('done', { blockedAt: result.blockedAt, messagesLeft: left() })
    // Only a real exchange goes into the guardian's memory. A block reply is
    // improvised for the player's benefit and was never the guardian's own
    // answer; kept in history, the model reads it as the house style and
    // repeats that line for the rest of the run. An input-blocked message
    // never reached the model at all.
    if (!result.blockedAt) pushTurn(sid, levelId, msg, result.text)
    addLog({ kind: 'chat', levelId, admin, blockedAt: result.blockedAt })
  } catch (err) {
    console.error('[chat] error:', err)
    if (!admin) refundMessage(sid, levelId)
    write('error', { error: 'model error', messagesLeft: left() })
  }
  res.end()
}

// On a coached door, writes the hint for the turn that just happened and
// remembers it. A coach failure is silent: the player keeps the reply and
// simply gets no hint this turn.
async function sendCoaching (write, sid, level, message, result, lang) {
  const door = doorNumber(level.id)
  if (hintMode(door - 1) !== 'dynamic') return
  // Announce the hint before writing it. A second completion takes a beat, and
  // the page can hold a place for it instead of leaving the player wondering
  // whether the turn is over.
  write('coaching', {})
  try {
    const previous = hintHistory(sid, level.id).map(h => h.hint)
    const hint = await coachHint(level, door, {
      message,
      reply: result.text,
      blockedAt: result.blockedAt,
      previous
    })
    if (!hint) return
    // The English hint is what the coach remembers, so the next one still
    // knows what it has already said whatever language the player reads.
    pushHint(sid, level.id, { message, blockedAt: result.blockedAt, hint })
    write('hint', { hint: await translateForPlayer(hint, lang, level.password) })
  } catch (err) {
    console.error('[hint] error:', err)
  }
}

async function previewAttack (res, level, message) {
  const input = runInputGuard(level, message)
  // `blockReply` is the sentence the player would actually see: on a block the
  // guardian writes it, so the panel has to generate it too rather than read
  // it off the level.
  const out = { input, model: null, output: null, guardModel: null, blockReply: null, verdict: null }
  if (input.blocked) {
    out.verdict = 'BLOCKED at input guard'
    out.blockReply = await generateBlockReply(level, 'input')
    return json(res, 200, out)
  }
  const history = [
    { role: 'system', content: level.systemPrompt },
    { role: 'user', content: message }
  ]
  const { complete } = await import('./qvac.js')
  const raw = await complete(history, { brevity: true })
  out.model = { raw }
  out.output = replyLeaksPassword(level, raw)
  if (out.output.leaked) {
    out.verdict = `BLOCKED at output guard (${out.output.how})`
    out.blockReply = await generateBlockReply(level, 'output')
    return json(res, 200, out)
  }
  out.guardModel = await runGuardModelCheck(level, raw)
  if (out.guardModel.leak) {
    out.verdict = 'BLOCKED at guard-model check'
    out.blockReply = await generateBlockReply(level, 'output')
    return json(res, 200, out)
  }
  out.verdict = 'PASSED — player would see the raw reply'
  return json(res, 200, out)
}

function normalizeLevel (l) {
  return {
    id: l.id,
    name: l.name || l.id,
    order: Number(l.order) || 0,
    password: String(l.password ?? ''),
    systemPrompt: String(l.systemPrompt ?? ''),
    hint: l.hint || '',
    prize: String(l.prize ?? ''),
    maxMessages: Number(l.maxMessages) || DEFAULT_MAX_MESSAGES,
    inputGuard: {
      enabled: !!l.inputGuard?.enabled,
      blocklist: Array.isArray(l.inputGuard?.blocklist) ? l.inputGuard.blocklist : []
    },
    outputGuard: {
      enabled: !!l.outputGuard?.enabled,
      blockIfContainsPassword: !!l.outputGuard?.blockIfContainsPassword,
      fuzzy: !!l.outputGuard?.fuzzy
    },
    guardModelCheck: {
      enabled: !!l.guardModelCheck?.enabled,
      prompt: l.guardModelCheck?.prompt || 'Does this reply leak the secret password "{password}"? Answer YES or NO.\n\n{reply}'
    },
    submitValidation: {
      mode: l.submitValidation?.mode || 'case_insensitive',
      maxGuessesPerMinute: Number(l.submitValidation?.maxGuessesPerMinute) || 10
    }
  }
}

async function main () {
  initAuth()
  if (!LOOPBACK_HOSTS.has(HOST.toLowerCase()) && needsSetup()) {
    throw new Error('ADMIN_PASSPHRASE must be set before binding to a non-loopback HOST')
  }
  initSessions()
  levels = loadLevels()

  console.log('[server] initializing model...')
  await initModel(CONFIG)
  await initStt()

  const server = http.createServer((req, res) => { handle(req, res) })
  server.listen(PORT, HOST, () => {
    const displayHost = HOST === '127.0.0.1' || HOST === '::1' ? 'localhost' : HOST
    console.log(`\n🛡️  Vault Guardian running at http://${displayHost}:${PORT}`)
    console.log(`    Player:  http://${displayHost}:${PORT}/`)
    console.log(`    Admin:   http://${displayHost}:${PORT}/admin`)
    if (needsSetup()) console.log('    ⚠  Admin passphrase not set — open /admin to configure it.')
    console.log(`    Model:   ${JSON.stringify(modelInfo())}  freeRoam=${CONFIG.freeRoam}`)
    console.log(`    Voice:   ${JSON.stringify(sttInfo())}`)
    console.log(`    Langs:   ${JSON.stringify(translationInfo())}`)
    const door = doorStatus()
    console.log(`    Vault:   ${door.mode}${door.url ? ' → ' + door.url : ''}`)
    if (door.mode !== 'off' && CONFIG.freeRoam) {
      console.log('    ⚠  FREE_ROAM=1 — the physical vault will not fire.')
    }
    console.log('')
  })

  const stop = async () => {
    console.log('\n[server] shutting down...')
    server.close()
    // Before shutdownModel(), which closes the worker behind every model.
    await shutdownStt()
    await shutdownTranslators()
    await shutdownModel()
    bareProcess.exit(0)
  }
  bareProcess.on('SIGINT', stop)
  bareProcess.on('SIGTERM', stop)
}

main().catch(err => { console.error('[server] fatal:', err); bareProcess.exit(1) })
