import { access } from 'node:fs/promises'

const required = [
  'bin/dsh-orcana-wsl.mjs',
  'lib/index.js',
  'lib/wsl-bridge.js',
  'lib/wsl-install.js',
  'lib/wsl-profile.js',
  'lib/types/index.d.ts',
  'lib/types/wsl-bridge.d.ts',
  'lib/types/wsl-install.d.ts',
  'lib/types/wsl-profile.d.ts',
]

const missing = []
for (const path of required) {
  try {
    await access(new URL(`../${path}`, import.meta.url))
  } catch {
    missing.push(path)
  }
}

if (missing.length > 0) {
  console.error('dsh-orcana-linux distribution closure is incomplete:')
  for (const path of missing) console.error(`  - missing ${path}`)
  process.exit(1)
}

console.error(`dsh-orcana-linux distribution closure OK (${required.length} files)`)
