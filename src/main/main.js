'use strict'
const path = require('path')
const { app, BrowserWindow, ipcMain } = require('electron')
const settings = require('./settings')
const store = require('./store')
const { fetchAll } = require('./usage')
const { openLogin, importSession } = require('./login')
const desktop = require('./desktop')
const winenv = require('./winenv')
const providers = require('./providers')

let mainWindow = null

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

ipcMain.handle('accounts:switch', (_e, id) => {
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
  notifyChanged()
  return settings.getActive()
})

ipcMain.handle('accounts:switchAndRestart', (_e, id) => {
  const token = store.tokenOf(id)
  if (!token) throw new Error('Account not found')
  const acct = store.listPublic().find(a => a.id === id)
  // Desktop profile is the one that actually changes the billing account; must
  // be written BEFORE the relaunch since Desktop reads it only at startup.
  const dRes = desktop.applyDesktop({ token, baseUrl: acct.baseUrl })
  settings.applyAccount({ token, baseUrl: acct.baseUrl })
  winenv.clearEnv()
  notifyChanged()
  restartClaudeDesktop()
  return { restarting: true, desktopOk: dRes.ok, desktopError: dRes.error || null }
})

ipcMain.handle('accounts:login', async (_e, id) => {
  const acct = store.listPublic().find(a => a.id === id)
  if (!acct) throw new Error('Account not found')
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

ipcMain.handle('accounts:refreshAll', async () => {
  const accts = store.listPublic()
  await Promise.all(accts.map(a => refreshOne(a.id)))
  return withActiveFlag(store.listPublic())
})

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
