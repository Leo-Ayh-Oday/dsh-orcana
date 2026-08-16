import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

interface BundleManifest {
  name?: string
  version?: string
  publishConfig?: { access?: string }
  dependencies?: Record<string, string>
  dsh?: { bundle?: { patch?: string } }
}

const bundleDir = resolve(import.meta.dirname, '../../dsh-orcana-linux-bundle')
const manifest = JSON.parse(
  readFileSync(resolve(bundleDir, 'package.json'), 'utf8'),
) as BundleManifest
const patch = readFileSync(resolve(bundleDir, 'cordis.patch.yml'), 'utf8')

describe('@leooday/dsh-orcana-linux-bundle release contract', () => {
  it('publishes the native-evidence semantic change as bundle 0.3.0', () => {
    expect(manifest).toMatchObject({
      name: '@leooday/dsh-orcana-linux-bundle',
      version: '0.3.0',
      publishConfig: { access: 'public' },
      dependencies: { '@leooday/dsh-orcana-linux': 'workspace:^' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })
  })

  it('mounts the evidence-only subpath and never the legacy package root', () => {
    expect(patch).toContain("name: '@leooday/dsh-orcana-linux/native-evidence'")
    expect(patch).not.toMatch(/^\s*name:\s*['"]?@leooday\/dsh-orcana-linux['"]?\s*$/m)
    expect(patch).toContain('config: {}')
  })

  it('keeps the stable profile row id across the semantic migration', () => {
    expect(patch).toContain('id: dsh-orcana-linux')
  })
})
