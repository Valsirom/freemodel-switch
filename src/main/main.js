'use strict'
const path = require('path')
const fs = require('fs')
const { app, BrowserWindow, ipcMain, session } = require('electron')
const settings = require('./settings')
const store = require('./store')
const { fetchAll } = require('./usage')
const { openLogin, importSession } = require('./login')
const desktop = require('./desktop')
const winenv = require('./winenv')
const providers = require('./providers')
const bridge = require('./bridge')
const proxyConfig = require('./proxy-config')
const relay = require('./proxy-relay')

let mainWindow = null

// Safety net: Chromium's SimpleURLLoaderWrapper can emit 'error' on the native
// side before our ClientRequest.on('error') handler is wired in — typically
// when the partition's residential proxy is dead and Chromium aborts the
// request at the URL-loader layer. Without this handler Electron shows the
// big "A JavaScript error occurred in the main process" dialog and exits,
// killing the entire switcher just because one of 17 accounts has a flaky
// proxy. Log it and move on; per-request fetches still fail-soft via their
// own error handlers and surface as fetchError on that account's card.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack || err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && reason.stack || reason)
})

function createWindow () {
  mainWindow = new BrowserWindow({
    width: 880,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    title: 'freemodel switch',
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow.removeMenu()
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
  // The Claude Desktop profile can be changed by other tools (e.g. CC Switch)
  // while we're open; re-sync the active indicator whenever the window regains
  // focus. The profile read is a cheap synchronous JSON read.
  mainWindow.on('focus', () => notifyChanged())
  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools({ mode: 'detach' })
}

// Each partition that has had setProxy applied. Keyed by partition string so we
// don't re-apply on every refresh — Chromium remembers the setting and we only
// need to re-push it if the toggle changed or the upstream changed.
const _partitionProxyState = new Map()  // partition -> { url, hasAuth }

// Apply (or clear) the account's residential proxy to its Electron session
// partition. With the toggle on and a proxy on the account, all requests issued
// from that partition (usage fetch via net.request, login BrowserWindow) leave
// through the upstream proxy. With the toggle off OR no proxy on the account,
// the partition is reset to direct.
async function applyPartitionProxy (partition, proxy) {
  const ses = session.fromPartition(partition)
  const enabled = proxyConfig.getProxyEnabled()
  const wantUrl = (enabled && proxy && proxy.host && proxy.port)
    ? 'http://' + proxy.host + ':' + proxy.port
    : ''
  const prev = _partitionProxyState.get(partition)
  if (prev && prev.url === wantUrl && !!prev.hasAuth === !!(proxy && proxy.username)) {
    return
  }

  if (wantUrl) {
    await ses.setProxy({ proxyRules: wantUrl, proxyBypassRules: '<local>' })
    // Chromium asks us for proxy creds via the global 'login' event below.
    // Tag the partition with the creds so the handler can pick the right pair.
    _partitionProxyCreds.set(partition, {
      username: proxy.username || '',
      password: proxy.password || ''
    })
  } else {
    await ses.setProxy({ proxyRules: 'direct://' })
    _partitionProxyCreds.delete(partition)
  }
  _partitionProxyState.set(partition, { url: wantUrl, hasAuth: !!(proxy && proxy.username) })
}

// Per-partition proxy credentials, consumed by the 'login' event handler below.
const _partitionProxyCreds = new Map()

// Apply proxy to a partition before any request goes through it. Pulls the
// account record and its full proxy from the store.
async function applyProxyForAccount (id) {
  const acct = store.listPublic().find(a => a.id === id)
  if (!acct) return
  const proxy = store.proxyOf(id)
  await applyPartitionProxy(acct.partition, proxy)
}

// Mark which stored account matches the token Claude Desktop will actually use.
// The desktop app reads its token from the Claude-3p gateway profile (NOT
// settings.json and NOT an env var), so that profile is the source of truth.
// Fall back to settings.json only off-Windows / when no profile exists.
function withActiveFlag (accounts) {
  const desktopToken = desktop.getActiveDesktopToken()
  const fileActive = settings.getActive()
  const activeToken = desktopToken || (fileActive && fileActive.token)
  return accounts.map(a => ({
    ...a,
    active: !!activeToken && store.tokenOf(a.id) === activeToken
  }))
}

// Restart the Claude desktop app (MSIX) cleanly, without a console window, so it
// re-reads the freemodel token from settings.json on next launch. A hidden
// PowerShell helper waits briefly (so this IPC reply is delivered first), kills
// the running Claude processes, then relaunches via the AppsFolder shell entry.
// freemodel switch itself stays open, so the (non-detached) helper survives.
//
// NOTE: do NOT pass detached:true here. On Windows that launches PowerShell in a
// new process group but the -Command payload silently never executes (verified
// empirically: 0/4 detached spawns ran the command, 3/3 non-detached ran it),
// which is exactly why the restart button appeared to "do nothing". Since this
// app stays open, a plain child with windowsHide is enough to run hidden.
function restartClaudeDesktop () {
  const { spawn } = require('child_process')
  if (process.platform !== 'win32') return
  const aumid = 'Claude_pzs8sxrjxfjjc!Claude'
  const ps = [
    'Start-Sleep -Milliseconds 1200',
    "Get-Process -Name 'Claude' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue",
    'Start-Sleep -Milliseconds 800',
    "explorer.exe 'shell:AppsFolder\\" + aumid + "'"
  ].join('; ')
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-Command', ps],
    { detached: false, stdio: 'ignore', windowsHide: true }
  )
  child.on('error', () => { /* helper failed to spawn; nothing actionable */ })
  child.unref()
}

// Refresh usage/billing for one account using its session cookies, caching
// the result. Returns the updated public account.
async function refreshOne (id) {
  const acct = store.listPublic().find(a => a.id === id)
  if (!acct) return null
  try {
    await applyProxyForAccount(id)
    const res = await fetchAll(acct.partition, acct.provider)
    if (!res.loggedIn) {
      store.setData(id, { fetchError: 'not-logged-in' })
    } else {
      store.setData(id, { usage: res.usage, billing: res.billing, account: res.account, windowsStale: !!res.windowsStale })
    }
  } catch (err) {
    store.setData(id, { fetchError: err.message })
  }
  return store.listPublic().find(a => a.id === id)
}

function notifyChanged () {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('accounts:changed')
}

ipcMain.handle('accounts:list', () => withActiveFlag(store.listPublic()))
ipcMain.handle('accounts:active', () => settings.getActive())

ipcMain.handle('accounts:add', (_e, data) => {
  const id = store.add(data)
  return id
})

ipcMain.handle('accounts:update', (_e, { id, data }) => store.update(id, data))
ipcMain.handle('accounts:remove', (_e, id) => { store.remove(id); return true })

function accountsSwitch (id) {
  const token = store.tokenOf(id)
  if (!token) throw new Error('Account not found')
  const acct = store.listPublic().find(a => a.id === id)
  // Claude Desktop reads the Claude-3p gateway profile; Claude Code reads
  // settings.json. Write both so either client picks up the account.
  desktop.applyDesktop({ token, baseUrl: acct.baseUrl })
  settings.applyAccount({ token, baseUrl: acct.baseUrl })
  // Remove the stray ANTHROPIC_AUTH_TOKEN env var an earlier build wrote to the
  // registry: it does nothing for Desktop and CC Switch flags it as an env
  // conflict that overrides Claude Code's config.
  winenv.clearEnv()
  // Point the loopback relay's upstream at this account's residential proxy.
  // Claude Code/Desktop traffic going through HTTPS_PROXY=127.0.0.1:<relay>
  // will now exit through the same residential IP this account was registered
  // under, so aerolink can't cluster all keys to one home IP.
  relay.setUpstream(store.proxyOf(id))
  notifyChanged()
  return settings.getActive()
}

function accountsSwitchAndRestart (id) {
  const token = store.tokenOf(id)
  if (!token) throw new Error('Account not found')
  const acct = store.listPublic().find(a => a.id === id)
  // Desktop profile is the one that actually changes the billing account; must
  // be written BEFORE the relaunch since Desktop reads it only at startup.
  const dRes = desktop.applyDesktop({ token, baseUrl: acct.baseUrl })
  settings.applyAccount({ token, baseUrl: acct.baseUrl })
  winenv.clearEnv()
  relay.setUpstream(store.proxyOf(id))
  notifyChanged()
  restartClaudeDesktop()
  return { restarting: true, desktopOk: dRes.ok, desktopError: dRes.error || null }
}

ipcMain.handle('accounts:switch', (_e, id) => accountsSwitch(id))
ipcMain.handle('accounts:switchAndRestart', (_e, id) => accountsSwitchAndRestart(id))

ipcMain.handle('accounts:login', async (_e, id) => {
  const acct = store.listPublic().find(a => a.id === id)
  if (!acct) throw new Error('Account not found')
  await applyProxyForAccount(id)
  await openLogin(acct.partition, mainWindow, acct.provider)
  return refreshOne(id)
})

// Import the provider's session cookie copied from the user's browser, refresh.
ipcMain.handle('accounts:importSession', async (_e, { id, cookieValue }) => {
  const acct = store.listPublic().find(a => a.id === id)
  if (!acct) throw new Error('Account not found')
  if (!cookieValue || !cookieValue.trim()) throw new Error('Empty cookie value')
  await importSession(acct.partition, cookieValue, acct.provider)
  return refreshOne(id)
})

// Provider registry for the renderer's add/edit picker.
ipcMain.handle('providers:list', () => providers.list())

ipcMain.handle('accounts:refresh', (_e, id) => refreshOne(id))

async function refreshAll () {
  const accts = store.listPublic()
  await Promise.all(accts.map(a => refreshOne(a.id)))
  return withActiveFlag(store.listPublic())
}

ipcMain.handle('accounts:refreshAll', () => refreshAll())

// ---- Proxy toggle ----
//
// Single global switch: "route Claude traffic through the active account's
// proxy". When on, accountsSwitch updates the relay's upstream and HTTPS_PROXY
// is wired into Claude Code (settings.json env) and Claude Desktop (HKCU env).
// When off, the relay still listens but tunnels direct, so existing clients
// pointing at it keep working without throwing connection errors.
ipcMain.handle('proxy:getEnabled', () => proxyConfig.getProxyEnabled())
ipcMain.handle('proxy:setEnabled', (_e, enabled) => {
  const flag = !!enabled
  proxyConfig.setProxyEnabled(flag)
  relay.setEnabled(flag)
  const port = proxyConfig.getRelayPort()
  const url = 'http://127.0.0.1:' + port
  if (flag) {
    settings.applyHttpsProxy(url)
    winenv.applyHttpsProxy(url)
  } else {
    settings.applyHttpsProxy(null)
    winenv.clearHttpsProxy()
  }
  // Re-apply partition proxies to reflect the new state.
  for (const a of store.listPublic()) applyProxyForAccount(a.id).catch(() => {})
  notifyChanged()
  return flag
})
ipcMain.handle('proxy:status', () => relay.status())

// Background refresh — aerolink's /api/usage only returns the last 50 logs and
// has no pagination, so to keep the rolling 5h cache complete we poll at least
// once a minute. Stale UI is fine; the renderer reads from the same store.
let _autoRefreshTimer = null
function startAutoRefresh () {
  if (_autoRefreshTimer) return
  _autoRefreshTimer = setInterval(() => {
    refreshAll().then(() => notifyChanged()).catch(() => { /* ignore */ })
  }, 60 * 1000)
}

// External tools (e.g. aerolink autoreger) can write accounts.json with a
// `pendingCookie` field per account — instead of asking the user to paste the
// cookie through the Import Session dialog. On startup we sweep these, import
// each cookie into the account's partition, then strip the field so the file
// stays clean and we never re-import the same cookie twice.
async function importPendingCookies () {
  let raw
  try {
    raw = fs.readFileSync(store.storePath(), 'utf8')
  } catch {
    return
  }
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    return
  }
  if (!data || !Array.isArray(data.accounts)) return

  let dirty = false
  for (const a of data.accounts) {
    if (!a.pendingCookie) continue
    try {
      await importSession(a.partition, a.pendingCookie, a.provider || 'freemodel')
      // Diagnostic: read the cookie back from the partition right after the
      // set and dump what's actually stored. Tells us whether the cookie made
      // it in with the value/domain/path we expected.
      try {
        const provId = a.provider || 'freemodel'
        const p = providers.get(provId)
        const ses = session.fromPartition(a.partition)
        const got = await ses.cookies.get({ url: p.dashOrigin, name: p.sessionCookie })
        const diagDir = path.join(app.getPath('userData'), 'diag')
        fs.mkdirSync(diagDir, { recursive: true })
        fs.appendFileSync(path.join(diagDir, 'import.log'), JSON.stringify({
          ts: new Date().toISOString(),
          label: a.label || a.id,
          partition: a.partition,
          provider: provId,
          pendingLen: (a.pendingCookie || '').length,
          pendingHead: (a.pendingCookie || '').slice(0, 16),
          readBack: got.map(c => ({
            name: c.name, domain: c.domain, path: c.path,
            secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
            valueLen: (c.value || '').length, valueHead: (c.value || '').slice(0, 16)
          }))
        }) + '\n')
      } catch { /* diag is best-effort */ }
      delete a.pendingCookie
      delete a.pendingCookieDomain
      delete a.pendingCookieName
      dirty = true
      console.log('[switcher] imported pendingCookie for', a.label || a.id)
    } catch (err) {
      console.error('[switcher] failed to import pendingCookie for',
                    a.label || a.id, err && err.message)
    }
  }
  if (dirty) {
    try {
      const tmp = store.storePath() + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify({ accounts: data.accounts }, null, 2), 'utf8')
      fs.renameSync(tmp, store.storePath())
    } catch (err) {
      console.error('[switcher] failed to persist after pendingCookie import:', err.message)
    }
  }
}

// Chromium asks for proxy credentials via the 'login' event when a request
// from a session goes through an authenticated upstream proxy. We look up the
// credentials we stashed in applyPartitionProxy for the right partition.
//
// Identifying which partition the auth request came from is awkward — Electron
// gives us a webContents (sometimes) but for net.request there's no webContents
// at all. Workaround: the residential creds are the same for every partition
// in practice (same provider, same password); we just hand the first set we
// have. If LO ever uses providers with different proxy passwords, we'll need a
// proper per-session login handler.
app.on('login', (event, webContents, details, authInfo, callback) => {
  if (!authInfo || !authInfo.isProxy) return
  let creds = null
  for (const c of _partitionProxyCreds.values()) { creds = c; break }
  if (!creds || !creds.username) return
  event.preventDefault()
  callback(creds.username, creds.password)
})

app.whenReady().then(async () => {
  await importPendingCookies()
  createWindow()

  // Bring the local proxy relay up before any account-aware request can fire.
  // It listens on 127.0.0.1:<relayPort>; Claude Code/Desktop point HTTPS_PROXY
  // at it. Initial enabled state + active account's upstream come from disk.
  await relay.start(proxyConfig.getRelayPort())
  relay.setEnabled(proxyConfig.getProxyEnabled())
  // Pick the upstream of whatever account Claude is currently set to, if any.
  try {
    const active = settings.getActive()
    if (active && active.token) {
      const acct = store.listPublic().find(a => store.tokenOf(a.id) === active.token)
      if (acct) relay.setUpstream(store.proxyOf(acct.id))
    }
  } catch { /* ignore */ }

  bridge.start({
    store, settings, providers,
    refreshOne, refreshAll, withActiveFlag,
    accountsSwitch, accountsSwitchAndRestart,
    importSession, restartClaudeDesktop
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  startAutoRefresh()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
