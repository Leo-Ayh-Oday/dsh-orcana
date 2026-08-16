import { describe, expect, it } from 'vitest'
import {
  WSL_HOST_PATH_ENV,
  WSL_HOST_SCALAR_ENV,
  augmentWslHostEnvironment,
} from '../src/wsl-host-env.ts'

describe('Windows host bootstrap environment', () => {
  it('covers DSH search/proxy scalars and trust paths that .env cannot own', () => {
    expect(WSL_HOST_SCALAR_ENV).toEqual([
      'DEEPSEEK_SEARCH_BASE_URL',
      'ALL_PROXY',
      'all_proxy',
    ])
    expect(WSL_HOST_PATH_ENV).toEqual([
      'NODE_EXTRA_CA_CERTS',
      'SSL_CERT_FILE',
      'SSL_CERT_DIR',
      'REQUESTS_CA_BUNDLE',
      'CURL_CA_BUNDLE',
    ])
  })

  it('adds scalar values one-way and certificate paths one-way with path translation', () => {
    const source: NodeJS.ProcessEnv = {
      WSLENV: 'EXISTING/u',
      EXISTING: 'keep',
      DEEPSEEK_SEARCH_BASE_URL: 'https://search.example.test',
      ALL_PROXY: 'socks5://127.0.0.1:1080',
      SSL_CERT_FILE: 'C:\\corp\\root.pem',
      NODE_EXTRA_CA_CERTS: 'C:\\corp\\node.pem',
    }
    const result = augmentWslHostEnvironment(source)

    expect(result.WSLENV?.split(':')).toEqual([
      'EXISTING/u',
      'DEEPSEEK_SEARCH_BASE_URL/u',
      'ALL_PROXY/u',
      'NODE_EXTRA_CA_CERTS/pu',
      'SSL_CERT_FILE/pu',
    ])
    expect(result.DEEPSEEK_SEARCH_BASE_URL).toBe(source.DEEPSEEK_SEARCH_BASE_URL)
    expect(result.SSL_CERT_FILE).toBe(source.SSL_CERT_FILE)
    expect(source.WSLENV).toBe('EXISTING/u')
  })

  it('normalizes inherited reverse/list flags for launcher-owned variables and removes duplicates', () => {
    const result = augmentWslHostEnvironment({
      WSLENV: 'ALL_PROXY/w:KEEP/l:SSL_CERT_FILE/lw:ALL_PROXY/lw',
      ALL_PROXY: 'socks5://proxy',
      SSL_CERT_FILE: 'C:\\certs\\root.pem',
      KEEP: 'x;y',
    })

    expect(result.WSLENV).toBe('ALL_PROXY/u:KEEP/l:SSL_CERT_FILE/pu')
  })

  it('does not invent WSLENV rows for unset host settings', () => {
    expect(augmentWslHostEnvironment({ WSLENV: 'KEEP/u', KEEP: 'yes' }).WSLENV).toBe('KEEP/u')
  })
})
