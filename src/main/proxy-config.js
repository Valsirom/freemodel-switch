'use strict'
const fs = require('fs')
const path = require('path')
const { app } = require('electron')

// Switcher-local preferences. Kept separate from settings.js (which owns the
// Claude Code ~/.claude/settings.json) so toggling the proxy doesn't risk
// touching anything the CLI relies on.
//
// Schema:
//   { proxyEnabled: boolean, relayPort: number }
function cfgPath () {
  return path.join(app.getPath('userData'), 'switcher-prefs.json')
}

const DEFAULT = {
  proxyEnabled: false,
  relayPort: 47822
}

function read () {
  try {
    const raw = fs.readFileSync(cfgPath(), 'utf8')
    const data = JSON.parse(raw)
    return Object.assign({}, DEFAULT, data || {})
  } catch (err) {
    if (err.code === 'ENOENT') return Object.assign({}, DEFAULT)
    return Object.assign({}, DEFAULT)
  }
}

function write (data) {
  const merged = Object.assign({}, DEFAULT, data || {})
  const tmp = cfgPath() + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8')
  fs.renameSync(tmp, cfgPath())
  return merged
}

function getProxyEnabled () {
  return !!read().proxyEnabled
}

function setProxyEnabled (enabled) {
  const cur = read()
  cur.proxyEnabled = !!enabled
  return write(cur)
}

function getRelayPort () {
  return Number(read().relayPort) || DEFAULT.relayPort
}

module.exports = {
  read, write, getProxyEnabled, setProxyEnabled, getRelayPort, cfgPath
}
