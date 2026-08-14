# @orcana/dsh-bundle

[English](README.md) | 中文

`dsh --profile orcana` 的 Profile 组合包：安装 `@orcana/dsh-governor`，并让它与
`repeat-tool-reminder` 协调。

契约：包 manifest 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，
使其成为可安装的 patch 层
（[bundle 契约](../../deepseek-harness/packages/bundle/README.md)）。

## 安装（官方命令，发布后可用）

```sh
dsh plugin --profile orcana add @orcana/dsh-bundle
```

`dsh plugin add` 安装组合包并自动激活为 profile 层（`@orcana/dsh-governor`
和 `@orcana/governor-core` 作为其依赖解析）。发布前，使用
[`scripts/dev-install.sh`](../../scripts/dev-install.sh) 或 profile 的
`pnpm-workspace.yaml` override 指向本地 tarball。

## 已知限制

- `repeat-tool-reminder` 的 `exclude` 覆盖针对 `dsh-base` 中的行 id；
  未加载 `dsh-base` 的 profile 会让该 patch 成为逐条目 Loader 警告
  （无害，符合 DSH patch 语义）。
