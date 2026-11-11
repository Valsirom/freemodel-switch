'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { app, safeStorage } = require('electron')
const { parseProxy } = require('./proxy-parse')

// Accounts live in the app's userData dir, separate from Claude Code's config.
function storePath () {
  return path.join(app.getPath('userData'), 'accounts.json')
}

// Tokens are encrypted at rest with the OS keychain (DPAPI on Windows) when
// available, so accounts.json never holds plaintext fe_oa_ tokens. Falls back
// to plaintext only if the OS refuses encryption (rare; logged to the user).
function encrypt (plain) {
  if (safeStorage.isEncryptionAvailable()) {
    return { enc: true, v: safeStorage.encryptString(plain).toString('base64') }
  }
  return { enc: false, v: plain }
}

function decrypt (field) {
  if (!field) return ''
  if (field.enc) {
    try {
      return safeStorage.decryptString(Buffer.from(field.v, 'base64'))
    } catch {
      return ''
    }
  }
  return field.v
}

function parseAccounts (file) {
  const raw = fs.readFileSync(file, 'utf8')
  const data = JSON.parse(raw)
  if (!Array.isArray(data.accounts)) throw new Error('accounts is not an array')
  return data.accounts
}

// A corrupted store must never look like "no accounts" — that used to make the
// switcher silently show an empty list while the real data was still on disk.
// Instead fall back to the rotated .bak, and if that is unusable too, move the
// bad file aside and surface a hard error.
function load () {
  const file = storePath()
  try {
    return parseAccounts(file)
  } catch (err) {
    if (err.code === 'ENOENT') return []
    const bak = file + '.bak'
    try {
      const accounts = parseAccounts(bak)
      console.error('accounts.json unreadable (' + err.message + '); using ' + bak)
      return accounts
    } catch (bakErr) {
      if (bakErr.code !== 'ENOENT') {
        console.error('accounts.json.bak also unreadable: ' + bakErr.message)
      }
    }
    const quarantine = file + '.corrupt-' + Date.now()
    try { fs.renameSync(file, quarantine) } catch {}
    throw new Error(
      'accounts.json is corrupted (' + err.message + '). Moved to ' +
      quarantine + '; no usable backup was found.'
    )
  }
}

// writeFileSync + rename alone is not crash-safe on NTFS: the rename can commit
// the new file size before the data reaches disk, leaving a full-length file of
// NUL bytes after a hard shutdown. fsync the temp file (and keep a rotated .bak)
// so a crash can cost at most the last write.
function persist (accounts) {
  const file = storePath()
  const tmp = file + '.tmp'
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeFileSync(fd, JSON.stringify({ accounts }, null, 2), 'utf8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  // Only rotate a store we could actually read — otherwise a corrupted live
  // file would overwrite the last good .bak and destroy the fallback.
  try {
    parseAccounts(file)
    fs.copyFileSync(file, file + '.bak')
  } catch {}
  fs.renameSync(tmp, file)
}

// Public shape returned to the renderer never includes the raw token.
// proxy is exposed in summary form (country/ip only) — host/port/username/
// password stay server-side; only main.js needs them via proxyOf().
function toPublic (a) {
  const summary = a.proxy
    ? {
        country: a.proxy.country || null,
        ip: a.proxy.ip || null,
        host: a.proxy.host || null,
        port: a.proxy.port || null,
        scheme: a.proxy.scheme || 'http',
        hasAuth: !!a.proxy.username
      }
    : null
  return {
    id: a.id,
    label: a.label,
    provider: a.provider || 'freemodel',
    baseUrl: a.baseUrl,
    tokenHint: a.tokenHint,
    partition: a.partition,
    usage: a.usage || null,
    billing: a.billing || null,
    account: a.account || null,
    fetchedAt: a.fetchedAt || 0,
    fetchError: a.fetchError || null,
    windowsStale: !!a.windowsStale,
    proxy: summary
  }
}

function listPublic () {
  return load().map(toPublic)
}

function tokenOf (id) {
  const a = load().find(x => x.id === id)
  return a ? decrypt(a.token) : null
}

// Full proxy record (host, port, username, password, country, ip) or null. Used
// by main.js to configure the partition's setProxy() and to point the local
// relay's upstream at the active account.
function proxyOf (id) {
  const a = load().find(x => x.id === id)
  if (!a || !a.proxy) return null
  const p = a.proxy
  if (!p.host || !p.port) return null
  return {
    host: p.host,
    port: Number(p.port) || 0,
    scheme: p.scheme === 'https' ? 'https' : 'http',
    username: p.username || '',
    // passwordEnc is ours (safeStorage); plain `password` comes from external
    // tools that write accounts.json directly.
    password: p.passwordEnc ? decrypt(p.passwordEnc) : (p.password || ''),
    country: p.country || null,
    ip: p.ip || null
  }
}

function tokenHint (token) {
  if (!token) return ''
  if (token.length <= 12) return token
  return token.slice(0, 8) + '…' + token.slice(-4)
}

// Apply a user-supplied proxy string to an account record. undefined = leave
// as is, '' = remove, otherwise parse (throws on bad input) and store with the
// password encrypted. Exit IP/country are reset; the tester fills them in.
function applyProxyInput (a, input) {
  if (input === undefined || input === null) return
  if (String(input).trim() === '') { delete a.proxy; return }
  const p = parseProxy(input)
  a.proxy = {
    scheme: p.scheme,
    host: p.host,
    port: p.port,
    username: p.username,
    passwordEnc: p.password ? encrypt(p.password) : null,
    country: null,
    ip: null
  }
}

function setProxyInfo (id, { ip, country }) {
  const accounts = load()
  const a = accounts.find(x => x.id === id)
  if (!a || !a.proxy) return
  a.proxy.ip = ip || null
  a.proxy.country = country || null
  persist(accounts)
}

function add ({ label, token, baseUrl, provider, proxy }) {
  const accounts = load()
  const id = crypto.randomBytes(6).toString('hex')
  accounts.push({
    id,
    label: label || 'Account',
    provider: provider || 'freemodel',
    token: encrypt(token),
    tokenHint: tokenHint(token),
    baseUrl: baseUrl || 'https://cc.freemodel.dev',
    partition: 'persist:acct-' + id
  })
  applyProxyInput(accounts[accounts.length - 1], proxy)
  persist(accounts)
  return id
}

function update (id, { label, token, baseUrl, provider, proxy }) {
  const accounts = load()
  const a = accounts.find(x => x.id === id)
  if (!a) return false
  if (typeof label === 'string') a.label = label
  if (typeof baseUrl === 'string') a.baseUrl = baseUrl
  if (typeof provider === 'string') a.provider = provider
  if (token) { a.token = encrypt(token); a.tokenHint = tokenHint(token) }
  applyProxyInput(a, proxy)
  persist(accounts)
  return true
}

function remove (id) {
  persist(load().filter(x => x.id !== id))
}

// Cache the last fetched usage/billing so the UI shows data instantly on
// launch before a refresh completes.
function setData (id, { usage, billing, account, fetchError, windowsStale }) {
  const accounts = load()
  const a = accounts.find(x => x.id === id)
  if (!a) return
  if (usage !== undefined) a.usage = usage
  if (billing !== undefined) a.billing = billing
  if (account !== undefined) a.account = account
  if (windowsStale !== undefined) a.windowsStale = windowsStale
  a.fetchError = fetchError || null
  a.fetchedAt = Date.now()
  persist(accounts)
}

module.exports = {
  listPublic, tokenOf, proxyOf, setProxyInfo, add, update, remove, setData, load, toPublic, storePath
}
