'use strict'
const http = require('http')
const net = require('net')

// Local HTTP/HTTPS forward proxy that lives inside the switcher process.
// Claude Desktop / Claude Code point HTTPS_PROXY at it (e.g. 127.0.0.1:47822)
// and never move from there. The relay decides per-connection where to send
// the traffic:
//   - tunnelling enabled  + upstream set  → tunnel through the upstream proxy
//                                            of the currently active account,
//                                            with Proxy-Authorization for it
//   - tunnelling disabled OR no upstream  → connect directly to the target,
//                                            no proxy involved
//
// Switching accounts in the UI updates `currentUpstream` here; the next request
// from Claude picks up the new upstream automatically. No client restart needed.
//
// Loopback-only. Never binds to a routable interface.

const HOST = '127.0.0.1'

let server = null
let listeningPort = 0
let currentUpstream = null  // {host, port, username, password} | null
let enabled = false

function setEnabled (flag) {
  enabled = !!flag
}

function isEnabled () {
  return enabled
}

function setUpstream (proxy) {
  if (!proxy || !proxy.host || !proxy.port) {
    currentUpstream = null
    return
  }
  currentUpstream = {
    host: String(proxy.host),
    port: Number(proxy.port),
    username: proxy.username || '',
    password: proxy.password || ''
  }
}

function getUpstream () {
  return currentUpstream ? { host: currentUpstream.host, port: currentUpstream.port } : null
}

function authHeader () {
  if (!currentUpstream || !currentUpstream.username) return ''
  const raw = currentUpstream.username + ':' + currentUpstream.password
  return 'Basic ' + Buffer.from(raw).toString('base64')
}

// Pipe two sockets to each other and clean up on any teardown. Errors are
// swallowed — they're routine when one side closes mid-stream.
function bridgeSockets (a, b) {
  const done = () => {
    try { a.destroy() } catch { /* */ }
    try { b.destroy() } catch { /* */ }
  }
  a.on('error', done)
  b.on('error', done)
  a.on('end', done)
  b.on('end', done)
  a.pipe(b)
  b.pipe(a)
}

// HTTPS connection: client sends CONNECT host:port. We either tunnel through
// the upstream proxy (account proxy) or connect direct.
function handleConnect (req, clientSocket, head) {
  const [host, portStr] = String(req.url || '').split(':')
  const port = Number(portStr) || 443
  if (!host) {
    clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    return
  }

  const useUpstream = enabled && currentUpstream

  if (useUpstream) {
    const upstream = net.connect(currentUpstream.port, currentUpstream.host, () => {
      const lines = [
        'CONNECT ' + host + ':' + port + ' HTTP/1.1',
        'Host: ' + host + ':' + port
      ]
      const auth = authHeader()
      if (auth) lines.push('Proxy-Authorization: ' + auth)
      lines.push('Proxy-Connection: keep-alive')
      lines.push('')
      lines.push('')
      upstream.write(lines.join('\r\n'))
    })

    // Read upstream's reply to our CONNECT, expect "200 ...". Then pipe.
    let preamble = ''
    const onPreambleData = (chunk) => {
      preamble += chunk.toString('binary')
      const idx = preamble.indexOf('\r\n\r\n')
      if (idx === -1) return
      upstream.off('data', onPreambleData)
      const statusLine = preamble.split('\r\n')[0] || ''
      const ok = / 2\d\d /.test(statusLine)
      if (!ok) {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
        upstream.destroy()
        return
      }
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      // If the upstream sent extra bytes past the preamble end, forward them
      // before bridging (rare with CONNECT but possible).
      const extra = Buffer.from(preamble.slice(idx + 4), 'binary')
      if (extra.length) clientSocket.write(extra)
      if (head && head.length) upstream.write(head)
      bridgeSockets(clientSocket, upstream)
    }
    upstream.on('data', onPreambleData)
    upstream.on('error', () => {
      try { clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n') } catch { /* */ }
    })
  } else {
    // Direct: connect target server, send 200, bridge.
    const target = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head && head.length) target.write(head)
      bridgeSockets(clientSocket, target)
    })
    target.on('error', () => {
      try { clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n') } catch { /* */ }
    })
  }

  clientSocket.on('error', () => { /* swallow */ })
}

// Plain HTTP requests come through as proxied requests (full URL in req.url).
// Claude API is HTTPS only, so this path is mostly a courtesy for tools that
// might point at the relay for other things.
function handleHttp (req, res) {
  const target = (() => {
    try { return new URL(req.url) } catch { return null }
  })()
  if (!target) {
    res.writeHead(400)
    res.end('bad request')
    return
  }

  const useUpstream = enabled && currentUpstream
  const opts = {
    method: req.method,
    headers: Object.assign({}, req.headers)
  }

  if (useUpstream) {
    // Send the request to the upstream proxy with the absolute URL — that's
    // how HTTP forward proxies expect to receive plain-HTTP requests.
    opts.host = currentUpstream.host
    opts.port = currentUpstream.port
    opts.path = req.url
    const auth = authHeader()
    if (auth) opts.headers['Proxy-Authorization'] = auth
  } else {
    opts.host = target.hostname
    opts.port = target.port || 80
    opts.path = target.pathname + target.search
    opts.headers.host = target.host
    delete opts.headers['proxy-connection']
    delete opts.headers['proxy-authorization']
  }

  const outbound = http.request(opts, (upRes) => {
    res.writeHead(upRes.statusCode || 502, upRes.headers)
    upRes.pipe(res)
  })
  outbound.on('error', () => {
    try {
      res.writeHead(502)
      res.end('bad gateway')
    } catch { /* */ }
  })
  req.pipe(outbound)
}

function start (port) {
  if (server) return { port: listeningPort }
  server = http.createServer(handleHttp)
  server.on('connect', handleConnect)
  server.on('error', (err) => {
    console.error('[proxy-relay] error:', err && err.message)
  })

  return new Promise((resolve) => {
    server.listen(port, HOST, () => {
      const addr = server.address()
      listeningPort = (addr && addr.port) || port
      console.log('[proxy-relay] listening on ' + HOST + ':' + listeningPort)
      resolve({ port: listeningPort })
    })
  })
}

function stop () {
  return new Promise((resolve) => {
    if (!server) return resolve()
    server.close(() => {
      server = null
      listeningPort = 0
      resolve()
    })
  })
}

function status () {
  return {
    listening: !!server,
    port: listeningPort,
    enabled,
    upstream: getUpstream()
  }
}

module.exports = {
  start, stop, status,
  setEnabled, isEnabled,
  setUpstream, getUpstream,
  HOST
}
