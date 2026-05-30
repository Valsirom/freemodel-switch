'use strict'
const path = require('path')
const { app, BrowserWindow, ipcMain } = require('electron')
const settings = require('./settings')
const store = require('./store')
const { fetchAll } = require('./usage')
const { openLogin, importSession } = require('./login')

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
  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools({ mode: 'detach' })
}

// Mark which stored account matches the token currently in settings.json.
function withActiveFlag (accounts) {
  const active = settings.getActive()
  const activeToken = active && active.token
  return accounts.map(a => ({
    ...a,
    active: !!activeToken && store.tokenOf(a.id) === activeToken
  }))
}

// Refresh usage/billing for one account using its session cookies, caching
// the result. Returns the updated public account.
async function refreshOne (id) {
  const acct = store.listPublic().find(a => a.id === id)
  if (!acct) return null
  try {
    const res = await fetchAll(acct.partition)
    if (!res.loggedIn) {
      store.setData(id, { fetchError: 'not-logged-in' })
    } else {
      store.setData(id, { usage: res.usage, billing: res.billing, account: res.account })
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
  settings.applyAccount({ token, baseUrl: acct.baseUrl })
  notifyChanged()
  return settings.getActive()
})

ipcMain.handle('accounts:switchAndRestart', (_e, id) => {
  const token = store.tokenOf(id)
  if (!token) throw new Error('Account not found')
  const acct = store.listPublic().find(a => a.id === id)
  settings.applyAccount({ token, baseUrl: acct.baseUrl })
  // Restart Claude Code: spawn detached, then quit this app
  const { spawn } = require('child_process')
  const isWin = process.platform === 'win32'
  const cmd = isWin ? 'claude' : 'claude'
  spawn(cmd, [], { detached: true, stdio: 'ignore', shell: true }).unref()
  setTimeout(() => app.quit(), 500)
  return { restarting: true }
})

ipcMain.handle('accounts:login', async (_e, id) => {
  const acct = store.listPublic().find(a => a.id === id)
  if (!acct) throw new Error('Account not found')
  await openLogin(acct.partition, mainWindow)
  return refreshOne(id)
})

// Import a bm_session cookie copied from the user's browser, then refresh.
ipcMain.handle('accounts:importSession', async (_e, { id, cookieValue }) => {
  const acct = store.listPublic().find(a => a.id === id)
  if (!acct) throw new Error('Account not found')
  if (!cookieValue || !cookieValue.trim()) throw new Error('Empty cookie value')
  await importSession(acct.partition, cookieValue)
  return refreshOne(id)
})

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
