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

// Parse a server date. freemodel sends "YYYY-MM-DD HH:MM:SS" (UTC, no zone);
// aerolink sends ISO "2026-06-09T00:00:00.000Z". Handle both.
function parseDate (s) {
  if (!s) return null
  const str = String(s)
  const d = str.includes('T') ? new Date(str) : new Date(str.replace(' ', 'T') + 'Z')
  return isNaN(d.getTime()) ? null : d
}

// Format a date string into { dateStr, days } (days remaining from now).
function fmtDate (s) {
  const d = parseDate(s)
  if (!d) return null
  const days = Math.ceil((d.getTime() - Date.now()) / 86400000)
  const dateStr = d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' })
  return { dateStr, days }
}

// Subscription period end (freemodel) with a renew/cancel/runs-out tail.
function fmtExpiry (billing) {
  if (!billing || !billing.currentPeriodEnd) return null
  const f = fmtDate(billing.currentPeriodEnd)
  if (!f) return null
  const tail = billing.cancelAtPeriodEnd
    ? 'заканчивается'
    : (billing.renewalType === 'manual' ? 'действует до' : 'продление')
  return { dateStr: f.dateStr, days: f.days, tail }
}

// Colored date span by urgency (days remaining).
function dateSpan (label, dateStr, days) {
  const color = days <= 3 ? 'var(--red)' : days <= 7 ? 'var(--amber)' : 'var(--text)'
  return `<span>${label}: <b style="color:${color}">${esc(dateStr)}</b> (${days} дн)</span>`
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

// freemodel card body: 5h/week spending bars + credits + trial expiry.
function freemodelBody (a) {
  const bars = a.usage
    ? usageBar('5 часов', a.usage.window5h) + usageBar('Неделя', a.usage.windowWeek)
    : '<p class="muted">Нет данных использования.</p>'
  const metaParts = []
  if (a.account && a.account.email) metaParts.push(`<span>${esc(a.account.email)}</span>`)
  if (a.usage) metaParts.push(`<span><b>${a.usage.totalRequests}</b> запросов</span>`)
  const exp = fmtExpiry(a.billing)
  if (exp) metaParts.push(dateSpan(exp.tail, exp.dateStr, exp.days))
  // "Available now" = bonus credits + remainder of the current 5h window.
  const win5 = a.usage && a.usage.window5h
  const windowRemainCents = win5 ? Math.max(0, win5.limitCents - win5.usedCents) : 0
  const availableCents = (a.billing ? a.billing.credits : 0) + windowRemainCents
  if (availableCents > 0) metaParts.push(`<span>кредиты: <b>${fmtCents(availableCents)}</b></span>`)
  if (a.billing && a.billing.trialExpiresAt) {
    const t = fmtDate(a.billing.trialExpiresAt)
    if (t) metaParts.push(dateSpan('trial кредиты сгорают', t.dateStr, t.days))
  }
  return `<div class="bars">${bars}</div><div class="meta">${metaParts.join('')}</div>`
}

// aerolink card body: 5h/weekly rate-limit bars (scraped from the dashboard) +
// balance + plan + today spend + trial.
function aerolinkBody (a) {
  const b = a.billing
  const bars = (a.usage && a.usage.window5h)
    ? usageBar('5 часов', a.usage.window5h) + usageBar('Неделя', a.usage.windowWeek)
    : ''
  const metaParts = []
  if (a.account && a.account.email) metaParts.push(`<span>${esc(a.account.email)}</span>`)
  if (a.usage && a.usage.totalRequests) metaParts.push(`<span><b>${a.usage.totalRequests}</b> запросов/нед</span>`)
  if (b && b.credits) metaParts.push(`<span>баланс: <b>${fmtCents(b.credits)}</b></span>`)
  if (b && b.todaySpendCents != null) metaParts.push(`<span>сегодня: <b>${fmtCents(b.todaySpendCents)}</b></span>`)
  if (b && b.apiKeyLimit) metaParts.push(`<span>ключи: <b>${b.activeApiKeys}/${b.apiKeyLimit}</b></span>`)
  if (b && b.trialExpiresAt) {
    const t = fmtDate(b.trialExpiresAt)
    if (t) metaParts.push(dateSpan('trial кредиты сгорают', t.dateStr, t.days))
  }
  return `${bars ? `<div class="bars">${bars}</div>` : ''}<div class="meta">${metaParts.join('')}</div>`
}

function cardHtml (a) {
  const loggedOut = a.fetchError === 'not-logged-in' || (!a.account && !a.usage && !a.billing)
  const planName = a.billing ? (a.billing.planName || planLabel(a.billing.planId)) : null

  let body
  if (loggedOut) {
    body = `<p class="notice">Войди в дашборд (или импортируй сессию), чтобы видеть баланс и использование.</p>`
  } else if (a.provider === 'aerolink') {
    body = aerolinkBody(a)
  } else {
    body = freemodelBody(a)
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
      <button class="btn ghost small" data-act="import" title="Вставить сессионную cookie из браузера, где ты уже залогинен">Импорт сессии</button>
      <button class="btn ghost small" data-act="refresh">⟳</button>
      <span class="spacer"></span>
      <button class="btn ghost small" data-act="edit">Изм.</button>
      <button class="btn ghost small danger" data-act="remove">Удалить</button>
    </div>
  </div>`
}

window.__fmRender = { cardHtml, cardsEl, emptyEl }
