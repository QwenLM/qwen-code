# Bun 运行时边界：App Launcher 与 JS Interpreter 分离

[English](bun-runtime-boundary.md) | [简体中文](bun-runtime-boundary.zh-CN.md)

状态：MYWO-8 S1 已实现（本变更）。读者：S2（Bun PTY）、S3（运行时兼容矩阵）、S4（打包）以及 qoder 的 PTY 对接工作。

## 问题

`process.execPath` 混淆了两个不同的身份：

- **app launcher（应用启动器）** —— 子进程如何触达*当前这一份* CLI 构建；
- **JS interpreter（JS 解释器）** —— 以子进程方式运行任意 JavaScript 文件或 `-e` 片段的二进制。

两者今天恰好一致（npm：宿主 Node；standalone：内置运行时启动 `lib/cli-entry.js`，因此 `process.execPath` 始终是一个 JS 解释器）。一旦出现编译产物形态（`bun build --compile`），两者就会分叉：`process.execPath` 变成应用二进制，无法运行任意 JS 文件。所有直接读 `process.execPath` 的 worker spawn 会同时、静默地失效。Bun 运行时迁移（MYWO-8）正是要引入该形态的项目，因此必须在 S2/S3/S4 依赖它之前把边界显式化。

## 现状：调用点清单

审计基线：`main` `d8558bba0198c1cdadac1523940c88c04b038f62`（与方案基线 `5aae8991bede…` 的 diff 不涉及下列任何文件）。按该位置真正需要的身份分类。

### App launcher 身份（如何再次唤起本构建）

| 位置                                                                                   | 机制                                                                                                                          | 备注                                            |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `scripts/cli-entry.js`                                                                 | 写入 `QWEN_CODE_CLI`（设置了 `QWEN_CODE_LAUNCHER_PATH` 时为 shim 路径，否则为入口文件）；捕获并删除 `QWEN_CODE_LAUNCHER_PATH` | launcher 的事实来源                             |
| `packages/core/src/services/shellContextEnv.ts`                                        | 将 `QWEN_CODE_CLI` 传播进 shell 子进程环境；已设置但不可用的脚本入口置空                                                      | 消费方使用 `"${QWEN_CODE_CLI:-qwen}"`           |
| `packages/cli/src/cli.ts`（`getShellContextEnvVars` 接线）                             | 对 CLI 启动的所有 shell 做同样的环境传播                                                                                      |                                                 |
| `packages/cli/src/serve/routes/daemon-update.ts`                                       | 读取 `QWEN_CODE_CLI` 作为更新重启的 bootstrap                                                                                 |                                                 |
| `packages/cli/src/commands/review/**`                                                  | agent 提示词中的 `"${QWEN_CODE_CLI:-qwen}" review …` 自调用                                                                   | launcher 身份，已被测试固定                     |
| `scripts/cli-entry.js` `relaunchAfterUpdate()`                                         | `findLauncher()` 优先 `QWEN_CODE_LAUNCHER_PATH`，其次按安装前缀打分的 PATH 扫描                                               | 更新后重启                                      |
| `packages/cli/src/utils/relaunch.ts`（`relaunchAppInChildProcess`）                    | 监督式重启：`spawn(process.execPath, [execArgv, argv[1], args], ipc)`；可用时走 `process.execve`                              | launcher 的同解释器回退                         |
| `packages/cli/src/utils/processUtils.ts`（`relaunchApp`）                              | `execve(process.execPath, [execPath, execArgv, argv…])`                                                                       | 同解释器回退                                    |
| `packages/core/src/agents/arena/ArenaManager.ts`                                       | 每个 arena agent `command: process.execPath, args: [resolve(argv[1]), …]`                                                     | worktree 内的应用再唤起；必须保持 launcher 形态 |
| `packages/cli/src/serve/managed-runtime-session-worker.ts`（`currentCliWorkerLaunch`） | `command: process.execPath, args: [execArgv, QWEN_CLI_ENTRY \|\| argv[1], 'managed-runtime-worker']`                          | 应用再唤起                                      |
| `packages/cli/src/commands/review/run.ts`（agent runner spawn）                        | `process.execPath` + 入口                                                                                                     | 应用再唤起                                      |

### JS interpreter 身份（如何运行任意 JS 子进程）

| 位置                                                                   | 用途                                                                                             | 本变更是否接入 `getJsInterpreterCommand`    |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| `packages/core/src/code-mode/host-client.ts`（`hostCommand`）          | code-mode host 子进程（`host.js` / 内置 `codeModeHost.js`；dev 为 `--import tsx host.ts`）       | 是                                          |
| `packages/core/src/sandbox/file-worker-client.ts`                      | sandbox file-worker 子进程（`sandboxAsset('file-worker')`）                                      | 是                                          |
| `packages/core/src/hooks/hookRunner.ts`（幸存 hook 监督进程）          | `spawn(--input-type=commonjs --eval SUPERVISOR …)`，detached                                     | 是                                          |
| `packages/core/src/hooks/hook-command-cgroup.ts`（`launch`）           | cgroup v2 launcher 子进程（`--input-type=commonjs --eval LAUNCHER …`），在 hook 的受托单元内运行 | 暂未（S3）—— 仅 Linux（cgroup v2 平台守卫） |
| `packages/core/src/sandbox/bwrap-execution.ts`（`executeBwrap`）       | 将解释器（`realpathSync(process.execPath)`）纳入 bubblewrap allowlist；relay 在其下启动 JS relay | 暂未（S3）—— 仅 Linux（bubblewrap）         |
| `packages/core/src/sandbox/landlock-execution.ts`（`executeLandlock`） | 将解释器纳入 landlock allowlist；relay 在其下启动 JS relay                                       | 暂未（S3）—— 仅 Linux（landlock LSM）       |
| `packages/core/src/utils/getPty.ts`（`loadPty`）                       | PTY 门控的 Bun 检测（当前 Bun 下 PTY 禁用 —— **S2 用真实后端替换此分支**）                       | 检测走 `isBunRuntime()`                     |
| `packages/cli/src/config/mem0-settings.ts`（`bundledMem0Server`）      | 内置 mem0 MCP 子进程；身份判断 `server.command !== process.execPath`                             | 暂未；须与其身份判断一起迁移（S3）          |
| `packages/core/src/agents/arena/ArenaManager.ts`                       | （另）worker 侧 in-process 运行时                                                                | launcher 形态，见上表                       |
| `packages/cli/src/serve/pem-certificate-blocks.ts`                     | 辅助子进程 spawn                                                                                 | 暂未（S3 清扫）                             |
| `packages/cli/src/commands/review/test-efficacy.ts`                    | 经 `process.execPath` 启动 vitest（开发工具路径）                                                | 有意不接入；保持宿主工具身份                |

标注"暂未"的行由 **S3 迁移清扫**（V8/GC/TLS/env 兼容阶段）负责，该表即其检查清单。cgroup/bwrap/landlock 三行是**仅 Linux** 机制（macOS/Windows 上有平台守卫或不生效），其迁移须对照平台矩阵中的 Linux target 验证；mem0 与 pem 两行适用于所有平台。

### 更新 / 安装身份（必须保持宿主 Node）

| 位置                                                                   | 备注                                                                                                                           |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `packages/cli/src/utils/managed-npm-update.ts`                         | 经 `process.execPath` 运行 npm 的 `cli.js`；npm **必须**在 Node 身份下运行，绝不能落入私有内置 Bun —— 这里要保持宿主 Node 解析 |
| `packages/cli/src/ui/handleAutoUpdate.ts`                              | 选择更新命令；Node 身份路径                                                                                                    |
| `packages/cli/src/serve/daemon-update-restart.ts`                      | 已在 Bun 下禁用（`process.versions['bun']`）且对 execve 做特性检测                                                             |
| `packages/cli/src/utils/installationInfo.ts`                           | 以 `process.execPath` 报告 node 路径（信息性）                                                                                 |
| `scripts/build-standalone-release.js` / `create-standalone-package.js` | 固定 Bun 1.3.14、五个 target、`manifest.json`（`runtime`、版本）；布局 `bun/bin/bun`、`node/bin/node`                          |

### SDK 消费方

`@qwen-code/qwen-code-core` 作为库使用（SDK 宿主）时运行在宿主自身运行时下。SDK 代码路径不得向 Node 宿主强加 Bun 解释器：只有包布局中存在 standalone `manifest.json` 时 `getJsInterpreterCommand` 才会偏离 `process.execPath`，npm 与源码安装都没有该文件。

## 接口约定

### 1. App launcher

- `scripts/cli-entry.js` 是 `QWEN_CODE_CLI` 的唯一写入方；`getShellContextEnvVars` 负责传播。自调用在 shell 中用 `"${QWEN_CODE_CLI:-qwen}"`，直接 spawn 用写入的值。
- 同进程树内再唤起应用（relaunch、managed worker、arena agent）保留同解释器回退 `process.execPath + process.argv[1]`，因为所有已发布布局中入口都是 JS 文件。编译产物形态必须先通过 `QWEN_CODE_CLI` 发布其 launcher，上述位置才能变更 —— 它们已被上面的清单固定。

### 2. JS interpreter —— `packages/core/src/utils/runtime-info.ts`

- `isBunRuntime(): boolean` —— 唯一的运行时检测点。
- `getJsInterpreterCommand(importMetaUrl): { command, runtime }` —— 解析任意 JS 子进程使用的解释器：
  1. 唯一可信位置是 **standalone 包根**：调用方 bundle 目录（`resolveBundleDir`）的父目录，必须同时存在 `manifest.json` 与 standalone 入口标记 `lib/cli-entry.js`。**不做向上遍历** —— 无关祖先清单（例如 npm 宿主工程的构建 manifest）永远不会被读取，npm、源码与 SDK 布局因此始终使用 `process.execPath`。
  2. 在该可信包根内，所有声明先校验后使用：`runtime` 必须恰为 `'bun'` 或 `'node'`；解释器 —— `interpreter` 字段相对包根解析，否则取标准位置 `bun/bin/bun` / `node/bin/node` —— 必须是已存在的普通文件。POSIX 还要求执行权限；Windows 只检查普通文件存在，不验证 PE 格式或实际可启动性，默认路径为 `bun/bun.exe` / `node/node.exe`。
  3. 任何无效或缺失的声明 —— 非对象清单、未知 `runtime`、非字符串 `interpreter`、二进制缺失、目录、POSIX 不可执行文件、入口标记缺失 —— 一律回退 `process.execPath`（运行当前进程的解释器：宿主 Node、内置 Node，或 standalone Bun 形态的私有内置 Bun）。解析绝不猜测其他二进制，也绝不抛出异常。
- 结果按进程记忆；`resetJsInterpreterCacheForTests()` 清除。
- 支持范围：**基于解释器的 Node/Bun 分发**。拒绝声明时返回 `process.execPath`，它在编译形态下会是应用二进制。本 PR 不支持编译应用，也没有提供编译制品生产路径。未来该形态必须显式打包解释器并独立验证失败行为后才能采用；当前回退不保证在编译形态下得到可用解释器。

迁移规则：任何新增的、以子进程方式运行 JS 文件或 `-e` 片段的代码必须走 `getJsInterpreterCommand`；再唤起应用的位置走 `QWEN_CODE_CLI` / 入口回退。

## 跨运行时测试覆盖

`packages/core/src/utils/runtime-boundary.node-bun.test.ts` 在 Node 和可用的
Bun 解释器下运行同一 fixture，覆盖身份与 stdio JSON 行、退出码传播、POSIX
SIGTERM 处理、显式 shutdown 的 IPC 往返、`--expose-gc` 和
`--input-type=commonjs --eval`。这些是测试契约，不代表全部平台或打包制品已经通过。
Windows 跳过可捕获 SIGTERM 用例；缺少 Bun 二进制时跳过 Bun 腿。报告执行结果时必须
记录实际运行时版本与 skip。交付 Bun 1.3.14 固定版本及 standalone 制品仍需独立打包验收。

此 fixture 不探测 `process.execve`、原生 PTY 加载、fd-3 状态管道或进程组信号。
重新启动位置的 `process.execve` 特性检测和 `getPty` 的 Bun 门禁属于源码机制，
不是本矩阵的实测结果。原生 PTY 与进程树行为需要各自真实进程和制品证据。

## 验证计划

- `packages/core/src/utils/runtime-info.test.ts` —— manifest 解析、回退、记忆化。
- `packages/core/src/utils/runtime-boundary.node-bun.test.ts` —— 上述同一 fixture 覆盖；无 Bun 二进制时 Bun 腿跳过，跳过不代表兼容性通过。
- S2/S3 以上述清单表为迁移检查清单；S5 按 MYWO-8 验收协议在真实归档上重跑矩阵。

## 遗留问题

- 未来编译形态下 `ArenaManager` / managed-worker 重启：编译包必须发布 launcher（`QWEN_CODE_CLI`），上列同解释器回退位置需要 launcher 形态的迁移。已列入 S4 跟踪。
- `mem0-settings.ts` 的身份判断与 `command === process.execPath` 耦合；S3 中与其 spawn 位置一起迁移，避免身份与 launcher 漂移。
