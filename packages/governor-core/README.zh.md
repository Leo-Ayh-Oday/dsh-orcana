# @leooday/governor-core

[English](README.md) | 中文

框架无关的进度事实引擎（零 Cordis、零 DSH 依赖）。Orcana runtime pack 的纯
核心：把工具观察分类为进度信号，跟踪工作区代际，记录验证 receipts。

## API

- `canonicalizeArgs` / `sha256` — 指纹构建块。
- `classifyObservation` — 环形分类：在当前代际内，窗口内任何位置的精确
  (tool, args, hash) 匹配都是重复观察（A-B-A 交替重复也能捕获）；同一调用
  带新结果则是新证据；其余都是进度。
- `verificationToken` / `matchesVerificationPattern` / `isVerificationCommand`
  — 首动词验证识别（`npm test` → `test`；`grep -r test src` 永不匹配）。
- `receiptStatus` — interruption > exit marker > isError > clean-pass。
- `ProgressFactEngine` — 单一状态机、单一转移路径：`applyEvent(EngineEvent)`
  被活跃适配器和会话日志回放（`rebuild`）共用，两者不会漂移。
  `snapshot` / `restore` 承载持久状态。

## 不变量

- 活跃状态与恢复状态由同一条代码路径构建。
- 引擎从不决定模型看到什么；它只推导事实。
- Receipts 以规范化命令身份为键（绝不使用带描述的全参数）。

## 已知限制

- shell 退出码标记契约（`[exit code: N]` 等）归 `@deepseek-ai/dsh-shell`
  所有；适配器解析它。若格式变化，receipts 退化为 clean-pass 读数
  （只抑制 pass/fail steer）。
- 回放反映当前会话日志；压缩修剪可能重写结果内容，因此回放状态对分歧的
  活跃尾部是权威的。
