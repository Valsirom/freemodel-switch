'use strict'
const { session, net } = require('electron')

const DASH_ORIGIN = 'https://freemodel.dev'

// Fetch a dashboard JSON endpoint using the cookies stored in the account's
// own persistent session partition. Returns { ok, status, data }.
function fetchJson (partition, pathname) {
  return new Promise((resolve) => {
    const ses = session.fromPartition(partition)
    const request = net.request({
      method: 'GET',
      url: DASH_ORIGIN + pathname,
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

// Pull auth + usage + billing for one account. /api/auth/me returns
// {user: {...}} when logged in, or {user: null} (HTTP 200) when not.
async function fetchAll (partition) {
  const me = await fetchJson(partition, '/api/auth/me')
  const user = me.data && me.data.user
  if (me.status === 401 || !user || !user.email) {
    return { loggedIn: false, account: null, usage: null, billing: null }
  }
  const [usage, billing] = await Promise.all([
    fetchJson(partition, '/api/usage'),
    fetchJson(partition, '/api/billing')
  ])
  return {
    loggedIn: true,
    account: { name: user.name || '', email: user.email || '' },
    usage: usage.ok ? normalizeUsage(usage.data) : null,
    billing: billing.ok ? normalizeBilling(billing.data) : null
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

// Real /api/billing nests the plan under `subscription` and reports credit as
// top-level `creditCents`. currentPeriodEnd is "YYYY-MM-DD HH:MM:SS" UTC.
// signupExpiresAt (also "YYYY-MM-DD HH:MM:SS" UTC) is when trial/signup credits expire.
function normalizeBilling (d) {
  d = d || {}
  const sub = d.subscription || {}
  return {
    planId: sub.planId || 'free',
    status: sub.status || 'unknown',
    currentPeriodEnd: sub.currentPeriodEnd || null,
    cancelAtPeriodEnd: !!sub.cancelAtPeriodEnd,
    renewalType: sub.renewalType || null,
    credits: Number(d.creditCents) || 0,
    signupExpiresAt: d.signupExpiresAt || null
  }
}

module.exports = { fetchAll, DASH_ORIGIN }
