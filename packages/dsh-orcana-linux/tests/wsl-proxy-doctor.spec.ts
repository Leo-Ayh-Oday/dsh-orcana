import { describe, expect, it } from 'vitest'
import {
  WSL_PROXY_ENV_NAMES,
  buildWslLoopbackProxyProbeArgs,
  loopbackProxyEndpoints,
  probeLoopbackProxiesFromWsl,
  reportWslLoopbackProxyDoctor,
} from '../src/wsl-proxy-doctor.ts'

describe('Windows loopback proxy discovery', () => {
  it('tracks only proxy variables whose Windows target is loopback and never returns credentials', () => {
    const endpoints = loopbackProxyEndpoints({
      COMPUTERNAME: 'LEO-PC',
      HTTP_PROXY: 'http://alice:top-secret@127.0.0.1:7890',
      http_proxy: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://proxy.example.test:8080',
      ALL_PROXY: 'socks5://localhost:1080',
      all_proxy: 'http://LEO-PC:8888',
    })

    expect(WSL_PROXY_ENV_NAMES).toEqual([
      'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy',
    ])
    expect(endpoints).toEqual([
      { variables: ['HTTP_PROXY', 'http_proxy'], host: '127.0.0.1', port: 7890 },
      { variables: ['ALL_PROXY'], host: 'localhost', port: 1080 },
      { variables: ['all_proxy'], host: 'leo-pc', port: 8888 },
    ])
    expect(JSON.stringify(endpoints)).not.toContain('top-secret')
    expect(JSON.stringify(endpoints)).not.toContain('alice')
  })

  it('recognizes the whole IPv4 loopback block and IPv6 loopback', () => {
    expect(loopbackProxyEndpoints({
      HTTP_PROXY: 'http://127.42.0.9:9000',
      HTTPS_PROXY: 'http://[::1]:9443',
    })).toEqual([
      { variables: ['HTTP_PROXY'], host: '127.42.0.9', port: 9000 },
      { variables: ['HTTPS_PROXY'], host: '::1', port: 9443 },
    ])
  })

  it('uses protocol defaults only when a loopback proxy omits its port', () => {
    expect(loopbackProxyEndpoints({
      HTTP_PROXY: 'http://localhost',
      HTTPS_PROXY: 'https://localhost',
      ALL_PROXY: 'socks5://localhost',
    })).toEqual([
      { variables: ['HTTP_PROXY'], host: 'localhost', port: 80 },
      { variables: ['HTTPS_PROXY'], host: 'localhost', port: 443 },
      { variables: ['ALL_PROXY'], host: 'localhost', port: 1080 },
    ])
  })
})

describe('WSL loopback proxy probe', () => {
  it('builds a direct Node TCP probe in the selected distro', () => {
    const args = buildWslLoopbackProxyProbeArgs({ host: '127.0.0.1', port: 7890 }, 'Ubuntu-24.04')
    expect(args.slice(0, 5)).toEqual([
      '--distribution', 'Ubuntu-24.04', '--exec', 'node', '-e',
    ])
    expect(args.at(-2)).toBe('127.0.0.1')
    expect(args.at(-1)).toBe('7890')
  })

  it('classifies successful, failed and indeterminate probes without shell interpolation', () => {
    const fake = ((_: string, args: readonly string[]) => {
      const port = args.at(-1)
      if (port === '7890') return { status: 0, error: undefined }
      if (port === '1080') return { status: 2, error: undefined }
      return { status: null, error: new Error('probe runner failed') }
    }) as unknown as typeof import('node:child_process').spawnSync

    expect(probeLoopbackProxiesFromWsl({
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://localhost:1080',
      ALL_PROXY: 'http://127.0.0.2:9999',
    }, 'Ubuntu', fake)).toEqual([
      { variables: ['HTTP_PROXY'], host: '127.0.0.1', port: 7890, status: 'reachable' },
      { variables: ['HTTPS_PROXY'], host: 'localhost', port: 1080, status: 'unreachable' },
      { variables: ['ALL_PROXY'], host: '127.0.0.2', port: 9999, status: 'unknown' },
    ])
  })

  it('fails doctor only for a definitively unreachable endpoint and redacts proxy credentials', () => {
    const lines: string[] = []
    const fake = ((_: string, args: readonly string[]) => ({
      status: args.at(-1) === '7890' ? 2 : 0,
      error: undefined,
    })) as unknown as typeof import('node:child_process').spawnSync

    const status = reportWslLoopbackProxyDoctor({
      HTTP_PROXY: 'http://alice:top-secret@127.0.0.1:7890',
      HTTPS_PROXY: 'http://localhost:9443',
    }, 'Ubuntu', fake, line => lines.push(line))

    expect(status).toBe(69)
    expect(lines.some(line => line.includes('UNREACHABLE'))).toBe(true)
    expect(lines.some(line => line.includes('reachable from WSL'))).toBe(true)
    expect(lines.join('\n')).not.toContain('alice')
    expect(lines.join('\n')).not.toContain('top-secret')
  })

  it('keeps an indeterminate probe advisory because the core doctor owns WSL/Node failures', () => {
    const lines: string[] = []
    const fake = (() => ({ status: null, error: new Error('wsl unavailable') })) as unknown as typeof import('node:child_process').spawnSync
    expect(reportWslLoopbackProxyDoctor({
      HTTP_PROXY: 'http://127.0.0.1:7890',
    }, undefined, fake, line => lines.push(line))).toBe(0)
    expect(lines).toEqual([
      '[orcana-wsl] proxy: HTTP_PROXY loopback 127.0.0.1:7890 reachability UNKNOWN',
    ])
  })

  it('does no WSL work when no explicit loopback proxy is present', () => {
    let called = false
    const fake = (() => {
      called = true
      return { status: 0, error: undefined }
    }) as unknown as typeof import('node:child_process').spawnSync

    expect(reportWslLoopbackProxyDoctor({
      HTTPS_PROXY: 'http://proxy.example.test:8080',
    }, 'Ubuntu', fake)).toBe(0)
    expect(called).toBe(false)
  })
})
