# @leooday/dsh-orcana-linux

[English](README.md) | [中文](README.zh.md)

**Orcana Linux execution hardening for DeepSeek Harness (DSH), with a Windows → WSL bridge.**

Native hardening layers run as a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
plugin over the **official** sandbox contract (no fork required). Starting in
v0.4, the same package also ships `dsh-orcana`: a host entrypoint that runs DSH
directly on Linux/WSL and moves the **entire DSH process** into WSL when invoked
from Windows. Windows remains a launch surface; the task itself stays in one
native Linux execution world.

- **Resource limits** — `memoryBytes` / `pidsMax` enforced as a `prlimit` argv
  prefix on Linux (`--as` = RLIMIT_AS **address-space approximation**, not a
  cgroup memory cap; `--nproc` = **PER-UID** live-task cap, not per-cell PID
  authority). `cpuQuotaUs` needs cgroup v2 authority and currently degrades.
- **Egress policy** — `network: 'none'` denies all network on supported native
  runners: `--unshare-net` for bwrap and `(deny network*)` for Seatbelt.
- **Fail-closed by default** — a requested layer this host cannot express
  throws `HARDENING_UNAVAILABLE` instead of running unenforced. Use
  `best-effort` only when the weakening is deliberate.
- **Execution evidence** — every confinement is recorded in a bounded
  `ctx.hardening` ledger with requested facts, applied layers, structured
  degradations, failures, and dropped/total counters.
- **Windows → WSL bridge** — cwd is translated by the selected distro's own
  `wslpath`; task argv remains positional; selected runtime environment crosses
  through one-way `WSLENV`; Windows `DSH_HOME` is not reused in Linux.

## Guarantees

```text
✓ confined read-only / workspace-write executions can be hardened through ctx.sandbox
✓ network-none on supported native runner (bwrap / Seatbelt)
✓ RLIMIT_AS / RLIMIT_NPROC fallback with explicit semantics
✓ required | best-effort layer policy
✓ bounded hardening evidence ledger
✓ lifecycle-correct confine patch and exact dispose restoration
✓ duplicate live instances fail loud
✓ one cross-platform dsh-orcana entrypoint
✓ whole DSH runtime enters WSL before task/tool execution on Windows
✓ cwd resolved by the selected WSL distro, not a hard-coded /mnt/c guess
✓ DSH -- sentinel and task argv survive the bridge unchanged
✓ installed dsh preferred; npm fallback pinned to a compatible DSH release
✓ API keys, provider base URLs and runtime env forwarded via one-way WSLENV
✓ normal terminal stdio, interactive Ctrl+C and exit status stay on WSL's native path
```

## Non-guarantees

```text
✗ danger-full-access sandbox hardening inside the plugin (that mode bypasses ctx.sandbox)
✗ cgroup v2 memory / pids / cpu authority in this package today
✗ per-cell PID authority
✗ exact CPU quota for cpuQuotaUs
✗ reuse of Windows DSH_HOME / Windows node_modules inside WSL
✗ WSL itself being treated as a security sandbox — it is the Linux execution world boundary here
✗ a separate Orcana programmatic timeout/cancel API in the Windows bridge today
```

## Scope: `danger-full-access`

When DSH is already running in Linux/WSL, `danger-full-access` bypasses the
confined sandbox seam, so those executions are outside this plugin's sandbox
hardening authority. `ctx.hardening.scope` reports that boundary honestly:

```ts
{ confinedModes: true, dangerFullAccess: false }
```

The Windows bridge is a different layer: it moves the **whole DSH runtime** into
WSL before tools run. A full-access tool is therefore still a Linux process; it
is merely not sandbox-hardened by this plugin.

## Install inside Linux / WSL

Recommended hardening bundle:

```sh
dsh plugin --profile orcana-linux add @leooday/dsh-orcana-linux-bundle
```

Combined governor + Linux hardening profile:

```sh
dsh plugin --profile orcana add @leooday/dsh-bundle @leooday/dsh-orcana-linux-bundle
```

The bundle is neutral by default; installation does not silently enable stronger
network or resource restrictions. Configure enforcement through the profile row
or a `--patch` overlay.

For programmatic embedding:

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

## Windows → WSL: same command, one Linux execution world

After v0.4 is published, install the launcher once on Windows:

```powershell
npm install -g @leooday/dsh-orcana-linux@^0.4.0
```

The selected WSL distro needs Node/npm satisfying the current DSH contract:
`^22.19.0 || >=24.0.0`. A global `dsh` installation is optional.

Check the execution world:

```powershell
dsh-orcana --wsl-doctor
```

The doctor reports:

- Linux kernel;
- Node and whether it satisfies the required runtime contract;
- direct `dsh` availability or npm fallback availability;
- `bwrap` and `prlimit` capability visibility;
- whether the current Windows-side cwd is WSL-native storage or a Windows
  filesystem mounted into WSL.

Windows-mounted projects are supported. For Git/npm/build-heavy Linux I/O, a
project stored in the WSL Linux filesystem is the fast path.

With multiple distros:

```powershell
dsh-orcana --wsl-distro Ubuntu-24.04 --wsl-doctor
```

Install the Orcana profile into WSL from Windows Terminal:

```powershell
dsh-orcana --wsl-install
```

Then normal work is the same command on Windows and Linux:

```sh
dsh-orcana "fix the failing tests"
```

The bridge defaults to profile `orcana`. An explicit DSH `--profile` before the
first `--` wins; the bridge default can also be changed independently:

```powershell
dsh-orcana --wsl-profile orcana-linux "run the tests"
dsh-orcana --profile bench "run the benchmark"
```

### Bridge contracts

1. **One execution world.** Windows does not run DSH and forward individual tool
   calls into Linux. `wsl.exe` starts the DSH process inside WSL before task
   execution begins.
2. **cwd is translated, not guessed.** Windows paths are mapped by the selected
   distro's `wslpath`; `\\wsl.localhost\Distro\...` and `\\wsl$\Distro\...`
   are recognized directly. A UNC distro conflicting with `--wsl-distro` fails
   loud.
3. **argv boundaries are preserved.** Bridge-owned `--wsl-*` options are parsed
   only before the first `--`. The sentinel itself and everything after it are
   preserved for DSH. User task text is never interpolated into the fixed
   resolver script.
4. **DSH resolution is deterministic.** `ORCANA_WSL_DSH_COMMAND` can select an
   explicit Linux executable. Otherwise the bridge prefers an installed `dsh`.
   If absent, v0.4.0 falls back to the pinned compatible package
   `@deepseek-ai/dsh@0.1.0-rc.5`, not npm `latest`. Use
   `ORCANA_WSL_DSH_PACKAGE` only for an intentional compatibility test/upgrade.
5. **Environment is one-way and selective.** Common model API keys, common
   provider base URLs, proxies, `DSH_*`, and non-bridge runtime `ORCANA_*`
   variables cross through `WSLENV` entries marked `/u` (Win32 → WSL only).
   `ORCANA_WSL_*` controls remain host-local.
6. **Windows DSH home is never reused.** `DSH_HOME`, `HOME`, and Windows `PATH`
   are not implicitly forwarded. WSL owns its own DSH profile/package graph,
   avoiding Windows-native `node_modules` / executable contamination.
7. **Terminal behavior stays native.** stdio is inherited and `wsl.exe` remains
   the Windows console/cancellation authority. The bridge does not fake POSIX
   signals with Windows `child.kill()` and does not insert an artificial Linux
   session/process-group supervisor into normal interactive runs. The DSH/WSL
   exit status is returned to the caller.

Additional environment variables can be explicitly allowed:

```powershell
$env:ORCANA_WSL_FORWARD_ENV = "MY_CORP_PROXY,MY_BUILD_FLAG"
dsh-orcana "build the project"
```

Bridge controls:

| Variable / flag | Meaning |
|---|---|
| `ORCANA_WSL_DISTRO` / `--wsl-distro` | select WSL distro |
| `ORCANA_WSL_PROFILE` / `--wsl-profile` | default DSH profile (`orcana`) |
| `ORCANA_WSL_DSH_COMMAND` | explicit DSH executable inside WSL |
| `ORCANA_WSL_DSH_PACKAGE` | explicit npm fallback package/version; default is pinned by bridge release |
| `ORCANA_WSL_FORWARD_ENV` | comma-separated extra environment allowlist |
| `--wsl-install` | install governor + Linux hardening bundles into the WSL profile |
| `--wsl-doctor` | inspect target execution world and workspace path class |

`dsh-orcana-wsl` is an explicit alias. `dsh-orcana` is the preferred
cross-platform entrypoint.

## Hardening configuration

| Field | Type | Default | Meaning |
|---|---|---|---|
| `resourceLimits.memoryBytes` | number | — | `prlimit --as` bytes; address-space approximation |
| `resourceLimits.pidsMax` | number | — | `prlimit --nproc`; PER-UID live-task cap |
| `resourceLimits.cpuQuotaUs` | number | — | requires cgroup v2 authority; currently degrades / fails closed |
| `network` | `'inherit' \| 'none'` | — | deny all egress when `none` |
| `degradationPolicy.resourceLimits` | `'required' \| 'best-effort'` | `required` | fail closed vs record-and-continue |
| `degradationPolicy.network` | `'required' \| 'best-effort'` | `required` | same for egress |
| `ledgerMaxEntries` | number | 1024 | bounded audit window |

A caller may attach `resourceLimits` / `network` to its per-call
`sandboxPolicy`; per-call values win over deployment defaults. Degradation
policy and ledger size remain deployment-level.

> **Security note:** a per-call carrier can widen a deployment request. A
> caller explicitly supplying `network: 'inherit'` overrides deployment
> `network: 'none'` for that call. Mandatory egress policy should therefore be
> enforced at the owning sandbox-policy layer.

> **`runnerCommand` note:** runner recognition currently uses exact `argv[0]`.
> A wrapper or absolute `/usr/bin/bwrap` will not be falsely claimed as hardened;
> a required layer fails loud instead.

## How native hardening works

Cordis 4.0.1 does not allow cross-fiber service replacement, so the plugin
patches the resolved `ctx.sandbox` provider's `confine` method:

1. the inner provider confines file effects;
2. Orcana adds requested `prlimit` / network-none layers to the returned argv;
3. a required layer that cannot be expressed fails closed;
4. the bounded ledger records requested/applied/degraded facts;
5. dispose restores the exact original `confine` reference when still owned by
   this plugin.

## Platform matrix

| Surface | Linux / WSL | macOS | Windows host |
|---|---|---|---|
| `dsh-orcana` execution | native | native command path | whole DSH enters WSL |
| resource hardening | `prlimit` | degraded | applied by Linux plugin after entering WSL |
| `network: none` | bwrap `--unshare-net` | Seatbelt | applied by Linux plugin after entering WSL |
| evidence ledger | yes | yes | recorded inside WSL runtime |
| interactive terminal/Ctrl+C | native | native | native `wsl.exe` → Linux path |
| Windows-native hardening | n/a | n/a | not claimed; Linux semantics use WSL bridge |

## Development

```sh
pnpm install
pnpm --filter @leooday/dsh-orcana-linux typecheck
pnpm --filter @leooday/dsh-orcana-linux test
pnpm --filter @leooday/dsh-orcana-linux build
pnpm --filter @leooday/dsh-orcana-linux pack
```

The bridge unit tests pin `--`/argv preservation, deterministic DSH fallback,
profile installation, UNC/wslpath mapping, workspace classification, and
WSLENV isolation without requiring a Windows runner. Native bwrap/prlimit tests
self-skip when the host lacks those capabilities.

## License

MIT — see [LICENSE](../../LICENSE).
