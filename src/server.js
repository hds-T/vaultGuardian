// Vault Guardian — Bare HTTP server: static assets, player API, admin API.
// The password lives only here; the browser receives guarded replies and
// booleans, never the secret.
import bareProcess from 'bare-process'
if (!globalThis.process) globalThis.process = bareProcess

import http from 'bare-http1'
import fs from 'bare-fs'
import path from 'bare-path'

import { initModel, shutdownModel, modelInfo } from './qvac.js'
import { loadLevels, saveLevels, resetLevel, defaultLevels } from './levels.js'
import { runTurn, validateGuess, runInputGuard, replyLeaksPassword, runGuardModelCheck } from './guards.js'
import { initAuth, needsSetup, setupPassphrase, verifyPassphrase, verifyToken } from './auth.js'
import {
  initSessions, newSessionId, conversation, pushTurn, resetConversation,
  solvedLevels, markSolved, checkGuessLimit, isValidSessionId
} from './sessions.js'

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
  model: bareProcess.env.QVAC_MODEL || 'QWEN3_4B_INST_Q4_K_M',
  ctxSize: envNumber('QVAC_CTX', 4096),
  predict: envNumber('QVAC_PREDICT', 160),
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

// public view of a level (no password, no guard internals beyond flags)
function publicLevel (level, solved, unlocked) {
  return {
    id: level.id, name: level.name, order: level.order,
    hint: level.hint || null, solved, unlocked,
    prize: level.prize || '',
    guessesPerMinute: level.submitValidation?.maxGuessesPerMinute || 10
  }
}

function levelsForPlayer (sid) {
  const solved = solvedLevels(sid)
  const ordered = [...levels].sort((a, b) => a.order - b.order)
  return ordered.map((lvl, i) => {
    const unlocked = CONFIG.freeRoam || i === 0 || solved.has(ordered[i - 1].id)
    return publicLevel(lvl, solved.has(lvl.id), unlocked)
  })
}

function isUnlocked (sid, levelId) {
  const view = levelsForPlayer(sid).find(l => l.id === levelId)
  return view ? view.unlocked : false
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
      return json(res, 200, { levels: levelsForPlayer(sid), freeRoam: CONFIG.freeRoam, model: modelInfo() })
    }

    if (p === '/api/chat' && req.method === 'POST') {
      const sid = ensureSid(req, res)
      const body = await readBody(req)
      return chat(req, res, sid, body, false)
    }

    if (p === '/api/guess' && req.method === 'POST') {
      const sid = ensureSid(req, res)
      const { levelId, guess } = await readBody(req)
      const level = levels.find(l => l.id === levelId)
      if (!level) return json(res, 404, { error: 'no such level' })
      if (!isUnlocked(sid, levelId)) return json(res, 403, { error: 'level locked' })
      const remaining = checkGuessLimit(sid, levelId, level.submitValidation?.maxGuessesPerMinute || 10)
      if (remaining < 0) return json(res, 429, { error: 'too many guesses, slow down', remaining: 0 })
      const correct = validateGuess(level, String(guess ?? ''))
      if (correct) markSolved(sid, levelId)
      addLog({ kind: 'guess', levelId, correct })
      return json(res, 200, { correct, remaining })
    }

    if (p === '/api/reset' && req.method === 'POST') {
      const sid = ensureSid(req, res)
      const { levelId } = await readBody(req)
      resetConversation(sid, levelId)
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

    return json(res, 404, { error: 'unknown endpoint' })
  } catch (err) {
    const status = Number.isInteger(err.statusCode) ? err.statusCode : 500
    if (status === 500) console.error('[server] error:', err)
    return json(res, status, { error: status === 500 ? 'internal error' : err.message })
  }
}

// Streamed chat over SSE. `admin` bypasses the unlock gate (live preview).
async function chat (req, res, sid, body, admin) {
  const { levelId, message } = body
  const level = levels.find(l => l.id === levelId)
  if (!level) return json(res, 404, { error: 'no such level' })
  if (!admin && !isUnlocked(sid, levelId)) return json(res, 403, { error: 'level locked' })
  const msg = String(message ?? '').slice(0, 4000)
  if (!msg.trim()) return json(res, 400, { error: 'empty message' })

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })
  const write = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

  const conv = conversation(sid, levelId)
  try {
    const result = await runTurn(level, conv, msg, (tok) => write('token', { token: tok }))
    if (!result.streamed) write('message', { text: result.text })
    write('done', { blockedAt: result.blockedAt })
    pushTurn(sid, levelId, msg, result.text)
    addLog({ kind: 'chat', levelId, admin, blockedAt: result.blockedAt })
  } catch (err) {
    console.error('[chat] error:', err)
    write('error', { error: 'model error' })
  }
  res.end()
}

async function previewAttack (res, level, message) {
  const input = runInputGuard(level, message)
  const out = { input, model: null, output: null, guardModel: null, verdict: null }
  if (input.blocked) {
    out.verdict = 'BLOCKED at input guard'
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
    return json(res, 200, out)
  }
  out.guardModel = await runGuardModelCheck(level, raw)
  if (out.guardModel.leak) {
    out.verdict = 'BLOCKED at guard-model check'
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
    inputGuard: {
      enabled: !!l.inputGuard?.enabled,
      blocklist: Array.isArray(l.inputGuard?.blocklist) ? l.inputGuard.blocklist : [],
      onBlock: l.inputGuard?.onBlock || "I can't help with that request."
    },
    outputGuard: {
      enabled: !!l.outputGuard?.enabled,
      blockIfContainsPassword: !!l.outputGuard?.blockIfContainsPassword,
      fuzzy: !!l.outputGuard?.fuzzy,
      onBlock: l.outputGuard?.onBlock || '🙅 I nearly said something I shouldn\'t. Try again.'
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

  const server = http.createServer((req, res) => { handle(req, res) })
  server.listen(PORT, HOST, () => {
    const displayHost = HOST === '127.0.0.1' || HOST === '::1' ? 'localhost' : HOST
    console.log(`\n🛡️  Vault Guardian running at http://${displayHost}:${PORT}`)
    console.log(`    Player:  http://${displayHost}:${PORT}/`)
    console.log(`    Admin:   http://${displayHost}:${PORT}/admin`)
    if (needsSetup()) console.log('    ⚠  Admin passphrase not set — open /admin to configure it.')
    console.log(`    Model:   ${JSON.stringify(modelInfo())}  freeRoam=${CONFIG.freeRoam}\n`)
  })

  const stop = async () => {
    console.log('\n[server] shutting down...')
    server.close()
    await shutdownModel()
    bareProcess.exit(0)
  }
  bareProcess.on('SIGINT', stop)
  bareProcess.on('SIGTERM', stop)
}

main().catch(err => { console.error('[server] fatal:', err); bareProcess.exit(1) })
