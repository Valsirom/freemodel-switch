'use strict'

// partition -> { username, password } for authenticated upstream proxies.
// Shared by main.js (writes), usage.js (net.request 'login') and the app-level
// 'login' handler (BrowserWindow sessions), so each account answers proxy auth
// with its own credentials instead of whichever was registered first.
const byPartition = new Map()

module.exports = {
  set (partition, creds) { byPartition.set(partition, creds) },
  delete (partition) { byPartition.delete(partition) },
  get (partition) { return byPartition.get(partition) || null },
  entries () { return byPartition.entries() }
}
