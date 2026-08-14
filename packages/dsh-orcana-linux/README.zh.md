# @leooday/dsh-orcana-linux

[English](README.md) | 中文

**Orcana 受限执行加固 for DeepSeek Harness (DSH)。**

作为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，
在**官方** sandbox 契约之上提供原生加固层（无需 fork）。本包加固经过
`ctx.sandbox` 的 DSH 执行 —— 它是兼容/加固层，**不是**完整的 Orcana Execution
Fabric（cgroup v2 权限、pidfd 所有权、`ctx.subprocess` / `ctx.codeRuntime`
拦截属于未来工作；见 R1 报告的 DEFERRED-01…06）。

- **资源限制** — `memoryBytes` / `pidsMax` 在 Linux 上以 `prlimit` argv 前缀
  执行（`--as` = RLIMIT_AS **地址空间近似**，不是 cgroup 内存上限；
  `--nproc` = **PER-UID** 活跃任务上限，不是 per-cell PID 权限）。
  `cpuQuotaUs` 需要 cgroup v2 权限，超出本包范围 —— 它总是降级。
- **出网策略** — `network: 'none'` 拒绝全部网络：向 bwrap argv 注入
  `--unshare-net`（全新网络命名空间，无路由），向 Seatbelt profile 追加
  `(deny network*)`。
- **默认 fail-closed** — 主机无法表达的请求层抛 `HARDENING_UNAVAILABLE`，
  而不是无加固运行。设 `degradationPolicy` 为 `best-effort` 则改为记录并继续。
- **执行证据** — 每次受限执行都记录进**有界**审计台账（`ctx.hardening`）：
  请求事实、已应用层、结构化降级、失败记录、dropped/total 计数器。降级从不
  静默。

## 保证（Guarantees）

```
✓ 经 ctx.sandbox 的受限执行（read-only / workspace-write）
✓ 支持 runner 上的 network-none（bwrap / Seatbelt）
✓ RLIMIT_AS / RLIMIT_NPROC 回退（地址空间 / PER-UID 语义）
✓ 逐层可配置的 fail-closed（required | best-effort）
✓ 有界审计台账（默认 1024 条，暴露 dropped/total）
✓ 生命周期正确的 patch：dispose 精确恢复原始 confine
✓ 重复活跃实例 fail loud（DUPLICATE_HARDENING_INSTANCE）
✓ 每次插件挂载最多探测一次主机能力
```

## 不保证（Non-guarantees）

```
✗ danger-full-access 执行（它们绕过 ctx.sandbox —— 见下文）
✗ cgroup v2 memory / pids / cpu 权限
✗ per-cell PID 权限
✗ CPU 配额（cpuQuotaUs 降级 / fail-closed）
✗ 进程所有权 / 崩溃恢复
✗ 服务生命周期（ctx.subprocess / ctx.codeRuntime / PTC worker 隔离）
```

## 范围：`danger-full-access`

DSH 的 `danger-full-access` 模式完全绕过受限 sandbox 接缝（官方 bash executor
运行 `super.run()`，从不调用 `ctx.sandbox.confine`）。该模式下的执行因此
**在本包的执行权限之外**。`ctx.hardening.scope` 诚实报告这一点：
`{ confinedModes: true, dangerFullAccess: false }`。加固 `danger-full-access`
需要拦截 `ctx.subprocess` / shell 路径 —— 未来工作（DEFERRED-02）。

## 安装

发布后，官方 DSH 组合包安装：

```sh
dsh plugin --profile orcana-linux add @leooday/dsh-orcana-linux-bundle
```

`dsh plugin add` 安装组合包，并自动以**中立默认值**激活加固行为 profile 层；
通过该行的 config 启用加固层（见
[bundle README](../dsh-orcana-linux-bundle/README.zh.md)）。发布前，使用
[`scripts/install-orcana-linux.sh`](../../scripts/install-orcana-linux.sh)
指向本地 tarball。

如需程序化嵌入（不走 profile 路径），直接安装包并在 harness 启动中加载插件：

```sh
npm i @leooday/dsh-orcana-linux
```

```ts
import { Context } from '@deepseek-ai/cordis'
import { apply as hardening } from '@leooday/dsh-orcana-linux'

// 在 harness 启动中，ctx.plugin(LocalSandboxProvider, {...}) 之后：
ctx.plugin(hardening, {
  network: 'none',                                   // 拒绝出网
  resourceLimits: { memoryBytes: 512 * 1024 * 1024 }, // RLIMIT_AS 近似
})
```

## 配置

| 字段 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `resourceLimits.memoryBytes` | number | — | `prlimit --as` 字节（**地址空间近似**，不是 "N MB RAM"） |
| `resourceLimits.pidsMax` | number | — | `prlimit --nproc` 活跃任务上限（**PER-UID** —— 限制调用用户的所有进程） |
| `resourceLimits.cpuQuotaUs` | number | — | 每 100ms 的 cgroup v2 cpu 配额 —— **本包永远不支持**；降级 / fail-closed |
| `network` | `'inherit' \| 'none'` | — | `'none'` 时拒绝全部出网 |
| `degradationPolicy.resourceLimits` | `'required' \| 'best-effort'` | `required` | fail-closed（抛 `HARDENING_UNAVAILABLE`）vs 记录并继续 |
| `degradationPolicy.network` | `'required' \| 'best-effort'` | `required` | 同上，针对出网层 |
| `ledgerMaxEntries` | number | 1024 | 有界审计窗口；更早的记录被丢弃并计入 `droppedCount` |

### 每次调用覆盖（Per-call overrides）

调用方可以把 `resourceLimits` / `network` 附加到传给 `confine` 的 sandbox
policy 对象上（例如 bash spec 的 `sandboxPolicy` 覆盖）；每次调用值优先于
部署配置：

```ts
const spec = shell.resolve({ command: 'make build' })
spec.sandboxPolicy = {
  ...spec.sandboxPolicy!,
  resourceLimits: { memoryBytes: 512 * 1024 * 1024, pidsMax: 32 },
  network: 'none',
}
```

降级策略与台账大小保持部署级。

> **安全说明（降级方向）：** 每次调用 carrier 只能*收窄或放宽*部署配置，
> 绝不会静默收紧。任何调用方只要传 `sandboxPolicy` 带 `network: 'inherit'`
> （或空的 `resourceLimits: {}`），就会覆盖部署级 `none` / 限制 —— 审计会
> 记录每一次这样的调用（`requested`），但没有响亮信号。若你的部署把出网
> 隔离视为强制，钉死 `degradationPolicy.network: 'required'` 并监控台账，
> 而不是依赖每次调用的纪律。

> **`runnerCommand` 说明：** 当 sandbox provider 配置了自定义 `runnerCommand`
> （操作者断言）时，runner 以 `argv[0]` 字符串精确相等识别 ——
> `/usr/bin/bwrap` 或包装脚本**不**匹配 `'bwrap'`，因此 `network: 'none'`
> 会降级（在默认 `required` 策略下 fail-closed）。这是响亮而非静默的，
> 但可能让操作者意外：使用 argv[0] 恰好为 `bwrap` 的 runnerCommand
> （或刻意设置 `degradationPolicy.network: 'best-effort'`）。

## 工作原理

cordis 4.0.1 拒绝跨 fiber 替换服务，因此插件**patch 解析出的 `ctx.sandbox`
provider 实例的 `confine` 方法**，而不是替换服务：

1. 内层 provider 照常限制文件效果（`bwrap` / Landlock / Seatbelt / Windows ACL），
2. 插件对返回的 argv 施加各层（`prlimit` 前缀、`--unshare-net` /
   `(deny network*)` 注入），`required` 层无法表达时 fail-closed，
3. 台账记录请求了什么、应用了什么、降级了什么。

patch 生命周期正确：原始 `confine` 在挂载时捕获、dispose 时**精确**恢复
（有守卫，绝不误伤其他插件的 patch）；同一 provider 上的第二个活跃实例
fail loud（`DUPLICATE_HARDENING_INSTANCE`），而不是静默忽略其配置。
主机能力（`prlimit` 可用性）每次插件挂载探测一次，绝不按次执行探测。

## 平台矩阵

| 层 | Linux | macOS | Windows |
|---|---|---|---|
| `resourceLimits` | `prlimit` argv 前缀 | 降级（无 prlimit） | 降级 |
| `network: 'none'` | bwrap `--unshare-net` | Seatbelt `(deny network*)` | 降级 |
| 证据台账 | 是 | 是（结构化降级） | 是 |

## 开发

```sh
pnpm install
pnpm --filter @leooday/dsh-orcana-linux typecheck
pnpm --filter @leooday/dsh-orcana-linux test   # 37 tests: 纯单元 + 真实 provider 集成
pnpm --filter @leooday/dsh-orcana-linux build
```

主机无 bwrap / prlimit 时集成测试自动跳过。

## License

MIT — 见 [LICENSE](../../LICENSE)。
