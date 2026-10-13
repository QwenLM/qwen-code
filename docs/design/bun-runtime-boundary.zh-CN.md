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

| 位置 | 机制 | 备注 |
| --- | --- | --- |
| `scripts/cli-entry.js` | 写入 `QWEN_CODE_CLI`（设置了 `QWEN_CODE_LAUNCHER_PATH` 时为 shim 路径，否则为入口文件）；捕获并删除 `QWEN_CODE_LAUNCHER_PATH` | launcher 的事实来源 |
| `packages/core/src/services/shellContextEnv.ts` | 将 `QWEN_CODE_CLI` 传播进 shell 子进程环境；已设置但不可用的脚本入口置空 | 消费方使用 `"${QWEN_CODE_CLI:-qwen}"` |
| `packages/cli/src/cli.ts`（`getShellContextEnvVars` 接线） | 对 CLI 启动的所有 shell 做同样的环境传播 | |
| `packages/cli/src/serve/routes/daemon-update.ts` | 读取 `QWEN_CODE_CLI` 作为更新重启的 bootstrap | |
| `packages/cli/src/commands/review/**` | agent 提示词中的 `"${QWEN_CODE_CLI:-qwen}" review …` 自调用 | launcher 身份，已被测试固定 |
| `scripts/cli-entry.js` `relaunchAfterUpdate()` | `findLauncher()` 优先 `QWEN_CODE_LAUNCHER_PATH`，其次按安装前缀打分的 PATH 扫描 | 更新后重启 |
| `packages/cli/src/utils/relaunch.ts`（`relaunchAppInChildProcess`） | 监督式重启：`spawn(process.execPath, [execArgv, argv[1], args], ipc)`；可用时走 `process.execve` | launcher 的同解释器回退 |
| `packages/cli/src/utils/processUtils.ts`（`relaunchApp`） | `execve(process.execPath, [execPath, execArgv, argv…])` | 同解释器回退 |
| `packages/core/src/agents/arena/ArenaManager.ts` | 每个 arena agent `command: process.execPath, args: [resolve(argv[1]), …]` | worktree 内的应用再唤起；必须保持 launcher 形态 |
| `packages/cli/src/serve/managed-runtime-session-worker.ts`（`currentCliWorkerLaunch`） | `command: process.execPath, args: [execArgv, QWEN_CLI_ENTRY \|\| argv[1], 'managed-runtime-worker']` | 应用再唤起 |
| `packages/cli/src/commands/review/run.ts`（agent runner spawn） | `process.execPath` + 入口 | 应用再唤起 |

### JS interpreter 身份（如何运行任意 JS 子进程）

| 位置 | 用途 | 本变更是否接入 `getJsInterpreterCommand` |
| --- | --- | --- |
| `packages/core/src/code-mode/host-client.ts`（`hostCommand`） | code-mode host 子进程（`host.js` / 内置 `codeModeHost.js`；dev 为 `--import tsx host.ts`） | 是 |
| `packages/core/src/sandbox/file-worker-client.ts` | sandbox file-worker 子进程（`sandboxAsset('file-worker')`） | 是 |
| `packages/core/src/hooks/hookRunner.ts`（幸存 hook 监督进程） | `spawn(--input-type=commonjs --eval SUPERVISOR …)`，detached | 是 |
| `packages/core/src/utils/getPty.ts`（`loadPty`） | PTY 门控的 Bun 检测（当前 Bun 下 PTY 禁用 —— **S2 用真实后端替换此分支**） | 检测走 `isBunRuntime()` |
| `packages/cli/src/config/mem0-settings.ts`（`bundledMem0Server`） | 内置 mem0 MCP 子进程；身份判断 `server.command !== process.execPath` | 暂未；须与其身份判断一起迁移（S3） |
| `packages/core/src/agents/arena/ArenaManager.ts` | （另）worker 侧 in-process 运行时 | launcher 形态，见上表 |
| `packages/cli/src/serve/pem-certificate-blocks.ts` | 辅助子进程 spawn | 暂未（S3 清扫） |
| `packages/cli/src/commands/review/test-efficacy.ts` | 经 `process.execPath` 启动 vitest（开发工具路径） | 有意不接入；保持宿主工具身份 |

### 更新 / 安装身份（必须保持宿主 Node）

| 位置 | 备注 |
| --- | --- |
| `packages/cli/src/utils/managed-npm-update.ts` | 经 `process.execPath` 运行 npm 的 `cli.js`；npm **必须**在 Node 身份下运行，绝不能落入私有内置 Bun —— 这里要保持宿主 Node 解析 |
| `packages/cli/src/ui/handleAutoUpdate.ts` | 选择更新命令；Node 身份路径 |
| `packages/cli/src/serve/daemon-update-restart.ts` | 已在 Bun 下禁用（`process.versions['bun']`）且对 execve 做特性检测 |
| `packages/cli/src/utils/installationInfo.ts` | 以 `process.execPath` 报告 node 路径（信息性） |
| `scripts/build-standalone-release.js` / `create-standalone-package.js` | 固定 Bun 1.3.14、五个 target、`manifest.json`（`runtime`、版本）；布局 `bun/bin/bun`、`node/bin/node` |

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
  2. 在该可信包根内，所有声明先校验后使用：`runtime` 必须恰为 `'bun'` 或 `'node'`；解释器 —— `interpreter` 字段相对包根解析，否则取标准位置 `bun/bin/bun` / `node/bin/node` —— 必须是已存在的可执行普通文件（目录与不可执行文件均拒绝）。
  3. 任何无效或缺失的声明 —— 非对象清单、未知 `runtime`、非字符串 `interpreter`、二进制缺失、目录、不可执行文件、入口标记缺失 —— 一律回退 `process.execPath`（运行当前进程的解释器：宿主 Node、内置 Node，或 standalone Bun 形态的私有内置 Bun）。解析绝不猜测其他二进制，也绝不抛出异常。
- 结果按进程记忆；`resetJsInterpreterCacheForTests()` 清除。
- 不变量：**绝不返回应用二进制**。编译形态下 manifest 必须携带解释器路径（S4 打包变更）。

迁移规则：任何新增的、以子进程方式运行 JS 文件或 `-e` 片段的代码必须走 `getJsInterpreterCommand`；再唤起应用的位置走 `QWEN_CODE_CLI` / 入口回退。

## Bun 兼容事实（本变更实测）

以本机 Bun 1.4.0 对照 Node 24.19.0（同一 fixture，见
`packages/core/src/utils/runtime-boundary.node-bun.test.ts`）。*交付* 的
Bun 1.3.14 固定版本由打包验收负责，不在此处。

| 行为 | Node 24.19.0 | Bun 1.4.0 |
| --- | --- | --- |
| `--expose-gc script.js` → `typeof gc === 'function'` | 是 | 是（接受 `--expose-gc`） |
| `--input-type=commonjs --eval '…'` | 是 | 是 |
| Node IPC 通道（`spawn stdio:[…,'ipc']`、`process.send` / `on('message')`） | 是 | 是，往返正常 |
| SIGTERM 处理函数 → 优雅 `exit(0)` | 是 | 是 |
| `process.exit(n)` 退出码传播 | 是 | 是 |
| `process.execve` | 是 | 缺失 —— 代码必须特性检测（`relaunch.ts`、`processUtils.ts`、`daemon-update-restart.ts` 已做） |
| PTY（`@lydell/node-pty`） | 是 | **在 `getPty` 中禁用** —— S2 阻塞项 |

## 验证计划

- `packages/core/src/utils/runtime-info.test.ts` —— manifest 解析、回退、记忆化。
- `packages/core/src/utils/runtime-boundary.node-bun.test.ts` —— 上表同一 fixture 矩阵；无 Bun 二进制时 Bun 腿干净跳过（CI 保持绿色；本机 PATH 有 bun 即执行）。
- S2/S3 以上述清单表为迁移检查清单；S5 按 MYWO-8 验收协议在真实归档上重跑矩阵。

## 遗留问题

- 未来编译形态下 `ArenaManager` / managed-worker 重启：编译包必须发布 launcher（`QWEN_CODE_CLI`），上列同解释器回退位置需要 launcher 形态的迁移。已列入 S4 跟踪。
- `mem0-settings.ts` 的身份判断与 `command === process.execPath` 耦合；S3 中与其 spawn 位置一起迁移，避免身份与 launcher 漂移。
