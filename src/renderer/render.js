'use strict'

const cardsEl = document.getElementById('cards')
const emptyEl = document.getElementById('empty')

// ---- formatting helpers ----

function fmtCents (c) {
  return '$' + (c / 100).toFixed(2)
}

// Percentage of a spend window, clamped 0..100. limit 0 = unlimited/unknown.
function pct (used, limit) {
  if (!limit || limit <= 0) return 0
  return Math.min(100, Math.round((used / limit) * 100))
}

function barClass (p) {
  if (p >= 90) return 'crit'
  if (p >= 70) return 'warn'
  return ''
}

// resetsAt is a unix-seconds timestamp; show a short relative "resets in".
function fmtResets (ts) {
  if (!ts) return ''
  const ms = ts * 1000 - Date.now()
  if (ms <= 0) return 'сброс скоро'
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  if (h >= 24) return 'сброс через ' + Math.floor(h / 24) + ' дн'
  if (h > 0) return 'сброс через ' + h + ' ч'
  return 'сброс через ' + m + ' мин'
}

// currentPeriodEnd comes as "YYYY-MM-DD HH:MM:SS" in UTC (no zone). Convert the
// space to "T" and append "Z" to parse. Show date + days remaining; the tail
// reflects whether it renews, cancels, or just runs out (manual renewal).
function fmtExpiry (billing) {
  if (!billing || !billing.currentPeriodEnd) return null
  const end = new Date(String(billing.currentPeriodEnd).replace(' ', 'T') + 'Z')
  if (isNaN(end.getTime())) return null
  const days = Math.ceil((end.getTime() - Date.now()) / 86400000)
  const dateStr = end.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' })
  const tail = billing.cancelAtPeriodEnd
    ? 'заканчивается'
    : (billing.renewalType === 'manual' ? 'действует до' : 'продление')
  return { dateStr, days, tail }
}

const PLAN_NAMES = { free: 'Free', pro: 'Pro', pro_plus: 'Pro+', max: 'Max', ultra: 'Ultra', power: 'Power' }
function planLabel (id) {
  if (!id) return null
  return PLAN_NAMES[id] || (id.charAt(0).toUpperCase() + id.slice(1))
}

function esc (s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ))
}

// ---- rendering ----

function usageBar (label, w) {
  const p = pct(w.usedCents, w.limitCents)
  const limitStr = w.limitCents > 0 ? fmtCents(w.limitCents) : '∞'
  const resets = fmtResets(w.resetsAt)
  return `
    <div class="bar-row">
      <div class="bar-label">
        <span>${esc(label)}</span>
        <span>${fmtCents(w.usedCents)} / ${limitStr}${resets ? ' · ' + resets : ''}</span>
      </div>
      <div class="bar-track"><div class="bar-fill ${barClass(p)}" style="width:${p}%"></div></div>
    </div>`
}

function cardHtml (a) {
  const loggedOut = a.fetchError === 'not-logged-in' || (!a.usage && !a.account)
  const exp = fmtExpiry(a.billing)
  const planName = a.billing ? planLabel(a.billing.planId) : null

  let body
  if (loggedOut) {
    body = `<p class="notice">Войди в дашборд, чтобы видеть использование и подписку.</p>`
  } else {
    const bars = a.usage
      ? usageBar('5 часов', a.usage.window5h) + usageBar('Неделя', a.usage.windowWeek)
      : '<p class="muted">Нет данных использования.</p>'
    const metaParts = []
    if (a.account && a.account.email) metaParts.push(`<span>${esc(a.account.email)}</span>`)
    if (a.usage) metaParts.push(`<span><b>${a.usage.totalRequests}</b> запросов</span>`)
    if (exp) {
      const color = exp.days <= 3 ? 'var(--red)' : exp.days <= 7 ? 'var(--amber)' : 'var(--text)'
      metaParts.push(`<span>${exp.tail}: <b style="color:${color}">${esc(exp.dateStr)}</b> (${exp.days} дн)</span>`)
    }
    // "Available now" on the dashboard = bonus credits + whatever is left in the
    // current 5-hour window (limit − used). Showing only creditCents under-reports
    // when the 5h window isn't fully spent (it just happens to match when it is).
    const win5 = a.usage && a.usage.window5h
    const windowRemainCents = win5 ? Math.max(0, win5.limitCents - win5.usedCents) : 0
    const availableCents = (a.billing ? a.billing.credits : 0) + windowRemainCents
    if (availableCents > 0) metaParts.push(`<span>кредиты: <b>${fmtCents(availableCents)}</b></span>`)
    body = `<div class="bars">${bars}</div><div class="meta">${metaParts.join('')}</div>`
  }

  const planBadge = planName ? `<span class="badge plan">${esc(planName)}</span>` : ''
  const activeBadge = a.active ? '<span class="badge active">активен</span>' : ''

  return `
  <div class="card ${a.active ? 'active' : ''}" data-id="${a.id}">
    <div class="card-head">
      <div>
        <div class="card-title">${esc(a.label)}</div>
        <div class="card-sub">${esc(a.tokenHint)} · ${esc(a.baseUrl)}</div>
      </div>
      <div style="display:flex;gap:6px;align-items:center">${planBadge}${activeBadge}</div>
    </div>
    ${body}
    <div class="card-foot">
      <button class="btn ${a.active ? 'primary' : 'ghost'} small" data-act="switch" ${a.active ? 'disabled' : ''} title="${a.active ? 'Активный аккаунт' : 'Переключить и перезапустить Claude Code'}">
        ${a.active ? '●' : '▶'}
      </button>
      <button class="btn ghost small" data-act="login">Войти</button>
      <button class="btn ghost small" data-act="import" title="Вставить cookie bm_session из браузера, где ты уже залогинен">Импорт сессии</button>
      <button class="btn ghost small" data-act="refresh">⟳</button>
      <span class="spacer"></span>
      <button class="btn ghost small" data-act="edit">Изм.</button>
      <button class="btn ghost small danger" data-act="remove">Удалить</button>
    </div>
  </div>`
}

window.__fmRender = { cardHtml, cardsEl, emptyEl }
