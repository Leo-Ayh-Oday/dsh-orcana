import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

interface PackageManifest {
  name?: string
  version?: string
  bin?: Record<string, string>
  exports?: Record<string, unknown>
  files?: string[]
  engines?: Record<string, string>
  scripts?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

const manifest = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'),
) as PackageManifest

describe('@leooday/dsh-orcana-linux package contract', () => {
  it('ships both cross-platform launcher names from the published tarball', () => {
    expect(manifest.name).toBe('@leooday/dsh-orcana-linux')
    expect(manifest.version).toBe('0.4.0')
    expect(manifest.bin).toEqual({
      'dsh-orcana': 'bin/dsh-orcana-wsl.mjs',
      'dsh-orcana-wsl': 'bin/dsh-orcana-wsl.mjs',
    })
    expect(manifest.files).toContain('bin/*.mjs')
    expect(manifest.files).toContain('lib/*.js')
    expect(manifest.files).toContain('lib/types/**/*.d.ts')
  })

  it('publishes legacy plugin, native evidence, low-level bridge and preferred launcher entrypoints', () => {
    expect(manifest.exports).toMatchObject({
      '.': {
        types: './lib/types/index.d.ts',
        default: './lib/index.js',
      },
      './native-evidence': {
        types: './lib/types/native-evidence.d.ts',
        default: './lib/native-evidence.js',
      },
      './wsl-bridge': {
        types: './lib/types/wsl-bridge.d.ts',
        default: './lib/wsl-bridge.js',
      },
      './wsl-launcher': {
        types: './lib/types/wsl-launcher.d.ts',
        default: './lib/wsl-launcher.js',
      },
      './package.json': './package.json',
    })
  })

  it('pins DSH/Cordis shell + ToolRuntime correlation ABI while keeping Windows launcher peers optional', () => {
    expect(manifest.engines?.node).toBe('^22.19.0 || >=24.0.0')
    expect(manifest.peerDependencies).toEqual({
      '@deepseek-ai/cordis': '4.0.1',
      '@deepseek-ai/dsh-sandbox': '0.1.0-rc.5',
      '@deepseek-ai/dsh-shell': '0.1.0-rc.5',
      '@deepseek-ai/dsh-tools': '0.1.0-rc.5',
    })
    expect(manifest.peerDependenciesMeta).toEqual({
      '@deepseek-ai/cordis': { optional: true },
      '@deepseek-ai/dsh-sandbox': { optional: true },
      '@deepseek-ai/dsh-shell': { optional: true },
      '@deepseek-ai/dsh-tools': { optional: true },
    })
  })

  it('refuses to pack/publish without typecheck, tests and a fresh build', () => {
    expect(manifest.scripts?.prepack).toBe('npm run typecheck && npm test && npm run build')
  })
})
