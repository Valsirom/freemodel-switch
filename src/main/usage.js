'use strict'
const { session, net } = require('electron')
const providers = require('./providers')

// Kept for backward compat (login.js historically imported it). Prefer the
// per-provider dashOrigin from providers.js.
const DASH_ORIGIN = providers.PROVIDERS.freemodel.dashOrigin

// Fetch a dashboard JSON endpoint using the cookies stored in the account's
// own persistent session partition. Returns { ok, status, data }.
function fetchJson (partition, origin, pathname) {
  return new Promise((resolve) => {
    const ses = session.fromPartition(partition)
    const request = net.request({
      method: 'GET',
      url: origin + pathname,
      session: ses,
      useSessionCookies: true
    })
    request.setHeader('Accept', 'application/json')
    let body = ''
    request.on('response', (response) => {
      response.on('data', (chunk) => { body += chunk.toString() })
      response.on('end', () => {
        let data = null
        try { data = JSON.parse(body) } catch { /* HTML fallback = not logged in */ }
        resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, data })
      })
    })
    request.on('error', (err) => resolve({ ok: false, status: 0, data: null, error: err.message }))
    request.end()
  })
}

// Fetch a page as text (for providers whose window data is server-rendered into
// HTML rather than exposed via a JSON endpoint). Returns { ok, status, body }.
function fetchText (partition, origin, pathname) {
  return new Promise((resolve) => {
    const ses = session.fromPartition(partition)
    const request = net.request({ method: 'GET', url: origin + pathname, session: ses, useSessionCookies: true })
    request.setHeader('Accept', 'text/html')
    let body = ''
    request.on('response', (response) => {
      response.on('data', (c) => { body += c.toString() })
      response.on('end', () => resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, body }))
    })
    request.on('error', () => resolve({ ok: false, status: 0, body: '' }))
    request.end()
  })
}

const loggedOut = { loggedIn: false, account: null, usage: null, billing: null }

// Dispatch to the right dashboard shape for the account's provider. Returns a
// unified { loggedIn, account, usage, billing } regardless of provider so the
// renderer can stay mostly provider-agnostic.
async function fetchAll (partition, providerId) {
  const p = providers.get(providerId)
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

// The 5h/weekly windows aren't exposed via JSON — they're server-rendered into
// the /dashboard/usage page. These are rate-limit counters (the weekly window's
// "used" is NOT the same as weekly $ spend), so they can't be derived from logs;
// we scrape them. Strip <!-- --> and tags first. We anchor on each window's
// label, then read the "$used / $limit" and "Resets in <…>" that follow it —
// order-independent, so a reshuffle of the %/label/amount order won't break it.
function parseAerolinkWindows (html) {
  const text = String(html || '').replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  const grab = (label) => {
    const i = text.indexOf(label)
    if (i < 0) return null
    const seg = text.slice(i, i + 200)
    const am = seg.match(/\$([0-9.]+)\s*\/\s*\$([0-9.]+)/)
    if (!am) return null
    const rs = seg.match(/Resets? in ([0-9]+[dhm](?:\s*[0-9]+[dhm])*)/i)
    return { usedCents: Math.round(+am[1] * 100), limitCents: Math.round(+am[2] * 100), resetsAt: 0, resetsText: rs ? rs[1].trim() : '' }
  }
  const window5h = grab('5-hour window')
  const windowWeek = grab('Weekly window')
  const reqM = text.match(/([0-9][0-9.,]*)\s*Requests\s*·?\s*weekly/i)
  const totalRequests = reqM ? Number(String(reqM[1]).replace(/,/g, '')) || 0 : 0
  if (!window5h && !windowWeek) return null
  return { totalRequests, totalTokens: 0, window5h: window5h || win(), windowWeek: windowWeek || win() }
}

const MONTHS = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12'
}

// The plan renewal date ("Renews July 6, 2026") is server-rendered into the
// /dashboard/billing page. Parse "Month D, YYYY" into an ISO string (midnight
// UTC) so the card can show days remaining. Returns ISO string or null.
function parseAerolinkRenewal (html) {
  const text = String(html || '').replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  const m = text.match(/Renews?\s+([A-Za-z]+)\s+([0-9]{1,2}),?\s+([0-9]{4})/i)
  if (!m) return null
  const mm = MONTHS[m[1].toLowerCase()]
  if (!mm) return null
  const dd = String(m[2]).padStart(2, '0')
  return m[3] + '-' + mm + '-' + dd + 'T00:00:00.000Z'
}

async function fetchAerolink (partition, p) {
  const sess = await fetchJson(partition, p.dashOrigin, '/api/auth/get-session')
  const user = sess.data && sess.data.user
  if (sess.status === 401 || !user || !user.email) return loggedOut
  const [keys, usageHtml, billingHtml] = await Promise.all([
    fetchJson(partition, p.dashOrigin, '/api/keys'),
    fetchText(partition, p.dashOrigin, '/dashboard/usage'),
    fetchText(partition, p.dashOrigin, '/dashboard/billing')
  ])
  const k = (keys.ok && keys.data) || {}
  const todaySpend = Array.isArray(k.keys)
    ? k.keys.reduce((s, x) => s + (Number(x.todaySpendCents) || 0), 0)
    : 0
  return {
    loggedIn: true,
    account: { name: user.name || '', email: user.email || '' },
    usage: usageHtml.ok ? parseAerolinkWindows(usageHtml.body) : null,
    billing: {
      planId: null,
      planName: k.planName || null,
      status: 'active',
      currentPeriodEnd: billingHtml.ok ? parseAerolinkRenewal(billingHtml.body) : null,
      cancelAtPeriodEnd: false,
      renewalType: null,
      credits: Number(user.bonusCents) || 0,
      trialExpiresAt: user.starterExpiresAt || null,
      todaySpendCents: todaySpend,
      apiKeyLimit: Number(k.apiKeyLimit) || 0,
      activeApiKeys: Number(k.activeApiKeys) || 0
    }
  }
}

module.exports = { fetchAll, DASH_ORIGIN }
