import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

function readJson(path) {
  return JSON.parse(readFileSync(resolve(root, path), 'utf8'))
}

function fail(message) {
  console.error(`release-contract: ${message}`)
  process.exitCode = 1
}

function importerBlock(lock, importer) {
  const marker = `  ${importer}:\n`
  const start = lock.indexOf(marker)
  if (start === -1) return undefined
  const bodyStart = start + marker.length
  const rest = lock.slice(bodyStart)
  const nextImporter = /\n  [^\s][^\n]*:\n/.exec(rest)
  const packagesSection = rest.indexOf('\npackages:')
  let relativeEnd = rest.length
  if (nextImporter !== null) relativeEnd = Math.min(relativeEnd, nextImporter.index)
  if (packagesSection !== -1) relativeEnd = Math.min(relativeEnd, packagesSection)
  return rest.slice(0, relativeEnd)
}

function unquoteYamlKey(value) {
  const trimmed = value.trim()
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function importerSpecifiers(lock, importer) {
  const block = importerBlock(lock, importer)
  if (block === undefined) return undefined
  const specifiers = new Map()
  let section
  let packageName

  for (const line of block.split('\n')) {
    const sectionMatch = /^    ([A-Za-z][A-Za-z0-9]*):$/.exec(line)
    if (sectionMatch !== null) {
      section = sectionMatch[1]
      packageName = undefined
      continue
    }
    const packageMatch = /^      (.+):$/.exec(line)
    if (packageMatch !== null) {
      packageName = unquoteYamlKey(packageMatch[1])
      continue
    }
    const specifierMatch = /^        specifier: (.+)$/.exec(line)
    if (specifierMatch !== null && section !== undefined && packageName !== undefined) {
      specifiers.set(`${section}:${packageName}`, specifierMatch[1].trim())
    }
  }
  return specifiers
}

function requireSpecifier(lock, importer, section, packageName, expected) {
  const specifiers = importerSpecifiers(lock, importer)
  if (specifiers === undefined) {
    fail(`${importer}: importer is missing from pnpm-lock.yaml`)
    return
  }
  const key = `${section}:${packageName}`
  const actual = specifiers.get(key)
  if (actual !== expected) {
    fail(`${importer}: ${section}.${packageName} expected specifier ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`)
  }
}

function requireSpecifierInAnySection(lock, importer, packageName, expected, sections) {
  const specifiers = importerSpecifiers(lock, importer)
  if (specifiers === undefined) {
    fail(`${importer}: importer is missing from pnpm-lock.yaml`)
    return
  }
  const matches = sections
    .map(section => ({ section, value: specifiers.get(`${section}:${packageName}`) }))
    .filter(entry => entry.value !== undefined)
  if (matches.length === 0) {
    fail(`${importer}: ${packageName} is missing from allowed lock sections ${sections.join(', ')}`)
    return
  }
  if (!matches.some(entry => entry.value === expected)) {
    fail(`${importer}: ${packageName} expected specifier ${JSON.stringify(expected)}, found ${matches.map(entry => `${entry.section}=${JSON.stringify(entry.value)}`).join(', ')}`)
  }
}

const rootManifest = readJson('package.json')
const governor = readJson('packages/dsh-governor/package.json')
const governorCore = readJson('packages/governor-core/package.json')
const bundle = readJson('packages/dsh-bundle/package.json')
const linux = readJson('packages/dsh-orcana-linux/package.json')
const linuxBundle = readJson('packages/dsh-orcana-linux-bundle/package.json')
const linuxBundlePatch = readFileSync(resolve(root, 'packages/dsh-orcana-linux-bundle/cordis.patch.yml'), 'utf8')
const profileVerifier = readFileSync(resolve(root, 'packages/dsh-orcana-linux/src/wsl-profile.ts'), 'utf8')
const nativeEvidence = readFileSync(resolve(root, 'packages/dsh-orcana-linux/src/native-evidence.ts'), 'utf8')
const nativeCorrelation = readFileSync(resolve(root, 'packages/dsh-orcana-linux/src/native-tool-correlation.ts'), 'utf8')
const lock = readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8')

if (rootManifest.packageManager !== 'pnpm@11.7.0') {
  fail(`root packageManager must stay pnpm@11.7.0, found ${JSON.stringify(rootManifest.packageManager)}`)
}

const publicPackages = [governorCore, governor, bundle, linux, linuxBundle]
for (const manifest of publicPackages) {
  if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@leooday/')) {
    fail(`public package has non-@leooday name: ${JSON.stringify(manifest.name)}`)
  }
  if (manifest.publishConfig?.access !== 'public') {
    fail(`${manifest.name}: publishConfig.access must be public`)
  }
}

// DSH is the sole native enforcement owner. The default bundle must consume
// DSH's public rc.6 shell sandbox facts and must never regress to the legacy
// argv-hardening package root.
const nativeEvidenceRow = "name: '@leooday/dsh-orcana-linux/native-evidence'"
const legacyRootRow = "name: '@leooday/dsh-orcana-linux'"
if (!linuxBundlePatch.includes(nativeEvidenceRow)) {
  fail('Linux bundle does not mount @leooday/dsh-orcana-linux/native-evidence')
}
if (linuxBundlePatch.includes(legacyRootRow)) {
  fail('Linux bundle regressed to the legacy argv-hardening package root')
}
if (!linuxBundlePatch.includes('config: {}')) {
  fail('Linux bundle must remain policy-neutral; expected config: {} on the evidence row')
}

const nativeExport = linux.exports?.['./native-evidence']
if (typeof nativeExport !== 'object' || nativeExport === null
  || nativeExport.default !== './lib/native-evidence.js'
  || nativeExport.types !== './lib/types/native-evidence.d.ts') {
  fail('@leooday/dsh-orcana-linux must publish the ./native-evidence JS/types export pair')
}
for (const dependency of ['@deepseek-ai/dsh-sandbox', '@deepseek-ai/dsh-shell', '@deepseek-ai/dsh-tools']) {
  if (linux.peerDependencies?.[dependency] !== '0.1.0-rc.6') {
    fail(`Linux native-evidence ABI must pin ${dependency}@0.1.0-rc.6, found ${JSON.stringify(linux.peerDependencies?.[dependency])}`)
  }
}
if (!profileVerifier.includes("'@leooday/dsh-orcana-linux/native-evidence'")) {
  fail('WSL profile verifier does not probe the actual native-evidence runtime subpath')
}
if (!nativeEvidence.includes('currentNativeToolCorrelation()') || !nativeEvidence.includes('installNativeToolCorrelation(ctx)')) {
  fail('native-evidence is not wired to exact DSH tool/session correlation')
}
if (!nativeCorrelation.includes("ctx.on('tools/execute'") || !nativeCorrelation.includes('AsyncLocalStorage')) {
  fail('native tool correlation must use the official tools/execute seam plus AsyncLocalStorage')
}

if (lock.includes('@orcana/')) {
  fail('pnpm-lock.yaml still contains the retired @orcana scope; regenerate it with pnpm 11.7.0 before release')
}

requireSpecifier(lock, 'packages/dsh-bundle', 'dependencies', '@leooday/dsh-governor', 'workspace:^')
requireSpecifier(lock, 'packages/dsh-bundle', 'dependencies', '@leooday/governor-core', 'workspace:^')
requireSpecifier(lock, 'packages/dsh-governor', 'dependencies', '@leooday/governor-core', 'workspace:^')

for (const packageName of [
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-tools',
]) {
  requireSpecifier(lock, 'packages/dsh-governor', 'devDependencies', packageName, '^0.1.0-rc.5')
}

for (const [packageName, expected] of [
  ['@deepseek-ai/cordis', '4.0.1'],
  ['@deepseek-ai/dsh-sandbox', '0.1.0-rc.6'],
  ['@deepseek-ai/dsh-shell', '0.1.0-rc.6'],
  ['@deepseek-ai/dsh-tools', '0.1.0-rc.6'],
]) {
  requireSpecifierInAnySection(
    lock,
    'packages/dsh-orcana-linux',
    packageName,
    expected,
    ['dependencies', 'devDependencies', 'optionalDependencies'],
  )
}

for (const packageName of [
  '@deepseek-ai/dsh-bash-local',
  '@deepseek-ai/dsh-bash-sandbox',
  '@deepseek-ai/dsh-sandbox-local',
  '@deepseek-ai/dsh-sandbox-policy',
  '@deepseek-ai/dsh-shell',
  '@deepseek-ai/dsh-subprocess',
  '@deepseek-ai/dsh-subprocess-local',
  '@deepseek-ai/dsh-tools',
]) {
  requireSpecifier(lock, 'packages/dsh-orcana-linux', 'devDependencies', packageName, '0.1.0-rc.6')
}

requireSpecifier(lock, 'packages/dsh-orcana-linux-bundle', 'dependencies', '@leooday/dsh-orcana-linux', 'workspace:^')

if (process.exitCode === 1) {
  console.error('release-contract: FAILED')
  console.error('release-contract: regenerate only with the repository-pinned pnpm: corepack prepare pnpm@11.7.0 --activate && pnpm install --lockfile-only')
} else {
  console.log('release-contract: PASS')
}
