import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { profileVerifyNodeArgs, type WslProfileExpectation } from '../src/wsl-profile.ts'

function withProfile<T>(run: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), 'dsh-orcana-preflight-'))
  try {
    const dir = join(home, 'profiles', 'orcana')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: {
        '@leooday/dsh-governor': '0.1.0',
      },
      dsh: {
        profile: {
          bundles: [
            '@deepseek-ai/dsh-base',
            '@deepseek-ai/dsh-headless',
            '@leooday/dsh-bundle',
            '@leooday/dsh-orcana-linux-bundle',
          ],
        },
      },
    }))
    return run(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

const baseExpectation: WslProfileExpectation = {
  dependencies: {
    '@leooday/dsh-governor': '0.1.0',
  },
  bundles: [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-headless',
    '@leooday/dsh-bundle',
    '@leooday/dsh-orcana-linux-bundle',
  ],
  importPackages: [],
}

describe('Orcana profile preflight strength', () => {
  it('allows manifest-only preflight to leave DSH peer-fallback healing to the real boot', () => {
    withProfile((home) => {
      const result = spawnSync(process.execPath, profileVerifyNodeArgs('orcana', baseExpectation), {
        env: { ...process.env, DSH_HOME: home },
        encoding: 'utf8',
      })
      expect(result.status).toBe(0)
      expect(result.stderr).toContain('manifest/module check OK')
    })
  })

  it('turns the same unresolved package into a hard failure when doctor/install requests full import verification', () => {
    withProfile((home) => {
      const strong: WslProfileExpectation = {
        ...baseExpectation,
        importPackages: ['@leooday/dsh-governor'],
      }
      const result = spawnSync(process.execPath, profileVerifyNodeArgs('orcana', strong), {
        env: { ...process.env, DSH_HOME: home },
        encoding: 'utf8',
      })
      expect(result.status).toBe(67)
      expect(result.stderr).toContain('module resolve FAILED')
    })
  })
})
