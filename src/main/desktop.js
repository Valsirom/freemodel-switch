'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')

// How Claude DESKTOP reads its token (this is the real source of truth, proven
// empirically: the live claude.exe carried exactly the token written here):
//
//   %LOCALAPPDATA%\Claude-3p\configLibrary\<appliedId>.json
//       { "inferenceProvider": "gateway",
//         "inferenceGatewayAuthScheme": "bearer",
//         "inferenceGatewayApiKey":  <token>,
//         "inferenceGatewayBaseUrl": <host> }
//   %LOCALAPPDATA%\Claude-3p\configLibrary\_meta.json -> { appliedId, entries }
//   %LOCALAPPDATA%\Claude\claude_desktop_config.json  -> { deploymentMode:"3p" }
//
// This is COMPLETELY separate from Claude Code (CLI), which reads
// ~/.claude/settings.json -> env.ANTHROPIC_AUTH_TOKEN. Writing settings.json or
// an ANTHROPIC_AUTH_TOKEN env var does NOTHING for the desktop app. Desktop
// reads this profile only at startup, so a switch must be followed by a restart.

function localAppData () {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
}
const c3pDir = () => path.join(localAppData(), 'Claude-3p')
const cfgLibDir = () => path.join(c3pDir(), 'configLibrary')
const metaPath = () => path.join(cfgLibDir(), '_meta.json')
const claudeCfgPath = () => path.join(localAppData(), 'Claude', 'claude_desktop_config.json')
const c3pCfgPath = () => path.join(c3pDir(), 'claude_desktop_config.json')

// Used only when no profile is currently applied; if one already is (e.g. left
// by CC Switch), we adopt it so the change takes effect on the exact file the
// app already reads.
const FALLBACK_PROFILE_ID = '0f3ee770-0000-4000-8000-000000000001'

function stripScheme (u) {
  return String(u || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '')
}

function readJson (p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

function writeJsonAtomic (p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, p)
}

// Write the account's token into the applied Claude Desktop gateway profile.
// Returns { ok, error, profileId }.
function applyDesktop (account) {
  if (process.platform !== 'win32') return { ok: false, error: 'not-windows' }
  try {
    const meta = readJson(metaPath()) || {}
    let appliedId = meta.appliedId
    const entries = Array.isArray(meta.entries) ? meta.entries : []

    // Adopt the currently-applied profile if its file exists; otherwise create
    // our own and mark it applied.
    let profilePath = appliedId ? path.join(cfgLibDir(), appliedId + '.json') : null
    if (!appliedId || !fs.existsSync(profilePath)) {
      appliedId = FALLBACK_PROFILE_ID
      profilePath = path.join(cfgLibDir(), appliedId + '.json')
      if (!entries.find(e => e && e.id === appliedId)) {
        entries.push({ id: appliedId, name: 'freemodel switch' })
      }
    }

    const profile = readJson(profilePath) || {}
    profile.inferenceProvider = 'gateway'
    profile.inferenceGatewayAuthScheme = 'bearer'
    profile.inferenceGatewayApiKey = account.token
    profile.inferenceGatewayBaseUrl = stripScheme(account.baseUrl || 'https://cc.freemodel.dev')
    // Match the defaults a working CC Switch profile carries, without clobbering
    // any the user/profile already has.
    if (profile.coworkEgressAllowedHosts === undefined) profile.coworkEgressAllowedHosts = ['*']
    if (profile.disableDeploymentModeChooser === undefined) profile.disableDeploymentModeChooser = true

    writeJsonAtomic(profilePath, profile)
    writeJsonAtomic(metaPath(), { appliedId, entries })

    // The gateway key only matters when Desktop is in 3p deployment mode; ensure
    // it, preserving every other key in those config files.
    for (const cfgPath of [claudeCfgPath(), c3pCfgPath()]) {
      const cfg = readJson(cfgPath) || {}
      if (cfg.deploymentMode !== '3p') {
        cfg.deploymentMode = '3p'
        writeJsonAtomic(cfgPath, cfg)
      }
    }
    return { ok: true, profileId: appliedId }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

// The token the desktop app will actually use on next launch, or null. Cheap
// synchronous read of a small JSON file.
function getActiveDesktopToken () {
  if (process.platform !== 'win32') return null
  const meta = readJson(metaPath())
  if (!meta || !meta.appliedId) return null
  const profile = readJson(path.join(cfgLibDir(), meta.appliedId + '.json'))
  return (profile && profile.inferenceGatewayApiKey) || null
}

module.exports = { applyDesktop, getActiveDesktopToken }
