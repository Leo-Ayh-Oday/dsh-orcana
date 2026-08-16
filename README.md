# Orcana for DeepSeek Harness

[English](README.md) | [中文](README.zh.md)

Runtime governance for stronger coding-agent execution.

**Same model. Same DSH. One runtime intervention.**

- progress-aware liveness (Progress Governor)
- generation-bound verification evidence (Evidence Freshness)
- evidence-aware completion (Completion Claim Guard)
- task-profile capability disclosure (Capability Router)
- native Linux hardening + a Windows → WSL single-execution-world bridge

The v0.1 governor scope remains frozen by [PLAN-v0.1.md](PLAN-v0.1.md); the
Linux/WSL execution layer evolves independently and is now targeting v0.4.
See [docs/architecture.md](docs/architecture.md),
[docs/methodology.md](docs/methodology.md), and the
[Linux/WSL package README](packages/dsh-orcana-linux/README.md).

## Layout

| Path | Role |
|---|---|
| `packages/governor-core` | Framework-agnostic progress-fact engine (zero Cordis) |
| `packages/dsh-governor` | DSH adapter plugin (function plugin, mounts DSH extension points) |
| `packages/dsh-bundle` | Profile bundle (`dsh.bundle.patch` contract) |
| `packages/dsh-orcana-linux` | Linux native hardening + the cross-platform `dsh-orcana` launcher |
| `packages/dsh-orcana-linux-bundle` | Profile bundle for the Linux edition (`dsh.bundle.patch` contract) |
| `benchmark/` | A/B harness: task manifests, patches, runner, reports |
| `scripts/` | dev-install / smoke / bench-run |

## Install

The npm scope is `@leooday`. DSH profiles use the official plugin command:

```sh
# Everything in one profile (governor + Linux hardening):
dsh plugin --profile orcana add @leooday/dsh-bundle @leooday/dsh-orcana-linux-bundle
# or separate profiles:
dsh plugin --profile orcana add @leooday/dsh-bundle
dsh plugin --profile orcana-linux add @leooday/dsh-orcana-linux-bundle
dsh --profile orcana "<task>"
```

`dsh plugin add` installs the bundle and activates it as a profile layer. Bundle
defaults are NEUTRAL: installation alone does not silently enable stronger
resource or network restrictions; enforcement is configured explicitly through
the profile row or a later `--patch` overlay.

Programmatic implementation packages use the same scope, including
`@leooday/dsh-governor`, `@leooday/governor-core`, and
`@leooday/dsh-orcana-linux`.

## Windows / WSL: one execution entrypoint

v0.4 does **not** keep DSH on Windows and jump individual tool calls into WSL.
Windows is only the launch surface:

```text
Windows Terminal / PowerShell
        ↓
    dsh-orcana
        ↓
      wsl.exe
        ↓
whole DSH runtime enters WSL once
        ↓
DSH + Orcana + sandbox + subprocess + bash/PTC/LSP
        ↓
one native Linux execution world
```

This keeps the Agent/preset/task layer free of separate Windows/Linux execution
branches. cwd, process, shell, sandbox, background work, terminal handling and
interactive Ctrl+C remain on WSL's native execution path rather than being
reimplemented by the bridge.

After the v0.4 package is published, install the launcher once on Windows:

```powershell
npm install -g @leooday/dsh-orcana-linux@^0.4.0
```

Inspect the target WSL world:

```powershell
dsh-orcana --wsl-doctor
```

The bridge prefers an existing `dsh`. If none is installed globally, it falls
back to the DSH npm package version pinned for this bridge release
(`@deepseek-ai/dsh@0.1.0-rc.5` for v0.4.0) instead of silently following
`latest`. Override intentionally with `ORCANA_WSL_DSH_PACKAGE` when validating
a newer DSH release.

Install the Orcana profile from Windows:

```powershell
dsh-orcana --wsl-install
```

Then Windows and Linux use the same command:

```sh
dsh-orcana "<task>"
```

Important boundaries: Windows `DSH_HOME` is not shared with WSL; Windows cwd is
translated by the selected distro's own `wslpath`; DSH `--` and task argv are
preserved; model credentials and common provider base URLs cross through
one-way `WSLENV` entries. Windows filesystem projects work directly, while
WSL-native project storage is the fast path for Linux-heavy Git/npm/build I/O.
Full details are in
[`packages/dsh-orcana-linux/README.md`](packages/dsh-orcana-linux/README.md).

For interactive development from a checkout:

```sh
pnpm install && pnpm build
bash scripts/dev-install.sh
bash scripts/install-orcana-linux.sh
dsh --profile orcana "<task>"
```

## Known Limitations

- Workspace generation observes mutation-typed tool calls only; shell-internal
  mutations (`sed -i`, etc.) are still invisible until git-probe receipts land.
- The governor itself does not directly kill/cancel an agent; its strongest
  action remains bounded steering.
- Interactive Ctrl+C intentionally stays under `wsl.exe`/Linux terminal
  semantics. A separate programmatic cancel/timeout control API for Orcana is
  not part of this bridge yet; it should be implemented at the execution-control
  seam rather than by changing terminal process/session semantics.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — PRs carry exactly one kind/* and at
least one area/* label, matching the upstream contribution convention.
