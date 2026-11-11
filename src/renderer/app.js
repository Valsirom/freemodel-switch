'use strict'

// Wrapped in an IIFE so its top-level const bindings (cardHtml, cardsEl,
// emptyEl) don't collide with the same-named globals declared in render.js,
// which share the classic-script global lexical scope.
;(function () {
const { cardHtml, cardsEl, emptyEl } = window.__fmRender

const modal = document.getElementById('modal')
const fProvider = document.getElementById('f-provider')
const fLabel = document.getElementById('f-label')
const fToken = document.getElementById('f-token')
const fBaseUrl = document.getElementById('f-baseurl')
const fProxy = document.getElementById('f-proxy')
const proxyHint = document.getElementById('proxy-hint')
const proxyCheckBtn = document.getElementById('f-proxy-check')

// Render a proxy check result into the hint line under the field.
function showProxyResult (res) {
  proxyHint.classList.remove('ok', 'bad')
  if (!res || !res.ok) {
    proxyHint.textContent = 'Не удалось: ' + ((res && res.error) || 'неизвестная ошибка')
    proxyHint.classList.add('bad')
    return
  }
  const head = 'Соединение ок. IP ' + res.ip + ' (' + (res.country || '??') + ')'
  if (res.usedBy && res.usedBy.length) {
    const who = res.usedBy.map(u => u.label + (u.deleted ? ' (удалён)' : '')).join(', ')
    proxyHint.textContent = head + ' — уже использовался: ' + who
    proxyHint.classList.add('bad')
  } else {
    proxyHint.textContent = head + ' — раньше не использовался'
    proxyHint.classList.add('ok')
  }
}

proxyCheckBtn.addEventListener('click', async () => {
  proxyCheckBtn.disabled = true
  const label = proxyCheckBtn.textContent
  proxyCheckBtn.textContent = 'Проверяю…'
  proxyHint.classList.remove('ok', 'bad')
  proxyHint.textContent = ''
  try {
    const raw = fProxy.value.trim()
    // '-' means "remove" in the field; nothing to test then.
    showProxyResult(await window.api.checkProxy(raw === '-' ? '' : raw, editingId))
  } finally {
    proxyCheckBtn.textContent = label
    proxyCheckBtn.disabled = false
  }
})
const modalTitle = document.getElementById('modal-title')
const tabsEl = document.getElementById('tabs')

let editingId = null
let activeTab = null // selected provider tab

// Provider registry loaded once from the main process; keyed by id.
let providersById = {}
async function loadProviders () {
  const list = await window.api.listProviders()
  providersById = {}
  fProvider.innerHTML = ''
  for (const p of list) {
    providersById[p.id] = p
    const opt = document.createElement('option')
    opt.value = p.id
    opt.textContent = p.label
    fProvider.appendChild(opt)
  }
}

// Reflect the chosen provider in the base URL + token placeholder. Only auto-
// fills the base URL when adding (not editing, where the user's value wins).
function applyProviderToForm (autoFillBaseUrl) {
  const p = providersById[fProvider.value]
  if (!p) return
  if (autoFillBaseUrl) fBaseUrl.value = p.proxyBaseUrl
  fToken.placeholder = (p.tokenPrefix || '') + '…'
}

// ---- toast ----
const toastEl = document.getElementById('toast')
let toastTimer = null
let toastHideTimer = null

function showToast (msg, ms) {
  if (toastTimer) clearTimeout(toastTimer)
  if (toastHideTimer) clearTimeout(toastHideTimer)
  toastEl.textContent = msg
  toastEl.classList.add('accent')
  toastEl.classList.remove('hidden')
  // Force reflow so the transition runs from the hidden state.
  void toastEl.offsetWidth
  toastEl.classList.add('show')
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('show')
    toastHideTimer = setTimeout(() => toastEl.classList.add('hidden'), 200)
  }, ms || 2600)
}

// One tab per provider, with a per-tab account count. Hidden entirely until
// providers are loaded.
function renderTabs (accounts) {
  const ids = Object.keys(providersById)
  if (!ids.length) { tabsEl.innerHTML = ''; return }
  const countOf = (id) => accounts.filter(a => (a.provider || 'freemodel') === id).length
  tabsEl.innerHTML = ids.map(id => {
    const p = providersById[id]
    const cls = 'tab' + (id === activeTab ? ' active' : '')
    return `<button class="${cls}" data-tab="${id}">${p.label}<span class="count">${countOf(id)}</span></button>`
  }).join('')
}

async function render () {
  let accounts
  try {
    accounts = await window.api.listAccounts()
  } catch (err) {
    // A corrupted store now throws instead of reporting zero accounts — show
    // that plainly, otherwise it looks like the accounts simply vanished.
    cardsEl.innerHTML = ''
    tabsEl.innerHTML = ''
    emptyEl.innerHTML = `<p>Не удалось прочитать список аккаунтов.</p><p class="muted">${String(err && err.message || err)}</p>`
    emptyEl.classList.remove('hidden')
    return
  }
  // Default tab on first paint: first provider that actually has accounts,
  // else the first provider in the registry.
  if (activeTab === null) {
    const ids = Object.keys(providersById)
    activeTab = ids.find(id => accounts.some(a => (a.provider || 'freemodel') === id)) || ids[0] || 'freemodel'
  }
  renderTabs(accounts)

  const shown = accounts.filter(a => (a.provider || 'freemodel') === activeTab)
  if (!shown.length) {
    cardsEl.innerHTML = ''
    const label = providersById[activeTab] ? providersById[activeTab].label : activeTab
    emptyEl.innerHTML = accounts.length
      ? `<p>В разделе «${label}» пока нет аккаунтов.</p><p class="muted">Нажми «Добавить аккаунт» и выбери провайдер «${label}».</p>`
      : '<p>Пока нет аккаунтов.</p><p class="muted">Нажми «Добавить аккаунт» и вставь токен из настроек.</p>'
    emptyEl.classList.remove('hidden')
    return
  }
  emptyEl.classList.add('hidden')
  cardsEl.innerHTML = shown.map(cardHtml).join('')
}

// ---- modal ----

function openModal (account) {
  editingId = account ? account.id : null
  modalTitle.textContent = account ? 'Изменить аккаунт' : 'Добавить аккаунт'
  fProvider.value = (account && account.provider) || 'freemodel'
  fLabel.value = account ? account.label : ''
  fToken.value = ''
  fProxy.value = ''
  if (account && account.proxy && account.proxy.host) {
    fProxy.placeholder = '(сейчас ' + account.proxy.scheme + '://' + account.proxy.host + ':' + account.proxy.port + ' — пусто: не менять, «-»: убрать)'
  } else {
    fProxy.placeholder = 'user:pass@host:port или host:port:user:pass'
  }
  proxyHint.textContent = ''
  // Editing keeps the stored base URL; adding auto-fills from the provider.
  if (account) {
    fBaseUrl.value = account.baseUrl
    fToken.placeholder = '(оставь пустым — не менять)'
  } else {
    applyProviderToForm(true)
  }
  modal.classList.remove('hidden')
  fLabel.focus()
}

function closeModal () {
  modal.classList.add('hidden')
  editingId = null
}

// ---- import session modal ----

const importModal = document.getElementById('import-modal')
const importValue = document.getElementById('import-value')
const importError = document.getElementById('import-error')
const importHint = document.getElementById('import-hint')
let importId = null

function openImportModal (account) {
  importId = account.id
  const p = providersById[account.provider] || providersById.freemodel
  if (p) {
    const host = p.dashOrigin.replace(/^https?:\/\//, '')
    importHint.innerHTML = 'Открой <code>' + host + '</code> в браузере (где ты залогинен) → F12 → ' +
      'Application → Cookies → <code>' + host + '</code> → скопируй значение cookie ' +
      '<code>' + p.sessionCookie + '</code> и вставь сюда.'
  }
  importValue.value = ''
  importError.classList.add('hidden')
  importError.textContent = ''
  importModal.classList.remove('hidden')
  importValue.focus()
}

function closeImportModal () {
  importModal.classList.add('hidden')
  importId = null
}

async function saveImport () {
  const val = importValue.value.trim()
  if (!val) { importValue.focus(); return }
  const btn = document.getElementById('import-save')
  btn.textContent = 'Импорт…'; btn.disabled = true
  try {
    const res = await window.api.importSession(importId, val)
    if (res && res.fetchError) {
      importError.textContent = 'Сессия не подошла — возможно, значение устарело или скопировано не полностью.'
      importError.classList.remove('hidden')
      return
    }
    closeImportModal()
    await render()
  } finally {
    btn.textContent = 'Импортировать'; btn.disabled = false
  }
}

async function saveModal () {
  const provider = fProvider.value || 'freemodel'
  const label = fLabel.value.trim()
  const token = fToken.value.trim()
  const fallbackBase = (providersById[provider] && providersById[provider].proxyBaseUrl) || 'https://cc.freemodel.dev'
  const baseUrl = fBaseUrl.value.trim() || fallbackBase
  // '' field = leave proxy alone when editing / none when adding; '-' removes it.
  const proxyRaw = fProxy.value.trim()
  const proxy = proxyRaw === '' ? undefined : (proxyRaw === '-' ? '' : proxyRaw)
  let id = editingId
  try {
    if (editingId) {
      await window.api.updateAccount(editingId, { label, baseUrl, provider, token: token || undefined, proxy })
    } else {
      if (!token) { fToken.focus(); return }
      id = await window.api.addAccount({ label, token, baseUrl, provider, proxy })
      activeTab = provider // jump to the new account's tab so it's visible
    }
  } catch (err) {
    // Strip Electron's "Error invoking remote method ..." prefix.
    proxyHint.textContent = String(err && err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    return
  }
  closeModal()
  await render()
  if (proxy) await checkProxy(id)
}

// Probe the account's proxy for its exit IP/country, then tell the user.
async function checkProxy (id) {
  showToast('Проверяю прокси…', 15000)
  const res = await window.api.testProxy(id)
  if (!res || !res.ok) {
    showToast('Прокси не отвечает: ' + ((res && res.error) || 'неизвестная ошибка'), 6000)
  } else if (res.usedBy && res.usedBy.length) {
    showToast('IP ' + res.ip + ' (' + (res.country || '??') + ') уже использовался: ' + res.usedBy.map(u => u.label + (u.deleted ? ' (удалён)' : '')).join(', '), 7000)
  } else {
    showToast('Прокси ок: ' + res.ip + ' (' + (res.country || '??') + ')', 4000)
  }
  await render()
}

// ---- card actions (event delegation) ----

cardsEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]')
  if (!btn) return
  const card = e.target.closest('.card')
  const id = card && card.dataset.id
  if (!id) return
  const act = btn.dataset.act
  const accounts = await window.api.listAccounts()
  const acct = accounts.find(a => a.id === id)

  if (act === 'switch') {
    btn.textContent = '⏳'; btn.disabled = true
    showToast('Переключаю на «' + (acct ? acct.label : '') + '» и перезапускаю Claude…')
    await window.api.switchAndRestart(id)
    await render()
    // Claude desktop restarts in the background; this app stays open.
  } else if (act === 'login') {
    btn.textContent = 'Вход…'; btn.disabled = true
    await window.api.login(id)
    await render()
  } else if (act === 'import') {
    openImportModal(acct)
  } else if (act === 'refresh') {
    btn.textContent = '…'
    await window.api.refresh(id)
    await render()
  } else if (act === 'edit') {
    openModal(acct)
  } else if (act === 'remove') {
    if (confirm('Удалить аккаунт «' + acct.label + '»? Токен будет стёрт из этого приложения.')) {
      await window.api.removeAccount(id)
      await render()
    }
  }
})

// ---- tabs ----

tabsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]')
  if (!btn) return
  if (btn.dataset.tab === activeTab) return
  activeTab = btn.dataset.tab
  render()
})

// ---- top bar ----

// Proxy toggle — single global switch wired to the relay + HTTPS_PROXY env.
// Reads initial state from the main process, persists on change, then re-renders
// so the via-country badge on cards appears/disappears.
const proxyToggle = document.getElementById('proxy-toggle-input')
async function syncProxyToggle () {
  try {
    const enabled = await window.api.getProxyEnabled()
    proxyToggle.checked = !!enabled
  } catch { /* main not ready yet — leave unchecked */ }
}
proxyToggle.addEventListener('change', async () => {
  const want = proxyToggle.checked
  proxyToggle.disabled = true
  try {
    const got = await window.api.setProxyEnabled(want)
    proxyToggle.checked = !!got
    showToast(got
      ? 'Прокси включены — Claude теперь ходит через прокси активного акка'
      : 'Прокси выключены — Claude ходит напрямую')
    await render()
  } finally {
    proxyToggle.disabled = false
  }
})
syncProxyToggle()

document.getElementById('btn-add').addEventListener('click', () => openModal(null))
document.getElementById('btn-refresh').addEventListener('click', async (e) => {
  e.target.textContent = '⟳ Обновляю…'
  await window.api.refreshAll()
  e.target.textContent = '⟳ Обновить'
  await render()
})

document.getElementById('modal-cancel').addEventListener('click', closeModal)
document.getElementById('modal-save').addEventListener('click', saveModal)
fProvider.addEventListener('change', () => applyProviderToForm(!editingId))
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal() })

document.getElementById('import-cancel').addEventListener('click', closeImportModal)
document.getElementById('import-save').addEventListener('click', saveImport)
importModal.addEventListener('click', (e) => { if (e.target === importModal) closeImportModal() })
importValue.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveImport() })

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  if (!modal.classList.contains('hidden')) closeModal()
  if (!importModal.classList.contains('hidden')) closeImportModal()
})

window.api.onChanged(render)

// Load providers first (the add/edit picker needs them), then paint and refresh.
loadProviders()
  .then(render)
  .then(() => window.api.refreshAll())
  .then(render)
})()
