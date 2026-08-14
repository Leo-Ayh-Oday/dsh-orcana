# Orcana Runtime Pack for DSH — v0.1 实施计划(v2,评审修正版)

> 一句话目标:把 Orcana 的 runtime-governance primitives 以纯 Cordis 插件形式接入 DSH,不改模型、不改 Agent Loop、不改任何核心包,通过受控 A/B 实验证明"执行纪律"能改善真实 coding agent 的任务质量与效率。
>
> 卖点:**Same model. Same DSH. One runtime intervention.**(唯一变量是 Orcana 是否被激活)

---

## 1. v0.1 范围

**做(4 模块 + 基建):**

| # | 模块 | 职责 |
|---|---|---|
| 1 | Progress Governor | 基于实际进展(非工具调用数)识别零进展轮,warn-steer 渐强引导,不杀 agent |
| 2 | Evidence Freshness | workspace generation + verification receipts,stale 即失效 |
| 3 | Completion Claim Guard | 模型准备结束时拦截,"结论不能超过运行时证据",只做客观硬规则 |
| 4 | Capability Router | 任务画像式工具披露(progressive disclosure via `ctx.tools.restrict()`) |
| — | dsh-bundle + bench profile | 激活开关(control/treatment 双 patch) |
| — | benchmark harness | 同构 A/B、隔离 home、配对执行、权威 supervisor、独立 judge |

**明确不做:** Linux Execution Fabric、AgentWorld、Full Ripple、Multi-Agent Graph、memory system、continual evolution、custom TUI、新 retry 引擎、第二套 conversation log。

## 2. 架构决策

### 2.1 仓库形态:独立 repo,core / adapter / bundle 三层

```
orcana-dsh/                          # 独立 repo,DSH 侧零 diff
├── packages/
│   ├── governor-core/               # @orcana/governor-core —— 框架无关核心
│   │   └── src/                     #   ProgressFactEngine、fingerprint、generation、receipt 纯逻辑
│   │                               #   零 Cordis 依赖,可服务 Orcana / DSH / 其他 harness
│   ├── dsh-governor/                # @orcana/dsh-governor —— DSH adapter(函数插件)
│   │   └── src/                     #   name/inject/Config/apply,挂 DSH 扩展点,调 governor-core
│   └── dsh-bundle/                  # @orcana/dsh-bundle —— profile bundle
│       ├── package.json             #   "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
│       └── cordis.patch.yml
├── benchmark/
│   ├── tasks/                       # 候选任务 + dry-run 结果
│   ├── manifests/                   # 冻结的任务 manifest(内容寻址)
│   ├── patches/                     # control.patch.yml / treatment.patch.yml
│   ├── runner/                      # supervisor:预算、配对、隔离 home、权威状态
│   └── reports/
├── scripts/                         # dev-install.sh / smoke-install.sh / bench-run.sh
├── docs/
│   ├── architecture.md
│   └── methodology.md
└── README.md
```

依赖方向:`governor-core` ← `dsh-governor` ← `dsh-bundle`。核心不与 Cordis 绑死;"毕业进 DSH"是未来路径,不是当前设计约束(§9.1)。

### 2.2 拦截点映射(已对 DSH 代码库逐项验证,全部现成)

| 功能 | DSH 扩展点 | 位置 |
|---|---|---|
| 观察每次工具调用 | `tools/post-execute` waterfall | packages/core/tools/src/index.ts:175 |
| 附加下一条请求提醒 | `PostToolDecision.additionalContexts`(plugin-source user message) | 同前 |
| 轮次即将结束时拦截 | `agent/turn-stopping` + `agent.steer()`(官方 /loop pattern,有测试) | packages/core/agent-loop/src/agent.ts:296 |
| 用户打断重置 | `agent/pre-step` | repeat-tool-reminder 现成模式 |
| 工具裁剪/渐进披露 | `ctx.tools.restrict({allow,deny})`,返回 disposer 可随时 lift | packages/core/tools/src/index.ts:1071 |
| 持久化/回放 | session log:`tool/call`、`tool/result`、`assistant/message`(含 usage)、`turn/end` | packages/core/session/src/types.ts:243-346 |

### 2.3 解析与组合语义(源码确认,§9.2 的依据)

- **Layer 顺序**:bundle patches(按 `dsh.profile.bundles` 顺序)→ profile 自己的 `cordis.patch.yml` → launcher layers(`--patch` 文件与 flag 派生 patch)(app-boot/src/profile.ts:8-13)
- **Loader baseUrl = profile 目录**(app-boot/src/index.ts:769 `ctx.baseUrl = dirname(config)`;profile.ts:17)
- **插件解析锚点**:DSH 安装 closure 优先,profile 的 `node_modules` 次之 —— **`--patch` 文件所在位置 ≠ 插件解析位置**
- **peer 语义(措辞修正)**:profile workspace 是 `nodeLinker: hoisted` + `autoInstallPeers: false`;DSH 维护 `$DSH_HOME/profiles/node_modules` flat symlink fallback,内容 = **DSH 安装 dependency closure 中已可解析的包(含 peer)**。不变量:Orcana 可以直接依赖 DSH 已提供的 service-definition peers;任何不在安装 closure 里的 peer,**必须由 orcana 包/profile 自己声明负责** —— 不能假设"missing peer 都会被 heal"

## 3. 模块设计

### 3.1 Progress Governor(核心)

**Fingerprint(观察指纹)** — 每次工具执行生成:

```ts
fingerprint = hash(toolName, canonicalArgs, resultHash, workspaceGeneration)
```

- `canonicalArgs`:deep key-sort 后 JSON.stringify(成熟实现已在 DSH:repeat-tool-reminder)
- `resultHash`:`ToolExecutionResult.content` 的 SHA-256(实测勘误:post-execute 观察到的就是**原始** content;`tool-result-pruner` 是独立服务,在 compaction 阶段(compaction-basic 触发)才改写日志 —— 指纹稳定性靠内容自身确定性,不做二次裁剪)

**进度分类(保守,只做客观信号):**

| 信号 | 判定 |
|---|---|
| mutation 类工具(write/edit/str-replace-editor)成功 | ✓ progress |
| 同 (tool,args) 但 resultHash 变化(新结果) | new-evidence(对 escalation 视为非零进展,区别于 repeated) |
| generation 变化(workspace 被改动) | ✓ progress |
| 新验证发生(新 receipt) | ✓ progress |
| 同 (tool,args,resultHash) 且 generation 未变 | ✗ 重复观察 |
| 纯文本分析 / "下一步我会修改……" | 不参与判定(不做 LLM-judge) |

**Escalation ladder(mode: warn-steer,阈值可配,默认 2/3/4):**

- 连续 2 个零进展轮 → `"Stop repeating investigation. Take the next concrete action."`
- 3 轮 → `"Re-evaluate the current approach before continuing."`
- 4 轮 → strong steer(点名重复模式:重复 read / 重复命令 + 轮次序号)
- **硬上限**:turn-stopping 强制续轮数(默认 3,可配),超过放行 — v0.1 绝不 kill(代码库 hooks-claude-code/src/index.ts:269 已挂 `TODO(stop-loop-guard)`)
- **零进展链重置点(P2 实现约定)**:mutation 成功(gen 前进)、非 repeated 信号、用户打断(claimed 含 user message)都重置链;gen 前进的同一观察即使被判 repeated(如重复写相同内容)也不算零进展

**与 repeat-tool-reminder 协调(必须处理):** base 默认启用(thresholds [3,5,8]);orcana profile 中 governor 接管重复观察(补 resultHash + generation 两层),patch 里 `exclude` 指向 governor 跟踪的工具集,同一模式只收一条提醒。

### 3.2 Evidence Freshness

**workspace generation:** plugin-owned derived state,逐 agent;gen++ = mutation 类工具成功返回。**已知局限**:bash 内 mutation(`sed -i`)不可见 → Known Limitations;v0.2 升级 git 探针(`git status --porcelain` + `git diff` hash)。**与 evidence 开关的耦合(已记录)**:gen 跟踪挂在 `evidence.enabled` 下(gen 是 Evidence Freshness 域的状态);evidence 关掉时 generation 不再前进,classify 的 gen 类信号与 receipt staleness 一起失效 —— 消融时按此预期解读,不视为 bug。

**VerificationReceipt:**

```ts
interface VerificationReceipt {
  tool: string;            // 验证命令工具(默认 bash)
  command: string;         // canonical args
  resultHash: string;
  generation: number;      // 验证发生时的 workspace generation
  status: 'pass' | 'fail' | 'unknown';
  turn: number; step: number; callId: string;
}
```

- 验证命令识别:test|typecheck|build|check|lint 模式(Config 可配)
- **stale 判定**:`receipt.generation !== 当前 generation` → STALE

**模型可见验证状态(简洁 context):**

```
Verification state:
- targeted test: PASS @gen18
- typecheck: NONE
- build: NONE
```

### 3.3 Completion Claim Guard

**拦截点**:`agent/turn-stopping`。三条硬规则(任一命中 → steer 续一轮,计入 §3.1 上限):

1. 本任务有 mutation 且验证 receipt 全部 STALE → steer
2. 存在 fail 状态 receipt 且之后无更新的 pass receipt → steer
3. (可选开关)assistant 最后文本含完成声明("tests pass"/"全部通过")但无当前 pass receipt → steer —— 文本只触发检查,不参与判定

**明确不做**:判断"任务是否真正完成"。

### 3.4 Capability Router

- **稳定核心(始终可用)**:read、write、edit、bash、todo_write(web_search 由 base 保证常开)
- **画像 v0.1**:coding(核心 + fs-search + str-replace-editor + subagent + workflow)/ research(核心 + web 全量)/ minimal(核心子集);benchmark 任务显式声明,交互场景默认 coding + 手动切换
- **实现**:首轮前 `agent.ctx.tools.restrict()`;v0.1 静态画像 + 手动 lift,自动渐进披露留 v0.2

### 3.5 不变量合规(DSH 硬约定)

1. 不建第二套 log:全部状态是 plugin-owned derived state,resume 从 session log 重放重建
2. model-visible ⟺ logged:每条 steer/提醒 = `createUserMessage({source:{kind:'plugin', plugin:'orcana-*'}})`,随 `user/message` 落盘
3. 提醒文本是稳定模型可见字符串 → 快照覆盖
4. 插件导出遵循函数插件约定(name/inject/Config/apply,无 default export)

## 4. Profile / bundle 设计

**控制面与处理面分离:同一 profile,双 patch。协调排除项在共享层,两臂补丁唯一差异 = orcana 行**(§10.1 硬不变量,审计修正):

```yaml
# profiles/bench/cordis.patch.yml(两臂共享,make-bench-home.sh 生成)
# 与 repeat-tool-reminder 协调:governor 接管 read/bash/search 的重复观察,
# base 提醒在双臂一致地排除它们 —— 双臂 base 配置完全相同
- id: repeat-tool-reminder
  config:
    exclude: [read, bash, '*search*']

# benchmark/patches/treatment.patch.yml(激活 Orcana,唯一差异行)
- insert:
    - id: orcana
      name: '@orcana/dsh-governor'
      config:
        governor:  { enabled: true, mode: warn-steer, zeroProgressThresholds: [2, 3, 4] }
        evidence:  { enabled: true, freshness: generation, verifyCommandPatterns: [test, typecheck, build, check, lint] }
        completion:{ mode: evidence-bound, maxForcedContinuations: 3 }
        tools:     { disclosure: task-profile, defaultProfile: coding }

# benchmark/patches/control.patch.yml(不激活 Orcana)
# 空列表(两臂 node_modules/profile/base 配置完全一致,唯一差异 = activation)
```

- patch 配置支持 `!!js process.env.ORCANA_*`,消融变量环境变量切换,无需重建

## 5. Benchmark(评审修正版)

### 5.1 结构:同一 bench profile,唯一变量 = activation

```
                 Benchmark Task Manifest
                         │
                         ▼
                Prepared Base Workspace
                         │
               verified baseline green (Gate A)
                         │
                         ▼
                  Hidden Reproducer
                         │
                    verified red (Gate B)
                         │
             ┌───────────┴───────────┐
             │                       │
             A                       B
             │                       │
       Same DSH Profile         Same DSH Profile
       Same Orcana pkg          Same Orcana pkg
       Same node_modules        Same node_modules
       Same pnpm-lock           Same pnpm-lock
             │                       │
      Control Patch (off)     Treatment Patch (on)
             │                       │
             └───────────┬───────────┘
                         │
                  Same Model
                         │
                  40 LLM Calls · 30 min Deadline · Cost Fuse
                         │
                         ▼
                   Independent Judge
```

**不变量:两臂共享完全相同的 profile / node_modules / lockfile / 已安装的 orcana 包,唯一差异是 activation。** Orcana 包在双臂之前就安装好(`pnpm add file:`),A 用空 patch,B 用 treatment patch。

### 5.2 隔离:每轮全新 DSH_HOME

- 建 `bench-home-template/`(profiles/bench + package.json + pnpm-lock.yaml + pnpm-workspace.yaml + node_modules,**无任何全局 patch**)
- 每 run:`template → copy/reflink → run-home-NNN`,设 `DSH_HOME=<run-home-NNN>`
- 用户日常的 TUI、plugins、settings、`$DSH_HOME/cordis.patch.yml` 全部隔离在 benchmark 之外

### 5.3 预算与权威判定(supervisor 说了算)

| 约束 | 值 | 语义 |
|---|---|---|
| 主预算 maxLLMCalls | 40/任务 | 工作量的直接度量,与延迟解耦 |
| 护栏 wallTimeout | 30 min/任务 | 到点即判定,不等待 |
| 保险丝 costCeiling | 可配(如 ¥X 或 tokens 上限) | 防"35 calls × 巨量上下文"烧穿,不作主评分 |
| 固定 | max_output_tokens / effort / sampling | 两臂同值 |

**超时处理(权威性修正)**:launcher 的 SIGTERM = supervisor ordinary stop = exit 0,launcher 不知道任务是否完成 → **绝不把 exit 0 当 success**。Runner 流程:

```
deadline reached
  → benchmark state = INCOMPLETE_TIMEOUT(权威事实,先于任何 exit code)
  → SIGTERM
  → grace 5s
  → 仍未退出 → SIGKILL
  → 无论 DSH exit code(0/130/137…),记录 { outcome: "incomplete", reason: "wall_time_budget_exhausted" }
```

**数据持久性措辞(修正)**:超时不会丢失已跨过语义 checkpoint 的历史(model request 前 / 顶层工具副作用前 / agent/pre-step 三处 checkpoint);**最后一个 in-flight streaming batch 允许丢失;未完成的外部副作用按 unknown outcome 处理**(持久化 call 无 result,恢复语义 = `TOOL_OUTCOME_UNKNOWN`,不能证明副作用是否发生)。

**重试**:仅 infra 失败(进程崩、API 挂)允许重跑;结果性失败零重试。

### 5.4 执行:paired + randomized

- 逐任务随机臂序(task 01: B,A;task 02: A,B;...),一对尽量连续执行
- **统计单元 = (task, arm) 配对**,不是"全部 A 平均 vs 全部 B 平均"
- 报告:paired success delta、paired call delta、paired token delta、paired wall delta
- 主效果相对差 <20% → 加 2 reps(72 runs)压噪声
- 记录每 run 的精确时间戳与 provider response metadata(模型服务端时间漂移无法取不可变快照,用紧配对 + 随机序 + 记录抵消)

### 5.5 任务管线:三 Gate 分开验证(评审修正)

```yaml
baseline:     # Gate A — repo 健康:官方 base + 原有测试套件 = GREEN
  existing_suite: PASS
reproducer:   # Gate B — 任务真实:base + hidden reproducer = RED
  base: FAIL
official_fix: # Gate C — fix 真实性:official fix + 原有套件 = PASS + reproducer = PASS
  existing_suite: PASS
  reproducer: PASS
```

三件事是**不同的测试、分开验证、全部写死进 manifest**。候选 repo 名只是搜索池,最终入选资格只来自 Gate。

### 5.6 污染封锁(防抄答案)

真实已合并 PR 的答案就在 repo 历史 / GitHub / 搜索引擎里,执行环境必须:

```
network:
  github.com       DENY
  search engine    DENY
  arbitrary web    DENY
  registry         ALLOWLIST ONLY(仅必要时)
```

- 依赖在 task preparation 阶段预装(install + build cache + baseline verify 都在考试前完成)
- repo 预处理:`git remote remove origin`;生成只含 base 所需历史的 benchmark clone,**保证 future fix commit 不在本地 object/history 里**
- 任务文本内容寻址(§5.7),剔除泄露 fix 思路的后续评论

### 5.7 Task Manifest(冻结、内容寻址)

```yaml
task_id: <repo>-<issue#>
source:
  issue: <url>
  snapshot_at: <iso8601>
  prompt_sha256: <hash>          # 任务文本内容寻址
repository:
  repo: <owner/name>
  base_sha: <sha>                # fix 的 parent
  fix_sha: <sha>
  verifier_sha: <sha>            # 验证脚本版本
verification:
  baseline_command: <cmd>        # Gate A
  reproducer: <cmd|file>         # Gate B
  acceptance: <cmd|file>         # Gate C + judge
environment:
  node: <version>
  install_command: <cmd>
  network: <deny|allowlist>
calibration:
  install_seconds: <n>           # dry-run 实测
  test_seconds: <n>
gates:
  baseline: { existing_suite: PASS }
  reproducer: { base: FAIL }
  official_fix: { existing_suite: PASS, reproducer: PASS }
```

六个月后凭 manifest 可完整复跑。

### 5.8 指标(全部从 session JSONL 离线导出,独立报告,不揉成"成本分")

| 类别 | 指标 |
|---|---|
| 结果 | Task success(judge 判定)、False completion(agent 宣称完成但 verifier 失败) |
| 成本 | LLM calls、input tokens、output tokens、cached tokens、cost、wall |
| 纪律 | Tool calls、Duplicate reads、Duplicate commands、Zero-progress rounds |
| 效率 | Time to first write、Time to first verification |
| 归因 | Stale evidence attempts、Completion interventions、Governor interventions、**Intervention outcome**(steer 后是否发生具体动作) |

## 6. 实施顺序(P0–P9)

| # | 内容 | 产出 | 验证方式 |
|---|---|---|---|
| P0 | repo 三层骨架 + bundle + 隔离 home 模板 + 安装冒烟 | `dsh --profile bench` 可 boot;**packed 与 local-file 两条安装路径都 mount/dispose 正确** | smoke-install.sh |
| P1 | governor-core:观察层(fingerprint + generation + receipts,含 resume 重放) | 纯逻辑引擎 | 单测:从 log 重建状态一致 |
| P2 | dsh-governor:Governor steer(escalation + 上限) | post-execute 提醒 + turn-stopping 续轮 | 单测 + 提醒文本快照 |
| P3 | Evidence 呈现 + stale 判定 | 验证状态 context | 单测 |
| P4 | Completion guard 三规则 | turn-stopping 拦截 | 单测 + 快照 |
| P5 | Capability Router | restrict 应用 + 画像 | 单测:schema 变化断言 |
| P6 | 任务选取 + 三 Gate dry-run + runner(supervisor/配对/隔离) | 冻结 manifests + A/B 可运行 | 基线任务跑通 |
| P7 | A/B 实验 + paired 分析 | 报告 | 归因结论 |
| P8 | README + docs | 发布物 | — |
| P9 | GitHub release(若 P7 有结果) | 发布 | — |

## 7. 验收标准

1. 零核心包改动:DSH 侧只安装 bundle,无 fork、无 agent-loop patch
2. A/B 两臂 profile / node_modules / lockfile 完全一致,唯一变量 = activation
3. 无 steer 死循环:续轮上限生效且有测试
4. 提醒文本快照稳定;resume 后状态可从 session log 完全重建
5. 超时判定 authority = supervisor,exit code 永不直接当 success
6. 三 Gate 分开验证全部写死;污染封锁生效(fix commit 不在执行环境可达处)
7. 报告:paired deltas + 全部独立指标 + pin 清单(DSH SHA、Orcana SHA、Node、pnpm、OS、model id、profile config digest、task manifest digest)

## 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| steer 提醒成为新噪声 | 阈值可配;intervention outcome 指标;消融定位 |
| 与 repeat-tool-reminder 双重提醒 | profile 内显式协调(exclude) |
| generation 不完整(Shell 内 mutation) | Known Limitations;v0.2 git 探针 |
| router 误分类 | v0.1 显式声明画像,不做 LLM 分类 |
| 小样本方差 | paired + 逐任务明细 + 效率/纪律指标;主效果 <20% 加 reps |
| 模型服务端时间漂移 | 紧配对 + 随机臂序 + 时间戳 + provider metadata |
| 抄答案污染 | 网络封锁 + remote 移除 + fix commit 不进历史 + prompt 内容寻址 |
| 本地安装冒烟失败 | P0 最先验证 packed 与 local-file 两条路径;备选:临时 registry |

## 9. 决策记录

### 9.1 仓库位置与分层
独立 repo;core / adapter / bundle 三层,核心零 Cordis 依赖。兼容 upstream(插件导出形状、bundle manifest、Cordis lifecycle、Known Limitations、packed install smoke)但 v0.1 不背 upstream 内部组织(双语文档、snapshot、repo invariant、100% coverage、doc-sync)——提交 upstream 前再补。"上贡"路径(`packages/guard/*` + `packages/bundle/orcana`)保留,但不作为当前设计约束。

### 9.2 安装/加载(源码确认后的修正)
- `--patch` 文件位置 ≠ 插件解析位置;解析锚点 = 安装 closure → profile node_modules
- Dev:profile 内 `pnpm add file:`;Benchmark:同构 bench profile + 双 patch;Release:`npm publish` + `dsh plugin --profile orcana add`
- peer 不变量:依赖 DSH 已提供的 service-definition peers 允许;不在安装 closure 的 peer 自己负责

### 9.3 预算与超时
主预算 40 LLM calls;护栏 30 min;保险丝 cost ceiling;超时由 supervisor 权威判定(INCOMPLETE_TIMEOUT → SIGTERM → 5s grace → SIGKILL);持久性措辞 = semantic-checkpoint durability(允许丢最后 in-flight batch / 副作用 unknown)。

### 9.4 任务
候选 repo 是搜索池不是规范;入选只凭三 Gate;污染封锁 + 内容寻址 manifest。

### 9.5 模型
主 A/B 用 base 默认 deepseek-v4-flash;敏感度第二模型;pin 全清单;紧配对 + 随机序 + 时间戳抵消漂移。

### 9.6 P0 packaging / activation smoke verification
- 两条安装路径都要 mount/dispose 正确:local-file(profile 内 `file:` + overrides)与 packed(`pnpm pack` tarball,发布路径预演)
- 断言策略(审计后定稿):`--dump-config` 证明行存在(组合树);**real-boot 哨兵**证明树加载 + 全部行激活 —— keyless 下 boot 必须越过加载、只败在 `MISSING_CREDENTIAL`;负例控制(无法解析的插件行必须 `failed to load`)保证探测有牙齿
- 陷阱(实测):`--help` 在树激活前退出,对坏行也 exit 0 —— 不能作为激活证据

## 10. 硬不变量(评审冻结,进入 P0 前生效)

1. **A/B 同构**:两臂使用完全相同的 profile、依赖树、已安装的 Orcana package,只改变 activation。
2. **隔离**:benchmark 使用隔离 DSH_HOME(模板复制),禁止用户 profile/home patch 污染。
3. **权威判定**:超时由 benchmark supervisor 判定,不信任 DSH 的 SIGTERM exit 0。
4. **持久性语义**:= semantic-checkpoint durability;允许最后 in-flight batch / 外部副作用 unknown outcome。
5. **三 Gate 分离**:原有套件 green(Gate A)、任务 reproducer red(Gate B)、official fix green(Gate C),三个测试分别验证、全部写死。
6. **唯一变量**:同模型、同 DSH SHA、同任务、同预算、同 workspace 类别;唯一 independent variable = Orcana runtime behavior。

## 11. P0 验证结论(已实测,SMOKE OK)

旧"overlay resolution uncertainty"已解除;P0 冒烟全部通过:

1. **解析语义成立**:`--patch` overlay 正确插入 orcana 行(control 无行、treatment 有行,由 `--dump-config` 组合树证明);boot exit 0(Loader 对无法激活的 entry fail loud,exit 0 ⇒ 行已激活)
2. **local-file 安装路径**:profile 内 `pnpm add file:` 可用;overrides 方案生效
3. **packed 安装路径**:`pnpm pack` tarball 安装 boot 通过(发布路径预演)
4. **dev-install**:临时 home 下 orcana profile 包安装 + 组合树含 governor 行
5. **两个实测坑(已修复,记录在案)**:
   - pnpm 11 对未发布的 workspace 包不做 range 链接(直接打 registry 404)→ 仓库内用 `workspace:^`,profile 侧用 pnpm-workspace.yaml 的 `overrides` 映射到 `file:`(pnpm 11 已不读 package.json 的 `pnpm` 字段)
   - YAML plain scalar 中 `? ... : ...` 三元表达式含 `: ` 会被解析成 mapping → 用 `(cond && a) || b` 形式替代
6. **断言策略**:headless 组合无 console logger(info 不可见)→ smoke 用 dump-config + exit code 断言,不 grep 日志

**P0 遗留(不算阻塞)**:`dsh plugin` 命令本体(launcher 侧,pnpm 转发)未实测;release 的 `npm publish` 未执行(需 npm 账号,P9)。

### 11.2 骨架审计(第二轮,已修)
1. **smoke 探测空转(已修)**:`--help` 在树激活前退出(headless-startup 直接解析并 appExit),bogus 插件行 + `--help` 也 exit 0 → 原"boot exit 0 ⇒ 行已激活"不成立。改为 real-boot + keyless 哨兵(`MISSING_CREDENTIAL` = 越过树加载与全部行激活),并加负例控制(bogus 行必须 `failed to load`)。实测确认:真实 boot 下 Loader 对无法解析的插件行 hard fail(`plugin tree failed to load`);缺失 row id 的 patch 无害(与 bundle README 一致)
2. **A/B 补丁不对称(已修)**:treatment 原同时改写 `repeat-tool-reminder.exclude`(第二处行为差异,违反 §10.1)→ 排除项移入共享 bench profile patch(make-bench-home.sh 生成),两臂补丁唯一差异 = orcana 行
3. **pruner 时序勘误(§3.1 已修)**:`tool-result-pruner` 是 compaction 阶段的服务(compaction-basic 调用),post-execute 观察的是原始 content,不存在"已先裁剪"
4. **分类语义定稿**:`new-evidence`(同调用新结果)是与 `repeated-observation` 对立的非零进展信号;mutation 成功即使观察判 repeated 也因 gen 前进重置零进展链

## 下一步(P1)

governor-core 观察层深化:ring-buffer fingerprint(不只 last-1)、session-log 重放重建(resume 一致性)、verification-command 识别 + receipt 记录;dsh-governor 接线 `tools/post-execute` 全量观察。