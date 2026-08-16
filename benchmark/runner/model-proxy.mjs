/**
 * Allowlist CONNECT proxy for benchmark runs (PLAN 5.6).
 *
 * The benchmark run environment strips host proxy variables, so the agent's
 * `bash` cannot tunnel anywhere. But the model provider must be reachable —
 * on hosts where the provider is only reachable through a proxy (e.g. WSL
 * behind 127.0.0.1:7890), this tiny proxy is injected as the run's
 * HTTP(S)_PROXY and forwards ONLY allowlisted hosts, chaining to an
 * upstream proxy when set. Everything else gets 403.
 *
 * usage: PORT=8787 UPSTREAM_PROXY=http://127.0.0.1:7890 \
 *        MODEL_PROXY_ALLOW=opencode.ai node model-proxy.mjs
 * @module orcana-benchmark/model-proxy
 */

import http from 'node:http'
import net from 'node:net'
import { URL } from 'node:url'

/** Default allowlist: model provider hosts (overridable via MODEL_PROXY_ALLOW). */
export const DEFAULT_ALLOWED_HOSTS = Object.freeze([
  'opencode.ai',
  'api.deepseek.com',
  'api.openai.com',
  'api.anthropic.com',
  'openrouter.ai',
])

/** True when the host is on the allowlist (exact or subdomain). */
export function hostAllowed(host, allowed = DEFAULT_ALLOWED_HOSTS) {
  const h = String(host).toLowerCase()
  return allowed.some(entry => h === entry || h.endsWith(`.${entry}`))
}

/** Parse an upstream proxy URL into { host, port }. */
export function parseUpstream(url) {
  if (url === undefined || url === '') return undefined
  const parsed = new URL(url)
  return {
    host: parsed.hostname,
    port: parsed.port !== '' ? Number(parsed.port) : 8080,
  }
}

/**
 * One CONNECT request: allowlist the target, then tunnel — directly, or
 * through the upstream proxy (upstream CONNECT, then pipe). Errors kill the
 * client connection with a plain text reply.
 */
export function handleConnect(req, client, head, { allowed = DEFAULT_ALLOWED_HOSTS, upstream } = {}) {
  const target = req.url ?? ''
  const separator = target.lastIndexOf(':')
  const host = separator >= 0 ? target.slice(0, separator) : target
  const port = separator >= 0 ? Number(target.slice(separator + 1)) : 443
  const fail = (code, message) => {
    client.write(`HTTP/1.1 ${code} ${message}\r\n\r\n`)
    client.end()
  }
  if (!hostAllowed(host, allowed)) {
    fail(403, 'Forbidden')
    return
  }
  const targetSocket = net.connect(port, host)
  targetSocket.once('connect', () => {
    if (upstream === undefined) {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head && head.length > 0) targetSocket.write(head)
      targetSocket.pipe(client)
      client.pipe(targetSocket)
      return
    }
    // Chain through the upstream proxy: CONNECT it first, then forward both
    // directions manually (no pipe — mixing a data listener with pipe()
    // would forward every chunk twice and corrupt TLS records).
    const up = net.connect(upstream.port, upstream.host)
    up.once('connect', () => {
      up.write(`CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\n\r\n`)
      let buffered = Buffer.alloc(0)
      let established = false
      const onData = (chunk) => {
        if (!established) {
          buffered = Buffer.concat([buffered, chunk])
          const end = buffered.indexOf('\r\n\r\n')
          if (end < 0) return
          const statusLine = buffered.slice(0, buffered.indexOf('\r\n')).toString()
          const status = Number(statusLine.split(' ')[1])
          if (status < 200 || status >= 300) {
            fail(status, 'UpstreamRefused')
            up.destroy()
            return
          }
          established = true
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          const rest = buffered.slice(end + 4)
          if (rest.length > 0) client.write(rest)
          if (head && head.length > 0) up.write(head)
          return
        }
        client.write(chunk)
      }
      up.on('data', onData)
      client.on('data', (chunk) => up.write(chunk))
      up.on('error', () => client.destroy())
      client.on('error', () => up.destroy())
    })
    up.on('error', () => fail(502, 'UpstreamUnreachable'))
  })
  targetSocket.on('error', () => fail(502, 'TargetUnreachable'))
  client.on('error', () => targetSocket.destroy())
}

/** Start the proxy server. */
export function createProxyServer({ port = Number(process.env.PORT ?? 8787), allowed, upstream } = {}) {
  const server = http.createServer((req, res) => {
    res.writeHead(405, { 'content-type': 'text/plain' })
    res.end('model-proxy: CONNECT only\n')
  })
  const resolvedAllowed = allowed ?? (process.env.MODEL_PROXY_ALLOW?.split(',').map(s => s.trim()).filter(Boolean) ?? DEFAULT_ALLOWED_HOSTS)
  const resolvedUpstream = upstream ?? parseUpstream(process.env.UPSTREAM_PROXY)
  server.on('connect', (req, client, head) => handleConnect(req, client, head, { allowed: resolvedAllowed, upstream: resolvedUpstream }))
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve({ server, port, allowed: resolvedAllowed, upstream: resolvedUpstream }))
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createProxyServer().then(({ port }) => {
    console.log(`model-proxy listening on 127.0.0.1:${port}`)
  }).catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
