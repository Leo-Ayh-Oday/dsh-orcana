# @leooday/dsh-orcana-linux

[English](README.md) | [中文](README.zh.md)

**DSH-native execution evidence + a Windows → WSL execution bridge for Orcana.**

The package has two product responsibilities:

1. **Linux / WSL governance evidence** — DeepSeek Harness remains the sole owner
   of sandbox policy and native enforcement. Orcana observes the actual DSH
   shell result and `SandboxReceipt`; it does not add a second resource limiter
   or network namespace.
2. **Windows → WSL execution transport** — `dsh-orcana` treats Windows as the
   launch surface and starts the whole DSH + Orcana runtime inside one WSL
   Linux execution world before task execution begins.

```text
Windows Terminal / PowerShell
        │
        ▼
    dsh-orcana
        │  cwd / argv / env bridge
        ▼
       WSL
        │
        ▼
       DSH
  sandbox-policy
        │
        ▼
 sandbox-local          ← sole native enforcement owner
 cgroup / prlimit
 network isolation
        │
        ▼
      ctx.shell
        │
        ▼
 SandboxReceipt
        │
        ▼
@leooday/dsh-orcana-linux/native-evidence
        │
        ▼
 ctx.orcanaLinuxEvidence
```

## Authority model

### DSH owns enforcement

Current DSH already owns these policy fields on its `sandbox-policy` row:

- `mode`
- `workspaceRoot`
- `resourceLimits.memoryBytes`
- `resourceLimits.cpuQuotaUs`
- `resourceLimits.pidsMax`
- `network: inherit | none`

Its native sandbox provider chooses the real mechanism (for example cgroup v2
or its documented `prlimit` fallback), owns process attach/detach, performs
cleanup, and produces the final `SandboxReceipt`.

**Orcana must not duplicate that enforcement.** The default bundle therefore
loads:

```text
@leooday/dsh-orcana-linux/native-evidence
```

not the legacy package root.

### Orcana owns evidence/governance

`native-evidence` observes DSH's public `ctx.shell` result seam. It:

- leaves `ShellExecSpec`, sandbox policy, argv, lifecycle, result objects and
  process handles unchanged;
- records foreground results after `shell.run()` settles;
- records background results after the exact returned `ShellProcess.done`
  settles;
- preserves pending background evidence across observer reloads;
- records DSH's real receipt fields: applied layers, degradations, limit
  mechanism, cgroup path, peak memory/CPU/PID facts and cleanup verification;
- records `danger-full-access` honestly as sandbox facts without fabricating a
  native receipt;
- stores only a SHA-256 command fingerprint and byte length — raw command text
  is not retained in the evidence ledger;
- keeps a bounded ledger with total/dropped/pending-background counters.

The service is exposed as:

```ts
ctx.orcanaLinuxEvidence
```

and declares its authority explicitly:

```ts
{
  enforcementOwner: 'dsh',
  observationSeam: 'shell',
  mutatesExecution: false,
  dangerFullAccessObserved: true,
}
```

## Install

Recommended combined Orcana profile:

```sh
dsh plugin --profile orcana add \
  @leooday/dsh-bundle \
  @leooday/dsh-orcana-linux-bundle
```

Linux evidence only:

```sh
dsh plugin --profile orcana-linux add @leooday/dsh-orcana-linux-bundle
```

Installation is **policy-neutral**. The bundle observes native execution facts;
it does not silently enable new network or resource restrictions.

### Configure native limits through DSH

Use a later profile/user patch targeting DSH's existing `sandbox-policy` row.
A DSH row patch replaces that row's whole `config`, so preserve the standing
mode/root when adding limits:

```yaml
- id: sandbox-policy
  config:
    mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
    workspaceRoot: !!js process.cwd()
    network: none
    resourceLimits:
      memoryBytes: 536870912
      pidsMax: 64
      cpuQuotaUs: 50000
```

The resulting DSH receipt — not a parallel Orcana approximation — becomes the
governance evidence.

### Programmatic evidence adapter

```sh
npm i @leooday/dsh-orcana-linux
```

```ts
import nativeEvidence from '@leooday/dsh-orcana-linux/native-evidence'

ctx.plugin(nativeEvidence, {
  ledgerMaxEntries: 1024,
})
```

## Windows → WSL: same command, one Linux execution world

Install the launcher on Windows:

```powershell
npm install -g @leooday/dsh-orcana-linux@^0.4.0
```

Then:

```powershell
dsh-orcana --wsl-doctor
dsh-orcana --wsl-install
dsh-orcana "fix the failing tests"
```

Linux / WSL uses the same task command:

```sh
dsh-orcana "fix the failing tests"
```

The target WSL distro must satisfy the pinned DSH Node contract:

```text
^22.19.0 || >=24.0.0
```

A global `dsh` install is optional. The launcher verifies an installed DSH
before using it and otherwise falls back to its pinned compatible npm release.
The v0.4 bridge default is:

```text
@deepseek-ai/dsh@0.1.0-rc.5
pnpm@11.7.0
```

### Bridge invariants

1. **One execution world** — Windows does not run DSH and bounce individual
   tools into WSL. The whole runtime enters WSL first.
2. **cwd is translated by WSL itself** — no hard-coded `/mnt/c` assumption;
   `\\wsl.localhost\Distro\...` and `\\wsl$\Distro\...` are recognized.
3. **argv stays positional** — Chinese, emoji, quotes, backslashes, newlines,
   shell metacharacters and the DSH `--` sentinel are not reinterpreted as a
   user-controlled shell string.
4. **DSH-owned paths are translated narrowly** — launcher `--patch` paths and
   local filesystem specs owned by `dsh plugin` are mapped; task/app argv stays
   opaque.
5. **Environment forwarding is selective and one-way** — common provider keys,
   base URLs, proxies, bootstrap-only network settings and certificate paths are
   bridged through `WSLENV`; values are not injected into task argv.
6. **Windows runtime home is isolated** — Windows `DSH_HOME`, `HOME`, `PATH` and
   native `node_modules` are not reused inside WSL.
7. **Terminal ownership stays native** — stdio and Windows console cancellation
   remain on the normal `wsl.exe` path; the bridge does not fake POSIX signals
   with Windows `child.kill()`.
8. **Version drift fails visibly** — the install path pins DSH, pnpm, Orcana
   runtime packages and bundles, then performs profile composition plus real
   module/peer import probes.

## `--wsl-doctor`

The doctor checks more than “does WSL exist?” It currently covers:

- WSL2 / kernel and Node runtime compatibility;
- pinned DSH and pnpm toolchain availability;
- Orcana headless + web profile manifest/module verification;
- Windows ↔ WSL localhost web reachability;
- loopback proxy reachability without printing credentials;
- current workspace path mapping and WSL-native vs Windows-mounted storage;
- Git worktree usability and identity;
- HTTPS credential-helper / visible credential-manager capability;
- SSH agent/default-key capability without printing key names;
- TTY, UTF-8 locale, path round-trip, filesystem/mount semantics and WSL
  interop;
- DrvFS metadata warnings when Windows-mounted workspaces cannot provide native
  Linux permission semantics.

Parity warnings explain semantic drift but do not silently rewrite Git, WSL,
mount or credential configuration.

For Git/npm/build-heavy workloads, storing the project on the WSL Linux
filesystem remains the fast and closest-to-native path.

## Current evidence scope

The product-owned `orcana` (headless) and `orcana-web` profiles use the ordinary
DSH shell execution path, so foreground/background shell executions receive the
native evidence described above.

A custom DSH profile may add other execution capabilities. In particular, the
current DSH persistent-terminal/PTY implementation confines its argv but does
not yet expose the same lifecycle receipt through the shell result seam.
`native-evidence` therefore **does not claim terminal/PTTY receipt parity** for
such custom profiles. It will not fabricate evidence to hide that gap.

## Legacy compatibility entrypoint

The package root:

```text
@leooday/dsh-orcana-linux
```

still exposes the earlier argv-hardening plugin for compatibility with existing
programmatic consumers. That legacy path patches `ctx.sandbox.confine` and is
**not mounted by the current bundle**.

New DSH integrations should use:

```text
@leooday/dsh-orcana-linux/native-evidence
```

Native resource/network policy belongs to DSH `sandbox-policy`.

## Published subpaths

```text
@leooday/dsh-orcana-linux
@leooday/dsh-orcana-linux/native-evidence
@leooday/dsh-orcana-linux/wsl-bridge
@leooday/dsh-orcana-linux/wsl-launcher
```

`wsl-launcher` is the preferred product API; `wsl-bridge` is the lower-level
transport primitive.

## Development / release

```sh
pnpm install
pnpm --filter @leooday/dsh-orcana-linux typecheck
pnpm --filter @leooday/dsh-orcana-linux test
pnpm --filter @leooday/dsh-orcana-linux build
pnpm --filter @leooday/dsh-orcana-linux pack
```

`prepack` runs typecheck + tests + build. The profile verifier probes the actual
runtime modules, including `@leooday/dsh-orcana-linux/native-evidence`, so a
broken export map or DSH/Cordis peer chain cannot pass merely because the
legacy package root imports successfully.

The repository release contract also intentionally blocks a stale workspace
lockfile. Regenerate `pnpm-lock.yaml` with the repository-pinned pnpm in a
registry-connected environment before release; do not hand-edit DSH dependency
snapshots.

## License

MIT — see [LICENSE](../../LICENSE).
