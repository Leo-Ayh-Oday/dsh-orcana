# @leooday/dsh-orcana-linux

[English](README.md) | 中文

**Orcana 的 DSH 原生 shell 证据层 + Windows → WSL 单一 Linux 执行世界桥。**

这个包承担两个明确职责：

1. **Linux / WSL 治理证据** —— DSH 是唯一的 sandbox policy 与原生 enforcement
   owner；Orcana 只观察 rc.6 公开的 shell sandbox facts，不再重复套第二层
   sandbox、资源限制或网络 namespace。
2. **Windows → WSL 执行后端** —— `dsh-orcana` 把 Windows 只当启动面；任务开始
   前，整个 DSH + Orcana runtime 已经进入同一个 WSL Linux execution world。

```text
Windows Terminal / PowerShell
        │
        ▼
    dsh-orcana
        │  cwd / argv / env bridge
        ▼
       WSL
        │
        ▼
       DSH rc.6
  sandbox-policy
  { mode, workspaceRoot, sessionId? }
        │
        ▼
 sandbox-local          ← 唯一原生 confinement owner
        │
        ▼
      ctx.shell
        │
        └─ sandbox facts
           { mode, denied, enforcement?, runnerFailed? }
        │
        ▼
@leooday/dsh-orcana-linux/native-evidence
        │
        ▼
 ctx.orcanaLinuxEvidence
```

## 权限边界

### DSH 负责真正执行限制

rc.6 公开的 `SandboxExecutionPolicy` 是文件效果策略，只包含：

- `mode`
- `workspaceRoot`
- 可选 `sessionId`

真正 confinement 由 DSH sandbox provider 负责。执行后，
`ShellRunResult.sandbox` / `ShellProcess.sandbox` 对外提供 Orcana 可以安全观察的事实：

- `mode`
- `denied`
- 可选 `enforcement`
- 可选 `runnerFailed`

rc.6 已经**不再公开**旧的 `SandboxReceipt`、资源限制 policy 或网络 policy/证据
API。Orcana 不会从 argv、stderr、provider 私有状态或类型断言中把这些已删除的
结论重新“拼”出来。

当前 bundle 默认加载：

```text
@leooday/dsh-orcana-linux/native-evidence
```

而不是旧包根入口。

### Orcana 负责证据与治理

`native-evidence` 观察 DSH 公共 `ctx.shell` 结果边界：

- 不修改 `ShellExecSpec`、sandbox policy、argv、lifecycle、result object 或
  process handle；
- 执行开始前快照 request-time 的 `mode + workspaceRoot`；
- 前台任务在 `shell.run()` 真正完成后结算证据；
- 后台任务等待原样返回的 `ShellProcess.done` 完成后再记录；
- observer reload/HMR 后，已经启动的后台任务仍在同一 DSH 进程内共享 ledger 中
  结算；
- 执行后只记录 rc.6 `ShellSandboxInfo` 真实 facts；
- `danger-full-access` 也只按真实 sandbox facts 记录；
- 不保存原始 command，只保存 SHA-256 fingerprint 与 UTF-8 byte length；
- Orcana 自己的 detached snapshot 会递归冻结，但不会 freeze 或修改 DSH 原始
  result object；
- ledger 有界，暴露 total / dropped / pending-background；
- 正常 ToolRuntime 调用会关联到 session/call/root-call/tool identity。

证据类型有意收窄为：

```ts
type NativeEvidenceKind = 'sandbox-facts' | 'none'
```

rc.6 下不再保留假的 `native-receipt` 兼容概念。

服务入口：

```ts
ctx.orcanaLinuxEvidence
```

并明确声明 authority：

```ts
{
  enforcementOwner: 'dsh',
  observationSeam: 'shell',
  mutatesExecution: false,
  dangerFullAccessObserved: true,
}
```

### 因果查询

正常 DSH ToolRuntime 调用会关联到：

```text
sessionId
callId
rootCallId
toolName
```

多个 selector 是 AND；直接程序化调用 `ctx.shell` 时，则诚实保留为无 correlation
的执行证据。

```ts
const bySession = ctx.orcanaLinuxEvidence.find({ sessionId })
const byRootCall = ctx.orcanaLinuxEvidence.find({ rootCallId })
const exact = ctx.orcanaLinuxEvidence.latest({ sessionId, callId })
```

当前 ledger 是**进程内证据**。observer reload 可以保留共享状态，但 DSH 进程重启
后不会自动恢复成 durable proof。

## 安装

推荐把 governor + Linux evidence 放在同一个 Orcana profile：

```sh
dsh plugin --profile orcana add \
  @leooday/dsh-bundle \
  @leooday/dsh-orcana-linux-bundle \
  @deepseek-ai/dsh-headless@next
```

只装 Linux evidence：

```sh
dsh plugin --profile orcana-linux add @leooday/dsh-orcana-linux-bundle
```

组合包默认**不改变执行策略**。安装只建立观察/证据层，不会偷偷打开新的限制。

### 从旧加固配置升级

Bundle `0.3.0` 保留 `dsh-orcana-linux` row id，但目标已经切换到
`/native-evidence`。如果已有 profile 仍然给这个行提供旧字段：

```text
network
resourceLimits
degradationPolicy
capabilities
```

新版会抛稳定错误：

```text
LEGACY_HARDENING_CONFIG_MOVED
```

这是故意的。rc.6 没有公开的 resource/network/receipt 等价 API；如果静默删除或
重新解释旧字段，就会让用户误以为原来的加固仍然存在。应删除旧 Orcana 字段，
并且只配置当前安装的 DSH rc.6 真正公开的能力。

### 程序化使用证据适配器

```sh
npm i @leooday/dsh-orcana-linux
```

```ts
import nativeEvidence from '@leooday/dsh-orcana-linux/native-evidence'

ctx.plugin(nativeEvidence, {
  ledgerMaxEntries: 1024,
})
```

## Windows → WSL：同一条命令、同一个 Linux 世界

Windows 安装一次 launcher：

```powershell
npm install -g @leooday/dsh-orcana-linux@^0.4.0
```

然后：

```powershell
dsh-orcana --wsl-doctor
dsh-orcana --wsl-install
dsh-orcana "修复失败的测试"
```

Linux / WSL 里日常任务也是同一条：

```sh
dsh-orcana "修复失败的测试"
```

目标 WSL 的 Node 必须满足当前 pinned DSH 契约：

```text
^22.19.0 || >=24.0.0
```

不强制全局安装 `dsh`。launcher 会先验证现有 `dsh` 是否与固定版本匹配；不匹配
或不存在时才走 pinned npm fallback。v0.4 R5 契约：

```text
@deepseek-ai/dsh@0.1.0-rc.6
pnpm@11.7.0
```

### Bridge 不变量

1. **只有一个执行世界。** Windows 不先跑 DSH 再把每个工具调用送进 WSL；整个
   runtime 在任务开始前就进入 Linux。
2. **cwd 由 WSL 自己映射。** 不硬编码 `/mnt/c`；直接识别
   `\\wsl.localhost\Distro\...` 与 `\\wsl$\Distro\...`。
3. **argv 保持位置参数语义。** 中文、emoji、单双引号、反斜杠、换行、shell
   metacharacter 和 DSH 的 `--` 哨兵不会被重新当成用户可控 shell 字符串解析。
4. **只翻译 DSH 自己拥有的路径字段。** launcher 的 `--patch` 与
   `dsh plugin` 的本地 filesystem spec 会映射；task/app argv 保持 opaque。
5. **环境变量单向、选择性传递。** 常见模型 key、base URL、代理、bootstrap
   网络变量、证书路径通过 `WSLENV` 传入；值不会拼到任务 argv。
6. **Windows runtime home 与 WSL 隔离。** 不复用 Windows `DSH_HOME`、`HOME`、
   `PATH`、原生 `node_modules`，避免 ABI/可执行文件污染。
7. **终端控制走 WSL 原生链。** stdio 和 Windows console cancellation 继续由
   `wsl.exe` 承担，不用 Windows `child.kill()` 假装 POSIX signal。
8. **版本漂移显式失败。** 安装链 pin DSH、pnpm、Orcana runtime packages 与
   bundles，并在安装后做 profile composition + 真实 module/peer import probe。

## `--wsl-doctor` 现在检查什么

包括：

- WSL2 / kernel 与 Node runtime；
- pinned DSH / pnpm toolchain；
- Orcana headless + web profile manifest/module；
- Windows ↔ WSL localhost Web relay；
- loopback proxy 可达性，同时不打印凭据；
- cwd 映射与 WSL-native / Windows-mounted storage；
- Git worktree 与 user identity；
- HTTPS credential helper / 可见 credential manager；
- SSH agent / 默认 key 能力，但不打印 key 文件名；
- TTY、UTF-8 locale、路径 roundtrip、文件系统/mount 语义、WSL interop；
- Windows 挂载目录缺少 DrvFS metadata 时提示 chmod/chown/POSIX 权限差异。

Parity warning 只解释语义差异，不会偷偷修改 Git、WSL、mount 或凭据配置。

Git/npm/build I/O 很重的项目仍建议放在 WSL Linux filesystem，这是性能与 Linux
语义最接近原生的路径。

## 当前证据覆盖范围

Orcana 自己管理的 `orcana`（headless）和 `orcana-web` 产品 profile 使用 DSH
普通 shell 执行链，因此前台/后台 shell 可以获得上述 sandbox-facts evidence。

自定义 profile 还可能挂不经过这个 shell result seam 的 execution capability。
`native-evidence` **不宣称这些路径拥有等价证据**，也不会为了“看起来全覆盖”去
伪造 receipt 或资源/网络 proof。

## 旧兼容入口

包根入口：

```text
@leooday/dsh-orcana-linux
```

暂时保留早期 argv-hardening plugin，避免直接打断已有程序化用户。这个 legacy
入口会 patch `ctx.sandbox.confine`，**当前 bundle 已经不再加载它**。

新的 DSH 集成应使用：

```text
@leooday/dsh-orcana-linux/native-evidence
```

## 已发布 subpath

```text
@leooday/dsh-orcana-linux
@leooday/dsh-orcana-linux/native-evidence
@leooday/dsh-orcana-linux/wsl-bridge
@leooday/dsh-orcana-linux/wsl-launcher
```

`wsl-launcher` 是产品级推荐 API；`wsl-bridge` 是更底层的 transport primitive。

## 开发 / 发布

```sh
pnpm install
pnpm --filter @leooday/dsh-orcana-linux typecheck
pnpm --filter @leooday/dsh-orcana-linux test
pnpm --filter @leooday/dsh-orcana-linux build
pnpm --filter @leooday/dsh-orcana-linux pack
```

`prepack` 会跑 typecheck + tests + build。Profile verifier 探测真实运行模块，包括
`@leooday/dsh-orcana-linux/native-evidence`，因此 export map 或 DSH/Cordis peer 链
坏掉时，不会因为 legacy 根入口还能 import 就假通过。

## License

MIT — 见 [LICENSE](../../LICENSE)。
