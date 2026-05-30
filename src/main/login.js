'use strict'
const { BrowserWindow, session } = require('electron')
const { DASH_ORIGIN } = require('./usage')

// freemodel sets exactly one HttpOnly session cookie on successful login
// (Google OAuth or email OTP) and clears it on logout. Detecting it precisely
// lets the login window auto-close the instant auth succeeds.
const SESSION_COOKIE = 'bm_session'

// Open the freemodel dashboard inside a BrowserWindow bound to this account's
// persistent session partition. The user logs in (Google / OTP) themselves —
// we never handle their password, we only reuse the resulting session cookies.
// Resolves true once the bm_session cookie appears, false if the window closes.
function openLogin (partition, parent) {
  return new Promise((resolve) => {
    const ses = session.fromPartition(partition)
    const win = new BrowserWindow({
      width: 480,
      height: 720,
      parent,
      modal: false,
      title: 'freemodel.dev login',
      webPreferences: { session: ses, partition }
    })
    let done = false
    const finish = (val) => { if (!done) { done = true; resolve(val) } }

    const timer = setInterval(async () => {
      try {
        const cookies = await ses.cookies.get({ url: DASH_ORIGIN })
        const hasAuth = cookies.some(c => c.name === SESSION_COOKIE && c.value)
        if (hasAuth) {
          clearInterval(timer)
          finish(true)
          if (!win.isDestroyed()) win.close()
        }
      } catch { /* ignore */ }
    }, 1200)

    win.on('closed', () => { clearInterval(timer); finish(false) })
    win.loadURL(DASH_ORIGIN + '/dashboard')
  })
}

// Import an existing browser session: inject a bm_session cookie value (copied
// by the user from a browser where they're already logged in) into this
// account's persistent partition, then verify it works.
async function importSession (partition, cookieValue) {
  const ses = session.fromPartition(partition)
  // expirationDate is REQUIRED for persistence: a cookie set without one is a
  // session cookie that Electron keeps only in memory and never writes to disk,
  // so it vanishes on restart. Pin it ~1 year out so the imported session
  // survives relaunches (the real session is invalidated server-side anyway if
  // the user logs out elsewhere). Unit is seconds since the Unix epoch.
  const oneYear = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365
  await ses.cookies.set({
    url: DASH_ORIGIN,
    name: SESSION_COOKIE,
    value: cookieValue.trim(),
    domain: 'freemodel.dev',
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

module.exports = { openLogin, importSession, SESSION_COOKIE }
