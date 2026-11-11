'use strict'

// Parse a user-pasted proxy string into { scheme, host, port, username, password }.
// Accepted forms:
//   [http|https://]user:pass@host:port
//   [http|https://]host:port
//   host:port:user:pass      (password may itself contain ':')
// scheme is the proxy's own transport ('https' = TLS to the proxy), default 'http'.
// Throws an Error with a user-readable message on bad input.
function parseProxy (input) {
  let s = String(input || '').trim()
  if (!s) throw new Error('Пустая строка прокси')
  let scheme = 'http'
  const m = s.match(/^(https?):\/\//i)
  if (m) { scheme = m[1].toLowerCase(); s = s.slice(m[0].length) }
  s = s.replace(/\/+$/, '')

  let host, portStr, username = '', password = ''
  const at = s.lastIndexOf('@')
  if (at >= 0) {
    const cred = s.slice(0, at)
    const hp = s.slice(at + 1).split(':')
    if (hp.length !== 2) throw new Error('Ожидается host:port после @')
    host = hp[0]; portStr = hp[1]
    const c = cred.indexOf(':')
    if (c < 0) { username = cred } else { username = cred.slice(0, c); password = cred.slice(c + 1) }
  } else {
    const parts = s.split(':')
    if (parts.length === 2) {
      host = parts[0]; portStr = parts[1]
    } else if (parts.length >= 4) {
      host = parts[0]; portStr = parts[1]; username = parts[2]; password = parts.slice(3).join(':')
    } else {
      throw new Error('Формат: host:port, host:port:user:pass или user:pass@host:port')
    }
  }
  const port = Number(portStr)
  if (!host || !/^[A-Za-z0-9.-]+$/.test(host)) throw new Error('Некорректный хост прокси')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Некорректный порт прокси')
  return { scheme, host, port, username, password }
}

module.exports = { parseProxy }
