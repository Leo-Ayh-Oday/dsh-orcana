# @orcana/dsh-orcana-linux

**dsh-orcana Linux edition** — native hardening layers as a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin, over the **official** sandbox contract (no fork required).

- **Resource limits** — `memoryBytes` / `pidsMax` / `cpuQuotaUs` enforced as a `prlimit` argv prefix on Linux (`--as` RLIMIT_AS memory approximation, `--nproc` PER-UID task cap; `cpuQuotaUs` has no rlimit equivalent and degrades visibly).
- **Egress policy** — `network: 'none'` denies all network: `--unshare-net` injected into a bwrap argv (fresh netns, no routes), `(deny network*)` appended to a Seatbelt profile.
- **Execution evidence** — every confinement is recorded in an audit ledger (`ctx.hardening.ledger`): layers applied, degradations, mechanism. Degradation is **never silent**.

## Install

```sh
npm i @orcana/dsh-orcana-linux
# or via a DSH profile bundle:
# pnpm --filter @orcana/dsh-orcana-linux-bundle ...
```

Load the plugin after the harness registered its sandbox provider (the
`apply.inject = ['sandbox']` declaration enforces the ordering):

```ts
import { Context } from '@deepseek-ai/cordis'
import { apply as hardening } from '@orcana/dsh-orcana-linux'

// in your harness bootstrap, after ctx.plugin(LocalSandboxProvider, {...}):
ctx.plugin(hardening, {
  resourceLimits: { memoryBytes: 1 * 1024 * 1024 * 1024, pidsMax: 64 },
  network: 'none',
})
```

## Configuration

| Field | Type | Meaning |
|---|---|---|
| `resourceLimits.memoryBytes` | number | `prlimit --as` bytes (address-space approximation) |
| `resourceLimits.pidsMax` | number | `prlimit --nproc` live-task cap (**PER-UID** — caps every process of the calling user) |
| `resourceLimits.cpuQuotaUs` | number | cgroup v2 cpu quota per 100 ms — **degrades** without cgroup v2 |
| `network` | `'inherit' \| 'none'` | deny all egress when `'none'` |

### Per-call overrides

A caller can attach `resourceLimits` / `network` to the sandbox policy object
it passes to `confine` (e.g. a bash spec's `sandboxPolicy` override); the
per-call values win over the deployment config:

```ts
const spec = bash.resolve({ command: 'make build' })
spec.sandboxPolicy = {
  ...spec.sandboxPolicy!,
  resourceLimits: { memoryBytes: 512 * 1024 * 1024, pidsMax: 32 },
  network: 'none',
}
```

## How it works

cordis 4.0.1 refuses service replacement across fibers (`provide` rejects a
second registration; `reflect.set` requires the registering fiber), so the
plugin **patches the resolved `ctx.sandbox` provider instance's `confine`
method** (idempotent, symbol-guarded) instead of replacing the service:

1. the inner provider confines file effects as usual (`bwrap` / Landlock /
   Seatbelt / Windows ACL),
2. the plugin applies its layers to the returned argv (`prlimit` prefix,
   `--unshare-net` / `(deny network*)` injection),
3. the ledger records what actually applied and what degraded.

## Platform matrix

| Layer | Linux | macOS | Windows |
|---|---|---|---|
| `resourceLimits` | `prlimit` argv prefix | degraded (no prlimit) | degraded |
| `network: 'none'` | bwrap `--unshare-net` | Seatbelt `(deny network*)` | degraded |
| evidence ledger | yes | yes (mechanism/degradation) | yes |

## Development

```sh
pnpm install
pnpm --filter @orcana/dsh-orcana-linux typecheck
pnpm --filter @orcana/dsh-orcana-linux test   # 13 tests: pure units + real-provider integration
pnpm --filter @orcana/dsh-orcana-linux build
```

Integration tests self-skip when bwrap / prlimit are unavailable on the host.

## License

MIT — see [LICENSE](../../LICENSE).

