# Orcana for DeepSeek Harness

Runtime governance for stronger coding-agent execution.

**Same model. Same DSH. One runtime intervention.**

- progress-aware liveness (Progress Governor)
- generation-bound verification evidence (Evidence Freshness)
- evidence-aware completion (Completion Claim Guard)
- task-profile capability disclosure (Capability Router)

Status: v0.1 experimental — see [PLAN-v0.1.md](PLAN-v0.1.md) for scope and the
frozen benchmark invariants, [docs/architecture.md](docs/architecture.md) and
[docs/methodology.md](docs/methodology.md) for details.

## Layout

| Path | Role |
|---|---|
| `packages/governor-core` | Framework-agnostic progress-fact engine (zero Cordis) |
| `packages/dsh-governor` | DSH adapter plugin (function plugin, mounts DSH extension points) |
| `packages/dsh-bundle` | Profile bundle (`dsh.bundle.patch` contract) |
| `packages/dsh-orcana-linux` | dsh-orcana Linux edition: native hardening layers over the official sandbox contract |
| `benchmark/` | A/B harness: task manifests, patches, runner, reports |
| `scripts/` | dev-install / smoke / bench-run |

## Install

```sh
pnpm install && pnpm build
bash scripts/dev-install.sh     # installs into ~/.dsh/profiles/orcana
dsh --profile orcana "<task>"
```

## Known Limitations

- Workspace generation observes mutation-typed tool calls only; mutations
  performed inside a shell command (`sed -i` etc.) are invisible to the
  generation counter (v0.2: git-probe receipts).
- v0.1 never kills or cancels an agent; the strongest action is a steer
  reminder, bounded by `maxForcedContinuations`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — PRs carry exactly one kind/* and at
least one area/* label, matching the upstream contribution convention.
