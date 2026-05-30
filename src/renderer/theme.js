'use strict'
// Applies the saved theme as early as possible (loaded in <head>) to avoid a
// flash of the wrong theme, and wires up the toggle button once the DOM is ready.
;(function () {
  const KEY = 'fm-theme'
  const root = document.documentElement

  function apply (theme) {
    root.setAttribute('data-theme', theme)
    const btn = document.getElementById('btn-theme')
    if (btn) {
      btn.textContent = theme === 'light' ? '☀️' : '🌙'
      btn.title = theme === 'light' ? 'Тёмная тема' : 'Светлая тема'
    }
  }

  let theme = 'dark'
  try { theme = localStorage.getItem(KEY) || 'dark' } catch (e) {}
  apply(theme)

  function toggle () {
    theme = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light'
    try { localStorage.setItem(KEY, theme) } catch (e) {}
    apply(theme)
  }

  function wire () {
    const btn = document.getElementById('btn-theme')
    if (btn) { btn.addEventListener('click', toggle); apply(theme) }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire)
  } else {
    wire()
  }
})()
