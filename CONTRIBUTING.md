# Contributing

贡献方式与 upstream [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
保持一致:每个 PR 恰好一个 `kind/*` 标签、至少一个实质影响的 `area/*` 标签,
评审自动校验([官方 taxonomy](../.agents/notes/implemented/process/2026-08-08-unified-github-label-taxonomy.md) 的轻量移植)。

## 工作流

1. 从 `main` 切功能分支;`main` 受保护,不直接推送。
2. 完成改动,本地全绿:`pnpm build`、`pnpm typecheck`、`pnpm test`、`bash scripts/smoke-install.sh`。
3. 推送分支,`gh pr create`,正文引用关联 Issue(解决型用 `Fixes #N`,关联型用 `Related to #N`)。
4. 给 PR 打**恰好一个** `kind/*` + **至少一个** `area/*` 标签。
5. Squash 合并。PR 校验 workflow 不通过时按审计评论修正。

## Labels

`kind/*` 闭集(互斥,取主导意图;伴随的测试/文档/清理不覆盖主类型):

| Label | 含义 |
|---|---|
| `kind/feature` | 新增或有意图地改变行为 |
| `kind/bug-fix` | 修正错误行为 |
| `kind/doc` | 文档是主导意图 |
| `kind/testing` | 只改测试/测试基建,不改产品行为 |
| `kind/cleanup` | 保持行为,维护/简化实现或仓库流程 |
| `kind/dependency` | 只更新依赖 |

`area/*` 表示实质影响的持久域,可扩展(durable 域才允许新增):

| Label | 域 |
|---|---|
| `area/governor` | governor-core 引擎与 dsh-governor adapter |
| `area/benchmark` | 任务池、manifest、patch、runner、报告、方法论 |
| `area/tools` | 通用 registry/schema/执行契约 |
| `area/infra` | build/release/CI/仓库门禁/依赖/开发工具 |
| `area/docs` | 文档与计划记录 |

Issue 使用 GitHub 原生 Issue Type,不用 `kind/*`;`source/*` 仅用于 Issue。

## 规范

- 版本号遵循 upstream 惯例:`0.1.0-rc.N`;发布时 bump 并打 `v0.1.0-rc.N` tag。
- 变更同步更新 README、包 README 与 PLAN(§11 记录落地结论)。
- 非平凡改动建议补 Agent Note(格式见 upstream [Agent Note 规则](../.agents/notes/README.md))。
- 测试覆盖行为,typecheck 覆盖测试代码(`tsconfig.test.json`)。
