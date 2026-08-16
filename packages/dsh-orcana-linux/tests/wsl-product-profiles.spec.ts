import { describe, expect, it } from 'vitest'
import { DEFAULT_WSL_BUNDLES, DEFAULT_WSL_DSH_PACKAGE } from '../src/wsl-bridge.ts'
import { DEFAULT_ORCANA_PROFILE_RUNTIME_PACKAGES, DSH_WEB_APP_PACKAGE } from '../src/wsl-install.ts'
import { buildWslCompanionProfileExpectation } from '../src/wsl-profile.ts'
import {
  orcanaWebProfileName,
  rewriteOrcanaWebInvocation,
} from '../src/wsl-product-profiles.ts'

describe('Orcana Web companion profile', () => {
  it('derives a dedicated profile without mutating upstream web', () => {
    expect(orcanaWebProfileName('orcana')).toBe('orcana-web')
    expect(orcanaWebProfileName('bench')).toBe('bench-web')
  })

  it('requires base -> web-app -> Orcana bundle order and exact release closure', () => {
    expect(buildWslCompanionProfileExpectation(
      DEFAULT_WSL_DSH_PACKAGE,
      DSH_WEB_APP_PACKAGE,
      DEFAULT_ORCANA_PROFILE_RUNTIME_PACKAGES,
      DEFAULT_WSL_BUNDLES,
    )).toEqual({
      dependencies: {
        '@deepseek-ai/dsh-web-app': '0.1.0-rc.5',
        '@leooday/governor-core': '0.1.0-rc.1',
        '@leooday/dsh-governor': '0.1.0-rc.1',
        '@leooday/dsh-orcana-linux': '0.4.0',
        '@leooday/dsh-bundle': '0.1.0-rc.1',
        '@leooday/dsh-orcana-linux-bundle': '0.2.0',
      },
      bundles: [
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-web-app',
        '@leooday/dsh-bundle',
        '@leooday/dsh-orcana-linux-bundle',
      ],
      importPackages: [
        '@leooday/governor-core',
        '@leooday/dsh-governor',
        '@leooday/dsh-orcana-linux',
      ],
    })
  })

  it('rewrites the web alias to the Orcana Web profile without disturbing argument order', () => {
    expect(rewriteOrcanaWebInvocation([
      'web', '--patch', './extra.yml', '--host', '127.0.0.1', '--port', '3081',
    ], 'orcana')).toEqual([
      '--profile', 'orcana-web', '--patch', './extra.yml', '--host', '127.0.0.1', '--port', '3081',
    ])

    expect(rewriteOrcanaWebInvocation(['web', '--help'], 'orcana')).toEqual([
      '--profile', 'orcana-web', '--help',
    ])
    expect(rewriteOrcanaWebInvocation(['web', '--dump-config'], 'orcana')).toEqual([
      '--profile', 'orcana-web', '--dump-config',
    ])
  })

  it('leaves every non-web invocation byte-for-byte unchanged', () => {
    const task = ['--profile', 'bench', 'fix the tests']
    expect(rewriteOrcanaWebInvocation(task, 'orcana')).toEqual(task)
    expect(rewriteOrcanaWebInvocation(['plugin', '--profile', 'dev', 'list'], 'orcana')).toEqual([
      'plugin', '--profile', 'dev', 'list',
    ])
  })
})
