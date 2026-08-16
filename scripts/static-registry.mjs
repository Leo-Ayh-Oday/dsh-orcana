#!/usr/bin/env node
/**
 * Static registry for release-link verification (R0): serves the local
 * `@leooday/*` tarballs as a real npm registry and proxies everything else
 * to an upstream registry. Lets us prove the full `dsh plugin add` chain
 * (metadata → tarball → dependency resolution → boot) without publishing.
 *
 * usage: node scripts/static-registry.mjs <packages-dir> [--port 4873] [--upstream https://registry.npmmirror.com]
 */
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const [packagesDir, ...rest] = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = rest.indexOf(name)
  return at >= 0 && rest[at + 1] !== undefined ? rest[at + 1] : fallback
}
const port = Number(flag('--port', 4873))
const upstream = flag('--upstream', 'https://registry.npmmirror.com')

if (!packagesDir || !existsSync(packagesDir)) {
  console.error('usage: static-registry.mjs <packages-dir> [--port N] [--upstream URL]')
  process.exit(1)
}

const tarballs = new Map() // "scope/name" -> { file, shasum, packageJson }
for (const file of readdirSync(packagesDir)) {
  if (!file.endsWith('.tgz')) continue
  const dir = join(packagesDir, `extract-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  execFileSync('tar', ['-xzf', join(packagesDir, file), '-C', dir])
  const pkg = JSON.parse(readFileSync(join(dir, 'package', 'package.json'), 'utf8'))
  rmSync(dir, { recursive: true, force: true })
  const shasum = createHash('sha1').update(readFileSync(join(packagesDir, file))).digest('hex')
  const key = pkg.name // "@leooday/governor-core"
  tarballs.set(key, { file: join(packagesDir, file), shasum, pkg })
}

function metadataFor(key) {
  const entry = tarballs.get(key)
  if (entry === undefined) return undefined
  const { pkg, shasum, file } = entry
  const version = pkg.version
  const tarballUrl = `http://127.0.0.1:${port}/${encodeURIComponent(pkg.name)}/-/${pkg.name.split('/')[1]}-${version}.tgz`
  return {
    name: pkg.name,
    'dist-tags': { latest: version },
    versions: {
      [version]: {
        ...pkg,
        _id: `${pkg.name}@${version}`,
        dist: { tarball: tarballUrl, shasum },
      },
    },
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`)
  const path = decodeURIComponent(url.pathname)

  // Local metadata
  const metaMatch = path.match(/^\/(@[\w-]+\/[\w-]+)$/)
  if (metaMatch) {
    const key = metaMatch[1]
    const meta = metadataFor(key)
    if (meta !== undefined) {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(meta))
      return
    }
  }

  // Local tarball
  const tarMatch = path.match(/^\/(@[\w-]+\/[\w-]+)\/-\/[\w.-]+\.tgz$/)
  if (tarMatch) {
    const key = tarMatch[1]
    const entry = tarballs.get(key)
    if (entry !== undefined) {
      const stream = createReadStream(entry.file)
      res.setHeader('content-type', 'application/octet-stream')
      stream.pipe(res)
      return
    }
  }

  // Everything else: proxy upstream (dependency resolution, auth endpoints).
  try {
    const upstreamRes = await fetch(`${upstream}${path}${url.search}`, {
      method: req.method,
      headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : '{}',
    })
    const body = await upstreamRes.text()
    res.statusCode = upstreamRes.status
    res.setHeader('content-type', upstreamRes.headers.get('content-type') ?? 'application/json')
    res.end(body)
  } catch (error) {
    res.statusCode = 502
    res.end(`upstream unavailable: ${error.message}`)
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`static-registry on 127.0.0.1:${port} (${tarballs.size} local packages, upstream ${upstream})`)
})
