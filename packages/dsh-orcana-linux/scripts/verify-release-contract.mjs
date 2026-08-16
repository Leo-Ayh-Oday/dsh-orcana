import { readFile } from 'node:fs/promises'

const packageRoot = new URL('../', import.meta.url)

async function readJson(relative) {
  return JSON.parse(await readFile(new URL(relative, packageRoot), 'utf8'))
}

function exactSpec(manifest) {
  return `${manifest.name}@${manifest.version}`
}

const [
  governorCore,
  dshGovernor,
  linuxRuntime,
  dshBundle,
  linuxBundle,
] = await Promise.all([
  readJson('../governor-core/package.json'),
  readJson('../dsh-governor/package.json'),
  readJson('./package.json'),
  readJson('../dsh-bundle/package.json'),
  readJson('../dsh-orcana-linux-bundle/package.json'),
])

const {
  DEFAULT_ORCANA_PROFILE_RUNTIME_PACKAGES,
  DEFAULT_WSL_PNPM_PACKAGE,
} = await import('../lib/wsl-install.js')
const {
  DEFAULT_WSL_BUNDLES,
  DEFAULT_WSL_DSH_PACKAGE,
} = await import('../lib/wsl-bridge.js')

const expectedRuntime = [
  exactSpec(governorCore),
  exactSpec(dshGovernor),
  exactSpec(linuxRuntime),
]
const expectedBundles = [
  exactSpec(dshBundle),
  exactSpec(linuxBundle),
]

const problems = []
if (JSON.stringify(DEFAULT_ORCANA_PROFILE_RUNTIME_PACKAGES) !== JSON.stringify(expectedRuntime)) {
  problems.push(`runtime specs: embedded=${JSON.stringify(DEFAULT_ORCANA_PROFILE_RUNTIME_PACKAGES)} workspace=${JSON.stringify(expectedRuntime)}`)
}
if (JSON.stringify(DEFAULT_WSL_BUNDLES) !== JSON.stringify(expectedBundles)) {
  problems.push(`bundle specs: embedded=${JSON.stringify(DEFAULT_WSL_BUNDLES)} workspace=${JSON.stringify(expectedBundles)}`)
}
if (DEFAULT_WSL_DSH_PACKAGE !== '@deepseek-ai/dsh@0.1.0-rc.5') {
  problems.push(`unexpected audited DSH entry selector ${JSON.stringify(DEFAULT_WSL_DSH_PACKAGE)}`)
}
if (DEFAULT_WSL_PNPM_PACKAGE !== 'pnpm@11.7.0') {
  problems.push(`unexpected audited pnpm selector ${JSON.stringify(DEFAULT_WSL_PNPM_PACKAGE)}`)
}
if (linuxRuntime.engines?.node !== '^22.19.0 || >=24.0.0') {
  problems.push(`Linux runtime Node engine drifted to ${JSON.stringify(linuxRuntime.engines?.node)}`)
}

if (problems.length > 0) {
  console.error('dsh-orcana-linux embedded release contract drifted:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.error('dsh-orcana-linux embedded release contract OK')
