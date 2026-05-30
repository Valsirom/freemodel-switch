'use strict'

// Wrapped in an IIFE so its top-level const bindings (cardHtml, cardsEl,
// emptyEl) don't collide with the same-named globals declared in render.js,
// which share the classic-script global lexical scope.
;(function () {
const { cardHtml, cardsEl, emptyEl } = window.__fmRender

const modal = document.getElementById('modal')
const fLabel = document.getElementById('f-label')
const fToken = document.getElementById('f-token')
const fBaseUrl = document.getElementById('f-baseurl')
const modalTitle = document.getElementById('modal-title')

let editingId = null

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

async function render () {
  const accounts = await window.api.listAccounts()
  if (!accounts.length) {
    cardsEl.innerHTML = ''
    emptyEl.classList.remove('hidden')
    return
  }
  emptyEl.classList.add('hidden')
  cardsEl.innerHTML = accounts.map(cardHtml).join('')
}

// ---- modal ----

function openModal (account) {
  editingId = account ? account.id : null
  modalTitle.textContent = account ? 'Изменить аккаунт' : 'Добавить аккаунт'
  fLabel.value = account ? account.label : ''
  fToken.value = ''
  fToken.placeholder = account ? '(оставь пустым — не менять)' : 'fe_oa_…'
  fBaseUrl.value = account ? account.baseUrl : 'https://cc.freemodel.dev'
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
let importId = null

function openImportModal (id) {
  importId = id
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
  const label = fLabel.value.trim()
  const token = fToken.value.trim()
  const baseUrl = fBaseUrl.value.trim() || 'https://cc.freemodel.dev'
  if (editingId) {
    await window.api.updateAccount(editingId, { label, baseUrl, token: token || undefined })
  } else {
    if (!token) { fToken.focus(); return }
    await window.api.addAccount({ label, token, baseUrl })
  }
  closeModal()
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
    openImportModal(id)
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

// ---- top bar ----

document.getElementById('btn-add').addEventListener('click', () => openModal(null))
document.getElementById('btn-refresh').addEventListener('click', async (e) => {
  e.target.textContent = '⟳ Обновляю…'
  await window.api.refreshAll()
  e.target.textContent = '⟳ Обновить'
  await render()
})

document.getElementById('modal-cancel').addEventListener('click', closeModal)
document.getElementById('modal-save').addEventListener('click', saveModal)
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

// Initial paint, then a background refresh of usage for all accounts.
render().then(() => window.api.refreshAll()).then(render)
})()
