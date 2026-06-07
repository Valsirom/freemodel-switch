'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { app, safeStorage } = require('electron')

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

function load () {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8')
    const data = JSON.parse(raw)
    return Array.isArray(data.accounts) ? data.accounts : []
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
}

function persist (accounts) {
  const tmp = storePath() + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify({ accounts }, null, 2), 'utf8')
  fs.renameSync(tmp, storePath())
}

// Public shape returned to the renderer never includes the raw token.
function toPublic (a) {
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
    windowsStale: !!a.windowsStale
  }
}

function listPublic () {
  return load().map(toPublic)
}

function tokenOf (id) {
  const a = load().find(x => x.id === id)
  return a ? decrypt(a.token) : null
}

function tokenHint (token) {
  if (!token) return ''
  if (token.length <= 12) return token
  return token.slice(0, 8) + '…' + token.slice(-4)
}

function add ({ label, token, baseUrl, provider }) {
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
  persist(accounts)
  return id
}

function update (id, { label, token, baseUrl, provider }) {
  const accounts = load()
  const a = accounts.find(x => x.id === id)
  if (!a) return false
  if (typeof label === 'string') a.label = label
  if (typeof baseUrl === 'string') a.baseUrl = baseUrl
  if (typeof provider === 'string') a.provider = provider
  if (token) { a.token = encrypt(token); a.tokenHint = tokenHint(token) }
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
  listPublic, tokenOf, add, update, remove, setData, load, toPublic, storePath
}
