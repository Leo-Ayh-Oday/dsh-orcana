# @orcana/dsh-governor

[English](README.md) | 中文

Orcana runtime pack 的 DSH 适配插件：把框架无关的 `ProgressFactEngine` 挂载到
DSH 扩展点上。函数插件（name / Config / apply，无默认导出）。

## 扩展点

| 关注点 | 钩子 |
|---|---|
| 观察每次工具调用 | `tools/post-execute`（waterfall，总是 `next()`） |
| 轮内重复提醒 | `PostToolDecision.additionalContexts`（自动记录为 `user/message`，每轮一次） |
| 零进度升级 + 强制续作 | `agent/turn-stopping` + `agent.steer()`，受 maxForcedContinuations 限制 |
| 用户插话重置 | `agent/pre-step`（user 来源消息重置链与预算） |
| 验证状态快照 | `systemPrompt.context`（持久 user-role 快照，`orcana:verification-state`，order 250） |

## 翻译契约

`toEngineEvent` 是唯一的 DSH→core 翻译，活跃监听器与
`translateSessionEvents`（会话日志回放）共用：规范化命令、退出码标记恢复、
后台确认排除、变更标记。通过 `ProgressFactEngine.rebuild` 回放会话日志可
重现活跃引擎状态 —— 已有测试覆盖。

## 配置

governor.enabled / mode（observe | warn-steer | enforce）/ zeroProgressThresholds /
fingerprintWindow / inlineRepeatTools（默认 read/bash/*search*，与协调后的
repeat-tool-reminder exclude 对齐）；evidence.enabled / freshness /
verifyCommandPatterns；
completion.mode / maxForcedContinuations；tools.disclosure / defaultProfile。
每个字段都由 schemastery 校验并带默认值；benchmark treatment patch 通过
`!!js process.env.ORCANA_*` 消融旋钮覆盖。

## 已知限制

- Bash 非零退出在结果文本中报告，而不是 `isError`（退出码标记契约）；
  receipts 解析该标记。
- 后台 bash 确认不携带终止退出码，被排除在验证之外。
- shell 命令内的变更对代际计数器不可见（v0.2：git-probe receipts）。
- 验证快照只渲染产生了 receipts 的命令（由 verifyCommandPatterns 匹配）；
  NONE 占位是未来工作。
- 被压缩修剪的日志回放到修剪后的状态（权威）。
