# @leooday/dsh-orcana-linux-bundle

[English](README.md) | 中文

[@leooday/dsh-orcana-linux](../dsh-orcana-linux/README.zh.md) 的 Profile 组合包。
现在通过 `dsh.bundle.patch` 激活的是 **DSH 原生 shell 证据适配器**。

真正的执行限制只由 DSH 负责。安装本组合包保持中立：不会再额外套一层 sandbox、
资源上限、网络 namespace 或出网策略。Orcana 只观察 DSH rc.6 在 shell result seam
真正公开的 sandbox facts。

## 安装

```sh
dsh plugin --profile orcana-linux add @leooday/dsh-orcana-linux-bundle
```

`dsh plugin add` 安装组合包并激活为 profile 层。从 checkout 开发时使用
[`scripts/install-orcana-linux.sh`](../../scripts/install-orcana-linux.sh)。

## 从旧加固行升级

Bundle `0.3.0` 保留原来的 `dsh-orcana-linux` row id，但这个行现在从旧的
argv-hardening plugin 切换到：

```text
@leooday/dsh-orcana-linux/native-evidence
```

如果已有 profile 仍在这个行里配置旧 Orcana enforcement 字段——
`network`、`resourceLimits`、`degradationPolicy` 或 `capabilities`——新版不会静默
忽略或重新解释，而会抛出稳定错误：

```text
LEGACY_HARDENING_CONFIG_MOVED
```

这是故意的 fail-loud 迁移边界。DSH rc.6 在当前 policy/result seam 已经没有公开的
resource-limit、network 或 `SandboxReceipt` 等价 API，因此这些旧 Orcana 字段没有
诚实的一一迁移目标。应删除旧字段，并且只配置当前安装的 DSH rc.6 真正公开的能力。

## rc.6 证据契约

公开的 request-time `SandboxExecutionPolicy` 包含：

```text
mode
workspaceRoot
sessionId?
```

公开的 post-execution `ShellSandboxInfo` 包含：

```text
mode
denied
enforcement?
runnerFailed?
```

`native-evidence` 只记录这些 shell facts，并把证据类型标成 `sandbox-facts`。它不会
从 provider 私有实现中伪造 receipt、cgroup/资源 accounting、网络隔离 proof、
cleanup proof 或 degradation report。

包根入口 `@leooday/dsh-orcana-linux` 暂时保留为旧 argv-hardening API，避免直接
打断已有程序化用户；**组合包已经不再加载这个 legacy 路径。** 新的 DSH 集成应
使用 bundle / `native-evidence` 路径。

Windows → WSL 执行桥、因果关联与证据边界见
[包 README](../dsh-orcana-linux/README.zh.md)。
