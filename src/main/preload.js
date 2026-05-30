'use strict'
const { contextBridge, ipcRenderer } = require('electron')

// Minimal, explicit IPC surface exposed to the renderer. No Node access leaks
// into the page; every privileged action goes through a named channel.
contextBridge.exposeInMainWorld('api', {
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  getActive: () => ipcRenderer.invoke('accounts:active'),
  addAccount: (data) => ipcRenderer.invoke('accounts:add', data),
  updateAccount: (id, data) => ipcRenderer.invoke('accounts:update', { id, data }),
  removeAccount: (id) => ipcRenderer.invoke('accounts:remove', id),
  switchTo: (id) => ipcRenderer.invoke('accounts:switch', id),
  switchAndRestart: (id) => ipcRenderer.invoke('accounts:switchAndRestart', id),
  login: (id) => ipcRenderer.invoke('accounts:login', id),
  importSession: (id, cookieValue) => ipcRenderer.invoke('accounts:importSession', { id, cookieValue }),
  refresh: (id) => ipcRenderer.invoke('accounts:refresh', id),
  refreshAll: () => ipcRenderer.invoke('accounts:refreshAll'),
  onChanged: (cb) => ipcRenderer.on('accounts:changed', () => cb())
})
