# Bun 运行时边界：App Launcher 与 JS Interpreter 分离

[English](bun-runtime-boundary.md) | [简体中文](bun-runtime-boundary.zh-CN.md)

状态：MYWO-8 S1 已实现（本变更）。读者：S2（Bun PTY）、S3（运行时兼容矩阵）、S4（打包）以及 qoder 的 PTY 对接工作。

## 问题

`process.execPath` 混淆了两个不同的身份：

- **app launcher（应用启动器）** —— 子进程如何触达*当前这一份* CLI 构建；
- **JS interpreter（JS 解释器）** —— 以子进程方式运行任意 JavaScript 文件或 `-e` 片段的二进制。

两者今天恰好一致（npm：宿主 Node；standalone：内置运行时启动 `lib/cli-entry.js`，因此 `process.execPath` 始终是一个 JS 解释器）。一旦出现编译产物形态（`bun build --compile`），两者就会分叉：`process.execPath` 变成应用二进制，无法运行任意 JS 文件。所有直接读 `process.execPath` 的 worker spawn 会同时、静默地失效。Bun 运行时迁移（MYWO-8）正是要引入该形态的项目，因此必须在 S2/S3/S4 依赖它之前把边界显式化。

## 现状：调用点清单

概念表源自 `main` `d8558bba0198c1cdadac1523940c88c04b038f62`，不是穷尽列表；下方固定父提交的字面调用点复核补齐范围内的每处命中及排除项。分类不代表迁移或兼容性已获证明。

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
| `packages/cli/src/utils/installationInfo.ts`                           | npm CLI 路径解析默认使用 `process.execPath`（宿主 Node）                                                                       |
| `scripts/build-standalone-release.js` / `create-standalone-package.js` | 固定 Bun 1.3.14、五个 target、`manifest.json`（`runtime`、版本）；布局 `bun/bin/bun`、`node/bin/node`                          |

### 固定父提交的完整字面调用点复核

上表是按概念分组的历史清单，不是穷尽列表。本表补齐固定父提交
`8b4a0a25ea2bc570a1a6070e05182f29501a1b7f` 上 `packages/**/src/**`
的所有可执行 `process.execPath` 字面读取：34 文件、48 处。行号固定于该父提交；
同文件不同用途逐一列出。扫描排除注释、`*.test.*`、`*.spec.*`、`__tests__`、
`test` 目录、`*test-helper*` 与 `acceptance` 目录；下面明确记录例外。
此清单是源码分类，不是平台/编译产物兼容性证明，也不是所有隐式 fork、别名、
外部命令或原生 spawn 的完整审计。后续改动需重跑同范围扫描。

| 固定源码位置（所有行号）                                               | 身份、当前行为及后续范围                                                                                                               |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/acp-bridge/src/spawnChannel.ts:554`                          | 启动器：带堆参数的 ACP CLI 子进程；未迁移（S4）。                                                                                      |
| `packages/browser-use/src/native-host-installer.ts:378`                | 解释器：将 native-host 运行时持久写入 shell 启动器；未迁移（S3），需验证安装生命周期和宿主兼容性。                                     |
| `packages/channels/base/src/AcpBridge.ts:141`                          | 启动器：CLI 入口、--acp 及继承的运行时参数；未迁移（S4）。                                                                             |
| `packages/cli/src/agent-view/current-cli-argv.ts:27,34`                | 启动器：开发态 tsx 入口（27）、普通入口（34）；均未迁移（S4）。                                                                        |
| `packages/cli/src/commands/review/run.ts:602`                          | 启动器：带 --expose-gc 的 CLI review agent；未迁移（S4）。                                                                             |
| `packages/cli/src/commands/review/test-efficacy.ts:1849`               | 宿主工具：本地 Vitest 入口；有意保留测试宿主，不属应用解释器迁移。                                                                     |
| `packages/cli/src/commands/sandbox.ts:228`                             | 解释器：沙箱 -e 诊断与 realpath 白名单；未迁移（S3、Linux）。                                                                          |
| `packages/cli/src/config/mem0-settings.ts:153,208`                     | 解释器：MCP 子进程（153）及匹配身份检查（208）；需一同迁移（S3），本 PR 均未修改。                                                     |
| `packages/cli/src/serve/channel-worker-supervisor.ts:1119`             | 启动器：带 IPC 的 channel daemon-worker 入口；未迁移（S4）。                                                                           |
| `packages/cli/src/serve/daemon-update-restart.ts:99,100`               | 启动器：execve 可执行文件及 argv[0]；Bun 下禁用的路径，不代表编译应用支持（S4）。                                                      |
| `packages/cli/src/serve/local-process-runtime-activator.ts:315`        | 启动器：配置的 managed-runtime 入口参数；未迁移（S4）。                                                                                |
| `packages/cli/src/serve/managed-runtime-session-worker.ts:250`         | 启动器：managed-runtime-worker 入口；未迁移（S4）。                                                                                    |
| `packages/cli/src/serve/pem-certificate-blocks.ts:83`                  | 解释器：CommonJS PEM oracle；未迁移（S3），运行时 crypto 语义待验证。                                                                  |
| `packages/cli/src/serve/run-qwen-serve.ts:913`                         | 解释器：module eval TLS 信任探针；未迁移（S3），须保留 Node/Bun TLS 差异。                                                             |
| `packages/cli/src/serve/session-agents/orchestrator.ts:631`            | 启动器：agents session-send-mcp 入口；未迁移（S4）。                                                                                   |
| `packages/cli/src/ui/handleAutoUpdate.ts:124`                          | 宿主 Node：npm 更新命令；保留宿主身份，不改用私有 Bun（S3 验证待补）。                                                                 |
| `packages/cli/src/ui/utils/updateCheck.ts:148`                         | 宿主 Node：npm 更新检查运行器默认值；保留宿主身份（S3 验证待补）。                                                                     |
| `packages/cli/src/utils/installationInfo.ts:27`                        | 宿主 Node：npm CLI 路径解析默认值，并非仅展示信息；与 npm 消费方一同保留。                                                             |
| `packages/cli/src/utils/managed-npm-update.ts:118,120,137,188,329,331` | 宿主 Node：npm 配置/路径解析（118/120/137）、暂存 CLI 健康启动（188）、npm 安装及路径查找（329/331）；保留宿主身份，逐阶段验证（S3）。 |
| `packages/cli/src/utils/processUtils.ts:68,69`                         | 启动器：execve 可执行文件及 argv[0]；尚未迁移编译应用形态（S4）。                                                                      |
| `packages/cli/src/utils/relaunch.ts:167,168,190`                       | 启动器：execve 可执行文件/argv[0]（167/168）、监督式 IPC spawn 回退（190）；尚未迁移编译应用形态（S4）。                               |
| `packages/core/src/agents/arena/ArenaManager.ts:1096`                  | 启动器：agent 工作树中的 argv[1]；未迁移（S4）。                                                                                       |
| `packages/core/src/hooks/hook-command-cgroup.ts:166`                   | 解释器：CommonJS eval cgroup 启动器；未迁移（S3、Linux cgroup v2）。                                                                   |
| `packages/core/src/sandbox/bwrap-execution.ts:41`                      | 解释器：JS relay 的 realpath 暂存；未迁移（S3、Linux bubblewrap）。                                                                    |
| `packages/core/src/sandbox/landlock-execution.ts:113`                  | 解释器：JS relay 的 realpath 暂存；未迁移（S3、Linux landlock）。                                                                      |
| `packages/core/src/utils/runtime-info.ts:175`                          | 解释器解析器回退：manifest 缺失/拒绝时使用宿主可执行文件；S1 已实现，不支持编译形态。                                                  |
| `packages/mobile-mcp/src/server.ts:189`                                | 信息：遥测身份哈希输入；不启动子进程，有意排除于迁移范围。                                                                             |
| `packages/node-repl/src/desktop-relay/cli.ts:89,174,192`               | 混合：npm 宿主解释器（89）；持久 launchd relay 应用入口（174，S4 待迁移）；权限提示文本（192，信息）；不可盲目统一替换。               |
| `packages/node-repl/src/desktop-relay/runtime.ts:53`                   | 解释器：node-repl 包入口，并非 Qwen CLI 启动器；未迁移（S3），须保留包/运行时边界。                                                    |
| `packages/node-repl/src/kernel-manager.ts:567`                         | 解释器：带实验参数和 fd3/fd4 协议的 VM kernel；属宿主 Node 契约，不自动换为 Bun（S3 兼容性待验证）。                                   |
| `packages/sdk-typescript/src/utils/cliPath.ts:313,340`                 | 启动器：捆绑 CLI 默认值（313）；解释器：显式 JS 可执行文件（340）。使用 SDK 宿主身份，有意不强制私有 Bun；编译形态处理待 S4。          |
| `packages/vscode-ide-companion/src/extension.ts:409`                   | 启动器：扩展宿主 CLI 终端命令；保留 Electron/VSCode 环境契约，不强制私有 Bun（S4 待迁移）。                                            |
| `packages/vscode-ide-companion/src/services/acpConnection.ts:109`      | 启动器：扩展宿主 ACP 入口；保留 Electron run-as-Node 契约（S4 待迁移）。                                                               |
| `packages/vscode-ide-companion/src/services/qwenDaemonProcess.ts:76`   | 启动器：扩展宿主 serve 入口；保留 Electron run-as-Node 契约（S4 待迁移）。                                                             |
| `scripts/cli-entry.js:476,488`                                         | 启动器：Bun/Windows 的 `spawnSync(--expose-gc, cliPath)` 分支及其错误文案；未迁移编译形态（S4），不是解释器选择器接线。                |
| `scripts/dev.js:237`                                                   | 开发宿主解释器选择；有意保留开发工具身份，非 standalone 生产入口迁移。                                                                 |

范围例外：`packages/sdk-typescript/src/transport/ProcessTransport.ts` 的字面命中仅在注释中，实际通过 `forkOptions.execPath` 消费 `cliPath.ts` 的选择，须与 SDK/Electron 契约共同验证；`channel-worker-supervisor.ts:196,271,280` 的 `execPath` 参数消费对应本表的 1119 调用。`core/src/utils/runtime-info.ts` 的其他字面命中均为注释。

有意排除生产迁移：`packages/cli/src/serve/cdp-tunnel/acceptance/run-real-chrome.mjs:95,112,129` 是验收驱动；`packages/cli/src/serve/managed-runtime-tool-v3-host.test-helper.ts:44` 是测试 helper；所有测试/夹具及 `packages/sdk-java/**/src/test/**` 是宿主测试。`packages/**/scripts/**`、包根的 `build.mjs` 和 `scripts/**` 中其余命中属于构建、打包、开发、benchmark、sandbox prototype、lint 或 E2E 驱动，保留各自工具宿主；不把它们算作已迁移的应用调用点。`scripts/build-standalone-release.js` 的脚本 spawn 是构建宿主行为，不证明生成归档已能运行。打包脚本中的运行时字符串是布局配置，另走原样归档验收。

S1 已接入选择器的三处是 `core/src/code-mode/host-client.ts`、`core/src/sandbox/file-worker-client.ts`、`core/src/hooks/hookRunner.ts`（均加 `packages/` 前缀）；它们不再直接读取 `process.execPath`，不能因本字面扫描未命中而漏记。`getPty.ts` 是运行时检测，不是解释器 spawn。S3/S4 是待办范围标识，不表示这些迁移已提交或获准；尤其 kernel、npm、SDK 与扩展宿主不能统一替换为私有 Bun。

### SDK 消费方

`@qwen-code/qwen-code-core` 作为库使用（SDK 宿主）时运行在宿主自身运行时下。SDK 代码路径不得向 Node 宿主强加 Bun 解释器：只有包布局中存在 standalone `manifest.json` 时 `getJsInterpreterCommand` 才会偏离 `process.execPath`，npm 与源码安装都没有该文件。

## 接口约定

### 1. App launcher

- `scripts/cli-entry.js` 是 `QWEN_CODE_CLI` 的唯一写入方；`getShellContextEnvVars` 负责传播。自调用在 shell 中用 `"${QWEN_CODE_CLI:-qwen}"`，直接 spawn 用写入的值。
- 同进程树内再唤起应用（relaunch、managed worker、arena agent）保留同解释器回退 `process.execPath + process.argv[1]`，因为所有已发布布局中入口都是 JS 文件。编译产物形态必须先通过 `QWEN_CODE_CLI` 发布其 launcher，上述位置才能变更；上面清单仅固定源码位置，不代表已验证编译应用行为。

### 2. JS interpreter —— `packages/core/src/utils/runtime-info.ts`

- `isBunRuntime(): boolean` —— 唯一的运行时检测点。
- `getJsInterpreterCommand(importMetaUrl): { command, runtime }` —— 解析任意 JS 子进程使用的解释器：
  1. 唯一可信位置是 **standalone 包根**：调用方 bundle 目录（`resolveBundleDir`）的父目录，必须同时存在 `manifest.json` 与 standalone 入口标记 `lib/cli-entry.js`。**不做向上遍历** —— 无关祖先清单（例如 npm 宿主工程的构建 manifest）永远不会被读取，npm、源码与 SDK 布局因此始终使用 `process.execPath`。
  2. 在该可信包根内，所有声明先校验后使用：`runtime` 必须恰为 `'bun'` 或 `'node'`；解释器 —— `interpreter` 字段相对包根解析（绝对路径原样采用，不强制限制在包根内），否则取标准位置 `bun/bin/bun` / `node/bin/node` —— 必须是已存在的普通文件。POSIX 还要求执行权限；Windows 只检查普通文件存在，不验证 PE 格式或实际可启动性，默认路径为 `bun/bun.exe` / `node/node.exe`。
  3. 任何无效或缺失的声明 —— 非对象清单、未知 `runtime`、非字符串 `interpreter`、二进制缺失、目录、POSIX 不可执行文件、入口标记缺失 —— 一律回退 `process.execPath`（运行当前进程的解释器：宿主 Node、内置 Node，或 standalone Bun 形态的私有内置 Bun）。解析绝不猜测其他二进制，也绝不抛出异常。
- `runtime` 是当前没有生产读点的元数据：三处已迁移调用方仅消费 `command`。按运行时区分的消费逻辑（包括未来 S3 对该字段的任何用途）尚未在此实现。
- 结果按进程记忆：首次调用方的 URL 决定解析结果，后续调用方 URL 被忽略；当前生产调用方共享一个安装根。`resetJsInterpreterCacheForTests()` 清除缓存。
- 沙箱 file-worker 选择此解释器，但 bwrap/landlock 的 allowlist 仍暂存 `realpathSync(process.execPath)`。这项衔接仍是尚未实现的 S3 迁移；本 PR 不证明解析出的解释器与暂存二进制不同时的布局已受支持。
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
