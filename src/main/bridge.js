'use strict'
const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { app } = require('electron')

// Localhost HTTP control plane so external tools (the tg-remote bot) can drive
// the switcher without an Electron window. Exposes the same operations as the
// IPC handlers in main.js, with a bearer token guard. Loopback-only — never
// binds a public interface.

const HOST = '127.0.0.1'
const PORT = 47821

function tokenPath () {
  return path.join(app.getPath('userData'), 'bridge.token')
}

// Random per-installation bearer secret. Written 0600-ish on first start so the
// bot can read it from the same userData dir; never logged.
function ensureToken () {
  const p = tokenPath()
  try {
    const cur = fs.readFileSync(p, 'utf8').trim()
    if (cur) return cur
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  const tok = crypto.randomBytes(32).toString('hex')
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, tok + '\n', { encoding: 'utf8', mode: 0o600 })
  return tok
}

function timingSafeEq (a, b) {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

// Read at most maxBytes of JSON body. Reject oversize requests so a runaway
// client can't pin memory.
function readJsonBody (req, maxBytes = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > maxBytes) {
        req.destroy()
        reject(new Error('payload too large'))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch (err) { reject(err) }
    })
    req.on('error', reject)
  })
}

function send (res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length
  })
  res.end(body)
}

// Routes are matched as (METHOD, /literal) or (METHOD, /accounts/:id/...).
// Tiny custom matcher — no Express dependency needed for ~10 endpoints.
function matchRoute (method, urlPath) {
  const idMatch = urlPath.match(/^\/accounts\/([a-f0-9]{4,64})(\/[a-z-]+)?$/)
  if (idMatch) {
    const id = idMatch[1]
    const sub = idMatch[2] || ''
    return { key: method + ' /accounts/:id' + sub, id }
  }
  return { key: method + ' ' + urlPath, id: null }
}

// deps are the bound functions/handlers main.js already uses, passed in so the
// bridge stays a pure transport layer.
function start (deps) {
  const {
    store, settings, providers,
    refreshOne, refreshAll, withActiveFlag,
    accountsSwitch, accountsSwitchAndRestart,
    importSession, restartClaudeDesktop
  } = deps

  const token = ensureToken()

  const handlers = {
    'GET /accounts': () => withActiveFlag(store.listPublic()),
    'GET /accounts/active': () => settings.getActive(),
    'GET /providers': () => providers.list(),
    'POST /desktop/restart': () => { restartClaudeDesktop(); return { restarting: true } },
    'POST /accounts/refresh-all': () => refreshAll(),

    'POST /accounts/:id/switch': (id) => accountsSwitch(id),
    'POST /accounts/:id/switch-and-restart': (id) => accountsSwitchAndRestart(id),
    'POST /accounts/:id/refresh': (id) => refreshOne(id),
    'POST /accounts/:id/import-session': async (id, body) => {
      if (!body || !body.cookieValue || !String(body.cookieValue).trim()) {
        throw new Error('Empty cookie value')
      }
      const acct = store.listPublic().find(a => a.id === id)
      if (!acct) throw new Error('Account not found')
      await importSession(acct.partition, body.cookieValue, acct.provider)
      return refreshOne(id)
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const auth = req.headers['authorization'] || ''
      const presented = auth.startsWith('Bearer ') ? auth.slice(7) : ''
      if (!presented || !timingSafeEq(presented, token)) {
        return send(res, 401, { error: 'unauthorized' })
      }

      const url = new URL(req.url, 'http://localhost')
      const route = matchRoute(req.method, url.pathname)
      const handler = handlers[route.key]
      if (!handler) return send(res, 404, { error: 'not found', route: route.key })

      const body = (req.method === 'POST' || req.method === 'PUT')
        ? await readJsonBody(req)
        : null
      const result = await handler(route.id, body)
      send(res, 200, { ok: true, data: result })
    } catch (err) {
      send(res, 500, { ok: false, error: err && err.message ? err.message : String(err) })
    }
  })

  server.on('error', (err) => {
    // EADDRINUSE most likely means a second switcher instance — log and move on
    // rather than crashing the UI.
    console.error('[bridge] listen error:', err.message)
  })
  server.listen(PORT, HOST, () => {
    console.log('[bridge] listening on ' + HOST + ':' + PORT)
    console.log('[bridge] token file: ' + tokenPath())
  })

  return server
}

module.exports = { start, tokenPath, PORT, HOST }
