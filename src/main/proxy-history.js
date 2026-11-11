'use strict'
const fs = require('fs')
const path = require('path')
const { app } = require('electron')

// Persistent log of exit IPs ever assigned to an account, so "was this IP used
// before?" still works after an account is deleted or its proxy replaced.
// Shape: { "<ip>": [ { id, label, ts } ] }
function histPath () {
  return path.join(app.getPath('userData'), 'proxy-ip-history.json')
}

function read () {
  try { return JSON.parse(fs.readFileSync(histPath(), 'utf8')) || {} } catch { return {} }
}

function record (ip, accountId, label) {
  if (!ip) return
  const h = read()
  const list = h[ip] || (h[ip] = [])
  const cur = list.find(e => e.id === accountId)
  if (cur) { cur.label = label; cur.ts = Date.now() } else list.push({ id: accountId, label, ts: Date.now() })
  try {
    const tmp = histPath() + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(h, null, 2), 'utf8')
    fs.renameSync(tmp, histPath())
  } catch { /* best effort */ }
}

// Entries for this IP belonging to accounts other than excludeId.
function lookup (ip, excludeId) {
  return (read()[ip] || []).filter(e => e.id !== excludeId)
}

module.exports = { record, lookup }
