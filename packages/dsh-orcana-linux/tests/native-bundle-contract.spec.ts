import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const patch = readFileSync(
  resolve(import.meta.dirname, '../../dsh-orcana-linux-bundle/cordis.patch.yml'),
  'utf8',
)

describe('Linux bundle native-enforcement ownership', () => {
  it('loads only the DSH-native evidence adapter, not the legacy argv-hardening root', () => {
    expect(patch).toContain("name: '@leooday/dsh-orcana-linux/native-evidence'")
    expect(patch).not.toMatch(/name:\s*['"]@leooday\/dsh-orcana-linux['"](?:\s|$)/)
  })

  it('keeps installation policy-neutral', () => {
    expect(patch).toContain('config: {}')
    expect(patch).not.toMatch(/^\s+network:\s+/m)
    expect(patch).not.toMatch(/^\s+resourceLimits:\s*$/m)
    expect(patch).toContain('DSH is the sole execution-enforcement owner')
  })
})
