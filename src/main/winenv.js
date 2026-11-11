'use strict'
const { spawn } = require('child_process')

// IMPORTANT: an earlier build of this app wrote ANTHROPIC_AUTH_TOKEN /
// ANTHROPIC_BASE_URL into the persistent USER environment (HKCU\Environment),
// on the mistaken theory that Claude Desktop reads the token from an env var.
// It does NOT — Desktop reads the Claude-3p gateway profile (see desktop.js).
//
// That stray env var is actively harmful: it overrides Claude CODE's
// settings.json, and CC Switch flags it as an "environment variable conflict".
// This module's only job now is to REMOVE it. Setting a USER env var to $null
// deletes the registry value and broadcasts WM_SETTINGCHANGE.

const VARS = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']

const PS_SCRIPT = VARS
  .map(v => "[Environment]::SetEnvironmentVariable('" + v + "', $null, 'User')")
  .join('; ')

// Best-effort, fire-and-forget removal of the stray USER env vars. Safe to call
// on every switch: a no-op if they're already absent.
function clearEnv () {
  if (process.platform !== 'win32') return
  try {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT],
      { detached: false, stdio: 'ignore', windowsHide: true }
    )
    child.on('error', () => {})
    child.unref()
  } catch { /* nothing actionable */ }
}

// Apply or remove HTTPS_PROXY/HTTP_PROXY at the USER scope so Claude Desktop
// (which reads system env at process start) picks up the loopback relay.
// Claude Code is handled via ~/.claude/settings.json env (see settings.js); the
// registry path here only matters for Desktop and any other tool that respects
// the env vars. Empty/null value DELETES the variables.
function runPs (script) {
  if (process.platform !== 'win32') return
  try {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { detached: false, stdio: 'ignore', windowsHide: true }
    )
    child.on('error', () => {})
    child.unref()
  } catch { /* nothing actionable */ }
}

function applyHttpsProxy (url) {
  if (!url) {
    runPs(
      "[Environment]::SetEnvironmentVariable('HTTPS_PROXY', $null, 'User'); " +
      "[Environment]::SetEnvironmentVariable('HTTP_PROXY', $null, 'User')"
    )
    return
  }
  const safe = String(url).replace(/'/g, "''")
  runPs(
    "[Environment]::SetEnvironmentVariable('HTTPS_PROXY', '" + safe + "', 'User'); " +
    "[Environment]::SetEnvironmentVariable('HTTP_PROXY', '" + safe + "', 'User')"
  )
}

function clearHttpsProxy () {
  applyHttpsProxy(null)
}

module.exports = { clearEnv, applyHttpsProxy, clearHttpsProxy }
