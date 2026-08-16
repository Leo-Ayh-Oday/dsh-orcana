# @leooday/dsh-orcana-linux-bundle

[English](README.md) | [中文](README.zh.md)

Profile bundle for [@leooday/dsh-orcana-linux](../dsh-orcana-linux). The
bundle now activates the **DSH-native execution evidence adapter** via the
`dsh.bundle.patch` contract.

DSH remains the sole execution-enforcement owner. Installing this bundle is
neutral: it does not add a second `prlimit`, network namespace, resource cap,
or egress policy. Orcana observes the sandbox facts and native receipt that DSH
actually produced.

## Install

```sh
dsh plugin --profile orcana-linux add @leooday/dsh-orcana-linux-bundle
```

`dsh plugin add` installs the bundle and activates it as a profile layer. For
checkout-based development, use
[`scripts/install-orcana-linux.sh`](../../scripts/install-orcana-linux.sh).

## Native enforcement belongs to `sandbox-policy`

Current DSH already owns `resourceLimits` and `network` on its existing
`sandbox-policy` row. Configure that row in a later profile/user patch instead
of configuring the Orcana evidence row.

A DSH patch replaces the target row's whole `config`, so preserve the standing
mode/root when adding native limits:

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

DSH then chooses its real mechanism (for example cgroup v2 or a documented
`prlimit` fallback), records degradations, and returns its native
`SandboxReceipt`. Orcana's `native-evidence` adapter records that receipt
without changing the execution.

The package root (`@leooday/dsh-orcana-linux`) remains available temporarily as
the legacy argv-hardening API for compatibility. **The bundle does not load
that legacy path.** New DSH integrations should use the bundle/native-evidence
path.

See the [package README](../dsh-orcana-linux/README.md) for the Windows → WSL
execution bridge and evidence semantics.
