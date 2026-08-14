# DeepSeek Harness 上的 Orcana

[English](README.md) | 中文

用于更强编码代理执行的运行时治理。

**同一个模型。同一个 DSH。一次运行时干预。**

- 进度感知的活性检测（Progress Governor）
- 以代际（generation）为界的验证证据（Evidence Freshness）
- 证据感知的完成判定（Completion Claim Guard）
- 任务级配置能力披露（Capability Router）

状态：v0.1 实验性 —— 范围与冻结的 benchmark 不变量见
[PLAN-v0.1.md](PLAN-v0.1.md)，细节见 [docs/architecture.md](docs/architecture.md)
和 [docs/methodology.md](docs/methodology.md)。

## 目录结构

| 路径 | 角色 |
|---|---|
| `packages/governor-core` | 框架无关的进度事实引擎（零 Cordis 依赖） |
| `packages/dsh-governor` | DSH 适配插件（函数插件，挂载 DSH 扩展点） |
| `packages/dsh-bundle` | Profile 组合包（`dsh.bundle.patch` 契约） |
| `packages/dsh-orcana-linux` | dsh-orcana Linux 版：官方 sandbox 契约之上的原生加固层 |
| `packages/dsh-orcana-linux-bundle` | Linux 版的 Profile 组合包（`dsh.bundle.patch` 契约） |
| `benchmark/` | A/B 测试：任务清单、patch、运行器、报告 |
| `scripts/` | dev-install / smoke / bench-run |

## 安装

发布后，官方 DSH 组合包安装（`@leooday/*` 包发布后可用）：

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
改变 DSH 的执行语义；启用加固需编辑 `~/.dsh/profiles/<name>/cordis.patch.yml`
中该行的 config，或用 `--patch` overlay。

在包发布之前，通过 profile 的 `pnpm-workspace.yaml` override 安装本地构建的
tarball（见 [`scripts/install-orcana-linux.sh`](scripts/install-orcana-linux.sh)
和 smoke 套件）—— 没有 registry 的 checkout 中，`dsh plugin add` 的
`file:`/`link:` 方式无法解析组合包的 workspace 依赖。

从 checkout 做交互式开发：

```sh
pnpm install && pnpm build
bash scripts/dev-install.sh              # 安装 governor profile 到 ~/.dsh/profiles/orcana
bash scripts/install-orcana-linux.sh     # 安装加固 profile 到 ~/.dsh/profiles/orcana-linux
dsh --profile orcana "<task>"
```

## 已知限制

- 工作区代际只观察 mutation 类型的工具调用；shell 命令内的变更
  （`sed -i` 等）对代际计数器不可见（v0.2：git-probe receipts）。
- v0.1 从不杀死或取消代理；最强动作是被 `maxForcedContinuations`
  限制的 steer 提醒。

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md) —— PR 携带恰好一个 kind/* 和至少一个
area/* 标签，与上游贡献约定一致。
