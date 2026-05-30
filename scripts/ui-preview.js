'use strict'
// Render REAL cards (via the app's own cardHtml) with mock data, in both themes,
// and save screenshots so we can verify the actual UI.
const path = require('path')
const fs = require('fs')
const { app, BrowserWindow } = require('electron')

const ACCTS = [
  {
    id: '1', label: 'Личный', active: true, tokenHint: 'fe_oa_…3f9a', baseUrl: 'https://cc.freemodel.dev',
    usage: { window5h: { usedCents: 420, limitCents: 1000, resetsAt: Math.floor(Date.now() / 1000) + 7200 },
             windowWeek: { usedCents: 6800, limitCents: 10000, resetsAt: Math.floor(Date.now() / 1000) + 320000 },
             totalRequests: 1284 },
    billing: { planId: 'Pro', currentPeriodEnd: new Date(Date.now() + 18 * 86400000).toISOString().slice(0, 19), cancelAtPeriodEnd: false, credits: 500 },
    account: { email: 'me@example.com' }
  },
  {
    id: '2', label: 'Рабочий', active: false, tokenHint: 'fe_oa_…b1c2', baseUrl: 'https://cc.freemodel.dev',
    usage: { window5h: { usedCents: 910, limitCents: 1000, resetsAt: Math.floor(Date.now() / 1000) + 1800 },
             windowWeek: { usedCents: 3000, limitCents: 10000, resetsAt: Math.floor(Date.now() / 1000) + 400000 },
             totalRequests: 542 },
    billing: { planId: 'Max', currentPeriodEnd: new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 19), cancelAtPeriodEnd: true, credits: 0 },
    account: { email: 'work@example.com' }
  }
]

async function shot (win, theme, out) {
  await win.webContents.executeJavaScript(`(() => {
    document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)})
    const { cardHtml, cardsEl, emptyEl } = window.__fmRender
    emptyEl.classList.add('hidden')
    cardsEl.innerHTML = ${JSON.stringify(ACCTS)}.map(cardHtml).join('')
  })()`)
  await new Promise(r => setTimeout(r, 250))
  const img = await win.webContents.capturePage()
  fs.writeFileSync(out, img.toPNG())
  console.log('SAVED=' + out)
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 640, show: false, webPreferences: { contextIsolation: true } })
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'))
  await new Promise(r => setTimeout(r, 300))
  await shot(win, 'dark', path.join(__dirname, '..', 'build', 'ui-dark.png'))
  await shot(win, 'light', path.join(__dirname, '..', 'build', 'ui-light.png'))
  app.quit()
})
