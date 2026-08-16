import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PROFILE_VERIFY_NODE_SCRIPT,
  buildWslProfileExpectation,
  buildWslProfileVerifyArgs,
  profileVerifyNodeArgs,
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

function runVerify(home: string) {
  return spawnSync(process.execPath, profileVerifyNodeArgs('orcana', expectation), {
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
  })
}

describe('WSL profile expectation', () => {
  it('pins exact top-level dependencies and the required bundle subsequence', () => {
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
    })
  })

  it('builds one direct read-only Node invocation in the selected distro', () => {
    const args = buildWslProfileVerifyArgs('orcana', expectation, 'Ubuntu-24.04')
    expect(args.slice(0, 4)).toEqual(['--distribution', 'Ubuntu-24.04', '--exec', 'node'])
    expect(args[4]).toBe('-e')
    expect(args[5]).toBe(PROFILE_VERIFY_NODE_SCRIPT)
    expect(args.at(-3)).toBe('orcana')
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
      expect(result.stderr).toContain('manifest check OK')
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

  it('rejects traversal-like profile names before filesystem access', () => {
    const result = spawnSync(process.execPath, profileVerifyNodeArgs('../escape', expectation), {
      encoding: 'utf8',
    })
    expect(result.status).toBe(64)
    expect(result.stderr).toContain('invalid profile name')
  })
})
