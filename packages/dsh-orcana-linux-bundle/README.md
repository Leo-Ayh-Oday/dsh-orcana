# @orcana/dsh-orcana-linux-bundle

[English](README.md) | [中文](README.zh.md)

Profile bundle for [@orcana/dsh-orcana-linux](../dsh-orcana-linux): activates
the hardening plugin with **neutral defaults** via the `dsh.bundle.patch`
contract. Installing this profile does not change DSH's execution semantics —
no resource limits, no egress policy.

## Install (official command, once published)

```sh
dsh plugin --profile orcana-linux add @orcana/dsh-orcana-linux-bundle
```

`dsh plugin add` installs the bundle and auto-activates it as a profile layer.
Before publishing, use [`scripts/install-orcana-linux.sh`](../../scripts/install-orcana-linux.sh)
or profile `pnpm-workspace.yaml` overrides against the local tarballs.

## Enforcing layers

Edit the bundle row's config (a later `--patch` overlay or a direct profile
edit), e.g.:

```yaml
- insert:
    - id: dsh-orcana-linux
      name: '@orcana/dsh-orcana-linux'
      config:
        network: none
        resourceLimits:
          memoryBytes: 536870912
        degradationPolicy:
          network: required
```

See the [package README](../dsh-orcana-linux/README.md) for the full
configuration surface and enforcement semantics.
