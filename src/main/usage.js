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

// Strip React comment separators + tags, collapse whitespace, for scraping.
function stripHtml (html) {
  return String(html || '').replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
}

// The 5h/weekly windows aren't exposed via JSON — they're server-rendered into
// the /dashboard/usage page. These are rate-limit counters (the weekly window's
// "used" is NOT the same as weekly $ spend), so they can't be derived from logs;
// we scrape them. The label appears more than once (RSC flight data + the real
// DOM node), so we scan ALL occurrences and take the first one that actually has
// "$used / $limit" next to it — order/duplication resilient.
function parseAerolinkWindows (html) {
  const text = stripHtml(html)
  const grab = (label) => {
    let from = 0, i
    while ((i = text.indexOf(label, from)) >= 0) {
      const seg = text.slice(i, i + 200)
      const am = seg.match(/\$([0-9.]+)\s*\/\s*\$([0-9.]+)/)
      if (am) {
        const rs = seg.match(/Resets? in ([0-9]+[dhm](?:\s*[0-9]+[dhm])*)/i)
        return { usedCents: Math.round(+am[1] * 100), limitCents: Math.round(+am[2] * 100), resetsAt: 0, resetsText: rs ? rs[1].trim() : '' }
      }
      from = i + label.length
    }
    return null
  }
  const window5h = grab('5-hour window')
  const windowWeek = grab('Weekly window')
  const reqM = text.match(/([0-9][0-9.,]*)\s*Requests\s*·?\s*weekly/i)
  const totalRequests = reqM ? Number(String(reqM[1]).replace(/,/g, '')) || 0 : 0
  if (!window5h && !windowWeek) return null
  return { totalRequests, totalTokens: 0, window5h: window5h || win(), windowWeek: windowWeek || win() }
}

// Total balance ("$9.69 Total balance") is rendered with the amount BEFORE the
// label. This is the real available amount (bonus + paid); get-session's
// bonusCents misses the paid portion. Returns cents, or null. */
function parseAerolinkBalance (html) {
  const text = stripHtml(html)
  const i = text.indexOf('Total balance')
  if (i < 0) return null
  const before = text.slice(Math.max(0, i - 40), i)
  const m = before.match(/\$([0-9][0-9.,]*)\s*$/)
  if (!m) return null
  const cents = Math.round(parseFloat(m[1].replace(/,/g, '')) * 100)
  return isNaN(cents) ? null : cents
}

// Month name -> "MM", accepting full ("July") and abbreviated ("Jun") forms.
function monthNum (name) {
  const k = String(name || '').toLowerCase().slice(0, 3)
  const order = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
  const idx = order.indexOf(k)
  return idx < 0 ? null : String(idx + 1).padStart(2, '0')
}

// The plan renewal date ("Renews July 6, 2026") is server-rendered into the
// /dashboard/billing page. Parse "Month D, YYYY" into an ISO string (midnight
// UTC) so the card can show days remaining. Returns ISO string or null.
function parseAerolinkRenewal (html) {
  const text = stripHtml(html)
  const m = text.match(/Renews?\s+([A-Za-z]+)\s+([0-9]{1,2}),?\s+([0-9]{4})/i)
  if (!m) return null
  const mm = monthNum(m[1])
  if (!mm) return null
  const dd = String(m[2]).padStart(2, '0')
  return m[3] + '-' + mm + '-' + dd + 'T00:00:00.000Z'
}

// The bonus/trial expiry ("Bonus · exp. Jun 11") is on the usage page WITHOUT a
// year. get-session's starterExpiresAt is stale (observed lagging the page), so
// prefer this. Infer the year: current year, bumped to next if already past.
function parseAerolinkBonusExp (html) {
  const text = stripHtml(html)
  const m = text.match(/Bonus[^A-Za-z]*exp\.?\s*([A-Za-z]+)\s+([0-9]{1,2})/i)
  if (!m) return null
  const mm = monthNum(m[1])
  if (!mm) return null
  const dd = String(m[2]).padStart(2, '0')
  const now = new Date()
  let year = now.getUTCFullYear()
  let iso = year + '-' + mm + '-' + dd + 'T00:00:00.000Z'
  // If that date is well in the past, the expiry must be next year.
  if (new Date(iso).getTime() < now.getTime() - 2 * 86400000) {
    iso = (year + 1) + '-' + mm + '-' + dd + 'T00:00:00.000Z'
  }
  return iso
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
  const usage = usageHtml.ok ? parseAerolinkWindows(usageHtml.body) : null
  const renewal = billingHtml.ok ? parseAerolinkRenewal(billingHtml.body) : null
  // Real available balance = "Total balance" scraped from the page (bonus +
  // paid). get-session's bonusCents misses the paid portion (e.g. an account
  // whose bonus is spent but still has a top-up balance). Fall back to bonusCents.
  const scrapedBalance = usageHtml.ok ? parseAerolinkBalance(usageHtml.body) : null
  const credits = scrapedBalance != null ? scrapedBalance : (Number(user.bonusCents) || 0)
  // Prefer the page's bonus expiry over get-session's starterExpiresAt, which
  // has been observed lagging behind the live dashboard.
  const trialExpiresAt = (usageHtml.ok && parseAerolinkBonusExp(usageHtml.body)) || user.starterExpiresAt || null
  // The usage page loaded (HTTP 200) but we couldn't find the windows in it —
  // a strong signal aerolink changed the markup and the scraper needs updating.
  const windowsStale = usageHtml.ok && !usage
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

module.exports = { fetchAll, DASH_ORIGIN }
