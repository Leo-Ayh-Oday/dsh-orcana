# @leooday/dsh-orcana-linux-bundle

[English](README.md) | [中文](README.zh.md)

Profile bundle for [@leooday/dsh-orcana-linux](../dsh-orcana-linux). The
bundle activates the **DSH-native shell evidence adapter** through the
`dsh.bundle.patch` contract.

DSH remains the sole execution-enforcement owner. Installing this bundle is
neutral: it does not add a second sandbox, resource cap, network namespace, or
egress policy. Orcana observes only the public sandbox facts that DSH rc.6
actually exposes on the shell result seam.

## Install

```sh
dsh plugin --profile orcana-linux add @leooday/dsh-orcana-linux-bundle
```

`dsh plugin add` installs the bundle and activates it as a profile layer. For
checkout-based development, use
[`scripts/install-orcana-linux.sh`](../../scripts/install-orcana-linux.sh).

## Upgrade from the legacy hardening row

Bundle `0.3.0` changes the `dsh-orcana-linux` row from the legacy argv-hardening
plugin to `@leooday/dsh-orcana-linux/native-evidence` while keeping the row id
stable.

If an existing profile still supplies any legacy Orcana enforcement fields on
that row — `network`, `resourceLimits`, `degradationPolicy`, or `capabilities`
— the evidence adapter throws the stable
`LEGACY_HARDENING_CONFIG_MOVED` error. It deliberately **fails loud instead of
letting Schemastery strip or reinterpret the old fields**.

That migration boundary matters because DSH rc.6 no longer exposes a public
resource-limit/network/`SandboxReceipt` equivalent on this policy/result seam.
There is therefore no honest one-to-one destination for those old Orcana
fields. Remove them and configure only capabilities that the installed DSH
rc.6 actually exposes.

## rc.6 evidence contract

The public request-time `SandboxExecutionPolicy` contains:

```text
mode
workspaceRoot
sessionId? 
```

The public post-execution `ShellSandboxInfo` contains:

```text
mode
denied
enforcement?
runnerFailed?
```

`native-evidence` records those shell facts and labels the evidence as
`sandbox-facts`. It does not fabricate a receipt, cgroup/resource accounting,
network-isolation proof, cleanup proof, or degradation report from provider
internals.

The package root (`@leooday/dsh-orcana-linux`) remains available temporarily as
the legacy argv-hardening API for compatibility. **The bundle does not load
that legacy path.** New DSH integrations should use the bundle/native-evidence
path.

See the [package README](../dsh-orcana-linux/README.md) for the Windows → WSL
execution bridge, correlation semantics, and evidence limitations.
