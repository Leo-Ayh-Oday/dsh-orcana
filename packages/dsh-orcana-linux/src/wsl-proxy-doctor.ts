import { spawnSync } from 'node:child_process'

const PROXY_ENV_NAMES = Object.freeze([
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
] as const)

const PROXY_PROBE_NODE_SCRIPT = [
  'const net=require("node:net")',
  'const [host,portText]=process.argv.slice(1)',
  'const port=Number(portText)',
  'if(!host||!Number.isInteger(port)||port<1||port>65535)process.exit(64)',
  'let done=false',
  'const finish=(code)=>{if(done)return;done=true;socket.destroy();process.exit(code)}',
  'const socket=net.createConnection({host,port})',
  'socket.setTimeout(1200)',
  'socket.once("connect",()=>finish(0))',
  'socket.once("timeout",()=>finish(2))',
  'socket.once("error",()=>finish(2))',
].join(';')

export interface LoopbackProxyEndpoint {
  variables: string[]
  host: string
  port: number
}

export interface LoopbackProxyProbe extends LoopbackProxyEndpoint {
  status: 'reachable' | 'unreachable' | 'unknown'
}

function normalizeHostname(hostname: string): string {
  const lower = hostname.toLowerCase()
  return lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower
}

function isIpv4Loopback(host: string): boolean {
  const parts = host.split('.')
  if (parts.length !== 4 || parts[0] !== '127') return false
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function defaultProxyPort(protocol: string): number | undefined {
  if (protocol === 'http:') return 80
  if (protocol === 'https:') return 443
  if (protocol === 'socks:' || protocol === 'socks4:' || protocol === 'socks5:' || protocol === 'socks5h:') return 1080
  return undefined
}

function parseLoopbackProxy(
  value: string,
  computerName?: string,
): { host: string; port: number } | undefined {
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined

  let url: URL
  try {
    url = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`)
  } catch {
    return undefined
  }

  const host = normalizeHostname(url.hostname)
  const machine = computerName?.trim().toLowerCase()
  const loopback = host === 'localhost'
    || host === '::1'
    || isIpv4Loopback(host)
    || (machine !== undefined && machine.length > 0 && host === machine)
  if (!loopback) return undefined

  const explicitPort = url.port.length > 0 ? Number(url.port) : undefined
  const port = explicitPort ?? defaultProxyPort(url.protocol)
  if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) return undefined
  return { host, port }
}

/**
 * Find Windows-host proxy variables whose target is loopback. The value itself
 * is never returned, so embedded proxy credentials cannot leak into doctor
 * output. Equivalent endpoints are coalesced while retaining variable names.
 */
export function loopbackProxyEndpoints(
  env: NodeJS.ProcessEnv = process.env,
): LoopbackProxyEndpoint[] {
  const byTarget = new Map<string, LoopbackProxyEndpoint>()
  for (const name of PROXY_ENV_NAMES) {
    const value = env[name]
    if (value === undefined) continue
    const parsed = parseLoopbackProxy(value, env.COMPUTERNAME)
    if (parsed === undefined) continue
    const key = `${parsed.host}\u0000${parsed.port}`
    const existing = byTarget.get(key)
    if (existing !== undefined) {
      existing.variables.push(name)
    } else {
      byTarget.set(key, { variables: [name], ...parsed })
    }
  }
  return [...byTarget.values()]
}

function distroPrefix(distro?: string): string[] {
  return distro === undefined ? [] : ['--distribution', distro]
}

export function buildWslLoopbackProxyProbeArgs(
  endpoint: Pick<LoopbackProxyEndpoint, 'host' | 'port'>,
  distro?: string,
): string[] {
  return [
    ...distroPrefix(distro),
    '--exec', 'node', '-e', PROXY_PROBE_NODE_SCRIPT,
    endpoint.host, String(endpoint.port),
  ]
}

export function probeLoopbackProxiesFromWsl(
  env: NodeJS.ProcessEnv = process.env,
  distro?: string,
  run: typeof spawnSync = spawnSync,
): LoopbackProxyProbe[] {
  return loopbackProxyEndpoints(env).map((endpoint) => {
    const result = run('wsl.exe', buildWslLoopbackProxyProbeArgs(endpoint, distro), {
      env,
      stdio: 'ignore',
      windowsHide: true,
      timeout: 5000,
    })
    const status: LoopbackProxyProbe['status'] = result.error !== undefined || result.status === null
      ? 'unknown'
      : result.status === 0 ? 'reachable' : 'unreachable'
    return { ...endpoint, status }
  })
}

/**
 * Report actual WSL reachability for explicit Windows loopback proxies.
 * Returns 69 when at least one endpoint is definitively unreachable; unknown
 * probe results remain warnings because the core doctor owns Node/WSL errors.
 */
export function reportWslLoopbackProxyDoctor(
  env: NodeJS.ProcessEnv = process.env,
  distro?: string,
  run: typeof spawnSync = spawnSync,
  write: (line: string) => void = line => console.error(line),
): number {
  const probes = probeLoopbackProxiesFromWsl(env, distro, run)
  let unreachable = false
  for (const probe of probes) {
    const names = probe.variables.join(',')
    if (probe.status === 'reachable') {
      write(`[orcana-wsl] proxy: ${names} loopback ${probe.host}:${probe.port} reachable from WSL`)
      continue
    }
    if (probe.status === 'unreachable') {
      unreachable = true
      write(`[orcana-wsl] proxy: ${names} loopback ${probe.host}:${probe.port} UNREACHABLE from WSL`)
      write('[orcana-wsl] proxy: WSL NAT does not expose Windows loopback by default; use a WSL-reachable proxy configuration (for example mirrored networking when appropriate) or remove the explicit loopback proxy override')
      continue
    }
    write(`[orcana-wsl] proxy: ${names} loopback ${probe.host}:${probe.port} reachability UNKNOWN`)
  }
  return unreachable ? 69 : 0
}

export const WSL_PROXY_ENV_NAMES = PROXY_ENV_NAMES
