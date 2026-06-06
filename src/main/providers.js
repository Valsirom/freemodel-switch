'use strict'

// Registry of supported Claude proxy providers. Each entry knows:
//  - proxyBaseUrl: what Claude talks to (written as ANTHROPIC_BASE_URL for Code
//    and inferenceGatewayBaseUrl for Desktop). This is the ONLY thing switching
//    needs — it's provider-agnostic.
//  - dashOrigin:   where the user logs in and the dashboard data API lives.
//  - sessionCookie/cookieDomain: the session cookie to import so we can read
//    usage/billing for the card. Different per provider.
//  - api: which fetch shape usage.js should use for this provider.
const PROVIDERS = {
  freemodel: {
    id: 'freemodel',
    label: 'freemodel',
    proxyBaseUrl: 'https://cc.freemodel.dev',
    dashOrigin: 'https://freemodel.dev',
    sessionCookie: 'bm_session',
    cookieDomain: 'freemodel.dev',
    tokenPrefix: 'fe_oa_',
    api: 'freemodel'
  },
  aerolink: {
    id: 'aerolink',
    label: 'aerolink',
    proxyBaseUrl: 'https://capi.aerolink.lat',
    dashOrigin: 'https://aerolink.lat',
    // Better Auth signed session cookie. The companion __Secure-better-auth.
    // session_data cookie is NOT needed — get-session validates on the token.
    sessionCookie: '__Secure-better-auth.session_token',
    cookieDomain: 'aerolink.lat',
    tokenPrefix: 'aero_live_',
    api: 'aerolink'
  }
}

const DEFAULT_PROVIDER = 'freemodel'

// Resolve a provider config by id, falling back to the default for unknown or
// legacy (pre-multi-provider) accounts that have no provider field.
function get (id) {
  return PROVIDERS[id] || PROVIDERS[DEFAULT_PROVIDER]
}

// Lightweight list for the renderer's provider picker + import hint.
function list () {
  return Object.values(PROVIDERS).map(p => ({
    id: p.id,
    label: p.label,
    proxyBaseUrl: p.proxyBaseUrl,
    dashOrigin: p.dashOrigin,
    sessionCookie: p.sessionCookie,
    tokenPrefix: p.tokenPrefix
  }))
}

module.exports = { PROVIDERS, DEFAULT_PROVIDER, get, list }
