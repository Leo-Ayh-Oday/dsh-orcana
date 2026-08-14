# @orcana/dsh-orcana-linux

**Orcana confined-execution hardening for DeepSeek Harness (DSH).**

Native hardening layers as a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
plugin, over the **official** sandbox contract (no fork required). This package
hardens DSH executions that traverse `ctx.sandbox` — it is the
compatibility/hardening layer, **not** the full Orcana Execution Fabric
(cgroup v2 authority, pidfd ownership, `ctx.subprocess` / `ctx.codeRuntime`
interception are future work; see DEFERRED-01…06 in the R1 report).

- **Resource limits** — `memoryBytes` / `pidsMax` enforced as a `prlimit` argv
  prefix on Linux (`--as` = RLIMIT_AS **address-space approximation**, not a
  cgroup memory cap; `--nproc` = **PER-UID** live-task cap, not per-cell PID
  authority). `cpuQuotaUs` needs cgroup v2 authority, out of this package's
  scope — it always degrades.
- **Egress policy** — `network: 'none'` denies all network: `--unshare-net`
  injected into a bwrap argv (fresh netns, no routes), `(deny network*)`
  appended to a Seatbelt profile.
- **Fail-closed by default** — a requested layer this host cannot express
  throws `HARDENING_UNAVAILABLE` instead of running unenforced. Set
  `degradationPolicy` to `best-effort` to record-and-continue instead.
- **Execution evidence** — every confinement is recorded in a **bounded**
  audit ledger (`ctx.hardening`): requested facts, layers applied, structured
  degradations, failure records, dropped/total counters. Degradation is never
  silent.

## Guarantees

```
✓ confined executions (read-only / workspace-write) through ctx.sandbox
✓ network-none on supported runner (bwrap / Seatbelt)
✓ RLIMIT_AS / RLIMIT_NPROC fallback (address-space / per-UID semantics)
✓ fail-closed configurable per layer (required | best-effort)
✓ bounded audit ledger (default 1024 entries, dropped/total exposed)
✓ lifecycle-correct patch: dispose restores the exact original confine
✓ duplicate live instances fail loud (DUPLICATE_HARDENING_INSTANCE)
✓ host capability probe at most once per plugin mount
```

## Non-guarantees

```
✗ danger-full-access executions (they bypass ctx.sandbox — see below)
✗ cgroup v2 memory / pids / cpu authority
✗ per-cell PID authority
✗ CPU quota (cpuQuotaUs degrades / fails closed)
✗ process ownership / crash recovery
✗ service lifecycle (ctx.subprocess / ctx.codeRuntime / PTC worker isolation)
```

## Scope: `danger-full-access`

DSH's `danger-full-access` mode bypasses the confined sandbox seam entirely
(the official bash executor runs `super.run()` and never calls
`ctx.sandbox.confine`). Executions under that mode are therefore **outside
this package's enforcement authority**. `ctx.hardening.scope` reports this
honestly: `{ confinedModes: true, dangerFullAccess: false }`. Hardening
`danger-full-access` requires intercepting `ctx.subprocess` / the shell path
— future work (DEFERRED-02).

## Install

```sh
npm i @orcana/dsh-orcana-linux
# or via a DSH profile bundle: @orcana/dsh-orcana-linux-bundle
```

Load the plugin after the harness registered its sandbox provider (the
`apply.inject = ['sandbox']` declaration enforces the ordering):

```ts
import { Context } from '@deepseek-ai/cordis'
import { apply as hardening } from '@orcana/dsh-orcana-linux'

// in your harness bootstrap, after ctx.plugin(LocalSandboxProvider, {...}):
ctx.plugin(hardening, {
  network: 'none',                                  // deny egress
  resourceLimits: { memoryBytes: 512 * 1024 * 1024 }, // RLIMIT_AS approximation
})
```

## Configuration

| Field | Type | Default | Meaning |
|---|---|---|---|
| `resourceLimits.memoryBytes` | number | — | `prlimit --as` bytes (**address-space approximation**, not "N MB RAM") |
| `resourceLimits.pidsMax` | number | — | `prlimit --nproc` live-task cap (**PER-UID** — caps every process of the calling user) |
| `resourceLimits.cpuQuotaUs` | number | — | cgroup v2 cpu quota per 100 ms — **always unsupported here**; degrades / fails closed |
| `network` | `'inherit' \| 'none'` | — | deny all egress when `'none'` |
| `degradationPolicy.resourceLimits` | `'required' \| 'best-effort'` | `required` | fail closed (throw `HARDENING_UNAVAILABLE`) vs record-and-continue |
| `degradationPolicy.network` | `'required' \| 'best-effort'` | `required` | same, for the egress layer |
| `ledgerMaxEntries` | number | 1024 | bounded audit window; older records drop and count toward `droppedCount` |

### Per-call overrides

A caller can attach `resourceLimits` / `network` to the sandbox policy object
it passes to `confine` (e.g. a bash spec's `sandboxPolicy` override); the
per-call values win over the deployment config:

```ts
const spec = shell.resolve({ command: 'make build' })
spec.sandboxPolicy = {
  ...spec.sandboxPolicy!,
  resourceLimits: { memoryBytes: 512 * 1024 * 1024, pidsMax: 32 },
  network: 'none',
}
```

Degradation policy and ledger size stay deployment-level.

## How it works

cordis 4.0.1 refuses service replacement across fibers, so the plugin
**patches the resolved `ctx.sandbox` provider instance's `confine` method**
instead of replacing the service:

1. the inner provider confines file effects as usual (`bwrap` / Landlock /
   Seatbelt / Windows ACL),
2. the plugin applies its layers to the returned argv (`prlimit` prefix,
   `--unshare-net` / `(deny network*)` injection), failing closed when a
   `required` layer cannot be expressed,
3. the ledger records what was requested, what applied, and what degraded.

The patch is lifecycle-correct: the original `confine` is captured at mount
and restored **exactly** at dispose (guarded so other plugins' patches are
never clobbered); a second live instance against the same provider fails loud
(`DUPLICATE_HARDENING_INSTANCE`) instead of silently ignoring its
configuration. Host capabilities (`prlimit` availability) are probed once per
plugin mount, never per confinement.

## Platform matrix

| Layer | Linux | macOS | Windows |
|---|---|---|---|
| `resourceLimits` | `prlimit` argv prefix | degraded (no prlimit) | degraded |
| `network: 'none'` | bwrap `--unshare-net` | Seatbelt `(deny network*)` | degraded |
| evidence ledger | yes | yes (structured degradation) | yes |

## Development

```sh
pnpm install
pnpm --filter @orcana/dsh-orcana-linux typecheck
pnpm --filter @orcana/dsh-orcana-linux test   # 32 tests: pure units + real-provider integration
pnpm --filter @orcana/dsh-orcana-linux build
```

Integration tests self-skip when bwrap / prlimit are unavailable on the host.

## License

MIT — see [LICENSE](../../LICENSE).
