# DeepSeek Harness 上的 Orcana

[English](README.md) | 中文

用于更强编码代理执行的运行时治理。

**同一个模型。同一个 DSH。一次运行时干预。**

- 进度感知的活性检测（Progress Governor）
- 以代际（generation）为界的验证证据（Evidence Freshness）
- 证据感知的完成判定（Completion Claim Guard）
- 任务级配置能力披露（Capability Router）
- Linux 原生执行加固 + Windows → WSL 单执行世界桥接

状态：v0.1 governor 实验范围仍由 [PLAN-v0.1.md](PLAN-v0.1.md) 冻结；
Linux/WSL 执行层正在独立演进到 v0.4。细节见
[docs/architecture.md](docs/architecture.md)、[docs/methodology.md](docs/methodology.md)
和 [Linux/WSL 包文档](packages/dsh-orcana-linux/README.zh.md)。

## 目录结构

| 路径 | 角色 |
|---|---|
| `packages/governor-core` | 框架无关的进度事实引擎（零 Cordis 依赖） |
| `packages/dsh-governor` | DSH 适配插件（函数插件，挂载 DSH 扩展点） |
| `packages/dsh-bundle` | Profile 组合包（`dsh.bundle.patch` 契约） |
| `packages/dsh-orcana-linux` | Linux 原生加固层 + Windows → WSL `dsh-orcana` 统一入口 |
| `packages/dsh-orcana-linux-bundle` | Linux 版的 Profile 组合包（`dsh.bundle.patch` 契约） |
| `benchmark/` | A/B 测试：任务清单、patch、运行器、报告 |
| `scripts/` | dev-install / smoke / bench-run |

## 安装

npm scope 已统一为 `@leooday`。DSH profile 继续使用官方插件命令：

```sh
# 一个 profile 一条命令装全部（governor + Linux 加固）：
dsh plugin --profile orcana add @leooday/dsh-bundle @leooday/dsh-orcana-linux-bundle
# 或分开两个 profile：
dsh plugin --profile orcana add @leooday/dsh-bundle
dsh plugin --profile orcana-linux add @leooday/dsh-orcana-linux-bundle
dsh --profile orcana "<task>"
```

`dsh plugin add` 会安装组合包并自动激活为 profile 层（包里的
`dsh.bundle.patch` 声明使其加入层栈）。组合包默认值是**中立的** —— 安装绝不
自动开启更强的资源/网络约束；需要的加固由 profile config 或 `--patch` 明确配置。

如果需要程序化嵌入，也可以直接使用同一 scope 下的实现包，包括
`@leooday/dsh-governor`、`@leooday/governor-core` 和
`@leooday/dsh-orcana-linux`。

## Windows / WSL：同一个执行入口

v0.4 的核心原则不是“Windows DSH 每次工具调用再跳 WSL”，而是：

```text
Windows Terminal / PowerShell
        ↓
    dsh-orcana
        ↓
整个 DSH runtime 一次性进入 WSL
        ↓
DSH + Orcana + sandbox + subprocess + bash/PTC/LSP
        ↓
同一个 Linux execution world
```

这样上层 Agent、preset 和任务无需维护 Windows/Linux 两套执行逻辑；路径、
进程、shell、sandbox 和后台任务从任务开始起就处在 Linux 语义里。

v0.4 发布后，Windows 侧安装一次统一入口：

```powershell
npm install -g @leooday/dsh-orcana-linux@^0.4.0
```

检查 WSL 环境：

```powershell
dsh-orcana --wsl-doctor
```

Bridge 会优先使用 WSL 中已有的 `dsh`；没有全局 `dsh` 时自动回退到 DSH
官方的 `npx --yes @deepseek-ai/dsh` 运行方式。然后可以从 Windows Terminal
直接把 Orcana profile 装进 WSL：

```powershell
dsh-orcana --wsl-install
```

之后 Windows / Linux 都使用同一个命令：

```sh
dsh-orcana "<task>"
```

关键边界：Windows `DSH_HOME` 不与 WSL 共用；Windows cwd 由目标发行版自己的
`wslpath` 映射；`--` 与任务 argv 原样透传；模型密钥等通过单向 `WSLENV`
进入 WSL。Windows 文件系统项目可以直接运行，但 Git/npm/build I/O 很重时，
项目放在 WSL Linux 文件系统中是性能快路径。完整契约见
[`packages/dsh-orcana-linux/README.zh.md`](packages/dsh-orcana-linux/README.zh.md)。

从 checkout 做交互式开发：

```sh
pnpm install && pnpm build
bash scripts/dev-install.sh
bash scripts/install-orcana-linux.sh
dsh --profile orcana "<task>"
```

## 已知限制

- 工作区代际只观察 mutation 类型的工具调用；shell 命令内的变更
  （`sed -i` 等）对代际计数器不可见（后续 git-probe receipts）。
- governor 当前不会直接 kill/cancel Agent；最强动作仍受
  `maxForcedContinuations` 限制。
- Windows Bridge 已保证执行世界、cwd、argv、env 和正常退出码边界；
  **确定性的 Linux 进程组 Ctrl+C/timeout 取消**仍应由下一阶段 WSL-side
  supervisor 完成，而不是用 Windows `child.kill()` 冒充 POSIX signal。

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md) —— PR 携带恰好一个 kind/* 和至少一个
area/* 标签，与上游贡献约定一致。
