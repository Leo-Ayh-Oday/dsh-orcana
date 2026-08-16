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
  ['@deepseek-ai/dsh-sandbox', '0.1.0-rc.5'],
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
]) {
  requireSpecifier(lock, 'packages/dsh-orcana-linux', 'devDependencies', packageName, '0.1.0-rc.5')
}

requireSpecifier(lock, 'packages/dsh-orcana-linux-bundle', 'dependencies', '@leooday/dsh-orcana-linux', 'workspace:^')

if (process.exitCode === 1) {
  console.error('release-contract: FAILED')
  console.error('release-contract: regenerate only with the repository-pinned pnpm: corepack prepare pnpm@11.7.0 --activate && pnpm install --lockfile-only')
} else {
  console.log('release-contract: PASS')
}
