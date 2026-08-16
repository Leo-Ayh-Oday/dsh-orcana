const SCALAR_WIN_TO_WSL = Object.freeze([
  'DEEPSEEK_SEARCH_BASE_URL',
  'ALL_PROXY',
  'all_proxy',
] as const)

const PATH_WIN_TO_WSL = Object.freeze([
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
] as const)

const PATH_LIST_WIN_TO_WSL = Object.freeze([
  'SSL_CERT_DIR',
] as const)

type WslEnvMode = '' | 'p' | 'l'

function wslenvName(entry: string): string {
  const slash = entry.indexOf('/')
  return slash === -1 ? entry : entry.slice(0, slash)
}

function ownedEntry(name: string, mode: WslEnvMode): string {
  return `${name}/${mode}u`
}

function upsertOneWayEntry(entries: string[], name: string, mode: WslEnvMode): void {
  const first = entries.findIndex(entry => wslenvName(entry) === name)
  const normalized = ownedEntry(name, mode)
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
 * - scalar network settings: one-way `/u`
 * - single certificate/trust paths: one-way path translation `/pu`
 * - certificate directory lists: one-way path-list translation `/lu`
 *
 * Values never enter argv. Existing unrelated WSLENV rows are preserved.
 * Rows owned by this launcher are normalized to deterministic flags even when
 * the inherited WSLENV contained reverse-only or incorrect path/list modes.
 */
export function augmentWslHostEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env }
  const entries = (env.WSLENV ?? '').split(':').filter(Boolean)

  for (const name of SCALAR_WIN_TO_WSL) {
    if (env[name] !== undefined) upsertOneWayEntry(entries, name, '')
  }
  for (const name of PATH_WIN_TO_WSL) {
    if (env[name] !== undefined) upsertOneWayEntry(entries, name, 'p')
  }
  for (const name of PATH_LIST_WIN_TO_WSL) {
    if (env[name] !== undefined) upsertOneWayEntry(entries, name, 'l')
  }

  next.WSLENV = entries.join(':')
  return next
}

export const WSL_HOST_SCALAR_ENV = SCALAR_WIN_TO_WSL
export const WSL_HOST_PATH_ENV = PATH_WIN_TO_WSL
export const WSL_HOST_PATH_LIST_ENV = PATH_LIST_WIN_TO_WSL
