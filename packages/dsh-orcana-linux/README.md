# @orcana/dsh-orcana-linux

Native hardening layers as a DSH plugin — no fork required.

Loads after the harness's sandbox services and replaces `ctx.sandbox` with a
wrapper that delegates file confinement to the platform provider and adds:

- `resourceLimits` (`memoryBytes` / `pidsMax` / `cpuQuotaUs`) — `prlimit`
  argv prefix on Linux; `cpuQuotaUs` degrades visibly (needs cgroup v2).
- `network: 'none'` — `--unshare-net` injected into bwrap argv.

Every confinement is recorded in `ctx.hardening.ledger` (layers applied,
degradations, mechanism). Limits are deployment-level (plugin config); a
per-call override surface is follow-up.

See [PLAN-v0.1.md](../../PLAN-v0.1.md) for the surrounding plan.

