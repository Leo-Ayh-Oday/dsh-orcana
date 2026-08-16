# Orcana for DeepSeek Harness

[English](README.md) | [中文](README.zh.md)

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
| `packages/dsh-orcana-linux-bundle` | Profile bundle for the Linux edition (`dsh.bundle.patch` contract) |
| `benchmark/` | A/B harness: task manifests, patches, runner, reports |
| `scripts/` | dev-install / smoke / bench-run |

## Install

Official DSH bundle install (once the `@leooday/*` packages are published):

```sh
# Everything in one profile, one command (governor + Linux hardening):
dsh plugin --profile orcana add @leooday/dsh-bundle @leooday/dsh-orcana-linux-bundle
# or separate profiles:
dsh plugin --profile orcana add @leooday/dsh-bundle
dsh plugin --profile orcana-linux add @leooday/dsh-orcana-linux-bundle
dsh --profile orcana "<task>"
```

`dsh plugin add` installs the bundle and auto-activates it as a profile layer
(the package's `dsh.bundle.patch` declaration joins it to the layer stack).
Bundle defaults are NEUTRAL — installing never changes DSH's execution
semantics; enforce layers by editing the bundle row's config in
`~/.dsh/profiles/<name>/cordis.patch.yml` or a `--patch` overlay.

Before the packages are published, install the locally built tarballs through
a profile `pnpm-workspace.yaml` override (see
[`scripts/install-orcana-linux.sh`](scripts/install-orcana-linux.sh) and the
smoke suite) — `dsh plugin add` with `file:`/`link:` specs cannot resolve the
bundles' workspace dependencies from a registry-free checkout.

For interactive development from a checkout:

```sh
pnpm install && pnpm build
bash scripts/dev-install.sh              # installs governor profile into ~/.dsh/profiles/orcana
bash scripts/install-orcana-linux.sh     # installs hardening profile into ~/.dsh/profiles/orcana-linux
dsh --profile orcana "<task>"
```

## Measured impact (preliminary)

Paired A/B runs, same model (deepseek-v4-flash), control vs treatment
(governor active), judged by an independent acceptance command. Full harness
and raw data: [benchmark/](benchmark/README.md), `benchmark/reports/`.

| Task | n | Treatment vs control (tokens, treatment − control) |
|---|---|---|
| demo-format-money (synthetic verification trap) | 2 | **−871 / −2695** (both negative) |
| marked-blank-tab (real issue markedjs#4007) | 6 | −4079 / +4082 / −29107 / −12181 / +48428 / −8850 — 4/6 negative, median ≈ −6.5k |
| dayjs-updatelocale (real issue dayjs#1118) | 3 | +2459 / −1841 / −731 — 2/3 negative, median ≈ −0.7k |

All tasks pooled: **8 of 11 paired runs used fewer tokens on treatment**
(median direction negative on every task; means are dragged by one large
positive outlier on marked). Call counts are censored by the budgets on the
real tasks (both arms hit them). Honest caveats: small samples, the harness
is the reliable deliverable, effect size needs more reps and tasks.

## Known Limitations

- Workspace generation observes mutation-typed tool calls only; mutations
  performed inside a shell command (`sed -i` etc.) are invisible to the
  generation counter (v0.2: git-probe receipts).
- v0.1 never kills or cancels an agent; the strongest action is a steer
  reminder, bounded by `maxForcedContinuations`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — PRs carry exactly one kind/* and at
least one area/* label, matching the upstream contribution convention.
