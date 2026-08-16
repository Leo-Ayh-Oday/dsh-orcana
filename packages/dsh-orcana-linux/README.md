# @leooday/dsh-orcana-linux

[English](README.md) | [中文](README.zh.md)

**Orcana Linux execution hardening for DeepSeek Harness (DSH), with a Windows → WSL bridge.**

Native hardening layers run as a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
plugin over the **official** sandbox contract (no fork required). Starting in
v0.4, the same package also ships `dsh-orcana`: a host entrypoint that runs
DSH directly on Linux/WSL and moves the **entire DSH process** into WSL when
invoked from Windows. This keeps one Linux execution world instead of mixing
Windows sandbox/process semantics with Linux subprocesses.

- **Resource limits** — `memoryBytes` / `pidsMax` enforced as a `prlimit` argv
  prefix on Linux (`--as` = RLIMIT_AS **address-space approximation**, not a
  cgroup memory cap; `--nproc` = **PER-UID** live-task cap, not per-cell PID
  authority). `cpuQuotaUs` needs cgroup v2 authority, out of this package's
  current hardening scope — it degrades.
- **Egress policy** — `network: 'none'` denies all network on supported native
  runners: `--unshare-net` for bwrap and `(deny network*)` for Seatbelt.
- **Fail-closed by default** — a requested layer this host cannot express
  throws `HARDENING_UNAVAILABLE` instead of running unenforced. Set the layer's
  degradation policy to `best-effort` only when that weakening is deliberate.
- **Execution evidence** — every confinement is recorded in a bounded audit
  ledger (`ctx.hardening`): requested facts, layers applied, structured
  degradations, failure records, dropped/total counters. Degradation is never
  silent.
- **Windows → WSL execution bridge** — Windows is only the launch surface.
  cwd is translated by the selected distro's `wslpath`; DSH/task argv remains
  positional and is never interpolated into a user-controlled shell string;
  selected runtime environment reaches WSL through one-way `WSLENV` entries;
  the Windows `DSH_HOME` is not reused inside Linux.

## Guarantees

```text
✓ confined executions (read-only / workspace-write) through ctx.sandbox
✓ network-none on supported runner (bwrap / Seatbelt)
✓ RLIMIT_AS / RLIMIT_NPROC fallback (address-space / per-UID semantics)
✓ fail-closed configurable per layer (required | best-effort)
✓ bounded audit ledger (default 1024 entries, dropped/total exposed)
✓ lifecycle-correct patch: dispose restores the exact original confine
✓ duplicate live instances fail loud (DUPLICATE_HARDENING_INSTANCE)
✓ host capability probe at most once per plugin mount
✓ one cross-platform `dsh-orcana` entrypoint
✓ Windows cwd mapped by WSL itself (no hard-coded /mnt/c assumption)
✓ DSH `--` sentinel and task argv survive the bridge unchanged
✓ prefer installed `dsh`, safely fall back to official `npx --yes @deepseek-ai/dsh`
✓ API/runtime environment forwarding via one-way WSLENV, not command-line secrets
```

## Non-guarantees

```text
✗ danger-full-access hardening inside the plugin (it bypasses ctx.sandbox)
✗ cgroup v2 memory / pids / cpu authority in this package today
✗ per-cell PID authority
✗ CPU quota (cpuQuotaUs degrades / fails closed)
✗ Windows DSH_HOME/node_modules reused inside WSL
✗ WSL itself being a security sandbox — it is an execution transport/world boundary
✗ fake POSIX signal forwarding from Windows child.kill(); deterministic Linux process-group cancellation is future supervisor work
```

## Scope: `danger-full-access`

When DSH itself is already running in Linux/WSL, `danger-full-access` bypasses
the confined sandbox seam entirely (the official bash executor runs the local
path and never calls `ctx.sandbox.confine`). Those executions are therefore
outside the plugin hardening authority; `ctx.hardening.scope` reports this
honestly as `{ confinedModes: true, dangerFullAccess: false }`.

This is distinct from the Windows bridge: the bridge moves the **whole DSH
runtime** into WSL before any tool execution, so even full-access tools still
execute in the Linux world. They are not sandbox-hardened, but they also do not
fall back to Windows process semantics.

## Install

The package family uses the `@leooday` scope. Recommended DSH bundle install
**inside Linux/WSL**:

```sh
dsh plugin --profile orcana-linux add @leooday/dsh-orcana-linux-bundle
```

For the combined governor + Linux hardening profile:

```sh
dsh plugin --profile orcana add @leooday/dsh-bundle @leooday/dsh-orcana-linux-bundle
```

If no global `dsh` executable is installed, the v0.4 bridge uses the official
DSH npm form automatically:

```sh
npx --yes @deepseek-ai/dsh ...
```

`dsh plugin add` installs the bundle and auto-activates the hardening row as a
profile layer with NEUTRAL defaults; enforce layers via the row's config (see
the [bundle README](../dsh-orcana-linux-bundle/README.md)). For checkout-based
development, use [`scripts/install-orcana-linux.sh`](../../scripts/install-orcana-linux.sh).

For programmatic embedding, install the package and load the plugin after the
sandbox provider:

```sh
npm i @leooday/dsh-orcana-linux
```

```ts
import { apply as hardening } from '@leooday/dsh-orcana-linux'

ctx.plugin(hardening, {
  network: 'none',
  resourceLimits: { memoryBytes: 512 * 1024 * 1024 },
})
```

## Windows → WSL: same command, one execution world

For the v0.4 release, install the package on the Windows side so the launcher
command exists:

```powershell
npm install -g @leooday/dsh-orcana-linux@^0.4.0
```

The target WSL distro needs Node/npm. A global `dsh` install is optional:
`dsh-orcana` prefers `dsh` when present and otherwise runs
`npx --yes @deepseek-ai/dsh` inside WSL.

Check the WSL execution world:

```powershell
dsh-orcana --wsl-doctor
```

The doctor reports the Linux kernel, Node, the DSH launch path (`dsh` or npx
fallback), `bwrap`, `prlimit`, and `setsid`. It also tells you whether the
current workspace is WSL-native or a Windows filesystem mounted into WSL.
The latter is supported; for Git/npm/build-heavy Linux workloads, a project
stored under the WSL Linux filesystem is the fast path.

If multiple distros are installed:

```powershell
dsh-orcana --wsl-distro Ubuntu-24.04 --wsl-doctor
```

Install the Orcana profile into WSL from the Windows terminal:

```powershell
dsh-orcana --wsl-install
```

Then normal work is one command on both Windows and Linux:

```powershell
dsh-orcana "fix the failing tests"
```

Equivalent Linux/WSL invocation:

```sh
dsh-orcana "fix the failing tests"
```

The bridge defaults to profile `orcana`. An explicit DSH `--profile` before
`--` is preserved, or the bridge default can be changed without touching DSH
args:

```powershell
dsh-orcana --wsl-profile orcana-linux "run the tests"
dsh-orcana --profile bench "run the benchmark"
```

### WSL bridge contracts

The bridge deliberately treats Windows as a launcher, not as a second runtime:

1. **cwd** — Windows drive paths are translated by `wslpath` inside the
   selected distro. It does not assume `/mnt/c`, so custom WSL automount roots
   remain valid. `\\wsl.localhost\Distro\...` and `\\wsl$\Distro\...` cwd
   forms are recognized directly.
2. **argv** — bridge-owned `--wsl-*` flags are parsed only before the first
   `--`; the sentinel itself and everything after it are preserved for DSH.
   Normal task text is passed as positional argv. The automatic dsh/npx
   resolver is a fixed script and receives user arguments only through `$@`.
3. **DSH resolution** — an explicit `ORCANA_WSL_DSH_COMMAND` wins. Otherwise
   the bridge uses `dsh` if available, then falls back to
   `npx --yes @deepseek-ai/dsh`.
4. **environment** — provider credentials commonly used by DSH plus `DSH_*`
   and runtime `ORCANA_*` variables cross through `WSLENV` with `/u` (Win32 →
   WSL only); their values are not placed in the process command line.
   `ORCANA_WSL_*` bridge controls stay host-local.
5. **DSH home** — `DSH_HOME` is intentionally **not** forwarded. A Windows
   profile can contain Windows-native `node_modules`; sharing it with WSL would
   reintroduce cross-platform ABI and executable contamination. WSL owns its
   own DSH profile graph.
6. **stdio / exit / cancellation** — terminal stdio is inherited and the
   WSL/DSH exit code is returned. On native POSIX the launcher can relay
   SIGINT/SIGTERM. On Windows it deliberately does **not** fake POSIX signals
   with Node `child.kill()`; Ctrl+C remains a console/WSL boundary today.
   Deterministic Linux process-group cancellation is the next supervisor layer.

Additional environment variables can be explicitly allowed through the bridge:

```powershell
$env:ORCANA_WSL_FORWARD_ENV = "MY_CORP_PROXY,MY_BUILD_FLAG"
dsh-orcana "build the project"
```

Bridge controls:

| Variable / flag | Meaning |
|---|---|
| `ORCANA_WSL_DISTRO` / `--wsl-distro` | select a WSL distro |
| `ORCANA_WSL_PROFILE` / `--wsl-profile` | default DSH profile (default `orcana`) |
| `ORCANA_WSL_DSH_COMMAND` | optional explicit DSH executable path/name inside WSL; otherwise dsh → npx fallback |
| `ORCANA_WSL_FORWARD_ENV` | comma-separated extra environment allowlist |
| `--wsl-install` | install the Orcana governor + Linux hardening bundles in WSL |
| `--wsl-doctor` | inspect the selected Linux execution world and workspace path class |

`dsh-orcana-wsl` is an explicit alias for the same launcher. `dsh-orcana` is
the preferred cross-platform entrypoint.

## Hardening configuration

| Field | Type | Default | Meaning |
|---|---|---|---|
| `resourceLimits.memoryBytes` | number | — | `prlimit --as` bytes (**address-space approximation**, not "N MB RAM") |
| `resourceLimits.pidsMax` | number | — | `prlimit --nproc` live-task cap (**PER-UID** — caps every process of the calling user) |
| `resourceLimits.cpuQuotaUs` | number | — | cgroup v2 cpu quota per 100 ms — unsupported here today; degrades / fails closed |
| `network` | `'inherit' \| 'none'` | — | deny all egress when `'none'` |
| `degradationPolicy.resourceLimits` | `'required' \| 'best-effort'` | `required` | fail closed vs record-and-continue |
| `degradationPolicy.network` | `'required' \| 'best-effort'` | `required` | same, for egress |
| `ledgerMaxEntries` | number | 1024 | bounded audit window; older records drop and increment `droppedCount` |

### Per-call overrides

A caller can attach `resourceLimits` / `network` to the sandbox policy object
it passes to `confine`; per-call values win over deployment config:

```ts
const spec = shell.resolve({ command: 'make build' })
spec.sandboxPolicy = {
  ...spec.sandboxPolicy!,
  resourceLimits: { memoryBytes: 512 * 1024 * 1024, pidsMax: 32 },
  network: 'none',
}
```

Degradation policy and ledger size stay deployment-level.

> **Security note:** a per-call carrier may widen a deployment request. A
> caller that explicitly supplies `network: 'inherit'` overrides deployment
> `network: 'none'` for that call. The request remains visible in the ledger;
> deployments that require mandatory egress isolation should enforce policy at
> the owning sandbox-policy layer rather than relying on caller discipline.

> **`runnerCommand` note:** runner recognition is based on exact `argv[0]`.
> A custom wrapper or absolute `/usr/bin/bwrap` does not currently match the
> literal `bwrap` hardening branch, so required network hardening fails loud
> rather than silently claiming enforcement.

## How native hardening works

Cordis 4.0.1 refuses service replacement across fibers, so the plugin patches
the resolved `ctx.sandbox` provider instance's `confine` method instead of
replacing the service:

1. the inner provider confines file effects (`bwrap` / Landlock / Seatbelt /
   Windows ACL),
2. the plugin applies its additional layers (`prlimit`, network-none) to the
   returned argv and fails closed when a required layer cannot be expressed,
3. the bounded ledger records requested/applied/degraded facts.

The patch is lifecycle-correct: the exact original `confine` reference is
restored on dispose when still owned by this plugin. A second live instance
against the same provider fails with `DUPLICATE_HARDENING_INSTANCE` instead of
silently stacking configuration.

## Platform matrix

| Surface | Linux / inside WSL | macOS | Windows host |
|---|---|---|---|
| DSH execution through `dsh-orcana` | native | native command path | whole DSH moved to WSL |
| `resourceLimits` hardening | `prlimit` argv prefix | degraded | applied after entering WSL, when configured there |
| `network: 'none'` | bwrap `--unshare-net` | Seatbelt `(deny network*)` | applied after entering WSL, when configured there |
| evidence ledger | yes | yes | yes, inside WSL runtime |
| Windows-native plugin hardening | n/a | n/a | not claimed; use WSL bridge for Linux semantics |

## Development

```sh
pnpm install
pnpm --filter @leooday/dsh-orcana-linux typecheck
pnpm --filter @leooday/dsh-orcana-linux test
pnpm --filter @leooday/dsh-orcana-linux build
pnpm --filter @leooday/dsh-orcana-linux pack
```

The WSL bridge unit tests are host-independent: they pin sentinel/argv
preservation, DSH resolver fallback, profile installation, UNC/wslpath mapping,
workspace classification, and WSLENV isolation without requiring a Windows
runner. Native integration tests self-skip when bwrap / prlimit are unavailable.

## License

MIT — see [LICENSE](../../LICENSE).
