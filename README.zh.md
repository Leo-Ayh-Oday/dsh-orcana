# DeepSeek Harness 上的 Orcana

[English](README.md) | 中文

用于更强编码代理执行的运行时治理。

**同一个模型。同一个 DSH。一次运行时干预。**

- 进度感知活性检测（Progress Governor）
- 以 generation 为界的验证证据（Evidence Freshness）
- 证据感知完成判定（Completion Claim Guard）
- 任务级能力披露（Capability Router）
- DSH 原生 Linux 执行证据
- Windows → WSL 单一 Linux 执行世界入口

v0.1 governor 范围仍由 [PLAN-v0.1.md](PLAN-v0.1.md) 冻结。Linux/WSL 线独立演进，
现在采用明确的 authority 分工：

```text
DSH                         Orcana
├ sandbox-policy            ├ Progress / Completion 治理
├ sandbox-local             ├ Native Execution Evidence
├ cgroup / prlimit          └ Windows → WSL 执行适配
└ SandboxReceipt
      │
      └──────────────► Orcana 消费事实，不重复执行限制
```

详细设计见 [docs/architecture.md](docs/architecture.md)、
[docs/methodology.md](docs/methodology.md) 与
[Linux/WSL 包文档](packages/dsh-orcana-linux/README.zh.md)。

## 目录结构

| 路径 | 角色 |
|---|---|
| `packages/governor-core` | 与框架无关的进度事实引擎 |
| `packages/dsh-governor` | DSH 治理适配器 |
| `packages/dsh-bundle` | Governor Profile 组合包 |
| `packages/dsh-orcana-linux` | DSH 原生证据适配器 + 跨平台 `dsh-orcana`；旧 root API 暂作兼容 |
| `packages/dsh-orcana-linux-bundle` | 中立组合包，默认加载 `@leooday/dsh-orcana-linux/native-evidence` |
| `benchmark/` | A/B 测试 |
| `scripts/` | 安装、smoke、release gate |

## 安装

npm scope 为 `@leooday`：

```sh
dsh plugin --profile orcana add \
  @leooday/dsh-bundle \
  @leooday/dsh-orcana-linux-bundle

dsh --profile orcana "<task>"
```

安装默认**不改变执行策略**。Orcana 负责观察执行事实；资源/网络限制配置在 DSH
已有的 `sandbox-policy` 行，DSH 最终产生的 `SandboxReceipt` 才是 Orcana 的证据源。

程序化使用新证据入口：

```ts
import nativeEvidence from '@leooday/dsh-orcana-linux/native-evidence'
ctx.plugin(nativeEvidence)
```

## Windows / WSL：同一个执行入口

设计不是“Windows 上运行 DSH，再把单个工具调用扔进 WSL”。Windows 只负责启动：

```text
Windows Terminal / PowerShell
        ↓
    dsh-orcana
        ↓
      wsl.exe
        ↓
整个 DSH + Orcana runtime 进入 WSL
        ↓
同一个原生 Linux execution world
```

Windows 安装 launcher：

```powershell
npm install -g @leooday/dsh-orcana-linux@^0.4.0
```

然后：

```powershell
dsh-orcana --wsl-doctor
dsh-orcana --wsl-install
dsh-orcana "修复失败的测试"
```

Bridge 保持 cwd/argv 边界，Windows 与 WSL 使用独立 DSH home，通过 WSLENV
选择性单向传递启动/运行环境，并固定 DSH/pnpm 兼容契约。`--wsl-install` 在安装后
不仅检查 profile composition，还会真实 resolve/import 实际运行模块与 peer 链，
包括 `@leooday/dsh-orcana-linux/native-evidence`。

`--wsl-doctor` 还会检查 Web localhost relay、代理可达性、工作区文件系统语义、
Git identity/credential 能力、TTY/UTF-8/path parity、DrvFS metadata 等，但不会
偷偷修改 Windows/WSL/Git 全局配置。

完整契约见
[`packages/dsh-orcana-linux/README.zh.md`](packages/dsh-orcana-linux/README.zh.md)。

## 当前 authority 边界

- **DSH 负责原生 enforcement。** 当前 DSH 已正式拥有 `resourceLimits` / `network`
  policy、cgroup-v2 / prlimit 机制、进程 lifecycle、cleanup 与 `SandboxReceipt`。
- **Orcana 负责治理与证据。** 默认 Linux bundle 观察 `ctx.shell` 的前台/后台执行，
  记录 DSH 真正产生的 receipt。
- **旧 package-root argv-hardening 只是兼容入口。** 当前 bundle 已经不再加载它。
- **自定义 persistent-terminal/PTTY profile 暂不宣称 receipt 等价。** Orcana 自己的
  headless/web 产品 profile 默认并不挂这个 capability。

## 已知限制

- Workspace generation 仍只观察 mutation 类型工具；shell 内部 mutation 需要未来
  git-probe receipt 链。
- Governor 不直接拥有 Agent kill/cancel authority，当前 steering 有明确上限。
- 交互式 Ctrl+C 有意继续走 `wsl.exe` / Linux 终端原生语义。未来程序化
  timeout/cancel 应属于 execution control plane，而不是伪造 Windows POSIX signal。
- `pnpm-lock.yaml` 仍必须在有 registry 网络的环境中使用仓库固定 pnpm 真正重新生成；
  release contract 会阻止手工伪造 rc.5 dependency snapshot。

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。
