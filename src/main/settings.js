'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')

// Path to the Claude Code user settings the proxy token lives in.
const CLAUDE_DIR = path.join(os.homedir(), '.claude')
const SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json')

function readSettings () {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8')
    return JSON.parse(raw)
  } catch (err) {
    if (err.code === 'ENOENT') return {}
    throw err
  }
}

// Write settings.json atomically (temp file + rename) so a crash mid-write
// can never leave Claude Code with a half-written, unparseable config.
function writeSettings (settings) {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true })
  const tmp = SETTINGS_PATH + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, SETTINGS_PATH)
}

// Return the token/baseUrl currently active in Claude Code, or null.
function getActive () {
  const s = readSettings()
  const env = s.env || {}
  if (!env.ANTHROPIC_AUTH_TOKEN) return null
  return {
    token: env.ANTHROPIC_AUTH_TOKEN,
    baseUrl: env.ANTHROPIC_BASE_URL || ''
  }
}

// Apply an account: rewrite ONLY the two env keys we own, preserving every
// other field (statusLine, theme, custom env vars) the user may have set.
function applyAccount (account) {
  const s = readSettings()
  s.env = s.env || {}
  s.env.ANTHROPIC_AUTH_TOKEN = account.token
  s.env.ANTHROPIC_BASE_URL = account.baseUrl || 'https://cc.freemodel.dev'
  writeSettings(s)
  return getActive()
}

module.exports = { readSettings, writeSettings, getActive, applyAccount, SETTINGS_PATH }
