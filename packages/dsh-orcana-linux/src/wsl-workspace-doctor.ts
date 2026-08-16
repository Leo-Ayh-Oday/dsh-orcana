import { spawnSync } from 'node:child_process'

export const WSL_WORKSPACE_DOCTOR_SCRIPT = [
  'fail=0',
  'printf "workspace-fs: "; if command -v stat >/dev/null 2>&1; then stat -f -c %T . 2>/dev/null || printf "UNKNOWN\\n"; else printf "UNKNOWN (stat missing)\\n"; fi',
  'printf "wsl-networking: "; if command -v wslinfo >/dev/null 2>&1; then wslinfo --networking-mode 2>/dev/null || printf "UNKNOWN\\n"; else printf "UNKNOWN (wslinfo missing)\\n"; fi',
  'repo_hint=0',
  'probe=$PWD',
  'while [ -n "$probe" ] && [ "$probe" != "/" ]; do if [ -e "$probe/.git" ]; then repo_hint=1; break; fi; probe=${probe%/*}; [ -n "$probe" ] || probe=/; done',
  'if ! command -v git >/dev/null 2>&1; then printf "git: MISSING\\n"; if [ "$repo_hint" -eq 1 ]; then printf "git-worktree: UNUSABLE (repository metadata exists but git is missing)\\n"; fail=70; fi; exit "$fail"; fi',
  'printf "git: "; git --version',
  'if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then',
  '  printf "git-worktree: OK\\n"',
  '  if [ -n "$(git config --get user.name 2>/dev/null || true)" ] && [ -n "$(git config --get user.email 2>/dev/null || true)" ]; then printf "git-identity: configured\\n"; else printf "git-identity: MISSING (commits may fail until WSL Git identity is configured)\\n"; fi',
  '  origin=$(git remote get-url origin 2>/dev/null || true)',
  '  case "$origin" in git@*|ssh://*) auth=ssh;; http://*|https://*) auth=https;; "") auth=none;; *) auth=other;; esac',
  '  printf "git-origin-auth: %s\\n" "$auth"',
  '  if [ "$auth" = https ]; then if git config --get-all credential.helper >/dev/null 2>&1; then printf "git-https-credentials: helper-configured\\n"; else printf "git-https-credentials: NO-HELPER (interactive/token auth may still work)\\n"; fi; fi',
  '  if [ "$auth" = ssh ]; then if [ -n "${SSH_AUTH_SOCK:-}" ] && [ -S "$SSH_AUTH_SOCK" ]; then printf "git-ssh-agent: available\\n"; else printf "git-ssh-agent: NO-AGENT (WSL key files may still work; Windows agent is not copied automatically)\\n"; fi; fi',
  'elif [ "$repo_hint" -eq 1 ]; then',
  '  printf "git-worktree: UNUSABLE (check safe.directory, ownership, permissions, or repository metadata)\\n"',
  '  fail=70',
  'else',
  '  printf "git-worktree: not-a-repository\\n"',
  'fi',
  'exit "$fail"',
].join('\n')

function distroPrefix(distro?: string): string[] {
  return distro === undefined ? [] : ['--distribution', distro]
}

export function buildWslWorkspaceDoctorArgs(linuxCwd: string, distro?: string): string[] {
  return [
    ...distroPrefix(distro),
    '--cd', linuxCwd,
    '--exec', '/bin/sh', '-c', WSL_WORKSPACE_DOCTOR_SCRIPT,
  ]
}

export function runWslWorkspaceDoctor(
  linuxCwd: string,
  env: NodeJS.ProcessEnv = process.env,
  distro?: string,
  run: typeof spawnSync = spawnSync,
): number {
  const result = run('wsl.exe', buildWslWorkspaceDoctorArgs(linuxCwd, distro), {
    env,
    stdio: 'inherit',
    windowsHide: false,
    timeout: 15_000,
  })
  if (result.error !== undefined || result.status === null) {
    console.error('[orcana-wsl] workspace doctor could not complete; core WSL doctor remains authoritative')
    return 0
  }
  return result.status
}
