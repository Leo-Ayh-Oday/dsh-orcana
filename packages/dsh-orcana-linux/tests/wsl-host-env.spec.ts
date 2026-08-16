import { describe, expect, it } from 'vitest'
import {
  WSL_HOST_PATH_ENV,
  WSL_HOST_PATH_LIST_ENV,
  WSL_HOST_SCALAR_ENV,
  augmentWslHostEnvironment,
} from '../src/wsl-host-env.ts'

describe('Windows host bootstrap environment', () => {
  it('covers DSH search/proxy scalars, trust paths and certificate directory lists', () => {
    expect(WSL_HOST_SCALAR_ENV).toEqual([
      'DEEPSEEK_SEARCH_BASE_URL',
      'ALL_PROXY',
      'all_proxy',
    ])
    expect(WSL_HOST_PATH_ENV).toEqual([
      'NODE_EXTRA_CA_CERTS',
      'SSL_CERT_FILE',
      'REQUESTS_CA_BUNDLE',
      'CURL_CA_BUNDLE',
    ])
    expect(WSL_HOST_PATH_LIST_ENV).toEqual(['SSL_CERT_DIR'])
  })

  it('uses /u for scalars, /pu for paths and /lu for path lists', () => {
    const source: NodeJS.ProcessEnv = {
      WSLENV: 'EXISTING/u',
      EXISTING: 'keep',
      DEEPSEEK_SEARCH_BASE_URL: 'https://search.example.test',
      ALL_PROXY: 'socks5://127.0.0.1:1080',
      SSL_CERT_FILE: 'C:\\corp\\root.pem',
      SSL_CERT_DIR: 'C:\\corp\\certs;D:\\shared\\certs',
      NODE_EXTRA_CA_CERTS: 'C:\\corp\\node.pem',
    }
    const result = augmentWslHostEnvironment(source)

    expect(result.WSLENV?.split(':')).toEqual([
      'EXISTING/u',
      'DEEPSEEK_SEARCH_BASE_URL/u',
      'ALL_PROXY/u',
      'NODE_EXTRA_CA_CERTS/pu',
      'SSL_CERT_FILE/pu',
      'SSL_CERT_DIR/lu',
    ])
    expect(result.DEEPSEEK_SEARCH_BASE_URL).toBe(source.DEEPSEEK_SEARCH_BASE_URL)
    expect(result.SSL_CERT_FILE).toBe(source.SSL_CERT_FILE)
    expect(source.WSLENV).toBe('EXISTING/u')
  })

  it('normalizes inherited reverse/wrong-mode flags and removes duplicates', () => {
    const result = augmentWslHostEnvironment({
      WSLENV: 'ALL_PROXY/w:KEEP/l:SSL_CERT_FILE/lw:SSL_CERT_DIR/pw:ALL_PROXY/lw',
      ALL_PROXY: 'socks5://proxy',
      SSL_CERT_FILE: 'C:\\certs\\root.pem',
      SSL_CERT_DIR: 'C:\\certs;D:\\corp-certs',
      KEEP: 'x;y',
    })

    expect(result.WSLENV).toBe('ALL_PROXY/u:KEEP/l:SSL_CERT_FILE/pu:SSL_CERT_DIR/lu')
  })

  it('does not invent WSLENV rows for unset host settings', () => {
    expect(augmentWslHostEnvironment({ WSLENV: 'KEEP/u', KEEP: 'yes' }).WSLENV).toBe('KEEP/u')
  })
})
