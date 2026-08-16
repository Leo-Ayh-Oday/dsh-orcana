import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ORCANA_PROFILE_IMPORT_MODULES,
  PROFILE_VERIFY_NODE_SCRIPT,
  buildWslProfileExpectation,
  buildWslProfileVerifyArgs,
  profileVerifyNodeArgs,
  type WslProfileExpectation,
} from '../src/wsl-profile.ts'

const DSH_PACKAGE = '@deepseek-ai/dsh@0.1.0-rc.5'
const RUNTIME_PACKAGES = [
  '@leooday/governor-core@0.1.0-rc.1',
  '@leooday/dsh-governor@0.1.0-rc.1',
  '@leooday/dsh-orcana-linux@0.4.0',
] as const
const BUNDLE_PACKAGES = [
  '@leooday/dsh-bundle@0.1.0-rc.1',
  '@leooday/dsh-orcana-linux-bundle@0.2.0',
] as const

const expectation = buildWslProfileExpectation(DSH_PACKAGE, RUNTIME_PACKAGES, BUNDLE_PACKAGES)
const manifestOnlyExpectation: WslProfileExpectation = { ...expectation, importPackages: [] }

function withDshHome<T>(run: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), 'dsh-orcana-profile-'))
  try {
    return run(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

function writeProfile(home: string, manifest: unknown): string {
  const dir = join(home, 'profiles', 'orcana')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return dir
}

function writeProbePackage(profileDir: string, source = 'export const ok = true\n'): void {
  const dir = join(profileDir, 'node_modules', 'probe-pkg')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'probe-pkg',
    version: '1.0.0',
    type: 'module',
    exports: './index.js',
  }))
  writeFileSync(join(dir, 'index.js'), source)
}

function runVerify(
  home: string,
  selected: WslProfileExpectation = manifestOnlyExpectation,
) {
  return spawnSync(process.execPath, profileVerifyNodeArgs('orcana', selected), {
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
  })
}

describe('WSL profile expectation', () => {
  it('pins exact dependencies, required bundle order and actual runtime import probes', () => {
    expect(DEFAULT_ORCANA_PROFILE_IMPORT_MODULES).toEqual([
      '@leooday/governor-core',
      '@leooday/dsh-governor',
      '@leooday/dsh-orcana-linux/native-evidence',
    ])
    expect(expectation).toEqual({
      dependencies: {
        '@deepseek-ai/dsh-headless': '0.1.0-rc.5',
        '@leooday/governor-core': '0.1.0-rc.1',
        '@leooday/dsh-governor': '0.1.0-rc.1',
        '@leooday/dsh-orcana-linux': '0.4.0',
        '@leooday/dsh-bundle': '0.1.0-rc.1',
        '@leooday/dsh-orcana-linux-bundle': '0.2.0',
      },
      bundles: [
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-headless',
        '@leooday/dsh-bundle',
        '@leooday/dsh-orcana-linux-bundle',
      ],
      importPackages: [
        '@leooday/governor-core',
        '@leooday/dsh-governor',
        '@leooday/dsh-orcana-linux/native-evidence',
      ],
    })
  })

  it('builds one direct read-only Node invocation in the selected distro', () => {
    const args = buildWslProfileVerifyArgs('orcana', expectation, 'Ubuntu-24.04')
    expect(args.slice(0, 4)).toEqual(['--distribution', 'Ubuntu-24.04', '--exec', 'node'])
    expect(args[4]).toBe('-e')
    expect(args[5]).toBe(PROFILE_VERIFY_NODE_SCRIPT)
    expect(args.at(-4)).toBe('orcana')
    expect(JSON.parse(args.at(-1)!)).toEqual(expectation.importPackages)
  })
})

describe('WSL profile manifest verifier', () => {
  it('accepts the exact release closure and allows unrelated extra bundles', () => {
    withDshHome((home) => {
      writeProfile(home, {
        dependencies: expectation.dependencies,
        dsh: {
          profile: {
            bundles: [
              '@deepseek-ai/dsh-base',
              '@deepseek-ai/dsh-headless',
              '@example/extra-layer',
              '@leooday/dsh-bundle',
              '@leooday/dsh-orcana-linux-bundle',
            ],
          },
        },
      })
      const result = runVerify(home)
      expect(result.status).toBe(0)
      expect(result.stderr).toContain('manifest/module check OK')
    })
  })

  it('reports a missing profile without creating it', () => {
    withDshHome((home) => {
      const profileDir = join(home, 'profiles', 'orcana')
      const result = runVerify(home)
      expect(result.status).toBe(2)
      expect(result.stderr).toContain('is not installed')
      expect(existsSync(profileDir)).toBe(false)
    })
  })

  it('fails when an exact dependency drifts', () => {
    withDshHome((home) => {
      writeProfile(home, {
        dependencies: {
          ...expectation.dependencies,
          '@leooday/dsh-orcana-linux': '^0.4.0',
        },
        dsh: { profile: { bundles: expectation.bundles } },
      })
      const result = runVerify(home)
      expect(result.status).toBe(66)
      expect(result.stderr).toContain('expected 0.4.0')
      expect(result.stderr).toContain('found "^0.4.0"')
    })
  })

  it('fails when required bundle order is inverted', () => {
    withDshHome((home) => {
      writeProfile(home, {
        dependencies: expectation.dependencies,
        dsh: {
          profile: {
            bundles: [
              '@deepseek-ai/dsh-base',
              '@leooday/dsh-bundle',
              '@deepseek-ai/dsh-headless',
              '@leooday/dsh-orcana-linux-bundle',
            ],
          },
        },
      })
      const result = runVerify(home)
      expect(result.status).toBe(66)
      expect(result.stderr).toContain('bundle order')
    })
  })

  it('imports a resolved implementation package from the profile anchor', () => {
    withDshHome((home) => {
      const profileDir = writeProfile(home, { dependencies: {}, dsh: { profile: { bundles: [] } } })
      writeProbePackage(profileDir)
      const result = runVerify(home, { dependencies: {}, bundles: [], importPackages: ['probe-pkg'] })
      expect(result.status).toBe(0)
      expect(result.stderr).toContain('manifest/module check OK')
    })
  })

  it('fails with 67 when an implementation package cannot resolve from the profile', () => {
    withDshHome((home) => {
      writeProfile(home, { dependencies: {}, dsh: { profile: { bundles: [] } } })
      const result = runVerify(home, { dependencies: {}, bundles: [], importPackages: ['missing-probe-pkg'] })
      expect(result.status).toBe(67)
      expect(result.stderr).toContain('module resolve FAILED')
    })
  })

  it('fails with 68 when a resolved implementation package throws during import', () => {
    withDshHome((home) => {
      const profileDir = writeProfile(home, { dependencies: {}, dsh: { profile: { bundles: [] } } })
      writeProbePackage(profileDir, 'throw new Error("peer-chain-broken")\n')
      const result = runVerify(home, { dependencies: {}, bundles: [], importPackages: ['probe-pkg'] })
      expect(result.status).toBe(68)
      expect(result.stderr).toContain('module import FAILED')
      expect(result.stderr).toContain('peer-chain-broken')
    })
  })

  it('rejects traversal-like profile names before filesystem access', () => {
    const result = spawnSync(process.execPath, profileVerifyNodeArgs('../escape', manifestOnlyExpectation), {
      encoding: 'utf8',
    })
    expect(result.status).toBe(64)
    expect(result.stderr).toContain('invalid profile name')
  })
})
