'use strict'
const { app, session, net } = require('electron')
const fs = require('fs')
const path = require('path')
const providers = require('./providers')
const proxyCreds = require('./proxy-creds')

// Per-account on-disk cache of aerolink request logs. /api/usage only returns
// the last 50 logs and ignores all pagination params (limit/offset/cursor/page),
// so a single fetch loses anything older. We merge new logs into the cache by
// id (idempotent), then compute the 5h window over the union. Pruned to 8 days
// so the cache stays bounded.
function aerolinkCacheDir () {
  try { return path.join(app.getPath('userData'), 'aerolink-cache') } catch { return null }
}
function aerolinkCachePath (partition) {
  const dir = aerolinkCacheDir()
  if (!dir) return null
  const safe = String(partition).replace(/[^A-Za-z0-9_-]/g, '_')
  return path.join(dir, safe + '.json')
}
function loadAerolinkCache (partition) {
  const p = aerolinkCachePath(partition)
  if (!p) return { logs: {} }
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) || { logs: {} } } catch { return { logs: {} } }
}
function saveAerolinkCache (partition, cache) {
  const p = aerolinkCachePath(partition)
  if (!p) return
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify(cache))
  } catch { /* best effort */ }
}
function mergeAerolinkLogs (cache, newLogs, nowMs) {
  if (!cache.logs) cache.logs = {}
  const cutoff = (Number(nowMs) || Date.now()) - 8 * 24 * 60 * 60 * 1000
  if (Array.isArray(newLogs)) {
    for (const l of newLogs) {
      if (l && l.id) cache.logs[l.id] = l
    }
  }
  for (const id of Object.keys(cache.logs)) {
    const t = Date.parse(cache.logs[id] && cache.logs[id].createdAt)
    if (isNaN(t) || t < cutoff) delete cache.logs[id]
  }
  return cache
}

// Kept for backward compat (login.js historically imported it). Prefer the
// per-provider dashOrigin from providers.js.
const DASH_ORIGIN = providers.PROVIDERS.freemodel.dashOrigin

// Fetch a dashboard JSON endpoint using the cookies stored in the account's
// own persistent session partition. Returns { ok, status, data }. Never throws
// — proxy CONNECT failures (ERR_TUNNEL_CONNECTION_FAILED), aborts, and parse
// errors all resolve to { ok: false }.
function fetchJson (partition, origin, pathname) {
  return new Promise((resolve) => {
    let settled = false
    const done = (val) => { if (!settled) { settled = true; resolve(val) } }
    let request
    try {
      const ses = session.fromPartition(partition)
      request = net.request({
        method: 'GET',
        url: origin + pathname,
        session: ses,
        useSessionCookies: true
      })
      // Wire error/abort handlers BEFORE anything else can fire, so a synchronous
      // SimpleURLLoaderWrapper error (dead residential upstream) is caught and
      // never bubbles up as an uncaught exception.
      request.on('error', (err) => done({ ok: false, status: 0, data: null, error: err && err.message }))
      request.on('abort', () => done({ ok: false, status: 0, data: null, error: 'aborted' }))
      request.on('login', (authInfo, cb) => {
        const c = authInfo && authInfo.isProxy ? proxyCreds.get(partition) : null
        if (c && c.username) cb(c.username, c.password); else cb()
      })
      request.setHeader('Accept', 'application/json')
      let body = ''
      request.on('response', (response) => {
        response.on('error', () => done({ ok: false, status: 0, data: null, error: 'response-error' }))
        response.on('data', (chunk) => { body += chunk.toString() })
        response.on('end', () => {
          let data = null
          try { data = JSON.parse(body) } catch { /* HTML fallback = not logged in */ }
          done({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, data })
        })
      })
      request.end()
    } catch (err) {
      done({ ok: false, status: 0, data: null, error: err && err.message })
    }
  })
}

// Fetch a page as text (for providers whose window data is server-rendered into
// HTML rather than exposed via a JSON endpoint). Returns { ok, status, body }.
function fetchText (partition, origin, pathname) {
  return new Promise((resolve) => {
    let settled = false
    const done = (val) => { if (!settled) { settled = true; resolve(val) } }
    let request
    try {
      const ses = session.fromPartition(partition)
      request = net.request({ method: 'GET', url: origin + pathname, session: ses, useSessionCookies: true })
      request.on('error', () => done({ ok: false, status: 0, body: '' }))
      request.on('abort', () => done({ ok: false, status: 0, body: '' }))
      request.on('login', (authInfo, cb) => {
        const c = authInfo && authInfo.isProxy ? proxyCreds.get(partition) : null
        if (c && c.username) cb(c.username, c.password); else cb()
      })
      request.setHeader('Accept', 'text/html')
      let body = ''
      request.on('response', (response) => {
        response.on('error', () => done({ ok: false, status: 0, body: '' }))
        response.on('data', (c) => { body += c.toString() })
        response.on('end', () => done({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, body }))
      })
      request.end()
    } catch {
      done({ ok: false, status: 0, body: '' })
    }
  })
}

const loggedOut = { loggedIn: false, account: null, usage: null, billing: null }

// Dispatch to the right dashboard shape for the account's provider. Returns a
// unified { loggedIn, account, usage, billing } regardless of provider so the
// renderer can stay mostly provider-agnostic.
async function fetchAll (partition, providerId) {
  const p = providers.get(providerId)
  if (p.api === 'coarena') return fetchCoarena(partition, p)
  if (p.api === 'aerolink') return fetchAerolink(partition, p)
  return fetchFreemodel(partition, p)
}

// ---- freemodel: /api/auth/me + /api/usage + /api/billing (5h/week windows) ----

async function fetchFreemodel (partition, p) {
  const me = await fetchJson(partition, p.dashOrigin, '/api/auth/me')
  const user = me.data && me.data.user
  if (me.status === 401 || !user || !user.email) return loggedOut
  const [usage, billing] = await Promise.all([
    fetchJson(partition, p.dashOrigin, '/api/usage'),
    fetchJson(partition, p.dashOrigin, '/api/billing')
  ])
  return {
    loggedIn: true,
    account: { name: user.name || '', email: user.email || '' },
    usage: usage.ok ? normalizeUsage(usage.data) : null,
    billing: billing.ok ? normalizeFreemodelBilling(billing.data) : null
  }
}

function win (w) {
  w = w || {}
  return {
    usedCents: Number(w.usedCents) || 0,
    limitCents: Number(w.limitCents) || 0,
    resetsAt: Number(w.resetsAt) || 0
  }
}

function normalizeUsage (d) {
  d = d || {}
  return {
    totalRequests: Number(d.totalRequests) || 0,
    totalTokens: Number(d.totalTokens) || 0,
    window5h: win(d.window5h),
    windowWeek: win(d.windowWeek)
  }
}

// /api/billing nests the plan under `subscription`, credit is top-level
// `creditCents`, and signupExpiresAt is when trial credits expire.
function normalizeFreemodelBilling (d) {
  d = d || {}
  const sub = d.subscription || {}
  return {
    planId: sub.planId || 'free',
    planName: null,
    status: sub.status || 'unknown',
    currentPeriodEnd: sub.currentPeriodEnd || null,
    cancelAtPeriodEnd: !!sub.cancelAtPeriodEnd,
    renewalType: sub.renewalType || null,
    credits: Number(d.creditCents) || 0,
    trialExpiresAt: d.signupExpiresAt || null,
    todaySpendCents: null
  }
}

// ---- aerolink: Better Auth get-session (balance) + /api/keys (plan/spend) ----
// No 5h/week windows — it's a pay-from-balance model. user.bonusCents is the
// balance, user.starterExpiresAt the trial expiry, /api/keys has plan + spend.

// Rolling 5h and 7-day spend computed from the per-request log stream that
// aerolink exposes at /api/usage (JSON, not behind Cloudflare). Sum each log's
// `totalCostCents` whose `createdAt` falls in the rolling window ending now.
// Limits come from a per-plan lookup (we don't get them in JSON either).
function parseAerolinkWindowsFromLogs (logs, planName, nowMs) {
  if (!Array.isArray(logs)) return null
  const now = Number(nowMs) || Date.now()
  const FIVE_H = 5 * 60 * 60 * 1000
  const WEEK = 7 * 24 * 60 * 60 * 1000
  let fiveCents = 0
  let weekCents = 0
  let totalReqWeek = 0
  for (const l of logs) {
    const t = Date.parse(l && l.createdAt)
    if (isNaN(t)) continue
    const age = now - t
    if (age < 0) continue
    const cents = Number(l.totalCostCents) || 0
    if (age <= FIVE_H) fiveCents += cents
    if (age <= WEEK) { weekCents += cents; totalReqWeek += 1 }
  }
  const limits = aerolinkPlanLimits(planName)
  return {
    totalRequests: totalReqWeek,
    totalTokens: 0,
    window5h: { usedCents: fiveCents, limitCents: limits.fiveCents, resetsAt: 0, resetsText: '' },
    windowWeek: { usedCents: weekCents, limitCents: limits.weekCents, resetsAt: 0, resetsText: '' }
  }
}

// Plan -> rate-limit caps in cents. Filled in once LO confirms the real values
// shown on the aerolink dashboard for each plan. Zero means "limit unknown" —
// the renderer can show a bar with no fill % rather than fake a number.
function aerolinkPlanLimits (planName) {
  const k = String(planName || '').toLowerCase()
  if (k.indexOf('max20') >= 0 || k.indexOf('max 20') >= 0) return { fiveCents: 8000, weekCents: 80000 }
  if (k.indexOf('max5') >= 0 || k.indexOf('max 5') >= 0) return { fiveCents: 4000, weekCents: 40000 }
  if (k.indexOf('pro') >= 0) return { fiveCents: 800, weekCents: 20000 }
  if (k.indexOf('starter') >= 0) return { fiveCents: 1000, weekCents: 7000 }
  return { fiveCents: 0, weekCents: 0 }
}

async function fetchAerolink (partition, p) {
  const sess = await fetchJson(partition, p.dashOrigin, '/api/auth/get-session')
  const user = sess.data && sess.data.user
  if (sess.status === 401 || !user || !user.email) {
    // Diagnostics: dump what aerolink actually returned so we can tell apart
    // "401 — cookie didn't reach server" from "200 empty session" from
    // "Cloudflare interstitial HTML". Logged once per refresh per partition.
    try {
      const dir = path.join(app.getPath('userData'), 'diag')
      fs.mkdirSync(dir, { recursive: true })
      const safe = String(partition).replace(/[^A-Za-z0-9_-]/g, '_')
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        partition,
        status: sess.status,
        err: sess.error || null,
        hasData: !!sess.data,
        userEmail: user && user.email,
        bodyPreview: typeof sess.data === 'string' ? sess.data.slice(0, 400) : JSON.stringify(sess.data || {}).slice(0, 400)
      }) + '\n'
      fs.appendFileSync(path.join(dir, safe + '.log'), line)
    } catch { /* best effort */ }
    return loggedOut
  }
  // All three endpoints are JSON and unaffected by Cloudflare's challenge
  // (only the SSR'd /dashboard/* HTML pages are gated). /api/usage returns
  // {logs: [{totalCostCents, createdAt, ...}, ...]} — we derive the 5h and
  // weekly rolling windows ourselves.
  const [keys, usageLogs] = await Promise.all([
    fetchJson(partition, p.dashOrigin, '/api/keys'),
    fetchJson(partition, p.dashOrigin, '/api/usage')
  ])
  const k = (keys.ok && keys.data) || {}
  const todaySpend = Array.isArray(k.keys)
    ? k.keys.reduce((s, x) => s + (Number(x.todaySpendCents) || 0), 0)
    : 0
  const freshLogs = (usageLogs.ok && usageLogs.data && Array.isArray(usageLogs.data.logs))
    ? usageLogs.data.logs
    : null
  // Always read+merge+write the cache, even if this fetch returned nothing —
  // the cache holds prior history we still need for the windows.
  const cache = loadAerolinkCache(partition)
  if (freshLogs) {
    mergeAerolinkLogs(cache, freshLogs)
    saveAerolinkCache(partition, cache)
  }
  const allLogs = Object.values(cache.logs || {})
  const usage = allLogs.length ? parseAerolinkWindowsFromLogs(allLogs, k.planName) : null
  const renewal = null
  // get-session.bonusCents misses any paid top-up portion, but it's the only
  // value we can get without scraping the dashboard. Good enough until LO
  // tops up a card and we see the gap.
  const credits = Number(user.bonusCents) || 0
  const trialExpiresAt = user.starterExpiresAt || null
  // /api/usage returned ok but no usable logs ever accumulated — schema may
  // have changed, surface it to the UI.
  const windowsStale = usageLogs.ok && !allLogs.length
  return {
    loggedIn: true,
    account: { name: user.name || '', email: user.email || '' },
    usage,
    windowsStale,
    billing: {
      planId: null,
      planName: k.planName || null,
      status: 'active',
      currentPeriodEnd: renewal,
      cancelAtPeriodEnd: false,
      renewalType: null,
      credits,
      trialExpiresAt,
      todaySpendCents: todaySpend,
      apiKeyLimit: Number(k.apiKeyLimit) || 0,
      activeApiKeys: Number(k.activeApiKeys) || 0
    }
  }
}

// ---- coarena: /api/me/model-api/usage — single JSON with today's spend vs the
// $5/day cap, reset time (unix ms), per-model stats. Pay-nothing model: no
// balance/subscription, so billing stays null.
async function fetchCoarena (partition, p) {
  const r = await fetchJson(partition, p.dashOrigin, '/api/me/model-api/usage?range=7d')
  const d = r.data
  if (r.status === 401 || r.status === 403 || !r.ok || !d || !d.today) return loggedOut
  const t = d.today
  const limitUsd = Number(d.limits && d.limits.usd_per_day) || Number(d.default_usd_per_day) || 0
  const models = Array.isArray(d.models) ? d.models.slice().sort((a, b) => (b.spent_usd || 0) - (a.spent_usd || 0)) : []
  return {
    loggedIn: true,
    account: { name: '', email: d.email_masked || '' },
    usage: {
      totalRequests: Number(t.requests) || 0,
      totalTokens: (Number(t.input_tokens) || 0) + (Number(t.output_tokens) || 0),
      inputTokens: Number(t.input_tokens) || 0,
      outputTokens: Number(t.output_tokens) || 0,
      rpm: Number(d.limits && d.limits.requests_per_minute && d.limits.requests_per_minute.key) || 0,
      topModel: models[0] ? models[0].name : null,
      windowDay: {
        usedCents: Math.round((Number(t.spent_usd) || 0) * 100),
        limitCents: Math.round(limitUsd * 100),
        resetsAt: Math.round((Number(t.resets_at) || 0) / 1000)
      }
    },
    billing: null
  }
}

module.exports = { fetchAll, fetchJson, DASH_ORIGIN }
