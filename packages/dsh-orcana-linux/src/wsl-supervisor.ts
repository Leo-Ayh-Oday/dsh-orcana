import { randomUUID } from 'node:crypto'

export type WslBridgeSignal = 'INT' | 'TERM' | 'KILL'

const SESSION_SCRIPT = [
  'state=$1',
  'package_spec=$2',
  'dsh_command=$3',
  'shift 3',
  'printf "%s\\n" "$$" > "$state" || exit 73',
  'if [ -n "$dsh_command" ]; then exec "$dsh_command" "$@"; fi',
  'if command -v dsh >/dev/null 2>&1; then exec dsh "$@"; fi',
  'if command -v npx >/dev/null 2>&1; then exec npx --yes "$package_spec" "$@"; fi',
  'printf "%s\\n" "dsh-orcana: neither dsh nor npx is available in this Linux execution world" >&2',
  'exit 127',
].join('\n')

const SUPERVISOR_SCRIPT = [
  'run_id=$1',
  'package_spec=$2',
  'dsh_command=$3',
  'shift 3',
  'case "$run_id" in ""|*[!a-f0-9]*) printf "%s\\n" "dsh-orcana: invalid bridge run id" >&2; exit 64;; esac',
  'command -v setsid >/dev/null 2>&1 || { printf "%s\\n" "dsh-orcana: setsid is required for Windows/WSL process-session control" >&2; exit 126; }',
  'command -v pkill >/dev/null 2>&1 || { printf "%s\\n" "dsh-orcana: pkill is required for Windows/WSL process-session control" >&2; exit 126; }',
  'runtime_root="/tmp/dsh-orcana-bridge-$UID"',
  'umask 077',
  'mkdir -p "$runtime_root" || exit 73',
  'state="$runtime_root/$run_id.sid"',
  'cleanup() { rm -f "$state"; }',
  'forward() { sig=$1; [ -s "$state" ] || return 0; IFS= read -r sid < "$state" || return 0; case "$sid" in ""|*[!0-9]*) return 0;; esac; pkill "-$sig" -s "$sid" 2>/dev/null || true; }',
  'trap "forward HUP" HUP',
  'trap "forward INT" INT',
  'trap "forward TERM" TERM',
  'trap cleanup EXIT',
  'ctty_arg=',
  '[ -t 0 ] && ctty_arg=--ctty',
  'setsid --wait $ctty_arg /bin/sh -c "$4" dsh-orcana-session "$state" "$package_spec" "$dsh_command" "$@" &',
  'launcher=$!',
  'status=0',
  'while :; do wait "$launcher"; status=$?; kill -0 "$launcher" 2>/dev/null || break; done',
  'exit "$status"',
].join('\n')

const CONTROL_SCRIPT = [
  'run_id=$1',
  'sig=$2',
  'case "$run_id" in ""|*[!a-f0-9]*) exit 64;; esac',
  'case "$sig" in INT|TERM|KILL) ;; *) exit 64;; esac',
  'state="/tmp/dsh-orcana-bridge-$UID/$run_id.sid"',
  'i=0',
  'while [ ! -s "$state" ] && [ "$i" -lt 20 ]; do sleep 0.05; i=$((i + 1)); done',
  '[ -s "$state" ] || exit 3',
  'IFS= read -r sid < "$state" || exit 3',
  'case "$sid" in ""|*[!0-9]*) exit 65;; esac',
  'pkill "-$sig" -s "$sid"',
].join('\n')

function distroPrefix(distro?: string): string[] {
  return distro === undefined ? [] : ['--distribution', distro]
}

export function createWslBridgeRunId(): string {
  return randomUUID().replaceAll('-', '')
}

/**
 * Build one supervised Windows→WSL DSH launch. User-controlled task arguments
 * are positional parameters only; the fixed supervisor/session scripts are
 * never constructed from task text.
 */
export function buildWslSupervisedDshArgs(
  linuxCwd: string,
  runId: string,
  dshArgs: readonly string[],
  dshPackage: string,
  distro?: string,
  dshCommand?: string,
): string[] {
  return [
    ...distroPrefix(distro),
    '--cd', linuxCwd,
    '--exec', '/bin/sh', '-lc', SUPERVISOR_SCRIPT,
    'dsh-orcana-supervisor',
    runId,
    dshPackage,
    dshCommand ?? '',
    SESSION_SCRIPT,
    ...dshArgs,
  ]
}

/** Build the short control invocation that sends a real Linux session signal. */
export function buildWslSignalArgs(
  runId: string,
  signal: WslBridgeSignal,
  distro?: string,
): string[] {
  return [
    ...distroPrefix(distro),
    '--exec', '/bin/sh', '-lc', CONTROL_SCRIPT,
    'dsh-orcana-control', runId, signal,
  ]
}
