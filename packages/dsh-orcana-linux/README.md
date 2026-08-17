# @leooday/dsh-orcana-linux

[English](README.md) | [中文](README.zh.md)

**DSH-native shell evidence + a Windows → WSL execution bridge for Orcana.**

The package has two product responsibilities:

1. **Linux / WSL governance evidence** — DeepSeek Harness remains the sole owner
   of sandbox policy and enforcement. Orcana observes the public rc.6 shell
   sandbox facts; it does not add a second sandbox, resource limiter, or network
   namespace.
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
       DSH rc.6
  sandbox-policy
  { mode, workspaceRoot, sessionId? }
        │
        ▼
 sandbox-local          ← sole native confinement owner
        │
        ▼
      ctx.shell
        │
        └─ sandbox facts
           { mode, denied, enforcement?, runnerFailed? }
        │
        ▼
@leooday/dsh-orcana-linux/native-evidence
        │
        ▼
 ctx.orcanaLinuxEvidence
```

## Authority model

### DSH owns enforcement

The rc.6 public `SandboxExecutionPolicy` is a file-effect policy:

- `mode`
- `workspaceRoot`
- optional `sessionId`

The DSH sandbox provider owns actual confinement. `ShellRunResult.sandbox` and
`ShellProcess.sandbox` expose the post-execution facts that Orcana can safely
observe:

- `mode`
- `denied`
- optional `enforcement`
- optional `runnerFailed`

rc.6 does **not** expose the previous `SandboxReceipt`, resource-limit policy,
or network policy/evidence API on this seam. Orcana does not recover those
removed claims from argv, stderr, private provider state, or type assertions.

The default bundle loads:

```text
@leooday/dsh-orcana-linux/native-evidence
```

not the legacy package root.

### Orcana owns evidence/governance

`native-evidence` observes DSH's public `ctx.shell` result seam. It:

- leaves `ShellExecSpec`, sandbox policy, argv, lifecycle, result objects and
  process handles unchanged;
- snapshots request-time `mode` + `workspaceRoot` before execution;
- records foreground results after `shell.run()` settles;
- records background results after the exact returned `ShellProcess.done`
  settles;
- preserves pending background accounting across observer reloads within the
  same DSH process;
- records only rc.6 `ShellSandboxInfo` facts after execution;
- records `danger-full-access` honestly as sandbox facts;
- stores only a SHA-256 command fingerprint and byte length — raw command text
  is not retained in the evidence ledger;
- deeply freezes Orcana-owned detached snapshots without freezing or mutating
  DSH's original result objects;
- keeps a bounded ledger with total/dropped/pending-background counters;
- correlates normal ToolRuntime work to session/call/root-call/tool identity.

Evidence kind is intentionally narrow:

```ts
type NativeEvidenceKind = 'sandbox-facts' | 'none'
```

There is no `native-receipt` compatibility fiction on rc.6.

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

### Causal queries

Normal DSH ToolRuntime calls are associated with:

```text
sessionId
callId
rootCallId
toolName
```

Multiple selectors are conjunctive. Direct programmatic `ctx.shell` calls are
recorded honestly without correlation.

```ts
const bySession = ctx.orcanaLinuxEvidence.find({ sessionId })
const byRootCall = ctx.orcanaLinuxEvidence.find({ rootCallId })
const exact = ctx.orcanaLinuxEvidence.latest({ sessionId, callId })
```

The ledger is process-local evidence. Observer reloads preserve the shared
in-process state, but a DSH process restart does not make these records durable.

## Install

Recommended combined Orcana profile:

```sh
dsh plugin --profile orcana add \
  @leooday/dsh-bundle \
  @leooday/dsh-orcana-linux-bundle \
  @deepseek-ai/dsh-headless@next
```

Linux evidence only:

```sh
dsh plugin --profile orcana-linux add @leooday/dsh-orcana-linux-bundle
```

Installation is **policy-neutral**. The bundle observes execution facts; it does
not silently enable new restrictions.

### Upgrade from legacy hardening config

Bundle `0.3.0` keeps the `dsh-orcana-linux` row id while switching its target to
`/native-evidence`. If an existing profile still supplies legacy fields:

```text
network
resourceLimits
degradationPolicy
capabilities
```

mount fails with:

```text
LEGACY_HARDENING_CONFIG_MOVED
```

This is deliberate. rc.6 has no public resource/network/receipt equivalent, so
silently dropping or reinterpreting the old fields would falsely imply the old
hardening still exists. Remove the legacy Orcana fields and configure only
capabilities that the installed DSH rc.6 actually exposes.

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
The v0.4 R5 bridge contract is:

```text
@deepseek-ai/dsh@0.1.0-rc.6
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
5. **Environment forwarding is selective and one-way** — provider keys, base
   URLs, proxies, bootstrap networking settings and certificate paths are
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

The doctor currently covers:

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
DSH shell execution path, so foreground/background shell executions can expose
the sandbox-facts evidence described above.

A custom profile may add execution capabilities outside this shell result seam.
`native-evidence` does **not** claim evidence parity for those paths and will not
fabricate a receipt or resource/network proof to hide the gap.

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

## License

MIT — see [LICENSE](../../LICENSE).
