# Orcana for DeepSeek Harness

[English](README.md) | [中文](README.zh.md)

Runtime governance for stronger coding-agent execution.

**Same model. Same DSH. One runtime intervention.**

- progress-aware liveness (Progress Governor)
- generation-bound verification evidence (Evidence Freshness)
- evidence-aware completion (Completion Claim Guard)
- task-profile capability disclosure (Capability Router)
- DSH-native Linux execution evidence
- Windows → WSL single-execution-world launcher

The v0.1 governor scope remains frozen by [PLAN-v0.1.md](PLAN-v0.1.md). The
Linux/WSL line evolves independently around a strict authority split:

```text
DSH                         Orcana
├ sandbox-policy            ├ Progress / Completion governance
├ sandbox-local             ├ Native execution evidence
├ cgroup / prlimit          └ Windows → WSL execution adapter
└ SandboxReceipt
      │
      └──────────────► Orcana consumes facts; it does not duplicate enforcement
```

See [docs/architecture.md](docs/architecture.md),
[docs/methodology.md](docs/methodology.md), and the
[Linux/WSL package README](packages/dsh-orcana-linux/README.md).

## Layout

| Path | Role |
|---|---|
| `packages/governor-core` | Framework-agnostic progress-fact engine |
| `packages/dsh-governor` | DSH governance adapter |
| `packages/dsh-bundle` | Governor profile bundle |
| `packages/dsh-orcana-linux` | DSH-native evidence adapters + cross-platform `dsh-orcana` launcher; legacy root API retained temporarily |
| `packages/dsh-orcana-linux-bundle` | Neutral profile bundle that mounts `@leooday/dsh-orcana-linux/native-evidence` |
| `benchmark/` | A/B harness |
| `scripts/` | install / smoke / release checks |

## Measured impact (preliminary)

Paired A/B runs, same model (deepseek-v4-flash), control vs treatment
(governor active), judged by an independent acceptance command. Full harness
and raw data: [benchmark/](benchmark/README.md), `benchmark/reports/`.

| Task | n | Treatment − control (tokens) |
|---|---|---|
| demo-format-money (synthetic verification trap) | 2 | −871 / −2695 (both negative) |
| marked-blank-tab (real issue markedjs#4007) | 6 | −4079 / +4082 / −29107 / −12181 / +48428 / −8850 (4/6 negative, median ≈ −6.5k) |
| dayjs-updatelocale (real issue dayjs#1118) | 3 | +2459 / −1841 / −731 (2/3 negative, median ≈ −0.7k) |

Pooled: **8 of 11 paired runs used fewer tokens with the governor active**
(median negative on every task). Call counts are censored by the budgets on
the real tasks. Small samples — the harness is the reliable deliverable;
effect size needs more reps and tasks.

## Install

The npm scope is `@leooday`:

```sh
dsh plugin --profile orcana add \
  @leooday/dsh-bundle \
  @leooday/dsh-orcana-linux-bundle

dsh --profile orcana "<task>"
```

Installation is **policy-neutral**. Orcana observes execution facts; native
resource/network enforcement is configured on DSH's existing `sandbox-policy`
row, whose `SandboxReceipt` becomes Orcana's evidence source.

Programmatic evidence adapter:

```ts
import nativeEvidence from '@leooday/dsh-orcana-linux/native-evidence'
ctx.plugin(nativeEvidence)
```

## Windows / WSL: one execution entrypoint

The Windows design does **not** keep DSH on Windows and forward individual tool
calls into WSL. Windows is only the launch surface:

```text
Windows Terminal / PowerShell
        ↓
    dsh-orcana
        ↓
      wsl.exe
        ↓
whole DSH + Orcana runtime enters WSL
        ↓
one native Linux execution world
```

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

The bridge preserves cwd/argv boundaries, keeps Windows and WSL DSH homes
separate, selectively forwards bootstrap/runtime environment through WSLENV,
and pins its DSH/pnpm compatibility contract. `--wsl-install` verifies profile
composition plus the **actual runtime module/peer chain**, including
`@leooday/dsh-orcana-linux/native-evidence`.

`--wsl-doctor` also checks web localhost relay, proxy reachability, workspace
filesystem semantics, Git identity/credential capability, TTY/UTF-8/path
parity, and DrvFS metadata warnings without silently mutating host or WSL
configuration.

Full contracts are documented in
[`packages/dsh-orcana-linux/README.md`](packages/dsh-orcana-linux/README.md).

## Current authority boundary

- **DSH owns native enforcement.** Current DSH has official
  `resourceLimits`/`network` policy fields, cgroup-v2/prlimit mechanisms,
  process lifecycle ownership, cleanup and `SandboxReceipt`.
- **Orcana owns governance/evidence.** The default Linux bundle observes
  foreground/background `ctx.shell` execution and records DSH's real receipt.
- **The old package-root argv-hardening plugin is compatibility-only.** The
  current bundle does not mount it.
- **Custom persistent-terminal/PTTY profiles are not claimed as receipt-parity
  surfaces yet.** Orcana's own headless/web product profiles do not mount that
  capability by default.

## Known Limitations

- Workspace generation still observes mutation-typed tool calls; shell-internal
  mutations need the future git-probe receipt path.
- The governor does not directly own agent kill/cancel authority; steering is
  bounded.
- Interactive Ctrl+C intentionally remains on native `wsl.exe` / Linux terminal
  semantics. A future programmatic timeout/cancel API belongs at the execution
  control plane, not in a fake Windows signal shim.
- `pnpm-lock.yaml` still requires genuine regeneration with the repository-pinned
  pnpm in a registry-connected environment; the release contract blocks hand-
  fabricated rc.5 snapshots.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
