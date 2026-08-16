# @leooday/dsh-orcana-linux

[English](README.md) | 中文

**Orcana 的 DSH Linux 执行加固层，并提供 Windows → WSL 无感执行桥。**

本包继续作为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
官方 sandbox 契约之上的原生加固插件，不 fork DSH。自 v0.4 起，它同时提供
`dsh-orcana` 统一入口：Linux / WSL 内直接运行 DSH；从 Windows 调用时，在任务
开始前把**整个 DSH 进程**一次性送进 WSL。Windows 只负责启动，真正任务始终
处于同一个原生 Linux 执行世界。

这意味着进入 WSL 后，DSH 的 sandbox、subprocess、bash、PTY、PTC、LSP、
后台进程以及 Orcana 加固全部继续使用 Linux 语义，而不是每个工具调用再跨一次
Windows/WSL 边界。

- **资源限制** — `memoryBytes` / `pidsMax` 在 Linux 上使用 `prlimit` argv
  前缀；`RLIMIT_AS` 是地址空间近似，不是 cgroup 物理内存上限，
  `RLIMIT_NPROC` 是 PER-UID 上限，不是 per-cell PID 权限。
- **出网策略** — `network: 'none'` 在支持的 runner 上使用 bwrap
  `--unshare-net` / Seatbelt `(deny network*)`。
- **默认 fail-closed** — 请求的加固层无法表达时抛
  `HARDENING_UNAVAILABLE`；只有明确配置 `best-effort` 才允许记录后继续。
- **执行证据** — 每次受限执行记录进有界 `ctx.hardening` 台账，包含 requested、
  applied、degraded、failure 和 dropped/total。
- **Windows → WSL Bridge** — cwd 由目标发行版自己的 `wslpath` 转换；任务参数
  保持 argv 边界；运行时环境通过单向 `WSLENV` 转发；Windows `DSH_HOME`
  不与 Linux 共用。

## 保证

```text
✓ 经 ctx.sandbox 的 read-only / workspace-write 执行可被加固
✓ 支持 runner 上的 network-none
✓ RLIMIT_AS / RLIMIT_NPROC fallback，并明确它们的真实语义
✓ required | best-effort 逐层降级策略
✓ 有界执行证据台账
✓ dispose 精确恢复原始 confine
✓ 重复插件实例 fail loud
✓ Windows / Linux 使用同一个 dsh-orcana 命令
✓ Windows 任务开始前整个 DSH runtime 已进入 WSL
✓ Windows cwd 交给目标 WSL 自己映射，不硬编码 /mnt/c
✓ DSH 的 -- 哨兵与任务 argv 穿过 Bridge 后保持原样
✓ 优先使用已有 dsh；npm fallback 固定到明确兼容的 DSH 版本
✓ API key、provider base URL、DSH_*、Orcana runtime 变量通过单向 WSLENV 传入
✓ stdio、交互式 Ctrl+C、正常退出码继续走 WSL 原生路径
```

## 不保证

```text
✗ 插件本身加固 danger-full-access（该模式绕过 ctx.sandbox）
✗ 当前版本拥有 cgroup v2 memory / pids / cpu 权限
✗ per-cell PID 权限
✗ cpuQuotaUs 的精确 CPU 配额
✗ 把 Windows 的 DSH_HOME / node_modules 直接拿给 WSL 使用
✗ 把 WSL 本身当成安全 sandbox —— WSL 在这里是 Linux 执行世界边界
✗ 当前 Windows Bridge 已提供独立的 Orcana 程序化 timeout/cancel API
```

## `danger-full-access` 与 WSL 的区别

当 DSH 已经运行在 Linux / WSL 中时，`danger-full-access` 会绕过
`ctx.sandbox.confine`，因此不受本插件 sandbox hardening；
`ctx.hardening.scope` 会诚实报告：

```ts
{ confinedModes: true, dangerFullAccess: false }
```

但 Windows Bridge 属于更外层：它在任何工具执行前就把**整个 DSH runtime**
送入 WSL。因此即使某个工具使用 `danger-full-access`，它仍然是 Linux 进程；
只是没有被本插件 sandbox 加固，而不是退回 Windows 进程语义。

## Linux / WSL 内安装插件

推荐加固组合包：

```sh
dsh plugin --profile orcana-linux add @leooday/dsh-orcana-linux-bundle
```

governor + Linux 加固放在同一个 profile：

```sh
dsh plugin --profile orcana add @leooday/dsh-bundle @leooday/dsh-orcana-linux-bundle
```

组合包默认保持中立；安装本身不会偷偷开启更强的网络或资源限制。需要的策略
继续由 profile config 或 `--patch` 显式配置。

程序化嵌入：

```sh
npm i @leooday/dsh-orcana-linux
```

```ts
import { apply as hardening } from '@leooday/dsh-orcana-linux'

ctx.plugin(hardening, {
  network: 'none',
  resourceLimits: { memoryBytes: 512 * 1024 * 1024 },
})
```

## Windows → WSL：同一个命令，一个 Linux 世界

v0.4 发布后，Windows 侧安装一次统一入口：

```powershell
npm install -g @leooday/dsh-orcana-linux@^0.4.0
```

目标 WSL 需要 Node/npm，并满足当前 DSH 的 Node 契约：
`^22.19.0 || >=24.0.0`。全局 `dsh` 不是硬前置。

先检查执行世界：

```powershell
dsh-orcana --wsl-doctor
```

Doctor 会报告：

- Linux kernel；
- Node 版本以及是否满足运行契约；
- 是否存在直接 `dsh`，或者是否可以走 npm fallback；
- `bwrap` / `prlimit` 是否可见；
- 当前 Windows cwd 是 WSL 原生文件系统，还是 Windows 文件系统挂载到 WSL。

两种文件系统都能运行。但 Git/npm/build I/O 很重时，把项目放在 WSL Linux
文件系统中才是性能快路径。

多发行版时：

```powershell
dsh-orcana --wsl-distro Ubuntu-24.04 --wsl-doctor
```

从 Windows Terminal 直接把 Orcana profile 安装进 WSL：

```powershell
dsh-orcana --wsl-install
```

之后 Windows / Linux 都使用同一个命令：

```sh
dsh-orcana "修复失败的测试"
```

Bridge 默认 profile 是 `orcana`。第一个 `--` 之前显式给 DSH 的 `--profile`
优先；也可以单独改变 Bridge 默认 profile：

```powershell
dsh-orcana --wsl-profile orcana-linux "运行测试"
dsh-orcana --profile bench "跑 benchmark"
```

### Bridge 不变量

1. **只有一个执行世界。** Windows 不运行 DSH 后再把单个工具调用送进 Linux；
   `wsl.exe` 会在任务开始前直接启动 WSL 内的 DSH。
2. **cwd 转换而不是猜测。** `C:\repo` 由目标 distro 的 `wslpath` 转成真实
   Linux 路径，不写死 `/mnt/c`；`\\wsl.localhost\Distro\...` 和
   `\\wsl$\Distro\...` 可以直接识别。UNC 所属 distro 与 `--wsl-distro`
   冲突时 fail loud。
3. **argv 边界不破坏。** Bridge 只解析第一个 `--` 之前的 `--wsl-*`；`--`
   本身和后面的所有内容原样交给 DSH。用户任务文本不会被插入固定 resolver
   脚本，只通过位置参数进入。
4. **DSH 解析可复现。** 设置 `ORCANA_WSL_DSH_COMMAND` 时使用指定 Linux
   executable；否则先找已有 `dsh`。没有时，v0.4.0 固定回退到
   `@deepseek-ai/dsh@0.1.0-rc.5`，而不是悄悄跟 npm `latest` 漂移。
   要验证新 DSH 时显式设置 `ORCANA_WSL_DSH_PACKAGE`。
5. **环境变量单向且有边界。** 常见模型 API key、provider base URL、代理、
   `DSH_*` 与非 Bridge 的运行时 `ORCANA_*` 通过带 `/u` 的 `WSLENV` 单向
   Win32 → WSL；`ORCANA_WSL_*` Bridge 控制变量留在主机侧。
6. **不共享 Windows DSH_HOME。** `DSH_HOME`、`HOME` 和 Windows `PATH`
   不隐式转发。WSL 使用自己的 DSH profile/package graph，避免 Windows 原生
   `node_modules` / executable 混进 Linux。
7. **终端行为保持 WSL 原生。** stdio 继承当前终端，`wsl.exe` 保持 Windows
   console/cancellation authority。Bridge 不用 Windows `child.kill()` 冒充
   POSIX 信号，也不在正常交互任务里人为插入新的 Linux session/process-group
   supervisor；最终 DSH/WSL 退出码返回调用方。

如果构建还需要额外环境变量，可以显式加入 allowlist：

```powershell
$env:ORCANA_WSL_FORWARD_ENV = "MY_CORP_PROXY,MY_BUILD_FLAG"
dsh-orcana "构建项目"
```

Bridge 控制项：

| 变量 / 参数 | 含义 |
|---|---|
| `ORCANA_WSL_DISTRO` / `--wsl-distro` | 指定 WSL 发行版 |
| `ORCANA_WSL_PROFILE` / `--wsl-profile` | Bridge 默认 DSH profile，默认 `orcana` |
| `ORCANA_WSL_DSH_COMMAND` | 显式指定 WSL 内 DSH executable |
| `ORCANA_WSL_DSH_PACKAGE` | 显式指定 npm fallback 包/版本；默认由 Bridge release 固定 |
| `ORCANA_WSL_FORWARD_ENV` | 额外允许转发的环境变量，逗号分隔 |
| `--wsl-install` | 在 WSL profile 中安装 governor + Linux hardening bundles |
| `--wsl-doctor` | 检查 Linux execution world 与当前工作区路径类型 |

`dsh-orcana-wsl` 是同一启动器的显式别名；正常使用推荐统一写
`dsh-orcana`。

## 加固配置

| 字段 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `resourceLimits.memoryBytes` | number | — | `prlimit --as` 字节；地址空间近似 |
| `resourceLimits.pidsMax` | number | — | `prlimit --nproc`；PER-UID live-task 上限 |
| `resourceLimits.cpuQuotaUs` | number | — | 需要 cgroup v2；当前降级 / fail-closed |
| `network` | `'inherit' \| 'none'` | — | `none` 时请求拒绝全部出网 |
| `degradationPolicy.resourceLimits` | `'required' \| 'best-effort'` | `required` | 缺能力时失败或记录后继续 |
| `degradationPolicy.network` | `'required' \| 'best-effort'` | `required` | 同上，针对网络层 |
| `ledgerMaxEntries` | number | 1024 | 有界审计窗口 |

每次调用仍可通过 `sandboxPolicy` 携带 `resourceLimits` / `network` 覆盖部署默认值；
降级策略和 ledger 大小保持部署级。

> **安全边界：** per-call carrier 可以放宽 deployment request。例如调用方显式
> 给出 `network: 'inherit'` 会覆盖该次执行的 deployment `network: 'none'`。
> 必须强制的 egress policy 应由真正拥有 sandbox policy 的层负责。

> **`runnerCommand`：** 当前 runner 识别基于精确 `argv[0]`。wrapper 或绝对
> `/usr/bin/bwrap` 不会被错误宣称为已加固；required 层会 fail loud。

## 原生加固工作原理

Cordis 4.0.1 不允许跨 fiber 直接替换服务，因此插件 patch 已解析出的
`ctx.sandbox.confine`：

1. 原 provider 负责基础文件效果限制；
2. Orcana 在返回 argv 上增加请求的 `prlimit` / network-none；
3. required 层无法表达时 fail-closed；
4. 有界 ledger 记录 requested / applied / degraded；
5. dispose 时仅在仍拥有 patch 的前提下恢复精确原引用。

## 平台矩阵

| 表面 | Linux / WSL | macOS | Windows 主机 |
|---|---|---|---|
| `dsh-orcana` 执行 | 原生 | 原生命令 | 整个 DSH 进入 WSL |
| resource hardening | `prlimit` | 降级 | 进入 WSL 后由 Linux 插件执行 |
| `network: none` | bwrap `--unshare-net` | Seatbelt | 进入 WSL 后由 Linux 插件执行 |
| evidence ledger | 是 | 是 | 在 WSL runtime 内记录 |
| 交互终端 / Ctrl+C | 原生 | 原生 | 原生 `wsl.exe` → Linux 路径 |
| Windows 原生加固 | n/a | n/a | 不宣称；需要 Linux 语义时走 WSL Bridge |

## 开发

```sh
pnpm install
pnpm --filter @leooday/dsh-orcana-linux typecheck
pnpm --filter @leooday/dsh-orcana-linux test
pnpm --filter @leooday/dsh-orcana-linux build
pnpm --filter @leooday/dsh-orcana-linux pack
```

WSL Bridge 单测会固定 `--`/argv 透传、DSH 固定版本 fallback、profile 安装、
UNC/wslpath 映射、工作区分类和 WSLENV 隔离，不要求 Windows runner。原生
bwrap/prlimit 集成测试在主机缺少对应能力时自动跳过。

## License

MIT — 见 [LICENSE](../../LICENSE)。
