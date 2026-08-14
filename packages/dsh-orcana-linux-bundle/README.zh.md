# @leooday/dsh-orcana-linux-bundle

[English](README.md) | 中文

[@leooday/dsh-orcana-linux](../dsh-orcana-linux/README.zh.md) 的 Profile 组合包：
通过 `dsh.bundle.patch` 契约以**中立默认值**激活加固插件。安装本组合包不会
改变 DSH 的执行语义 —— 无资源限制、无出网策略。

## 安装（官方命令，发布后可用）

```sh
dsh plugin --profile orcana-linux add @leooday/dsh-orcana-linux-bundle
```

`dsh plugin add` 安装组合包并自动激活为 profile 层。发布前，使用
[`scripts/install-orcana-linux.sh`](../../scripts/install-orcana-linux.sh)
或 profile 的 `pnpm-workspace.yaml` override 指向本地 tarball。

## 启用加固层

编辑组合包行的 config（后续的 `--patch` overlay 或直接编辑 profile），例如：

```yaml
- insert:
    - id: dsh-orcana-linux
      name: '@leooday/dsh-orcana-linux'
      config:
        network: none
        resourceLimits:
          memoryBytes: 536870912
        degradationPolicy:
          network: required
```

完整配置面与执行语义见[包 README](../dsh-orcana-linux/README.zh.md)。
