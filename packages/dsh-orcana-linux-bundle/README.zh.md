# @leooday/dsh-orcana-linux-bundle

[English](README.md) | 中文

[@leooday/dsh-orcana-linux](../dsh-orcana-linux/README.zh.md) 的 Profile 组合包。
现在通过 `dsh.bundle.patch` 激活的是 **DSH 原生执行证据适配器**。

真正的执行加固只由 DSH 负责。安装本组合包保持中立：不会再额外套一层
`prlimit`、网络 namespace、资源上限或出网策略。Orcana 只观察 DSH 实际产生的
sandbox facts 与原生 `SandboxReceipt`。

## 安装

```sh
dsh plugin --profile orcana-linux add @leooday/dsh-orcana-linux-bundle
```

`dsh plugin add` 安装组合包并激活为 profile 层。从 checkout 开发时使用
[`scripts/install-orcana-linux.sh`](../../scripts/install-orcana-linux.sh)。

## 原生加固配置属于 `sandbox-policy`

当前 DSH 已经在自己的 `sandbox-policy` 行正式拥有 `resourceLimits` 与
`network`。所以以后需要资源/网络约束时，应修改这个 DSH 原生 policy row，
**不要再给 Orcana evidence row 配资源限制。**

DSH 的 patch 会替换目标行的整个 `config`，因此增加原生限制时要把当前 mode
和 workspace root 一起保留下来：

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

之后由 DSH 自己选择真实执行机制（例如 cgroup v2，或其明确记录语义差异的
`prlimit` fallback），记录 degradation，并在执行结束后返回真实
`SandboxReceipt`。Orcana 的 `native-evidence` 只记录这份事实，不修改执行。

包根入口 `@leooday/dsh-orcana-linux` 暂时保留为旧 argv-hardening API，避免直接
打断已有程序化用户；**组合包已经不再加载这个 legacy 路径。** 新的 DSH
集成应使用 bundle / `native-evidence` 路径。

Windows → WSL 执行桥和证据语义见[包 README](../dsh-orcana-linux/README.zh.md)。
