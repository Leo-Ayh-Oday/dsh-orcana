# @orcana/dsh-orcana-linux-bundle

Profile bundle for [@orcana/dsh-orcana-linux](../dsh-orcana-linux): activates
the hardening plugin with **neutral defaults** via the `dsh.bundle.patch`
contract. Installing this profile does not change DSH's execution semantics —
no resource limits, no egress policy. Enforce layers explicitly by overriding
the `dsh-orcana-linux` row's config (a later `--patch` overlay or a direct
profile edit), e.g.:

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
