# @leooday/dsh-bundle

[English](README.md) | [中文](README.zh.md)

Profile bundle for `dsh --profile orcana`: installs `@leooday/dsh-governor`
and coordinates it with `repeat-tool-reminder`.

Contract: the package manifest declares `"dsh": { "bundle": { "patch":
"./cordis.patch.yml" } }`, making it an installable patch layer
([bundle contract](../../deepseek-harness/packages/bundle/README.md)).

## Install

```sh
dsh plugin --profile orcana add @leooday/dsh-bundle
```

`dsh plugin add` installs the bundle and auto-activates it as a profile layer
(`@leooday/dsh-governor` and `@leooday/governor-core` resolve as its
dependencies). For checkout-based development, use
[`scripts/dev-install.sh`](../../scripts/dev-install.sh) or profile
`pnpm-workspace.yaml` overrides against local tarballs.

## Known Limitations

- The `exclude` override of `repeat-tool-reminder` targets the row id from
  `dsh-base`; a profile that does not load `dsh-base` leaves the patch as a
  per-entry Loader warning (harmless, matches DSH patch semantics).
