import { describe, expect, it } from 'vitest'
import { DEFAULT_WSL_DSH_PACKAGE } from '../src/wsl-bridge.ts'
import { DEFAULT_WSL_PNPM_PACKAGE } from '../src/wsl-install.ts'
import {
  assertSupportedProductToolchainSelectors,
  requiredOrcanaProfileForRun,
} from '../src/wsl-launcher.ts'

describe('dsh-orcana product toolchain authority', () => {
  it('accepts the built-in exact selector or the same exact value spelled explicitly', () => {
    expect(() => assertSupportedProductToolchainSelectors({})).not.toThrow()
    expect(() => assertSupportedProductToolchainSelectors({
      ORCANA_WSL_DSH_PACKAGE: DEFAULT_WSL_DSH_PACKAGE,
      ORCANA_WSL_PNPM_PACKAGE: DEFAULT_WSL_PNPM_PACKAGE,
    })).not.toThrow()
  })

  it('rejects an unvalidated DSH package selector for product profiles', () => {
    expect(() => assertSupportedProductToolchainSelectors({
      ORCANA_WSL_DSH_PACKAGE: '@deepseek-ai/dsh@0.1.0',
    })).toThrow(/0\.1\.0-rc\.6/)
  })

  it('rejects pnpm drift from the validated profile-install toolchain', () => {
    expect(() => assertSupportedProductToolchainSelectors({
      ORCANA_WSL_PNPM_PACKAGE: 'pnpm@11.8.0',
    })).toThrow(/pnpm@11\.7\.0/)
  })

  it('rejects an opaque custom DSH executable for product-owned profiles', () => {
    expect(() => assertSupportedProductToolchainSelectors({
      ORCANA_WSL_DSH_COMMAND: '/opt/dev/dsh',
    })).toThrow(/bypasses the exact product DSH selector/)
  })

  it('keeps explicit non-Orcana profiles outside product authority', () => {
    expect(requiredOrcanaProfileForRun([
      '--profile', 'experimental-rc6', 'fix the tests',
    ], 'orcana')).toBeUndefined()
  })
})
