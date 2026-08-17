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
DSH rc.6                    Orcana
├ sandbox-policy            ├ Progress / Completion 治理
│  └ mode/workspaceRoot     ├ Native shell evidence
├ sandbox-local             └ Windows → WSL 执行适配
└ ctx.shell
   └ sandbox facts
      { mode, denied,
        enforcement?,
        runnerFailed? }
             │
             └──────────► Orcana 消费事实，不重复执行限制
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

## 实测效果（初步）

配对 A/B：同一模型（deepseek-v4-flash），control vs treatment（governor
激活），由独立 acceptance 命令判定。完整装置与原始数据：
[benchmark/](benchmark/README.md)、`benchmark/reports/`。

| 任务 | n | treatment − control（tokens） |
|---|---|---|
| demo-format-money（合成 verification trap） | 2 | -871 / -2695（均为负） |
| marked-blank-tab（真实 issue markedjs#4007） | 6 | -4079 / +4082 / -29107 / -12181 / +48428 / -8850（4/6 负，中位数约 -6.5k） |
| dayjs-updatelocale（真实 issue dayjs#1118） | 3 | +2459 / -1841 / -731（2/3 负，中位数约 -0.7k） |

合计 11 对中 **8 对 treatment tokens 更少**（每个任务中位数均为负）。真实
任务的 calls 维度被预算截断。样本小——可靠交付物是整套实验装置，效果
大小需要更多 reps 与任务。

## 安装

npm scope 为 `@leooday`。完整 Orcana Profile 使用一条命令安装：

```sh
dsh plugin --profile orcana add @leooday/dsh-bundle @leooday/dsh-orcana-linux-bundle @deepseek-ai/dsh-headless@next
```

这里明确使用 `@deepseek-ai/dsh-headless@next`，作为 R5 已验证的安装路径。

然后运行：

```sh
dsh --profile orcana "<task>"
```

安装默认**不改变执行策略**。DSH rc.6 负责自己的文件效果 sandbox policy 与
真正 enforcement；Orcana 只读取公开的执行后 shell sandbox facts，不额外增加
资源限制、网络隔离或第二层 sandbox。

程序化使用证据入口：

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

- **DSH 负责原生文件 confinement。** rc.6 的 `SandboxExecutionPolicy` 公开
  `mode`、`workspaceRoot` 与可选 `sessionId`；sandbox provider 负责真正限制，并
  通过 shell result seam 返回执行事实。
- **Orcana 负责治理与证据。** 默认 Linux bundle 记录前台/后台 `ctx.shell` 的
  `ShellSandboxInfo`：`mode`、`denied`，以及可选的 `enforcement`、`runnerFailed`。
- **不做 receipt 兼容伪装。** rc.6 已不再公开旧的 `SandboxReceipt`、资源限制或
  网络证据 API。Orcana 不会从 argv、stderr 或 provider 内部信息反推这些结论。
- **旧 package-root argv-hardening 只是兼容入口。** 当前 bundle 已经不再加载它。

## 已知限制

- rc.6 的 native evidence 是 **sandbox-facts 证据**，不是资源/网络 accounting
  proof。治理/完成判定不能把它当成 cgroup、网络隔离、峰值用量、cleanup 或
  degradation 证据。
- Workspace generation 仍只观察 mutation 类型工具；shell 内部 mutation 需要未来
  git-probe evidence 链。
- Governor 不直接拥有 Agent kill/cancel authority，当前 steering 有明确上限。
- 交互式 Ctrl+C 有意继续走 `wsl.exe` / Linux 终端原生语义。未来程序化
  timeout/cancel 应属于 execution control plane，而不是伪造 Windows POSIX signal。

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。
