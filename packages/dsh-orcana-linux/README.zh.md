# @leooday/dsh-orcana-linux

[English](README.md) | 中文

**Orcana 的 DSH Linux 执行加固层，并提供 Windows → WSL 无感执行桥。**

本包继续作为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
官方 sandbox 契约之上的原生加固插件，不 fork DSH。自 v0.4 起，它同时提供
`dsh-orcana` 统一入口：在 Linux / WSL 中直接运行 DSH；从 Windows 调用时，
则在任务开始前把**整个 DSH 进程**一次性送进 WSL，而不是让每个工具调用在
Windows 和 Linux 两套进程世界之间来回跳。

这意味着进入 WSL 后，DSH 的 sandbox、subprocess、bash、PTY、PTC、LSP、
后台进程以及 Orcana 加固仍然全部使用原生 Linux 语义。

- **资源限制** — `memoryBytes` / `pidsMax` 在 Linux 上使用 `prlimit` argv
  前缀（`RLIMIT_AS` 是地址空间近似，不是 cgroup 物理内存上限；
  `RLIMIT_NPROC` 是 PER-UID 上限，不是 per-cell PID 权限）。
- **出网策略** — `network: 'none'` 在支持的 runner 上使用 bwrap
  `--unshare-net` / Seatbelt `(deny network*)`。
- **默认 fail-closed** — 请求的加固层无法表达时抛
  `HARDENING_UNAVAILABLE`；只有明确配置 `best-effort` 才允许记录后继续。
- **执行证据** — 每次受限执行记录进有界 `ctx.hardening` 台账，包含请求、
  已应用层、结构化降级、失败信息和 dropped/total 计数。
- **Windows → WSL Bridge** — cwd 由目标发行版自己的 `wslpath` 转换；任务
  参数通过 `wsl.exe --exec` 直接以 argv 传递，不再经过一层 `bash -c`；
  必要运行时环境通过 `WSLENV` 转发，Windows 的 `DSH_HOME` 不与 Linux 共用。

## 保证

```text
✓ 经 ctx.sandbox 的 read-only / workspace-write 执行可被加固
✓ 支持 runner 上的 network-none
✓ RLIMIT_AS / RLIMIT_NPROC fallback
✓ required | best-effort 逐层降级策略
✓ 有界审计台账
✓ dispose 精确恢复原始 confine
✓ 重复插件实例 fail loud
✓ 每次插件挂载最多探测一次主机能力
✓ Windows / Linux 使用同一个 dsh-orcana 命令
✓ Windows cwd 交给 wslpath 映射，不硬编码 /mnt/c
✓ 任务 argv 跨 Windows → WSL 时不做第二次 shell 解析
✓ API key / DSH_* / Orcana runtime 变量通过 WSLENV 传递，不把秘密塞进 argv
```

## 不保证

```text
✗ 插件本身加固 danger-full-access（该模式绕过 ctx.sandbox）
✗ 当前版本拥有 cgroup v2 memory / pids / cpu 权限
✗ per-cell PID 权限
✗ cpuQuotaUs 的精确 CPU 配额
✗ 把 Windows 的 DSH_HOME / node_modules 直接拿给 WSL 使用
✗ 把 WSL 本身当成安全 sandbox —— WSL 在这里是执行世界/传输边界
```

## `danger-full-access` 与 WSL 的区别

当 DSH 已经运行在 Linux / WSL 里时，`danger-full-access` 会绕过
`ctx.sandbox.confine`，因此它不受本插件的 sandbox hardening；
`ctx.hardening.scope` 会诚实报告：

```ts
{ confinedModes: true, dangerFullAccess: false }
```

但 Windows Bridge 是另一层概念：它在任何工具执行前就把**整个 DSH runtime**
搬进 WSL。因此即使某个工具是 `danger-full-access`，它也仍然运行在 Linux
执行世界里，只是没有 sandbox 加固，而不是退回 Windows 进程语义。

## Linux / WSL 内安装插件

推荐组合包：

```sh
dsh plugin --profile orcana-linux add @leooday/dsh-orcana-linux-bundle
```

如果 governor + Linux 加固放在同一个 profile：

```sh
dsh plugin --profile orcana add @leooday/dsh-bundle @leooday/dsh-orcana-linux-bundle
```

组合包默认保持中立，不会仅仅因为安装就强制改变执行策略。需要的网络/资源
加固继续通过 profile 行的 config 或后续 `--patch` 配置。

程序化嵌入仍然支持：

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

## Windows → WSL：同一个命令

Windows 侧安装 v0.4+，用于获得统一启动命令：

```powershell
npm install -g @leooday/dsh-orcana-linux@^0.4.0
```

> DSH 本身也必须安装在目标 WSL 发行版里。这里的设计就是让任务真正运行在
> Linux，而不是调用 Windows Node 安装目录里的 DSH。

先检查执行世界：

```powershell
dsh-orcana --wsl-doctor
```

它会检查目标 WSL 中的 Linux kernel，以及 `node`、`dsh`、`bwrap`、
`prlimit` 是否可见。

多发行版时指定：

```powershell
dsh-orcana --wsl-distro Ubuntu-24.04 --wsl-doctor
```

DSH 已经存在于 WSL 后，可以直接从 Windows Terminal 把 Orcana profile 装进
WSL：

```powershell
dsh-orcana --wsl-install
```

之后日常使用：

```powershell
dsh-orcana "修复失败的测试"
```

Linux / WSL 也是同一条：

```sh
dsh-orcana "修复失败的测试"
```

默认 profile 是 `orcana`。你也可以改变 Bridge 默认值，或者直接给 DSH
显式 profile；显式 DSH 参数优先：

```powershell
dsh-orcana --wsl-profile orcana-linux "运行测试"
dsh-orcana --profile bench "跑 benchmark"
```

### Bridge 不变量

1. **cwd 不猜路径。** `C:\repo` 由目标 distro 的 `wslpath` 转成真实 Linux
   路径，因此即使 WSL automount root 不是 `/mnt` 也不会被写死。
   `\\wsl.localhost\Distro\...` 和旧式 `\\wsl$\Distro\...` 也能直接识别。
2. **任务不重新解释。** 最终是 `wsl.exe --exec dsh ...`，用户任务文本保持一个
   argv 元素，不会再被 Windows shell / Linux shell 各解释一次。
3. **秘密不进命令行。** 常用模型 API key、`DSH_*` 和运行时 `ORCANA_*`
   通过 `WSLENV` 传入；`ORCANA_WSL_*` 只属于 Windows Bridge 自己，不继续
   泄漏给 Agent 任务。
4. **不共享 Windows DSH_HOME。** Windows profile 可能有 Windows 原生
   `node_modules` / 可执行文件，直接给 WSL 会制造 ABI 和平台污染，因此 WSL
   使用自己的 `~/.dsh`。
5. **终端与返回码直通。** stdio 继承当前终端，DSH/WSL 的退出码返回给调用方；
   Bridge 会向子进程转发 SIGINT / SIGTERM。

如果公司构建还需要额外环境变量，可以显式加入 allowlist：

```powershell
$env:ORCANA_WSL_FORWARD_ENV = "MY_CORP_PROXY,MY_BUILD_FLAG"
dsh-orcana "构建项目"
```

Bridge 控制项：

| 变量 / 参数 | 含义 |
|---|---|
| `ORCANA_WSL_DISTRO` / `--wsl-distro` | 指定 WSL 发行版 |
| `ORCANA_WSL_PROFILE` / `--wsl-profile` | Bridge 默认 DSH profile，默认 `orcana` |
| `ORCANA_WSL_DSH_COMMAND` | WSL 内 DSH 可执行文件名/路径，默认 `dsh` |
| `ORCANA_WSL_FORWARD_ENV` | 额外允许转发的环境变量，逗号分隔 |
| `--wsl-install` | 在 WSL 中安装 governor + Linux hardening bundles |
| `--wsl-doctor` | 检查目标 Linux execution world |

`dsh-orcana-wsl` 是同一个启动器的显式别名；正常使用推荐统一写
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

每次调用仍可通过 `sandboxPolicy` 携带 `resourceLimits` / `network` 覆盖部署值；
降级策略和 ledger 大小保持部署级。

## 原生加固工作原理

Cordis 4.0.1 不允许跨 fiber 直接替换服务，因此插件 patch 已解析出的
`ctx.sandbox.confine`：

1. 原 provider 负责基础文件效果限制；
2. Orcana 在返回 argv 上增加 `prlimit` / network-none 等层；
3. required 层无法表达时 fail-closed；
4. 有界 ledger 记录 requested / applied / degraded；
5. dispose 时仅在仍拥有 patch 的前提下恢复精确原引用。

## 平台矩阵

| 表面 | Linux / WSL 内 | macOS | Windows 主机 |
|---|---|---|---|
| `dsh-orcana` 执行 | 原生 Linux | 原生命令 | 整个 DSH 进入 WSL |
| resource hardening | `prlimit` | 降级 | 进入 WSL 后由 Linux 插件执行 |
| `network: none` | bwrap `--unshare-net` | Seatbelt | 进入 WSL 后由 Linux 插件执行 |
| evidence ledger | 是 | 是 | 在 WSL runtime 内记录 |
| Windows 原生插件加固 | n/a | n/a | 不宣称；需要 Linux 语义时走 WSL Bridge |

## 开发

```sh
pnpm install
pnpm --filter @leooday/dsh-orcana-linux typecheck
pnpm --filter @leooday/dsh-orcana-linux test
pnpm --filter @leooday/dsh-orcana-linux build
pnpm --filter @leooday/dsh-orcana-linux pack
```

WSL Bridge 的单元测试不要求 Windows runner：会固定 argv 透传、profile 安装、
UNC/wslpath 映射、WSLENV 隔离等契约。原生 bwrap / prlimit 集成测试在主机缺少
对应能力时继续自动跳过。

## License

MIT — 见 [LICENSE](../../LICENSE)。
