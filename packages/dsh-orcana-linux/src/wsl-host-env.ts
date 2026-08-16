const SCALAR_WIN_TO_WSL = Object.freeze([
  'DEEPSEEK_SEARCH_BASE_URL',
  'ALL_PROXY',
  'all_proxy',
] as const)

const PATH_WIN_TO_WSL = Object.freeze([
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
] as const)

function wslenvName(entry: string): string {
  const slash = entry.indexOf('/')
  return slash === -1 ? entry : entry.slice(0, slash)
}

function ownedEntry(name: string, pathValue: boolean): string {
  return `${name}/${pathValue ? 'p' : ''}u`
}

function upsertOneWayEntry(entries: string[], name: string, pathValue: boolean): void {
  const first = entries.findIndex(entry => wslenvName(entry) === name)
  const normalized = ownedEntry(name, pathValue)
  if (first === -1) {
    entries.push(normalized)
    return
  }

  entries[first] = normalized
  for (let i = entries.length - 1; i > first; i -= 1) {
    if (wslenvName(entries[i]!) === name) entries.splice(i, 1)
  }
}

/**
 * Add DSH bootstrap-only host settings that need to survive Windows → WSL.
 *
 * Scalar network settings cross one-way (`/u`). Certificate/trust settings
 * are Windows paths, so they cross one-way with WSL path translation (`/pu`).
 * Values never enter argv. Existing unrelated WSLENV rows are preserved.
 * Rows owned by this launcher are normalized to deterministic flags even when
 * the inherited WSLENV contained reverse-only or list/path modifiers.
 */
export function augmentWslHostEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env }
  const entries = (env.WSLENV ?? '').split(':').filter(Boolean)

  for (const name of SCALAR_WIN_TO_WSL) {
    if (env[name] !== undefined) upsertOneWayEntry(entries, name, false)
  }
  for (const name of PATH_WIN_TO_WSL) {
    if (env[name] !== undefined) upsertOneWayEntry(entries, name, true)
  }

  next.WSLENV = entries.join(':')
  return next
}

export const WSL_HOST_SCALAR_ENV = SCALAR_WIN_TO_WSL
export const WSL_HOST_PATH_ENV = PATH_WIN_TO_WSL
