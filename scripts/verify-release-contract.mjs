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
  const nextImporter = lock.indexOf('\n  ', bodyStart)
  const packagesSection = lock.indexOf('\npackages:', bodyStart)
  let end = lock.length
  if (nextImporter !== -1) end = Math.min(end, nextImporter)
  if (packagesSection !== -1) end = Math.min(end, packagesSection)
  return lock.slice(start, end)
}

function requireText(block, needle, label) {
  if (block === undefined) {
    fail(`${label}: importer is missing from pnpm-lock.yaml`)
    return
  }
  if (!block.includes(needle)) fail(`${label}: expected ${JSON.stringify(needle)} in pnpm-lock.yaml importer`)
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

const dshBundleBlock = importerBlock(lock, 'packages/dsh-bundle')
requireText(dshBundleBlock, "'@leooday/dsh-governor':", 'packages/dsh-bundle')
requireText(dshBundleBlock, "'@leooday/governor-core':", 'packages/dsh-bundle')

const governorBlock = importerBlock(lock, 'packages/dsh-governor')
requireText(governorBlock, "'@leooday/governor-core':", 'packages/dsh-governor')
requireText(governorBlock, 'specifier: ^0.1.0-rc.5', 'packages/dsh-governor DSH rc.5 ABI')

const linuxBlock = importerBlock(lock, 'packages/dsh-orcana-linux')
requireText(linuxBlock, "'@deepseek-ai/cordis':", 'packages/dsh-orcana-linux')
requireText(linuxBlock, 'specifier: 4.0.1', 'packages/dsh-orcana-linux Cordis ABI')
requireText(linuxBlock, "'@deepseek-ai/dsh-sandbox':", 'packages/dsh-orcana-linux')
requireText(linuxBlock, 'specifier: 0.1.0-rc.5', 'packages/dsh-orcana-linux DSH rc.5 ABI')

const linuxBundleBlock = importerBlock(lock, 'packages/dsh-orcana-linux-bundle')
requireText(linuxBundleBlock, "'@leooday/dsh-orcana-linux':", 'packages/dsh-orcana-linux-bundle')

if (process.exitCode === 1) {
  console.error('release-contract: FAILED')
  console.error('release-contract: regenerate only with the repository-pinned pnpm: corepack prepare pnpm@11.7.0 --activate && pnpm install --lockfile-only')
} else {
  console.log('release-contract: PASS')
}
