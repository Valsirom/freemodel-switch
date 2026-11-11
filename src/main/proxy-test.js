'use strict'
const http = require('http')
const https = require('https')
const net = require('net')

// Ask a plain-HTTP geo-IP service through the proxy, so we learn the exit IP
// and country without involving Electron sessions. Resolves {ok, ip, country}
// or {ok:false, error}. Never throws.
function testProxy (proxy) {
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    try {
      const secure = proxy.scheme === 'https'
      const headers = { Host: 'ip-api.com', Accept: 'application/json' }
      if (proxy.username) {
        headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(proxy.username + ':' + (proxy.password || '')).toString('base64')
      }
      const opts = {
        host: proxy.host,
        port: proxy.port,
        method: 'GET',
        path: 'http://ip-api.com/json/?fields=status,query,countryCode,message',
        headers,
        timeout: 15000
      }
      if (secure && !net.isIP(proxy.host)) opts.servername = proxy.host
      const req = (secure ? https : http).request(opts, (res) => {
        let body = ''
        res.on('data', (c) => { body += c })
        res.on('end', () => {
          if (res.statusCode === 407) return done({ ok: false, error: 'Прокси отклонил логин/пароль (407)' })
          try {
            const j = JSON.parse(body)
            if (j.status !== 'success') return done({ ok: false, error: j.message || 'неожиданный ответ' })
            done({ ok: true, ip: j.query, country: j.countryCode || null })
          } catch {
            // Surface the proxy's own explanation (Bright Data sends x-brd-err-msg,
            // others a short text body) instead of a bare status code.
            const why = res.headers['x-brd-err-msg'] || res.headers['x-luminati-error'] ||
              String(body).replace(/\s+/g, ' ').trim().slice(0, 160)
            done({ ok: false, error: 'HTTP ' + res.statusCode + (why ? ': ' + why : ', ответ не разобран') })
          }
        })
      })
      req.on('timeout', () => { req.destroy(); done({ ok: false, error: 'таймаут' }) })
      req.on('error', (e) => done({ ok: false, error: e && e.message }))
      req.end()
    } catch (e) {
      done({ ok: false, error: e && e.message })
    }
  })
}

module.exports = { testProxy }
