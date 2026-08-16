# @leooday/dsh-orcana-linux

[English](README.md) | 中文

**Orcana 的 DSH 原生执行证据层 + Windows → WSL 单一 Linux 执行世界桥。**

这个包现在承担两个明确职责：

1. **Linux / WSL 治理证据** —— DSH 是唯一的 sandbox policy 与原生 enforcement
   owner；Orcana 读取 DSH 真正产生的 shell result / `SandboxReceipt`，不再重复
   套第二层资源限制或网络 namespace。
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
       DSH
  sandbox-policy
        │
        ▼
 sandbox-local          ← 唯一原生 enforcement owner
 cgroup / prlimit
 network isolation
        │
        ▼
      ctx.shell
        │
        ▼
 SandboxReceipt
        │
        ▼
@leooday/dsh-orcana-linux/native-evidence
        │
        ▼
 ctx.orcanaLinuxEvidence
```

## 权限边界

### DSH 负责真正执行限制

当前 DSH 的 `sandbox-policy` 已经正式拥有：

- `mode`
- `workspaceRoot`
- `resourceLimits.memoryBytes`
- `resourceLimits.cpuQuotaUs`
- `resourceLimits.pidsMax`
- `network: inherit | none`

DSH 原生 sandbox provider 自己选择实际机制，例如 cgroup v2 或其明确记录语义
差异的 `prlimit` fallback；它负责进程 attach/detach、cleanup，并最终生成真实的
`SandboxReceipt`。

**Orcana 不应再重复执行这一层。** 因此当前组合包加载的是：

```text
@leooday/dsh-orcana-linux/native-evidence
```

而不是旧包根入口。

### Orcana 负责证据与治理

`native-evidence` 观察 DSH 公共 `ctx.shell` 结果边界：

- 不修改 `ShellExecSpec`、sandbox policy、argv、lifecycle、result object 或
  process handle；
- 前台任务在 `shell.run()` 真正完成后结算证据；
- 后台任务等待原样返回的 `ShellProcess.done` 完成后再记录；
- observer reload/HMR 后，已经启动的后台任务证据仍会归入同一持久 ledger；
- 记录 DSH 真 receipt：实际 layers、degraded、limits mechanism、cgroup path、
  memory/CPU/PID peak、cleanup verification、live usage；
- `danger-full-access` 只记录真实 sandbox facts，不伪造不存在的 native receipt；
- 不保存原始 command，只保存 SHA-256 fingerprint 与 UTF-8 byte length，降低
  command 中 token/secret 落入治理台账的风险；
- ledger 有界，暴露 total / dropped / pending-background。

服务入口：

```ts
ctx.orcanaLinuxEvidence
```

并明确声明自己的 authority：

```ts
{
  enforcementOwner: 'dsh',
  observationSeam: 'shell',
  mutatesExecution: false,
  dangerFullAccessObserved: true,
}
```

## 安装

推荐把 governor + Linux evidence 放在同一个 Orcana profile：

```sh
dsh plugin --profile orcana add \
  @leooday/dsh-bundle \
  @leooday/dsh-orcana-linux-bundle
```

只装 Linux evidence：

```sh
dsh plugin --profile orcana-linux add @leooday/dsh-orcana-linux-bundle
```

组合包默认**不改变执行策略**。安装只建立观察/证据层，不会偷偷打开新的网络
限制或资源上限。

### 原生资源/网络限制要配 DSH

通过后续 profile/user patch 修改 DSH 已有的 `sandbox-policy` 行。DSH patch 会替换
该行整个 `config`，所以增加限制时要保留当前 mode 与 workspace root：

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

之后 Orcana 消费的是 DSH 真正执行后产生的 receipt，而不是第二份平行的
“Orcana 估算加固结果”。

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
或不存在时才走 pinned npm fallback。v0.4 默认：

```text
@deepseek-ai/dsh@0.1.0-rc.5
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
5. **环境变量单向、选择性传递。** 常见模型 key、base URL、代理、DSH
   bootstrap-only 网络变量、证书路径通过 `WSLENV` 传入；值不会拼到任务 argv。
6. **Windows runtime home 与 WSL 隔离。** 不复用 Windows `DSH_HOME`、`HOME`、
   `PATH`、原生 `node_modules`，避免 ABI/可执行文件污染。
7. **终端控制走 WSL 原生链。** stdio 和 Windows console cancellation 继续由
   `wsl.exe` 承担，不用 Windows `child.kill()` 假装 POSIX signal。
8. **版本漂移显式失败。** 安装链 pin DSH、pnpm、Orcana runtime packages 与
   bundles，并在安装后做 profile composition + 真实 module/peer import probe。

## `--wsl-doctor` 现在检查什么

它已经不是简单的“WSL 在不在”：

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

Parity warning 只解释“不像原生 Linux”的原因，不会偷偷修改 Git、WSL、mount 或
凭据配置。

Git/npm/build I/O 很重的项目仍建议放在 WSL Linux filesystem，这是性能与 Linux
语义最接近原生的路径。

## 当前证据覆盖范围

Orcana 自己管理的 `orcana`（headless）和 `orcana-web` 产品 profile 使用 DSH
普通 shell 执行链，因此前台/后台 shell 都能获得上面的 native evidence。

自定义 DSH profile 还可能挂其他 execution capability。当前 DSH 的 persistent
terminal/PTTY 实现会 confine argv，但没有通过 shell result seam 暴露同等级
lifecycle receipt。因此 `native-evidence` **暂不宣称 custom terminal/PTTY receipt
等价**，也不会为了“看起来全覆盖”去伪造证据。

这不是当前 Orcana 默认 headless/web profile 的阻断项；默认产品 closure 并不挂
persistent terminal-bash。

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

资源/网络 policy 归 DSH `sandbox-policy` 所有。

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

`prepack` 会跑 typecheck + tests + build。Profile verifier 现在探测的是真实运行
模块，包括 `@leooday/dsh-orcana-linux/native-evidence`，因此 export map 或
DSH/Cordis peer 链坏掉时，不会因为 legacy 根入口还能 import 就假通过。

仓库 release contract 也会故意阻断 stale lockfile。当前 `pnpm-lock.yaml` 仍需在
具备 registry 网络的环境中用仓库固定的 pnpm 重新生成；不要手工把 rc.6 dependency
snapshot 改成 rc.5 伪造一致性。

## License

MIT — 见 [LICENSE](../../LICENSE)。
