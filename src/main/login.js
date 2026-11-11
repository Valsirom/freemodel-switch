'use strict'
const { BrowserWindow, session } = require('electron')
const providers = require('./providers')
const { fetchJson } = require('./usage')

// Open the provider's dashboard inside a BrowserWindow bound to this account's
// persistent session partition. The user logs in themselves — we never handle
// their password, we only reuse the resulting session cookies. Resolves true
// once the provider's session cookie appears, false if the window closes.
function openLogin (partition, parent, providerId) {
  const p = providers.get(providerId)
  return new Promise((resolve) => {
    const ses = session.fromPartition(partition)
    const win = new BrowserWindow({
      width: 480,
      height: 720,
      parent,
      modal: false,
      title: p.dashOrigin.replace(/^https?:\/\//, '') + ' login',
      webPreferences: { session: ses, partition }
    })
    let done = false
    const finish = (val) => { if (!done) { done = true; resolve(val) } }

    const timer = setInterval(async () => {
      try {
        let hasAuth
        if (p.sessionCookie) {
          const cookies = await ses.cookies.get({ url: p.dashOrigin })
          hasAuth = cookies.some(c => c.name === p.sessionCookie && c.value)
        } else {
          // No known cookie name: logged in once the usage API answers 200.
          const r = await fetchJson(partition, p.dashOrigin, p.usageProbePath)
          hasAuth = r.ok && !!r.data
        }
        if (hasAuth) {
          clearInterval(timer)
          finish(true)
          if (!win.isDestroyed()) win.close()
        }
      } catch { /* ignore */ }
    }, 1200)

    win.on('closed', () => { clearInterval(timer); finish(false) })
    win.loadURL(p.dashOrigin + (p.loginPath || '/dashboard'))
  })
}

// Import an existing browser session: inject the provider's session cookie value
// (copied by the user from a browser where they're already logged in) into this
// account's persistent partition.
async function importSession (partition, cookieValue, providerId) {
  const p = providers.get(providerId)
  if (!p.sessionCookie) throw new Error('Import by cookie is not supported for ' + p.label + ' yet — use "Войти"')
  const ses = session.fromPartition(partition)
  // expirationDate is REQUIRED for persistence: a cookie set without one is a
  // session cookie that Electron keeps only in memory and never writes to disk,
  // so it vanishes on restart. Pin it ~1 year out so the imported session
  // survives relaunches. Unit is seconds since the Unix epoch.
  const oneYear = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365
  await ses.cookies.set({
    url: p.dashOrigin,
    name: p.sessionCookie,
    value: cookieValue.trim(),
    domain: p.cookieDomain,
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    expirationDate: oneYear
  })
  // Flush to disk immediately so a crash before normal shutdown can't lose it.
  await ses.cookies.flushStore()
  return true
}

module.exports = { openLogin, importSession }
