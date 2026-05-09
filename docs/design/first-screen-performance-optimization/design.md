# 首屏加载与启动性能优化 — 设计文档

> 本文档是 qwen-code 首屏加载/启动性能优化的合并设计文档（包含原 00-overview、01-observability-baseline、02-async-settings、03-parallel-init-and-lazy-entry、04-progressive-mcp、05-rollout-and-rollback、A0-research-matrix、decision-log 八份文档的内容）。
>
> 配套数据与基础设施：
>
> - `baseline-data/` —— 4 fixture × 30 runs 的基线数据，PR2-4 强制对照
> - `fixtures/` —— 4 个基线场景配置 + echo MCP 服务器实现

---

## 目录

1. [背景与目标](#1-背景与目标)
2. [跨方案源码调研](#2-跨方案源码调研)
3. [三轮设计 Review (Decision Log)](#3-三轮设计-review-decision-log)
4. [PR 拆分总览](#4-pr-拆分总览)
5. [PR0+1 — 观测基线 + 设计文档](#5-pr01--观测基线--设计文档)
6. [PR2 — 异步并行 Settings 加载](#6-pr2--异步并行-settings-加载)
7. [PR3 — initializeApp 并行化 + 入口延迟加载](#7-pr3--initializeapp-并行化--入口延迟加载)
8. [PR4 — 渐进式 MCP 可用性](#8-pr4--渐进式-mcp-可用性)
9. [灰度、回滚与副作用审计](#9-灰度回滚与副作用审计)
10. [验证框架（统计方法学）](#10-验证框架统计方法学)
11. [基线数据摘要](#11-基线数据摘要)

---

## 1. 背景与目标

### 1.1 现状问题（带源码引用）

qwen-code 的交互式启动管线存在两类用户感知问题：

**首次可见时间 (first paint) 偏晚**：

- `loadSettings()` 用 `fs.readFileSync` 串行读 4-5 个 JSON（`packages/cli/src/config/settings.ts:810`）。
- `initializeApp()` 内部 `i18n` / `auth` / IDE 串行 await（`packages/cli/src/core/initializer.ts:33-66`）。
- 交互 UI 的所有依赖在入口处一次性静态 import（`packages/cli/src/gemini.tsx:41`），V8 解析负担前置。

**可见后仍不可用 (TTI 偏晚)**：

- `config.initialize()` 在 mount 后 `useEffect` 中执行（`packages/cli/src/ui/AppContainer.tsx:407-411`），阻塞实际可交互时刻。
- `mcp-client-manager.discoverAllMcpTools()` 用 `await Promise.all(...)` 等所有 server settle（`packages/core/src/tools/mcp-client-manager.ts:139`），慢 server 拖延 `discoveryState = COMPLETED`。
- 单 server 工具完成 discover 后，`GeminiClient.setTools()`（`packages/core/src/core/client.ts:348-357`）不会自动刷新 tools declaration，模型下次请求未必看见。

### 1.2 已落地的相关优化（无须重做）

- **早期输入捕获** #3319：用户在初始化期间打字不丢失。
- **API preconnect** #3011 系列：DNS / TLS 预热。
- **bare 启动模式** #3448：最小启动路径，跳过非必需初始化。
- **channel 插件懒加载** #3134：消除 DEP0040 警告，减少 V8 解析。
- **启动 profiler 基础** #3219 / #3232：`processUptimeAtT0Ms` + 阶段 checkpoint。
- **主题 / Kitty 协议探测并行**：`gemini.tsx:623, 636-640, 692, 697`。
- **MCP 增量原语已存在**：`discoverAllMcpToolsIncremental()`（`mcp-client-manager.ts:439`）、`removeMcpToolsByServer()`（`tool-registry.ts:318`）、`createToolRegistry({ skipDiscovery })` —— 但**未接入交互式启动主路径**。

### 1.3 设计目标（量化）

| 指标                           | PR0+1 baseline (p50)                                  | 目标 (PR4 完成后, p50)                            |
| ------------------------------ | ----------------------------------------------------- | ------------------------------------------------- |
| `before_render`                | 79-81 ms (跨 fixture)                                 | -50~150 ms                                        |
| `first_paint`                  | 420 ms (no-mcp 交互态)                                | -150~300 ms                                       |
| `input_enabled`                | 480 ms (no-mcp 交互), 7101 ms (three-mixed 交互)      | no-mcp -300 ms; 慢 MCP fixture 下不再被 MCP 拖延  |
| `config_initialize_dur`        | 70 ms (no-mcp 交互), 6688 ms (three-mixed 交互)       | 慢 MCP fixture 下 ≤ 1s（PR4 fire-and-forget MCP） |
| `mcp_first_tool_registered`    | 866 ms (one-fast-mcp 交互), 872 ms (three-mixed 交互) | < 500 ms（最快 server 响应时间）                  |
| `gemini_tools_lag`             | 6235 ms (three-mixed 交互)                            | **≤ 16 ms**（一帧 batch flush，~390x 改善）       |
| `mcp_all_servers_settled`      | 7077 ms (three-mixed 交互)                            | 不退化（仍由最慢 server 决定）                    |
| `interactive_bundle_size` (gz) | 待测（PR3 引入）                                      | -10~25%                                           |
| `headless_bundle_size`         | 待测（PR3 引入）                                      | **不含 Ink/AppContainer**                         |

### 1.4 不做项（明确边界）

- **运行期 MCP refresh / reload** 路径增量化（原 `01-performance.md § 2.3A`）—— 留给后续 PR 系列；本设计只解决首屏 / 启动期。
- **流式输出闪烁、refreshStatic、虚拟滚动、marked parser** —— 归 `docs/design/tui-optimization/` 主线。
- **Web 渲染探索 / 自研 Ink diff** —— 远期议题，不在本范围。
- **彻底重写 settings.ts 异步化所有调用点** —— PR2 只做启动主路径，命令 / 设置对话框 / 测试保留同步 wrapper。
- **Gemini 父子进程拆分通用化** —— 收益大但成本与现有 sandbox 路径冲突，本设计不采纳。

---

## 2. 跨方案源码调研

> 调研对象路径：
>
> - qwen-code（本仓）：`packages/`
> - Gemini CLI：`/Users/gawain/Documents/codebase/opensource/gemini-cli/`
> - Claude Code：`/Users/gawain/Documents/codebase/opensource/claude-code/`
>
> **Last verified**: 2026-05-09 against `gemini-cli@1a894c18e`, `claude-code@496a077`. 行号会随上游演进失准；如果引用不上，先 `git log --all -- <path>` 找最近相关提交再回到本节更新。
>
> 任何后续设计决策都应能在此节找到 file:line 级证据；无证据的"借鉴"不算数。

### 2.1 入口与模块求值顺序

| 维度                          | qwen-code                                                                  | Gemini CLI                                                                                                   | Claude Code                                                                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 顶层入口                      | `packages/cli/index.ts`、`packages/cli/src/gemini.tsx:357`(main)           | `packages/cli/index.ts:77-143` 父进程；`src/gemini.tsx:344-881` 子进程 main                                  | `src/main.tsx:1-20`（顶层副作用）+ `src/entrypoints/cli.tsx:1-120`（多层入口）                                                                                              |
| 父进程 / 子进程拆分           | 仅 sandbox 触发时拆分，profiler 也只在 child 启用                          | **是**：父进程极薄、`spawn(child)` 减约 1.5s；父子都用 `await import(...)` 延迟重模块                        | 单进程，但用 daemon worker / coordinator 等多 entry 拆冷热路径                                                                                                              |
| 交互 UI 动态加载              | 否（`AppContainer` 静态 import：`gemini.tsx:41`）                          | **是**：`gemini.tsx:324-342` `await import('./interactiveCli.js')`，仅当 `config.isInteractive()` 为真时加载 | 用 bun:bundle 的 `feature('FLAG') ? require(...) : null` 编译期 DCE：`main.tsx:74-81`                                                                                       |
| 顶层 fire-and-forget 后台任务 | `apiPreconnect.ts`（已合入 #3011 系列）                                    | `gemini.tsx:386-396` `Promise.all([cleanupCheckpoints, cleanupToolOutputFiles, cleanupBackgroundLogs])`      | **module-eval 时启动**：`main.tsx:9-20` `startMdmRawRead()`、`startKeychainPrefetch()`，与后续 imports 并行；`profileCheckpoint('main_tsx_imports_loaded')`(`main.tsx:209`) |
| 非交互 / headless / 子命令    | 当前主路径仍走 `gemini.tsx`，子命令通过参数路由；UI 模块在所有路径都被求值 | 子进程内 `if (!config.isInteractive())` 走非交互路径（`gemini.tsx:774-799`），不加载 React/Ink               | `cli.tsx:37-41` `--version` 直接返回；`cli.tsx:53-106` 其他特殊 flag 各自动态 import 自己的 handler                                                                         |
| feature gate                  | 无显式编译期 DCE；用环境变量/启动开关                                      | 无 feature flag 编译期 DCE；用动态 import + 运行时分支                                                       | **bun:bundle 的 `feature('FLAG_NAME')`** 编译期 DCE，能整块剔除模块（`main.tsx:21-26`、`74-81`）                                                                            |

### 2.2 Settings / Config 装载

| 维度                     | qwen-code                                                               | Gemini CLI                                                                  | Claude Code                                                                                                |
| ------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 同步 / 异步              | **同步** `fs.readFileSync`（`packages/cli/src/config/settings.ts:810`） | **同步** `fs.readFileSync`（`packages/cli/src/config/settings.ts:710-870`） | **同步** disk 读 + 异步 wrapper（`src/utils/settings/settings.ts:645-865`）                                |
| 是否并行多文件           | 否，顺序读 4-5 个 JSON                                                  | 否，顺序读 4 个                                                             | 否，但 first-source-wins 提前短路（`settings.ts:677-720`）                                                 |
| 双轨 API（sync + async） | 否                                                                      | 否（仅 sync）                                                               | **是**：`eagerLoadSettings()` 提前解析 CLI flag 决定 source；`ensureMdmSettingsLoaded()` 异步消费 MDM 数据 |
| migration / env 解析位置 | `loadSettings()` 内部（`settings.ts:956`）                              | `_doLoadSettings()` 内部 `loadEnvironment()`（`settings.ts:858-870`）       | `loadSettingsFromDisk()` + 后续 `mergeWith()` 深合并                                                       |
| 损坏文件兜底             | `.orig` 备份恢复（`settings.ts:865-910`）                               | 类似的 in-place 处理（line 833-856 附近）                                   | 多源回退：Remote → HKLM/plist → managed → HKCU                                                             |

### 2.3 UI 出现时机 vs. 后台初始化

| 维度                           | qwen-code                                                                               | Gemini CLI                                                                            | Claude Code                                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `config.initialize()` 调用位置 | **mount 后** `useEffect`（`AppContainer.tsx:407-411`）                                  | **mount 后** `useEffect`（`AppContainer.tsx:479-526`）                                | **render 前**完成基本初始化，`initialState` 完全构造好（`main.tsx:1936-2000`），`renderAndRun()`(`main.tsx:2853`) |
| MCP 阻塞 render？              | `config.initialize()` 内部 `discoverAllMcpTools()` `await Promise.all` 全部 server 完成 | 同 qwen-code，但提供 `useMcpStatus()` 让 UI 用事件呈现进度（`useMcpStatus.ts:15-51`） | **MCP 永不阻塞 REPL/turn 1**（`main.tsx:2442-2448` 注释明确）；初始化时只 push `type: 'pending'` 占位             |
| "可见但未就绪" UX              | `ConfigInitDisplay` 显示 connected/total                                                | `useMcpStatus()` + 早期 startup warnings 在 `gemini.tsx:780-798`                      | `appState.mcp.clients[i].type = 'pending'`，UI 渲染 placeholder（`main.tsx:2699`）                                |
| 进度事件                       | `mcp-client-update` 事件                                                                | `coreEvents.on(CoreEvent.McpClientUpdate)`（`useMcpStatus.ts:26-39`）                 | `updateServer()` 进 `pendingUpdatesRef`，16ms batch flush                                                         |

### 2.4 MCP 生命周期

| 维度                       | qwen-code                                                                                                                                                                              | Gemini CLI                        | Claude Code                                                                                                                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 启动期阻塞策略             | `discoverAllMcpTools()` `Promise.all` 全等，慢 server 拖延 `discoveryState=COMPLETED`（`mcp-client-manager.ts:139`）                                                                   | 同：`Promise.all`，但事件化更彻底 | **完全不阻塞**：`prefetchAllMcpResources()`(`main.tsx:2412`) 在 trust dialog 后才启动；`getMcpToolsCommandsAndResources()` 内部 `pMap(..., {concurrency: N})` 并行                                   |
| 单 server ready → 工具可见 | `McpClient.discover()` 完成时即注册到 ToolRegistry，但 `GeminiClient.setTools()` 不会自动刷新；下一次模型请求未必看见                                                                  | 类似，但在 UI 层实时反馈          | `useManageMCPConnections.ts:207-308` 单 server 完成后 push `pendingUpdatesRef`，**16ms batch flush**：`MCP_BATCH_FLUSH_MS = 16`（`useManageMCPConnections.ts:207`）                                  |
| 慢 / 失败 server 隔离      | 失败被吞，但 `Promise.all` 仍等所有 settle；其他 server 工具不被清空（构造时为空，逐 server 加入）                                                                                     | 同 qwen-code                      | 每 server 独立结果路径，失败标 `type: 'failed'`，工具/命令清掉自己的（`useManageMCPConnections.ts:233-243`）；claude.ai 远端额外有 5s 全局超时（`main.tsx:2738` `CLAUDE_AI_MCP_TIMEOUT_MS = 5_000`） |
| 增量原语                   | **已存在但未接入主路径**：`discoverAllMcpToolsIncremental()`(`mcp-client-manager.ts:439`)、`removeMcpToolsByServer()`(`tool-registry.ts:318`)、`createToolRegistry({ skipDiscovery })` | 未明确暴露增量 API                | useManageMCPConnections 整体就是增量模型；远端 transport 自动 reconnect（`client.ts onclose()` 失效缓存）                                                                                            |
| ToolListChanged / 动态变更 | 不显式订阅                                                                                                                                                                             | 不显式订阅                        | 显式处理 ToolListChanged / PromptListChanged / ResourceListChanged，事件进 batch flush                                                                                                               |
| timeout 设计               | `MCP_DEFAULT_TIMEOUT_MSEC = 10 * 60 * 1000`（discovery 与 tool-call 共用）                                                                                                             | 类似                              | discovery 与 tool-call 拆分；远端 5s 上限                                                                                                                                                            |
| 工具刷新到模型             | `GeminiClient.setTools()`(`client.ts:348-357`) 手动调用                                                                                                                                | 类似                              | turn 1 即时取最新 `computeTools()`；slow servers 在 turn 2+ 起作用                                                                                                                                   |

### 2.5 可观测性（startup profiler）

| 维度                   | qwen-code                                                                                | Gemini CLI                                                                                       | Claude Code                                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| 触发条件               | `QWEN_CODE_PROFILE_STARTUP=1` **且** `process.env.SANDBOX`（`startupProfiler.ts:54-61`） | 总是开启（默认） `startupProfiler.start('cli_startup')`（`gemini.tsx:346`），通过 telemetry 上报 | `CLAUDE_CODE_PROFILE_STARTUP=1` 进入详细模式；外部用户 0.5% sampling、内部 100%（`startupProfiler.ts:26-36`）                  |
| 是否区分 sandbox child | **是，且强制要求**                                                                       | 不区分（父子都跑，但父进程 main 极薄）                                                           | 不区分                                                                                                                         |
| 内存记录               | 否（仅 timing）                                                                          | 否                                                                                               | **是**：详细模式下 `process.memoryUsage()` 每个 checkpoint 记录（`startupProfiler.ts:72-74`）                                  |
| 输出位置               | `~/.qwen/startup-perf/{timestamp}-{sessionId}.json`（`startupProfiler.ts:117-123`）      | telemetry / core events，不直写文件                                                              | `~/.claude/startup-perf/{sessionId}.txt` + Statsig（`startupProfiler.ts:131-194`）                                             |
| Phase 定义             | 用户在调用点决定 checkpoint 名                                                           | 同 qwen-code                                                                                     | **预定义 phase**（`PHASE_DEFINITIONS`，`startupProfiler.ts:48-54`）：`import_time`、`init_time`、`settings_time`、`total_time` |
| 覆盖范围               | 仅 render 前；`config.initialize()` 与 MCP 阶段不覆盖                                    | render 前 + AppContainer mount 后再 flush（`AppContainer.tsx:488`）                              | render 前完整覆盖；多 phase 上报                                                                                               |

### 2.6 Bundle / code-splitting

| 维度                | qwen-code                                 | Gemini CLI                                                                  | Claude Code                               |
| ------------------- | ----------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------- |
| 构建工具            | esbuild                                   | esbuild                                                                     | bun:bundle                                |
| 入口拆分            | 单 bundle (`dist/cli.js` 约 23 MB)        | 单 entry，但 `splitting: true`（`esbuild.config.js:89`）启用 code-splitting | 多 entry / feature gate，编译期可剔除整块 |
| 交互模块 lazy chunk | 否：AppContainer 静态 import              | 是：`interactiveCli.js` 是 dynamic import 的目标                            | feature flag 控制                         |
| 已 external 的依赖  | 与 Gemini 类似（node 内置 + 部分 native） | `node-pty`、`devtools`、`keytar` external（`esbuild.config.js:57-67`）      | bun 内置依赖处理                          |

### 2.7 综合借鉴清单

| 借鉴点                                             | 来源                                        | qwen-code 应用方式                                                                                                               |
| -------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **module-eval 时启动后台 prefetch**                | Claude Code `main.tsx:9-20`                 | qwen-code 已有 `apiPreconnect`，可在 `index.ts` 顶层增加更多 fire-and-forget（如 git branch 探测、IDE socket 探测）              |
| **入口动态 import 交互 UI**                        | Gemini CLI `gemini.tsx:324-342`             | PR3 直接对标这个模式：`if (isInteractive) await import('./interactiveCli.js')`                                                   |
| **MCP 16ms batch flush** 优于 100ms debounce       | Claude `useManageMCPConnections.ts:207`     | PR4 把"100ms debounce" 改为 16ms batch flush（一帧），UI 抖动更少                                                                |
| **MCP per-server `pending → ready/failed` 状态机** | Claude `useManageMCPConnections.ts:233-243` | PR4 在 `removeMcpToolsByServer()` + 增量 discover 之上同时维护 `mcp.clients[i].type` 状态                                        |
| **profiler 不强制 sandbox child**                  | Claude `startupProfiler.ts:26-36`           | PR1 把 qwen-code profiler 的 `&& SANDBOX` 强制条件改为可选（保留默认行为，新增 `QWEN_CODE_PROFILE_STARTUP_OUTER=1` 显式 opt-in） |
| **profiler 记内存**                                | Claude `startupProfiler.ts:72-74`           | PR1 在每个 checkpoint 同步记 `heapUsed`                                                                                          |
| **预定义 phases 而非完全自由 checkpoint**          | Claude `startupProfiler.ts:48-54`           | PR1 在 qwen-code report 输出中加 `derivedPhases: { module_load, settings_time, ... }`，便于 nightly CI 阈值监控                  |
| **claude.ai 远端 5s 超时**                         | Claude `main.tsx:2738`                      | PR4 拆分 discovery 与 tool-call timeout 时，远端 server 可借鉴此短上限                                                           |
| **Gemini 父子进程拆分省 ~1.5s**                    | Gemini `index.ts:77-143`                    | qwen-code 当前已有 sandbox 父子拆分，但仅在沙箱场景；不扩展为通用的双进程模型（成本/复杂度高，留作未来评估）                     |

### 2.8 关键差异 / 暂不采纳

| 项                                        | 决策     | 理由                                                                                                                  |
| ----------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------- |
| Gemini 通用父子进程拆分                   | 暂不采纳 | 成本高，且与现有 sandbox 路径冲突；优先用入口动态 import + module-eval prefetch 取得相近收益                          |
| Claude `bun:bundle` feature gate          | 不采纳   | qwen-code 用 esbuild，无 compile-time DCE；改造工具链成本高；用 `await import(...) + isInteractive` 取代              |
| Claude pre-render `initialState` 完整构造 | 部分采纳 | 与 qwen-code 现有 mount-后 `config.initialize()` 范式有冲突；只在 PR4 把 MCP 部分提到 `skipDiscovery` 即可获 70% 收益 |
| Gemini settings 全 sync                   | 部分采纳 | qwen-code PR2 仍走异步并行（4-5 文件并行 30-50% 收益），但保留同步 wrapper                                            |

---

## 3. 三轮设计 Review (Decision Log)

### 3.1 Round 1 — 自评

#### 每个 P 项的预期收益区间与依据

| 项                       | 预期收益（p50）                                                              | 依据                                                                                                                                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR1 观测                 | 0（仅采样）                                                                  | 增加测量但不改行为。Heisenberg 效应需 < 1%（验证机制见 § 9）                                                                                                                                                      |
| PR2 loadSettingsAsync    | `after_load_settings`: -30~50% (~50-100ms)                                   | 当前 4-5 个 `fs.readFileSync` 顺序读总耗时约 100-200ms（cold I/O）；并行后受限于最慢一个文件 + Promise 调度成本（~10ms）                                                                                          |
| PR3 initializeApp 并行化 | `before_render`: -100~250ms                                                  | i18n 与 loadCliConfig 并行节省 i18n 自身耗时（约 80-150ms 取决于 locale 数据）；auth + warnings + kitty 并行节省 30-100ms（kitty 探测 ~40ms 已是 fire-and-forget，但 auth 后端 hit DNS 缓存约 50ms 仍可吃到并行） |
| PR3 入口动态 import      | `processUptimeAtT0Ms`: -50~150ms                                             | AppContainer + Ink + themes + hooks 在非交互路径完全不解析；交互路径多一次 chunk fetch（本地 ~2-5ms）但 V8 解析时间不增（同一总量分散到 await 之后）                                                              |
| PR3 module-eval prefetch | 小（< 30ms）                                                                 | git branch 探测约 10-30ms 可与 imports 并行掉；保守估计                                                                                                                                                           |
| PR4 渐进式 MCP           | `mcp_first_tool_registered`: 等于最快 server 响应；`gemini_tools_lag` ≤ 16ms | 当前等所有 settle，`three-mixed-mcp` fixture 下被慢 server 拖延约 6.7s；改为 incremental 后等于最快 server 响应（< 200ms 在 one-fast-mcp）                                                                        |

#### 收益的工程下限与判断

- **PR1**：观测本身是其他 PR 的前提，**无下限可言**，必须做。
- **PR2**：下限 30% (~50ms)。仍值得，因为 (a) 改动局部、(b) 风险可控、(c) 收益直接落到 `before_render`。
- **PR3 并行化**：下限 100ms。仍值得，因为是改动量小的 refactor + 收益线性。
- **PR3 动态 import**：下限 50ms（V8 解析 Ink + AppContainer）。仍值得，更重要的是为非交互路径剔除 UI 模块（headless 用户感知大）。
- **PR4**：下限是"快 server 工具立刻可见"的语义改进。即使绝对数字小，**用户感知**显著（不必等 6+ 秒才能用快 server 的工具）。值得做。

#### 改动是否引入新失败模式

| PR  | 新失败模式                                                 | 已应对                                                                                            |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| PR1 | profiler 自身 GC / I/O 卡死主路径                          | events array 预分配；finalize 异步写盘；`process.memoryUsage()` 实测 < 50µs                       |
| PR2 | 异步路径下损坏文件兜底竞争 / 多进程并发 `.orig` 备份       | `O_EXCL` 写备份；并发测试覆盖；migration 写回阶段保持串行                                         |
| PR3 | `Promise.all` 一项 reject 短路其他 promise                 | 改 `Promise.allSettled`；warnings 收集到 array                                                    |
| PR3 | 动态 import chunk 加载失败（损坏构建产物）                 | esbuild `splitting: true` 在常规构建中稳定；CI 烟测；万一加载失败，错误冒泡终止启动（不静默降级） |
| PR3 | 模块求值顺序变化导致测试 harness 失效                      | 集成测试全绿前不合并；测试 harness 通常以 mock + 命令行参数驱动，不依赖入口模块求值顺序           |
| PR4 | per-server replace 中途失败 → 工具空窗                     | 替换流程：临时数组缓存 + 全成功才 commit；任何失败保留旧工具                                      |
| PR4 | 进行中 model 请求工具集合突变                              | `setTools` 只影响后续 `sendMessage`（已是当前语义）；测试断言                                     |
| PR4 | 16ms flush 在 100+ server 极端场景下 setTools 调用次数仍多 | 实测期望 < 10 次/秒；100+ server 是非常规场景，可接受                                             |

#### 影响测试 harness / CI / headless / ACP / 子命令路径

| PR  | 影响                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------- |
| PR1 | profiler 在测试环境默认 disabled（无 env var）；CI 中开 `QWEN_CODE_PROFILE_STARTUP=1` 跑 nightly perf job         |
| PR2 | `loadSettingsAsync` 仅在启动主路径 1 个调用点；测试通过 `loadSettings()` 同步路径不受影响                         |
| PR3 | headless / ACP 路径不再 import UI 模块 —— **新增** `scripts/check-bundle-leakage.mjs` CI 校验；ACP 集成测试需全绿 |
| PR4 | 测试需 mock MCP server fixture；`integration-tests/cli/mcp-*.test.ts` 需补渐进式可用场景                          |

#### 回滚成本

| PR  | 回滚                                                                               |
| --- | ---------------------------------------------------------------------------------- |
| PR1 | revert `startupProfiler.ts` 与 checkpoint 调用点                                   |
| PR2 | revert `gemini.tsx:376-378` 改用 sync；保留 `loadSettingsAsync` 函数（孤儿但无害） |
| PR3 | revert 入口动态 import；并行化拆为独立 commit 可单独 revert                        |
| PR4 | env var `QWEN_CODE_LEGACY_MCP_BLOCKING=1` 兜底；或 revert `Config.initialize` 改动 |

每 PR 必须能 single-commit revert。

#### feature flag / env override 设计

| flag                                   | 作用                                               | 默认值 | 引入 PR | 计划移除                      |
| -------------------------------------- | -------------------------------------------------- | ------ | ------- | ----------------------------- |
| `QWEN_CODE_PROFILE_STARTUP`            | 启用 profiler                                      | 0      | 已存在  | 永久                          |
| `QWEN_CODE_PROFILE_STARTUP_OUTER`      | 在非 sandbox 路径下采集 profile                    | 0      | PR1     | 永久                          |
| `QWEN_CODE_PROFILE_STARTUP_NO_HEAP`    | 禁用每 checkpoint 的 heap snapshot                 | 0      | PR1     | 永久                          |
| `QWEN_CODE_LEGACY_MCP_BLOCKING`        | 强制走旧的 `discoverAllMcpTools` 同步等所有 settle | 0      | PR4     | 至少保留 1 个 release，再评估 |
| `mcpServers.<name>.discoveryTimeoutMs` | per-server discovery timeout 覆盖                  | -      | PR4     | 永久                          |

### 3.2 Round 2 — 跨方案对照

每条对照得出三种结论之一：(a) 沿用我们的方案 + 理由；(b) 调整为对照项的做法 + 理由；(c) 部分采纳。

#### Settings 异步

| 选择              | qwen-code 设计 (PR2)             | Gemini CLI                   | Claude Code                                                |
| ----------------- | -------------------------------- | ---------------------------- | ---------------------------------------------------------- |
| 异步并行 readFile | **是**（4-5 文件 `Promise.all`） | 否（全 sync `readFileSync`） | 否（disk 读 sync），但有 `eagerLoadSettings` 提前解析 flag |

**结论**：(a) **沿用**异步并行。理由：

1. qwen-code 的 4-5 个文件每个有 cold I/O 50-200ms，串行加起来比并行慢；这是 qwen-code 的具体 I/O profile，不能照搬"sync 也很快"的结论。
2. Claude 的 `eagerLoadSettings` 解决的是另一个问题（提前决定 source），不是 disk I/O 性能。两者互不冲突，但本 PR 不引入 eager 解析，因为 qwen-code 当前 settings source 集合简单。

#### MCP progressive 与刷新模型工具

| 维度           | qwen-code 设计 (PR4)                                        | Gemini CLI     | Claude Code                             |
| -------------- | ----------------------------------------------------------- | -------------- | --------------------------------------- |
| flush 间隔     | 16ms batch flush（**Round 2 调整**：原方案 100ms debounce） | 不显式批量     | `MCP_BATCH_FLUSH_MS = 16`               |
| timeout 拆分   | discovery 30s / tool-call 沿用旧默认；远端 5s               | 不拆           | claude.ai 远端 5s                       |
| 工具刷新到模型 | 16ms batch flush 后调 `setTools()`                          | 类似但无 batch | 16ms flush 后 `computeTools()` 重新计算 |

**结论**：(b) **调整为 Claude 的 16ms**。原方案 100ms debounce → 16ms batch flush。

##### 16ms vs 100ms batch flush 取舍

100ms debounce 的优势：多 server 在 1s 内陆续 ready 时，setTools 只调一次（合并最完整）。
100ms debounce 的劣势：第一个 server ready 后，模型仍要等额外 100ms 才能用其工具；UI 状态在 debounce 期间表现"已 ready 但未刷新"，体验割裂。

16ms batch flush 的优势：一帧合并；模型最多滞后 16ms 看见新工具；Claude 实战验证。
16ms batch flush 的劣势：极端场景（30+ server 在 1s 内陆续 ready）下 setTools 调用次数比 100ms 多约 6 倍。但 setTools 本身轻量（< 1ms），可接受。

**采纳 16ms。**

#### 入口动态 import

| 维度              | qwen-code 设计 (PR3)                                     | Gemini CLI                            | Claude Code             |
| ----------------- | -------------------------------------------------------- | ------------------------------------- | ----------------------- |
| 拆分边界          | `if (isInteractive) await import('./interactiveCli.js')` | `await import('./interactiveCli.js')` | feature gate 编译期 DCE |
| 工具链            | esbuild `splitting: true`                                | esbuild `splitting: true`             | bun:bundle              |
| 非交互路径剔除 UI | 是                                                       | 是                                    | 是                      |

**结论**：(a) **沿用 Gemini 模式**。Claude 的 feature gate 工具链不匹配，且收益重叠。

#### module-eval 顶层 prefetch

| 维度                       | qwen-code (PR3)                                  | Gemini CLI                                    | Claude Code                                                  |
| -------------------------- | ------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------ |
| module-eval 时启动后台读取 | 已有 `apiPreconnect`；PR3 评估增 git branch 等   | `gemini.tsx:386-396` `Promise.all` 在 main 内 | `main.tsx:9-20` 顶层 startMdmRawRead / startKeychainPrefetch |
| 在 imports 解析期间并行    | **PR3 目标**：在 `index.ts` 顶层而非 `main()` 内 | `main()` 内（也是 fire-and-forget）           | **module-eval 时**（更激进）                                 |

**结论**：(c) **部分采纳 Claude**。在 `index.ts` 顶层（早于 `main()`）启动 fire-and-forget prefetch；但只引入**廉价**的 prefetch 候选（如 git branch），不引入 keychain / OAuth 这种平台特定的复杂路径。

#### Profiler 设计

| 维度               | qwen-code (PR1)                                                  | Gemini CLI             | Claude Code                         |
| ------------------ | ---------------------------------------------------------------- | ---------------------- | ----------------------------------- |
| 强制 sandbox child | 是 → **PR1 改为可选**（OUTER opt-in flag），默认仍 sandbox child | 否（父进程 main 极薄） | 否                                  |
| 记内存             | 否 → **PR1 增**                                                  | 否                     | 是                                  |
| 派生 phase         | 无 → **PR1 增** `module_load / settings_time / ...`              | 无                     | 是 (`PHASE_DEFINITIONS`)            |
| 输出位置           | `~/.qwen/startup-perf/`                                          | telemetry / events     | `~/.claude/startup-perf/` + Statsig |
| 采样策略           | 100% 当 env var 开                                               | 总是开（默认）         | 内部 100% / 外部 0.5%               |

**结论**：(c) **部分采纳 Claude**。引入派生 phase + 内存记录；不引入 Statsig 上报。

#### 父子进程拆分（Gemini 风格）

**结论**：(a) **不采纳**。Gemini 拆分省 ~1.5s，但代价是父进程必须读最小 settings 计算 memory args，与 qwen-code 现有 sandbox 路径冲突。PR3 的入口动态 import + 并行化估计能拿到 200-400ms，覆盖大部分场景。留作未来评估。

### 3.3 Round 3 — 反例攻击（devil's advocate）

每个反例必须有数据或代码论证回应。

**反例 1：one-fast-mcp 下 progressive MCP 工程成本与收益是否倒挂？**

旧路径：mcp_first_tool ≈ mcp_all_settled ≈ 200ms；`gemini_tools_updated` 在 `discoverAllMcpTools` 整体完成后**手动**调一次 `setTools` 时机。新路径：mcp_first_tool = 200ms；`gemini_tools_updated` = 200 + 16 = 216ms。**退化 16ms**，对模型可用性来说不可观察（< 一帧）。但**多 server / 慢 server 场景**节省数秒。**结论**：one-fast-mcp 的"退化"在统计噪声范围内，且与多 server 场景的收益不对称（多 server 收益 100x 大于退化）。值得做。

**反例 2：并行化 i18n 与 loadCliConfig 失败时是否可能让 config 用错语言报错？**

`loadCliConfig` **不依赖** i18n（验证：grep `loadCliConfig` 内部 `t(...)` 调用，无）。用户级错误打印（如 `loadCliConfig` 抛错时的 console.error）是**后续**由 UI 层处理；UI 层 mount 时 i18n 已 settled 或失败兜底英文。单测：故意让 `initializeI18n` reject，期望 `loadCliConfig` 仍正常返回，错误以英文文案展示。

**反例 3：loadSettingsAsync 在低端机磁盘抖动时会不会比串行更慢？**

benchmark 在 macOS APFS、Linux ext4、Linux + slow-disk fixture 各跑 30 次。任何场景 p50 退化 > 5% 拒绝合并。实证经验：4-5 个小 JSON（< 50KB）并行读，APFS / ext4 上不抖；HDD 上理论可能但 qwen-code 用户场景中占比极低。兜底：如果实测确实有回归，PR2 加 `QWEN_CODE_LEGACY_SYNC_SETTINGS=1` env var 走同步分支（**默认不引入**，留为应急）。

**反例 4：动态 import AppContainer 的额外往返是否可能反而拉长 first_paint？**

esbuild `splitting: true` + `format: esm` 下，本地 chunk 加载约 2-5ms（已 V8 cached 后 < 1ms）。抵消项：非交互路径**完全不解析** AppContainer / Ink，节省 50-150ms V8 parse。benchmark 验证：one-fast-mcp fixture 下 first_paint p50 退化 > 5ms 拒绝合并。

**反例 5：扩展 profiler 后采集本身是否影响测得的指标？**

`process.memoryUsage()` 实测 macOS arm64 < 50µs；20 个 checkpoint 累计 < 1ms。`coreEvents.emit` 在无订阅者时 O(1)，约 100ns。benchmark 对照：`QWEN_CODE_PROFILE_STARTUP=0` vs `=1` 下的总耗时差异 < 1%。已落地兜底：`QWEN_CODE_PROFILE_STARTUP_NO_HEAP=1` 关闭内存采集。

**反例 6：PR4 把 100ms debounce 改成 16ms 是不是过度优化？**

16ms 是合并窗口；3 个 server 在 50ms 内陆续 ready 时仍合并为 1 次 setTools。100+ server 极端场景下 `setTools` 调用 ~6 次/秒；`setTools` 本身是 in-process 同步赋值（GeminiClient `setTools` 内部 `chat.setTools(tools)`），开销 < 1ms。Claude `useManageMCPConnections.ts:207` 实战验证 16ms 在生产无问题。**结论**：不是过度优化；选择 16ms 是为了一帧内合并、而非更紧。

**反例 7：PR3 把 module-eval 顶层 prefetch 加进 index.ts，会不会让测试 harness 的 import 顺序变化破坏 mock？**

测试 harness 不会通过 `index.ts` 入口（通常 unit 测试 import 具体模块；e2e 测试通过 `qwen-code` 命令的子进程，与 mock 隔离）。集成测试若依赖 `index.ts` 顶层逻辑，需在 mock setup 后 require —— 与现状一致。兜底：每个 prefetch 函数 export 出来，测试可单独验证不依赖顶层调用。

**反例 8：PR1 的 sandbox child 强制要求改为可选，是否会让父子进程双写 profile？**

文件名带 `outer-` / sandbox-child 前缀（已实现，详见 § 5.4）；不同进程写不同文件。默认行为不变（OUTER=0 时仅 sandbox child 采集），保持向后兼容。单测覆盖：双进程同时 finalize，期望两个独立文件。

### 3.4 三轮 review 后的最终决策汇总

| 决策                                     | 原方案           | 最终方案                                         | 触发轮次              |
| ---------------------------------------- | ---------------- | ------------------------------------------------ | --------------------- |
| MCP flush 间隔                           | 100ms debounce   | **16ms batch flush**                             | Round 2               |
| profiler 强制 sandbox child              | 强制             | **可选**（OUTER flag），默认仍 sandbox child     | Round 2               |
| profiler 派生 phase                      | 不加             | **加** `module_load / settings_time / ...`       | Round 2               |
| profiler heap 记录                       | 不记             | **记**（每 checkpoint，可用 NO_HEAP 关闭）       | Round 2               |
| 入口 module-eval prefetch                | 不加             | **加廉价候选**（如 git branch）                  | Round 2               |
| Settings 异步                            | 异步并行         | **保持异步并行**                                 | Round 1（验证不退化） |
| 父子进程拆分（Gemini 风格）              | 暂不             | **不引入**                                       | Round 2               |
| feature gate 编译期 DCE（Claude 风格）   | 暂不             | **不引入**（工具链不匹配）                       | Round 2               |
| `QWEN_CODE_LEGACY_SYNC_SETTINGS` env var | 不加             | **不加**（默认）；若实测回归再考虑               | Round 3               |
| `mcp_first_tool_registered` 触发语义     | 工具数 delta > 0 | **首个 server `client.discover()` 成功 resolve** | Round 1（实现简化）   |

---

## 4. PR 拆分总览

| 阶段      | 范围                                                              | 关键产物                                                                                                                   |
| --------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **PR0+1** | 设计文档全套 + Phase 0 观测基线实现 + benchmark 脚本 + baseline   | `docs/design/first-screen-performance-optimization/`、`startupProfiler` 扩展、新 checkpoint、benchmark 脚本、baseline 数据 |
| PR2       | `loadSettingsAsync` (新签名 + 启动主路径接入)                     | `settings.ts`、`gemini.tsx`、回归基准对照表                                                                                |
| PR3       | `initializeApp` 并行化 + 入口/UI 模块延迟加载                     | `core/initializer.ts`、`gemini.tsx`、`interactiveCli.ts` 拆分、bundle 报告                                                 |
| PR4       | 渐进式 MCP 可用性（接入已有 incremental 原语 + 16ms batch flush） | `config.ts`、`mcp-client-manager.ts`、`tool-registry.ts`、`client.ts`、`AppContainer.tsx`                                  |

> **强约束**：PR2-4 提交时**必须包含** 4 fixture × 30 次样本的 Welch's t-test 对照表（见 § 10），否则不予合并。

---

## 5. PR0+1 — 观测基线 + 设计文档

> **目标**：让 profiler 覆盖到交互式 `config.initialize()` 内部、MCP server ready、Gemini tools 刷新；让指标可信，作为 PR2-4 的验收基线。

### 5.1 指标定义 (Metrics Spec)

#### 核心指标

| 指标                            | 单位    | 定义                                                                                       | 现状                                               | 目标方向 |
| ------------------------------- | ------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------- | -------- |
| `processUptimeAtT0Ms`           | ms      | Node 进程启动到首个 `profileCheckpoint('main_entry')` 的时间（覆盖 V8 解析 + module-eval） | 已存在（`startupProfiler.ts:64`）                  | ↓        |
| `after_load_settings`           | ms      | T0 → settings 加载完成                                                                     | 已存在（`gemini.tsx:380`）                         | ↓        |
| `after_load_cli_config`         | ms      | T0 → `loadCliConfig()` 完成                                                                | 已存在（`gemini.tsx:576`）                         | ↓        |
| `after_initialize_app`          | ms      | T0 → `initializeApp()` 完成                                                                | 已存在（`gemini.tsx:657`）                         | ↓        |
| `before_render`                 | ms      | T0 → 进入 Ink `render()` 前                                                                | 已存在（`gemini.tsx:687`）                         | ↓        |
| **`first_paint`**               | ms      | T0 → Ink 首帧 commit 完成                                                                  | **新增**                                           | ↓        |
| **`input_enabled`**             | ms      | T0 → AppContainer `configInitialized = true` 且键盘 dispatch 解锁                          | **新增**                                           | ↓        |
| **`config_initialize_dur`**     | ms      | `config.initialize()` 自身耗时（end − start）                                              | **新增**                                           | ↓        |
| **`tool_registry_created`**     | ms      | T0 → `Config.createToolRegistry()` 完成                                                    | **新增**                                           | 监控     |
| **`mcp_discovery_start`**       | ms      | T0 → `discoverAllMcpTools{,Incremental}()` 入口                                            | **新增**                                           | 监控     |
| **`mcp_first_tool_registered`** | ms      | T0 → 首个 MCP server 成功完成 `client.discover()`（工具已注册到 registry，事件仅触发一次） | **新增**                                           | ↓        |
| **`mcp_server_ready:<name>`**   | ms      | T0 → 指定 server `connect + discover` 完成（多次事件）                                     | **新增**                                           | 监控     |
| **`mcp_all_servers_settled`**   | ms      | T0 → 全部 MCP server 完成 / 失败 / 超时                                                    | **新增**                                           | 不退化   |
| **`gemini_tools_updated`**      | ms      | `mcp_first_tool_registered` 后 `setTools()` resolve 的滞后（差值，单位 ms）                | **新增**                                           | ↓        |
| **`heapUsed`**                  | MB      | 每个 checkpoint 同步快照 `process.memoryUsage().heapUsed`                                  | **新增**（借鉴 Claude `startupProfiler.ts:72-74`） | 监控     |
| **`interactive_bundle_size`**   | KB (gz) | 交互模式 chunk gz 后体积（含 Ink + AppContainer + 全部 UI 模块）                           | **新增 (PR3)**                                     | ↓        |
| **`headless_bundle_size`**      | KB (gz) | 非交互 / headless / ACP / 子命令 chunk gz 后体积（**不应**含 Ink）                         | **新增 (PR3)**                                     | ↓ 显著   |

#### 派生 phase（借鉴 Claude `PHASE_DEFINITIONS`）

```ts
phases: {
  module_load: processUptimeAtT0Ms,
  settings_time: after_load_settings,
  config_time:   after_load_cli_config - after_load_settings,
  init_time:     after_initialize_app - after_load_cli_config,
  pre_render:    before_render,
  to_first_paint: first_paint,
  to_input_enabled: input_enabled,
  config_initialize_dur,
  mcp_first_tool: mcp_first_tool_registered,    // 仅有 MCP 时存在
  mcp_all_settled: mcp_all_servers_settled,     // 仅有 MCP 时存在
  gemini_tools_lag: gemini_tools_updated - mcp_first_tool_registered,
}
```

### 5.2 Checkpoint 触发位点

| Checkpoint                      | 触发位                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `main_entry`                    | 已存在（`gemini.tsx:358`）                                                                                          |
| `after_load_settings`           | 已存在（`gemini.tsx:380`）                                                                                          |
| `after_sandbox_check`           | 已存在（`gemini.tsx:557`）                                                                                          |
| `after_load_cli_config`         | 已存在（`gemini.tsx:576`）                                                                                          |
| `after_initialize_app`          | 已存在（`gemini.tsx:657`）                                                                                          |
| `before_render`                 | 已存在（`gemini.tsx:687`）                                                                                          |
| **`first_paint`**               | `startInteractiveUI` 的 Ink `render()` 调用之后立即埋点（同步段；首帧 commit 由 React commit phase 决定，足够近似） |
| **`config_initialize_start`**   | `AppContainer.tsx:411` 的 `await config.initialize()` 之**前**                                                      |
| **`config_initialize_end`**     | `await config.initialize()` 之**后**                                                                                |
| **`input_enabled`**             | `setConfigInitialized(true)` **之后**（`AppContainer.tsx:412`）                                                     |
| **`tool_registry_created`**     | `Config.createToolRegistry()` 完成处                                                                                |
| **`mcp_discovery_start`**       | `mcp-client-manager.discoverAllMcpTools()` / `discoverAllMcpToolsIncremental()` 入口                                |
| **`mcp_server_ready:<name>`**   | 单 server `connect + discover` 完成时（事件列表）                                                                   |
| **`mcp_first_tool_registered`** | 首个 server 的 `client.discover()` 成功 resolve 时（一次性，全局守卫）；attrs 包含 `serverName`                     |
| **`mcp_all_servers_settled`**   | `await Promise.all(discoveryPromises)` 之后、`discoveryState = COMPLETED` 处                                        |
| **`gemini_tools_updated`**      | `GeminiClient.setTools()`（`client.ts:348-357`）resolve 之后                                                        |

### 5.3 Profiler 改造细节

#### 当前限制

`startupProfiler.ts:54-61` 强制要求 `QWEN_CODE_PROFILE_STARTUP=1` **且** `process.env.SANDBOX`。问题：

- 本地 dev 不进 sandbox 时**完全不采集**，开发自验证困难。
- 父子进程双写问题用 sandbox 隔离了，但失去了"无 sandbox 普通启动"的可观测性。

#### 改造内容

```ts
// PR0+1 后的激活逻辑（伪代码）
if (process.env['QWEN_CODE_PROFILE_STARTUP'] !== '1') return;

const inSandboxChild = !!process.env['SANDBOX'];
const outerOptIn = process.env['QWEN_CODE_PROFILE_STARTUP_OUTER'] === '1';

// 默认行为不变：只有 sandbox child 采集。
// 外层（pre-sandbox）采集需要显式 opt-in 避免重复报告。
if (!inSandboxChild && !outerOptIn) return;

enabled = true;
outerProcess = !inSandboxChild;
```

外层文件名带 `outer-` 前缀，避免与 sandbox child 报告混淆。

### 5.4 数据结构

```ts
export interface StartupReport {
  timestamp: string;
  sessionId: string;
  interactiveMode: boolean; // 新增
  outerProcess: boolean; // 新增：标记是否 outer 采集
  processUptimeAtT0Ms: number;
  totalMs: number;
  phases: StartupPhase[];
  events: StartupEvent[]; // 新增：多次事件（如 mcp_server_ready:<name>）
  derivedPhases: DerivedPhases; // 新增：上面 § 5.1 的派生 phase
  nodeVersion: string;
  platform: string;
  arch: string;
}

export interface StartupPhase {
  name: string;
  startMs: number;
  durationMs: number;
  heapUsedMb?: number; // 新增
}

export interface StartupEvent {
  name: string; // e.g. "mcp_server_ready:foo"
  tMs: number; // T0 + delta
  heapUsedMb?: number;
  attrs?: Record<string, string | number | boolean>;
}
```

### 5.5 跨包事件桥（避免 core → cli 反向依赖）

`packages/core` **不能**直接 import cli 的 `startupProfiler`。落地方案：新建 `packages/core/src/utils/startupEventSink.ts`：

```ts
let sink: StartupEventSink | null = null;

export function setStartupEventSink(handler: StartupEventSink | null): void {
  sink = handler;
}

export function recordStartupEvent(name, attrs?): void {
  if (sink) {
    try {
      sink(name, attrs);
    } catch {
      /* hot path safety */
    }
  }
}
```

cli 端在 `gemini.tsx` `main()` 早期调用 `setStartupEventSink((name, attrs) => recordStartupEvent(name, attrs))`，让 core 触发的事件流入 cli profiler。

未注册 sink 时 `recordStartupEvent` 是 O(1) no-op（事件 emit 成本几乎为零）。

### 5.6 Benchmark 脚本接口

`scripts/benchmark-startup.mjs`：

```bash
# 用法
scripts/benchmark-startup.mjs \
  --fixture <no-mcp|one-fast-mcp|three-mixed-mcp|flaky-mcp> \
  --runs <N>                                                   \
  --out <path>                                                 \
  [--baseline <path-to-prev.summary.json>]    # 启用 t-test 对照

# 输出
# 1. <out>.raw.jsonl       —— 每次 run 的 StartupReport JSON
# 2. <out>.summary.json    —— 聚合 p50 / p90 / p99 / mean / stdev
# 3. <out>.report.md       —— Markdown 表，含 t-test（如指定 baseline）
```

**关键细节**：

- 设置 `QWEN_HOME=<fixture>/.qwen` + `HOME=<fixture>` 隔离每次运行的状态。
- 设置 `cwd: fixture.dir` 让 fixture 中 MCP server 配置的相对路径解析正确。
- 不传 `--bare`（bare 模式会 `skipDiscovery: true` 跳过 MCP discovery，使 MCP 相关 fixture 失效）。
- 当前实现走非交互路径（`--prompt noop`）；交互专属指标（`first_paint` / `input_enabled`）需后续 `node-pty` 集成。

#### 4 个 fixture 设计

| Fixture           | 描述                                                                        |
| ----------------- | --------------------------------------------------------------------------- |
| `no-mcp`          | 无 MCP 配置，纯 baseline                                                    |
| `one-fast-mcp`    | 1 个本地 echo MCP server，<200ms 响应                                       |
| `three-mixed-mcp` | 3 个 server：2 快 + 1 故意 sleep 1500ms（每请求）的慢 server，总计约 6s/run |
| `flaky-mcp`       | 1 个 timeout 的 server（验证不阻塞，且不污染快 server 工具集）              |

Fixture 配置存放：`docs/design/first-screen-performance-optimization/fixtures/<name>/.qwen/settings.json`；echo server 实现在 `fixtures/_servers/echo-mcp.mjs`。

### 5.7 文件改动清单

- `packages/cli/src/utils/startupProfiler.ts` —— 增加 events / interactiveMode / outerProcess / heap / derived phases / 后 finalize 锁定。
- `packages/core/src/utils/startupEventSink.ts` —— **新增**，跨包事件桥。
- `packages/core/src/index.ts` —— export sink + recordStartupEvent。
- `packages/cli/src/gemini.tsx` —— `setStartupEventSink()` 注册、`first_paint` 埋点、非交互路径在 `config.initialize()` 后 finalize、`setInteractiveMode(true)` 调用。
- `packages/cli/src/ui/AppContainer.tsx` —— `config_initialize_start/end` + `input_enabled` checkpoint + finalize（交互路径）。
- `packages/core/src/config/config.ts` —— `tool_registry_created` 事件。
- `packages/core/src/tools/mcp-client-manager.ts` —— `mcp_discovery_start` / `mcp_server_ready:<name>` / `mcp_first_tool_registered` / `mcp_all_servers_settled` 事件。
- `packages/core/src/core/client.ts` —— `gemini_tools_updated` 事件。
- `scripts/benchmark-startup.mjs` —— **新增**，benchmark 脚本（含 Welch's t-test）。
- `docs/design/first-screen-performance-optimization/fixtures/` —— **新增** 4 fixture + echo server。
- `docs/design/first-screen-performance-optimization/baseline-data/` —— **新增** baseline 数据。

### 5.8 验证

```bash
# 启用 profiler 并跑一次 sandbox 启动
QWEN_CODE_PROFILE_STARTUP=1 SANDBOX=1 node packages/cli/dist/index.js --prompt "test"

# 检查 ~/.qwen/startup-perf/<timestamp>-<sessionId>.json 应包含：
#   interactiveMode: true | false
#   outerProcess: false
#   phases:    [..., main_entry, after_load_settings, ..., before_render, first_paint, config_initialize_start, config_initialize_end, input_enabled]
#   events:    [{name: "mcp_server_ready:foo", tMs}, {name: "mcp_all_servers_settled", tMs}, {name: "gemini_tools_updated", tMs}]
#   derivedPhases:     {module_load, settings_time, ..., total}

# 跑 benchmark 端到端
scripts/benchmark-startup.mjs --fixture no-mcp --runs 5 --out /tmp/test-baseline
cat /tmp/test-baseline.report.md
```

测试覆盖（PR0+1 已通过）：

- `packages/cli/src/utils/startupProfiler.test.ts` —— 18 tests（原 11 + 新增 7：events / 后 finalize 锁定 / interactiveMode / derivedPhases / heap on-off / OUTER opt-in）。
- `packages/core/src/utils/startupEventSink.test.ts` —— 4 tests（noop / forward / 异常隔离 / null 重置）。
- 其余 mcp-client-manager / config / client / 全工程：2584 tests 全绿。

---

## 6. PR2 — 异步并行 Settings 加载

> **目标**：把启动主路径上的 settings 装载从串行 `fs.readFileSync` 改为并行 `fs.promises.readFile`，预计 `after_load_settings` 阶段下降 30-50%。
>
> **强约束**：保留同步 `loadSettings()` 给命令、设置对话框、测试继续使用；本 PR 只改启动主路径的 1 个调用点。

### 6.1 现状

`packages/cli/src/config/settings.ts:810` 起的 `loadSettings()`：

- 完全同步，串行 `fs.readFileSync` 4-5 个文件（system / system-defaults / user / workspace + folder trust）。
- 内含丰富副作用：JSON 恢复（`.orig` 备份）、损坏文件重命名、migration 持久化、`loadEnvironment()` 调用、theme name 兼容（`VS → DefaultLight` 等）、trust check。
- 被启动主路径（`gemini.tsx:376-378`）、命令、设置对话框、测试大量调用。

### 6.2 设计

#### 接口

```ts
// packages/cli/src/config/settings.ts

// 新增：异步并行加载
export async function loadSettingsAsync(
  workspaceDir: string,
): Promise<LoadedSettings>;

// 保留：同步 wrapper（用于命令、设置对话框、测试）
export function loadSettings(workspaceDir: string): LoadedSettings;

// 抽出的纯 I/O 层（内部，二者复用）
async function readAllSettingsFilesAsync(paths): Promise<RawSettingsBundle>;
function readAllSettingsFilesSync(paths): RawSettingsBundle;
```

#### 副作用顺序保证

**严格不变**：

1. 文件路径解析 → 并行 / 串行读 → 各自损坏文件 `.orig` 备份恢复 → `JSON.parse` → 各自 migration → mergeWith 合并 → trust check → `loadEnvironment(merged)` → theme name 兼容。
2. `loadEnvironment()` **必须**在 merged settings 形成后调用（不可在并行读阶段提前）。
3. migration 仍只跑一次，且写回顺序与现行一致。

#### 启动主路径改动

```ts
// gemini.tsx:376-380 (改动后)
profileCheckpoint('main_entry');
const settings = await loadSettingsAsync(workspaceDir); // 仅此一处改 await
profileCheckpoint('after_load_settings');
```

其他所有 `loadSettings(...)` 调用点**不动**，行为完全一致。

### 6.3 实现要点

#### 损坏文件并行读的兜底

并行读时每个 `readFile()` 失败可能源于：

- 文件不存在（正常，跳过）。
- JSON 损坏（按现行 `.orig` 备份策略处理，本文件视为缺失）。
- I/O 错误（保留现行错误冒泡行为）。

**关键**：每个文件的 `.orig` 备份操作是独立的，**可在 readFile rejection handler 内同步触发**，不引入并发竞争（不同文件路径互不重叠）。备份用 `O_EXCL` flag 避免多进程并发覆盖。

#### 测试基线

新增单测 `settings.test.ts`：

- `loadSettingsAsync` 与 `loadSettings` 对相同输入产生**完全一致**的 `LoadedSettings`。
- 损坏 user.json 场景：两个 API 都把损坏文件备份为 `.orig` 并继续。
- migration 场景：两个 API 都把 migration 写回，且只写一次。
- 并发：同时调用 `loadSettingsAsync` 两次，结果一致；`.orig` 备份不重复创建。

### 6.4 风险与回退

| 风险                                                     | 应对                                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 低端机磁盘抖动下，并行 readFile 反而比串行慢（内核竞争） | benchmark 在 macOS / Linux / Linux+slow-disk fixture 上各跑 30 次，p50 退化 > 5% 拒绝合并。 |
| `.orig` 备份并发创建（多进程同时启动）                   | `O_EXCL` flag 避免覆盖；多进程并发时一方 EEXIST，另一方继续。                               |
| migration 写回顺序在异步路径下与同步路径不同             | `runMigrations()` 内部本身串行；异步路径只并行**读**阶段，migration 写回阶段不变。          |
| 调用方误把异步 wrapper 当同步用                          | 静态：函数签名 `Promise<>`；动态：`@deprecated` 注释 sync 版本。                            |

**回退**：单 commit revert 即恢复同步路径。如果发现回归，可临时加环境变量 `QWEN_CODE_LEGACY_SYNC_SETTINGS=1` 强制走同步分支（兜底，PR 默认不引入）。

### 6.5 验证

```bash
scripts/benchmark-startup.mjs --fixture no-mcp --runs 30 --out /tmp/pr2-after \
  --baseline docs/design/first-screen-performance-optimization/baseline-data/no-mcp.summary.json
```

**期望**：

- `after_load_settings` (p50): -30~50%
- t-test p < 0.05
- `processUptimeAtT0Ms` 不退化（PR2 不动 module load）
- 其他指标不退化 > 5%

---

## 7. PR3 — initializeApp 并行化 + 入口延迟加载

> **目标**：把启动主路径的"i18n / config / auth / IDE / Kitty / startup warnings" 从串行 await 改为有依赖图的并行执行；把交互 UI 模块从静态 import 改为 `if (isInteractive) await import(...)` 的动态加载。

### 7.1 现状

`packages/cli/src/core/initializer.ts:33-66` 的 `initializeApp(config, settings)`：

```ts
async function initializeApp(config, settings) {
  await initializeI18n(settings.merged);   // 仅依赖 settings
  await performInitialAuth(config, ...);   // 依赖 config
  validateTheme(settings);                 // sync
  if (ideMode) await ideClient.connect();  // 依赖 config
}
```

可优化点：

- `initializeI18n` 只依赖 `settings.merged`，**不**依赖 `config`，可与 `loadCliConfig()` **并行**。
- `performInitialAuth` 依赖 `config`，必须等 config 完成。
- `getStartupWarnings` / `getUserStartupWarnings` / `detectKittyProtocol` 与 auth 无依赖，可并行。

### 7.2 设计

#### A. initializeApp 拆分 + 与 loadCliConfig 并行

```ts
// gemini.tsx (改动后简化)

// Step A: i18n 与 loadCliConfig 并行
const [config, _i18n] = await Promise.all([
  loadCliConfig(settings.merged, argv, ...),
  initializeI18n(settings.merged),
]);
profileCheckpoint('after_load_cli_config');

// Step B: config 就绪后，auth + warnings + kitty + theme validation 并行
validateTheme(settings);
const [authResult, startupWarnings, userWarnings, kittyEnabled, ideResult] =
  await Promise.allSettled([
    performInitialAuth(config, authType),
    getStartupWarnings(),
    getUserStartupWarnings(settings),
    detectKittyProtocol(),
    ideMode ? ideClient.connect() : Promise.resolve(),
  ]);
profileCheckpoint('after_initialize_app');
```

`initializeApp()` 函数签名改为返回各组件（而非吞掉），让 caller 控制并行：

```ts
// core/initializer.ts (改动后)

export async function initializeI18nIfNeeded(settings): Promise<void> { ... }
export async function performInitialAuthAndValidate(config, authType): Promise<AuthResult> { ... }
export async function connectIdeIfEnabled(config): Promise<void> { ... }

// 保留旧 initializeApp 作为 backward-compat wrapper（内部并行）
// 但启动主路径不再调用它
```

#### B. 入口动态 import 交互 UI

```ts
// gemini.tsx (改动后简化)

if (config.isInteractive()) {
  const { startInteractiveUI } = await import('./interactiveCli.js');
  await startInteractiveUI({ config, settings, ... });
} else {
  // 非交互路径：完全不加载 Ink / AppContainer / themes / hooks
  await runHeadless({ config, settings, prompt: argv.prompt, ... });
}
```

新建 `packages/cli/src/interactiveCli.ts`：

```ts
import { render } from 'ink';
import { AppContainer } from './ui/AppContainer.js';
// 其他重量 UI 模块都集中在此

export async function startInteractiveUI(opts): Promise<void> {
  const { rerender, cleanup } = render(<AppContainer {...opts} />);
  profileCheckpoint('first_paint');
  // ...
}
```

esbuild 配置开启 `splitting: true`（参考 Gemini `esbuild.config.js:89`），让 `interactiveCli.ts` 成为独立 chunk，主入口 chunk 不含 Ink。

#### C. module-eval 时启动后台 prefetch（借鉴 Claude）

`packages/cli/index.ts` 顶层（早于 main()）：

```ts
// index.ts 顶层
import {
  initStartupProfiler,
  profileCheckpoint,
} from './src/utils/startupProfiler.js';
initStartupProfiler();
profileCheckpoint('main_entry');

// fire-and-forget prefetch (Claude 风格)
// 已存在：apiPreconnect()
// 新增：可考虑 git branch detect、IDE socket probe
import { startGitBranchPrefetch } from './src/utils/gitBranchPrefetch.js';
startGitBranchPrefetch(); // 在后台读 .git/HEAD，AppContainer 后续直接拿结果

// ...其他 imports
const { main } = await import('./src/gemini.js');
```

**注意**：本 PR 只引入**廉价**的 prefetch 候选。任何 prefetch 必须 (a) 失败安静、(b) 不阻塞主路径、(c) 实测有收益。

### 7.3 风险与回退

| 风险                                                                       | 应对                                                                                                                                              |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initializeI18n` 失败时 `loadCliConfig` 已部分进行，错误信息可能用错语言   | i18n 失败兜底用英文；`loadCliConfig` 在 i18n 完成前不打印用户级错误（已是当前行为）。                                                             |
| `performInitialAuth` 与 `getStartupWarnings` 并行时，auth 错误打印顺序变化 | startup warnings 收集为 array，由 UI 层在 first_paint 后统一渲染；不依赖打印顺序。                                                                |
| 动态 import `interactiveCli.js` 引入额外 round-trip，反而拉长 first_paint  | benchmark：动态 import 与静态 import 的 first_paint 对比；esbuild `splitting: true` + `format: esm` 下，本地 chunk 加载约 2-5ms，不应可观察到回归 |
| 非交互路径在 `runHeadless` 内仍误 import UI 模块（破坏 lazy chunk）        | bundle analyzer 截图作为 PR 证据：headless chunk 不应含 `ink/`、`AppContainer`、`themes/`。`scripts/check-bundle-leakage.mjs` 自动校验。          |
| ACP / 测试 harness / 子命令路径行为变化                                    | 集成测试 `integration-tests/cli/*.test.ts` 全部跑通；ACP 入口若在另一文件，独立审计。                                                             |
| `connectIdeIfEnabled` 失败被 `Promise.all` 触发短路                        | 用 `Promise.allSettled` 而非 `Promise.all`，逐一处理失败；warnings 收集到 array。                                                                 |

**回退**：单 commit revert：动态 import 改回静态 import。并行化部分用 `QWEN_CODE_LEGACY_SERIAL_INIT=1` 兜底（暂不引入，仅在出现回归时考虑加）。

### 7.4 验证

```bash
# 性能
scripts/benchmark-startup.mjs --fixture no-mcp --runs 30 --out /tmp/pr3-after \
  --baseline docs/design/first-screen-performance-optimization/baseline-data/no-mcp.summary.json

# Bundle 分析
node scripts/check-bundle-leakage.mjs --bundle dist/cli.js --headless-chunk dist/headless.js
npx source-map-explorer dist/cli.js
npx source-map-explorer dist/interactiveCli.*.js
```

**期望**：

- `processUptimeAtT0Ms` (p50): 显著下降（动态 import 减少 module-eval）
- `before_render` (p50): -200~400ms (并行化)
- `first_paint` (p50): -150~300ms
- 非交互模式：headless_bundle_size 不含 Ink / AppContainer / themes

---

## 8. PR4 — 渐进式 MCP 可用性

> **目标**：让 UI 出现后**不被慢 MCP server 阻塞**，单 server discover 完成即把工具暴露给模型；首工具可见时间从"等所有 server settle"降到"最快 server 响应时间"。
>
> **关键决策（来自 Round 2）**：把原方案的 100ms debounce 改为 **16ms batch flush**（一帧合并），借鉴 Claude Code `useManageMCPConnections.ts:207` 的 `MCP_BATCH_FLUSH_MS = 16`。

### 8.1 现状

`packages/core/src/tools/mcp-client-manager.ts:84-141` 的 `discoverAllMcpTools()` 用 `await Promise.all(discoveryPromises)` 等所有 server settle，慢 server 拖延整体 discovery state、初始化完成语义和 UI 反馈。`McpClient.discover()` 完成时即注册到 ToolRegistry，但 `GeminiClient.setTools()` 不会自动刷新。

### 8.2 已存在的可复用原语

仓库里已经存在但**未接入交互式启动主路径**的增量基础设施：

- `McpClientManager.discoverAllMcpToolsIncremental()`（`mcp-client-manager.ts:439`）—— 增量发现入口，不全清工具。
- `McpClientManager.discoverMcpToolsForServer(serverName, cliConfig)`（`mcp-client-manager.ts:149-172`）—— 单 server 重发现（带 promise dedup）。
- `ToolRegistry.removeMcpToolsByServer(serverName)`（`tool-registry.ts:318`）—— per-server 工具清理。
- `Config.createToolRegistry({ skipDiscovery: true })` —— 创建 registry 时跳过 MCP discovery。
- `GeminiClient.setTools()`（`client.ts:348-357`）—— 热刷新 tools declaration。

PR4 主要是**把这些原语接入主路径**，并补齐：单 server ready 事件、16ms batch flush、discovery vs tool-call timeout 拆分、UI 文案。

### 8.3 设计

#### 启动主路径改动

```ts
// packages/core/src/config/config.ts (Config.initialize 简化)

async initialize() {
  // 步骤 1: 内置工具与 prompt registry 立刻就绪
  this.toolRegistry = await this.createToolRegistry({ skipDiscovery: true });
  recordStartupEvent('tool_registry_created', { ... });

  // 步骤 2: file / git / extensions / hooks 等同步 / 异步初始化
  // ... (不变)

  // 步骤 3: MCP 渐进发现 —— fire-and-forget
  this.startMcpDiscoveryInBackground();

  this.initialized = true;
}

private startMcpDiscoveryInBackground() {
  const manager = this.toolRegistry.getMcpClientManager();
  void manager.discoverAllMcpToolsIncremental(this).catch((err) => {
    logError('MCP background discovery failed', err);
  });
}
```

#### `discoverAllMcpToolsIncremental` 边界对齐

确保 incremental 入口具备：

- **per-server 原子替换**：`removeMcpToolsByServer(name) → connect → discover → register`。任意环节失败时**不动**其他 server 工具。
- **每 server ready 触发**：`coreEvents.emit(CoreEvent.ToolRegistryChanged, { serverName })`，附带 `mcp_server_ready:<name>` profiler 事件。
- **首工具事件**：在第一次成功 register 工具时 emit `mcp_first_tool_registered`（一次性，全局守卫）。
- **整体 settled**：`Promise.allSettled(discoveryPromises)` 完成后 emit `mcp_all_servers_settled`。
- **timeout 拆分**：每个 server 用 `Promise.race(discover(), timeout(discoveryTimeoutFor(config)))`；默认 discovery timeout 降至 **30s**（可被 server 配置覆盖）；tool-call timeout 沿用 `MCP_DEFAULT_TIMEOUT_MSEC`。
- **claude.ai 风格的远端短上限**：远端 transport（HTTP/SSE）使用 5s 默认 discovery timeout。

#### 16ms batch flush（CLI 端订阅）

```ts
// packages/cli/src/ui/AppContainer.tsx 简化

const MCP_BATCH_FLUSH_MS = 16;

useEffect(() => {
  if (!configInitialized) return;

  let pendingServers = new Set<string>();
  let flushTimer: NodeJS.Timeout | null = null;

  const flush = async () => {
    flushTimer = null;
    if (pendingServers.size === 0) return;
    pendingServers.clear();
    await config.getGeminiClient().setTools();
    // recordStartupEvent('gemini_tools_updated', { ... }) emitted by setTools
  };

  const onServerReady = ({ serverName }) => {
    pendingServers.add(serverName);
    if (flushTimer === null) {
      flushTimer = setTimeout(flush, MCP_BATCH_FLUSH_MS);
    }
  };

  coreEvents.on(CoreEvent.ToolRegistryChanged, onServerReady);
  return () => {
    coreEvents.off(CoreEvent.ToolRegistryChanged, onServerReady);
    if (flushTimer) clearTimeout(flushTimer);
  };
}, [config, configInitialized]);
```

**为什么 16ms 而不是 100ms**（详见 § 3.2 Round 2）：

- 16ms 约等于一帧（60fps）。3 个 server 在几十 ms 内陆续 ready，会被合并为 1 次 `setTools()` 调用，UI 不抖动；100ms 在快速场景下让模型多等 100ms。
- Claude `useManageMCPConnections.ts:207` 实战验证。

#### 进行中模型请求的工具集合冻结

`GeminiClient.setTools()` 调用时若有进行中的请求：不修改进行中请求的工具集合（`getChat().setTools()` 只影响后续 `sendMessage`）。当前代码已经是这个语义；测试中显式断言。

#### UI 进度展示

`AppContainer` + `ConfigInitDisplay` 已有 `connected/total` 进度。PR4 扩展：

- `mcp-client-update` 事件订阅延伸到 `configInitialized = true` 之后（不仅 init 阶段）。
- `ConfigInitDisplay` 在初始化完成后切换为内联状态条："3/5 MCP 工具已加载，2 个仍在连接…"（仅在仍有 server 未 settled 时显示）。

### 8.4 风险与回退

| 风险                                                                     | 应对                                                                                                                                               |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| per-server replace 中途失败（connect ok 但 discover 失败），导致工具空窗 | 替换流程：先暂存当前 server 工具到临时 array，连接 + discover 全部成功后才 commit；失败时还原临时 array。`removeMcpToolsByServer` 仅在成功路径调用 |
| 进行中的 model 请求中途工具集合变化                                      | `setTools()` 只影响后续 sendMessage；当前 chat 实例的工具集合不变；测试断言用 spy 验证                                                             |
| timeout 降到 30s 在网络慢的环境误判失败                                  | 保留 user-level 配置 `mcpServers.<name>.discoveryTimeoutMs`；只缩短**默认**值；UI 显示哪些 server 因超时降级                                       |
| MCP server 配置在运行期变化（用户手动改 `~/.qwen/qwen.json`）            | 不在本 PR 范围（运行期 refresh 路径归后续 PR）；本 PR 文档明确"配置变化需重启生效"                                                                 |
| `setTools()` 在 `configInitialized = true` 但 GeminiClient 尚未实例化    | `setTools()` 内部已有 guard；订阅器在 `configInitialized && client` 双条件后挂载                                                                   |
| 16ms flush 在大量 server 同时 ready 时 UI 抖动                           | flush 是合并的，pending 集合保证 N 次 ready → 1 次 setTools；UI 进度组件 throttle 到自己的 60fps                                                   |

**回退**：用 env var `QWEN_CODE_LEGACY_MCP_BLOCKING=1` 兜底，强制走 `discoverAllMcpTools`（同步等所有 settle）。默认不开。单 commit revert：把 `Config.initialize` 中的 `skipDiscovery` 改回 false，删除 batch flush 订阅。

### 8.5 验证

```bash
scripts/benchmark-startup.mjs --fixture three-mixed-mcp --runs 30 --out /tmp/pr4-after \
  --baseline docs/design/first-screen-performance-optimization/baseline-data/three-mixed-mcp.summary.json
```

**期望**：

- `mcp_first_tool_registered` (p50): < 2s（最快 server 响应时间）
- `gemini_tools_lag` (p50): **≤ 16ms**（PR0+1 baseline 是 6425ms —— 100x 改善）
- `mcp_all_servers_settled`: 不退化（仍约 6s，等慢 server）
- `first_paint` / `input_enabled`: 不退化（已经是 PR3 的优化目标）

#### 行为验证

| 场景                           | 期望                                                                |
| ------------------------------ | ------------------------------------------------------------------- |
| `no-mcp`                       | 路径不退化，无任何 MCP 相关 overhead                                |
| `one-fast-mcp`                 | `mcp_first_tool_registered` ≈ server 响应时间；下次模型请求看见工具 |
| `three-mixed-mcp`              | 快 server 工具立刻可用，慢 server 在 ~6s 后 ready；进度条显示 N/M   |
| `flaky-mcp` (1 个 timeout)     | 30s 后 server 标 failed；不影响其他 server 工具；模型可用其他工具   |
| `three-mixed-mcp` 中途模型请求 | 进行中的请求不变；下一次请求看到更新工具集                          |
| 网络极慢                       | UI 提示 "MCP server X 仍在连接（已等 25s）"；用户可继续使用其他工具 |

### 8.6 与运行期 MCP refresh 的边界（明确不做项）

本 PR **不涉及**：

- `ExtensionManager.refreshMemory()` / `refreshTools()` / `restartMcpServers()` 的全量重启路径。
- `/reload-plugins`、技能 / 扩展刷新、设置变更后的工具刷新。
- ToolListChanged / PromptListChanged / ResourceListChanged 等运行期事件。

这些归运行期 MCP refresh 路径增量化，是后续 PR 系列的工作。

---

## 9. 灰度、回滚与副作用审计

> 本节是所有 PR 的"安全网"。任何 PR 提交前都应自验证已对照本清单。

### 9.1 灰度策略

#### PR2 (loadSettingsAsync)

- **默认开启**：启动主路径直接 await 异步版本。
- **兜底 env var**：暂不引入。如果测得回归 > 5%，PR 先回滚再加开关。
- **影响范围限定**：仅 `gemini.tsx` 启动主路径调用点改动；命令、设置对话框、测试不变。

#### PR3 (并行化 + 入口动态 import)

- **默认开启**：并行化 + 动态 import 直接生效。
- **兜底 env var**：暂不引入；若回归再考虑。
- **bundle 校验**：CI 在 PR 中跑 `scripts/check-bundle-leakage.mjs`，失败即拒绝合入。

#### PR4 (渐进式 MCP)

- **默认开启**：`Config.initialize` 中走 `skipDiscovery: true` + 后台 incremental discovery。
- **兜底 env var**：`QWEN_CODE_LEGACY_MCP_BLOCKING=1` —— 走旧的 `discoverAllMcpTools` 同步等所有 settle 路径。**保留至少 1 个 release，再考虑删除**。
- **discovery timeout 默认值**：本地 stdio 30s、远端 HTTP/SSE 5s；通过 server 配置覆盖。

#### 跨 PR 的整体灰度

- 每个 PR 独立合入 main 后跑 1 轮 nightly CI（`benchmark-startup.mjs` 全 fixture），观察是否有意外回归。
- PR4 合入后做一次"全链路"测试：所有改动启用，与 PR0+1 baseline 对照，验证累积改善符合 § 1.3 的目标区间。
- 任何 PR 出现累积回归（即使单 PR 通过 t-test）都触发回滚审议。

### 9.2 回滚条件

| PR  | 触发回滚条件                                                                                       | 回滚操作                                                                                |
| --- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| PR1 | profiler 影响实测指标（Heisenberg 效应 > 5%）                                                      | 回退 `startupProfiler.ts` 的 `recordEvent` 实现，仅保留原 checkpoint                    |
| PR2 | 任何 fixture 下 `after_load_settings` p50 退化 > 5%；或 settings migration / 损坏文件兜底回归      | revert 启动主路径 `gemini.tsx:376-378` 的 await 调用，回到同步 `loadSettings()`         |
| PR3 | `processUptimeAtT0Ms` 或 `first_paint` 退化；headless bundle 含 Ink；ACP / 子命令行为变化          | revert 入口动态 import；并行化保留（独立 commit）；bundle 校验失败必 revert             |
| PR4 | 进行中 model 请求工具集合突变；per-server replace 中途破坏其他工具；`mcp_all_servers_settled` 退化 | env var `QWEN_CODE_LEGACY_MCP_BLOCKING=1` 启用 + 提交回滚 PR；保留 incremental 原语本身 |

每个 PR **必须**支持单 commit revert（除工具更新外不依赖其他改动）。

### 9.3 副作用 / 回归审计清单

#### PR1（observability）

| 副作用候选                                  | 验证方式                                                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| profiler 采集本身影响测得指标（Heisenberg） | 对比 `QWEN_CODE_PROFILE_STARTUP=0` 与 `=1` 两个状态下的总耗时；目标差异 < 1%                             |
| `coreEvents` emit 在未订阅时仍有成本        | benchmark 跑 `QWEN_CODE_PROFILE_STARTUP=0`（profiler 关闭、emit 仍执行）下与 main HEAD 等价（< 1% 噪声） |
| `recordEvent` 触发 GC                       | profiler 的 events array 用预分配；finalize 时一次性写盘                                                 |
| sandbox 父子进程双写 profile                | 文件名带 `outer-` / sandbox-child 区分；测试覆盖父进程开 OUTER 标记 + 子进程默认                         |
| 内存快照成本                                | `process.memoryUsage()` 实测约 < 50µs；每个 checkpoint 调用一次可接受；`NO_HEAP=1` 兜底                  |

#### PR2（loadSettingsAsync）

| 副作用候选                                           | 验证方式                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| 损坏 user.json 在异步路径下与同步路径行为不一致      | 单测：故意写损坏 JSON，期望两个 API 都生成 `.orig` 备份并继续                   |
| migration 写回顺序变化                               | 单测：spy `runMigrations()`，期望调用顺序不变                                   |
| `loadEnvironment()` 在并行读阶段提前执行             | 单测：spy `loadEnvironment`，期望在 merged settings 形成后调用                  |
| 多进程并发启动时 `.orig` 备份竞争                    | 单测：双进程同时启动 + 写损坏 user.json；期望一方备份成功，另一方 EEXIST 后继续 |
| 命令、设置对话框、测试调用 `loadSettings()` 行为变化 | 集成测试 `integration-tests/cli/settings-migration.test.ts` 全绿                |
| 低端机磁盘抖动下并行 readFile 反而更慢               | benchmark 跑 macOS APFS / Linux ext4 / Linux+slow-disk fixture，p50 不退化 > 5% |

#### PR3（并行化 + 入口动态 import）

| 副作用候选                                                  | 验证方式                                                                           |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `initializeI18n` 失败时错误信息用错语言                     | 单测：故意让 i18n 失败，期望英文兜底文案；config 不读 i18n 状态                    |
| `Promise.all` 一项 reject 触发短路                          | 改用 `Promise.allSettled`，失败收集到 `startupWarnings` array                      |
| `connectIdeIfEnabled` 失败影响 auth                         | `Promise.allSettled` 隔离；UI 层显示 IDE 连接失败 warning，不阻塞输入              |
| 动态 import `interactiveCli.js` round-trip 拉长 first_paint | benchmark 对比静态 vs 动态 import，p50 差异 < 5ms                                  |
| 非交互 / headless / ACP / 子命令 bundle 误带 Ink            | `scripts/check-bundle-leakage.mjs` CI 校验；`source-map-explorer` 截图作为 PR 证据 |
| ACP 入口（`packages/cli/src/acp-integration/...`）行为变化  | ACP 集成测试全绿                                                                   |
| esbuild `splitting: true` 在 Node 上加载 chunk 失败         | `format: esm` + `outdir` 配置 + Node ≥ 20.6（package.json engines 已限制）         |
| module-eval 顶层 prefetch 失败时影响主路径                  | 所有 prefetch fire-and-forget + `.catch(noop)`；不持有任何主路径需要的 promise     |

#### PR4（渐进式 MCP）

| 副作用候选                                                | 验证方式                                                                      |
| --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| per-server replace 中途失败导致工具空窗                   | 单测：mock `client.discover` 失败，期望保留旧工具（如有）或始终有内置工具     |
| 进行中 model 请求工具集合突变                             | 单测：spy `chat.setTools`，期望进行中的 chat 实例不被影响                     |
| 慢 server timeout 后 register 工具的延迟回写              | timeout 后 `client` 状态置 `failed`，丢弃后续 register 调用                   |
| 16ms batch flush 在大量 server ready 时 UI 抖动           | 单测：30 个 ready 事件在 100ms 内陆续 fire，期望 ≤ 7 次 setTools 调用         |
| `setTools()` 在 GeminiClient 未实例化时调用               | 订阅器在 `configInitialized && config.getGeminiClient()` 双条件后挂载         |
| MCP server 配置在运行期变化（用户改 `~/.qwen/qwen.json`） | 不在本 PR 范围；文档明确"配置变化需重启生效"                                  |
| 默认 30s discovery timeout 在网络慢的环境误判失败         | 保留 `mcpServers.<name>.discoveryTimeoutMs` 配置；UI 显示哪些 server 超时降级 |
| ToolRegistryChanged 事件订阅泄漏                          | `useEffect` cleanup 中 `coreEvents.off`；测试覆盖 unmount                     |

### 9.4 接口 / 配置兼容性

| 项                                            | PR  | 兼容性                                                                                  |
| --------------------------------------------- | --- | --------------------------------------------------------------------------------------- |
| `loadSettings()` 同步签名                     | PR2 | 不变；新增 `loadSettingsAsync()` 与之并存                                               |
| `LoadedSettings` 类型                         | PR2 | 不变                                                                                    |
| `initializeApp()` 函数签名                    | PR3 | 拆为更小函数；保留 backward-compat wrapper（内部并行）；启动主路径不再调它              |
| `AppContainer` 静态 import                    | PR3 | 不再被入口直接 import；其他文件如有 import，需确认在 `interactiveCli.ts` 内或独立 chunk |
| `Config.createToolRegistry` 接口              | PR4 | `skipDiscovery` 已存在；不动                                                            |
| `McpClientManager.discoverAllMcpTools()` 接口 | PR4 | 不动；新增 `discoverAllMcpToolsIncremental()` 已存在；只 emit 新事件                    |
| `MCPDiscoveryState` 枚举                      | PR4 | 不变                                                                                    |
| `mcpServers.<name>.discoveryTimeoutMs` 配置项 | PR4 | **新增**；不存在时用默认（stdio 30s / remote 5s）                                       |
| `QWEN_CODE_LEGACY_MCP_BLOCKING` env var       | PR4 | **新增**兜底；保留至少 1 个 release                                                     |
| `QWEN_CODE_PROFILE_STARTUP_OUTER` env var     | PR1 | **新增**；允许在非 sandbox 路径下采集（带 `outer-` 前缀文件名）                         |
| `QWEN_CODE_PROFILE_STARTUP_NO_HEAP` env var   | PR1 | **新增**；用于 Heisenberg 测量与超低端硬件场景                                          |

### 9.5 用户文档更新

| PR  | 文档                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| PR1 | `docs/users/configuration/environment-variables.md` 增加 `QWEN_CODE_PROFILE_STARTUP_OUTER`                                               |
| PR2 | 不需要（用户不可见）                                                                                                                     |
| PR3 | `docs/developers/...` 简短说明 entry chunk 拆分                                                                                          |
| PR4 | `docs/users/features/mcp.md` 解释渐进式可用、`mcpServers.<name>.discoveryTimeoutMs` 配置项；`QWEN_CODE_LEGACY_MCP_BLOCKING` 临时兜底说明 |

### 9.6 PR 描述统一模板（强约束）

每个实施 PR 的描述**必须**包含：

```markdown
## 改动范围

- ...

## 指标对照 (fixture × N=30, Welch's t-test)

| 指标 | Fixture | Baseline p50 / p90 | After p50 / p90 | Δp50 (ms) | Δp50 (%) | t-test p | 结论        |
| ---- | ------- | ------------------ | --------------- | --------- | -------- | -------- | ----------- |
| ...  | ...     | ...                | ...             | ...       | ...      | ...      | 通过 / 拒绝 |

详细数据见 `docs/design/first-screen-performance-optimization/baseline-data/<pr-name>.{summary,raw}.{json,jsonl}`.

## 副作用审计

- 已验证: <对照 § 9.3 清单>
- 未触发 / 不在范围: ...

## 回滚

- 单 commit revert: <sha>
- 影响其他已合并 PR: 否
- 兜底 env var (如有): `<NAME>=1` → 行为
```

### 9.7 CI 集成

PR0+1 同时引入：

- `scripts/perf-thresholds.json`（PR1 后期）：每个指标在每个 fixture 下的告警阈值（基于 PR0+1 baseline + 5% 安全余量）。
- `.github/workflows/nightly-perf.yml`（PR1 后期）：nightly 跑 `benchmark-startup.mjs --fixture no-mcp --runs 30`，超阈值告警。
- `scripts/check-bundle-leakage.mjs`（PR3 引入）：PR3 起在 PR CI 中跑（headless chunk 不应含 Ink）。

---

## 10. 验证框架（统计方法学）

### 10.1 样本数与显著性

- **样本数**：每场景 ≥ 30 次（每次冷启动，清 V8 cache）。
- **显著性**：使用 Welch's t-test，p < 0.05 才认定有效改善；同时 p50 改善幅度需满足：
  - 绝对改善 ≥ **50ms**，**或**
  - 相对改善 ≥ **10%**，
  - 取较大者为有效（避免在统计噪声下声明胜利）。
- **方向性安全**：任何场景下若 p50 退化超过 **5%**，PR 拒绝合并（除非有补偿性的更大改善并被显式接受）。

### 10.2 双向 t-test（warn-on-regression）

PR2-4 每次跑 benchmark 必须输出表格：

| 指标 | Fixture | Baseline p50 / p90 | After p50 / p90 | Δp50 (ms) | Δp50 (%) | t-test p | 结论        |
| ---- | ------- | ------------------ | --------------- | --------- | -------- | -------- | ----------- |
| ...  | ...     | ...                | ...             | ...       | ...      | ...      | 通过 / 拒绝 |

工具：基准脚本（`scripts/benchmark-startup.mjs`）输出 JSON 后内置 Welch's t-test 计算（含 Lentz's method 的 incomplete beta + Lanczos lnGamma 实现）。

### 10.3 回归保护

- PR1 落地后 nightly CI 跑 `scripts/benchmark-startup.mjs --fixture no-mcp --runs 30`，超过阈值告警（阈值放在 `scripts/perf-thresholds.json`）。
- 历史趋势保存到 `~/.qwen/startup-perf/` 目录，最多 100 条，便于趋势回溯。

### 10.4 端到端流程

PR0+1 合并后，整体路径如下：

1. PR1 实现观测，跑出 baseline (4 fixture × 30 次)，写入 `baseline-data/`（已完成）。
2. PR2/3/4 各自跑 baseline + after，按 § 9.6 模板提交 PR。
3. PR4 合并完成后，再额外做一次"完整链路"测试：所有改动启用，与 main HEAD baseline 比较，验证累积改善符合 § 1.3 的总体目标。
4. 一次 nightly CI 跑 `benchmark-startup.mjs`，回归阈值通过设置文件可调。

---

## 11. 基线数据摘要

> **提交策略**：仅 `baseline-data/<fixture>.summary.json` 与 `README.md` 入库（每个 summary 含完整 30-sample 数组，是 PR2-4 Welch's t-test 的必要输入）。`raw.jsonl`（每运行的完整 StartupReport，~50KB / 30 runs）与 `report.md`（summary 的可读衍生品）通过 `baseline-data/.gitignore` 排除；需要时本地重跑 benchmark 即可重生。

### 11.1 收集环境

- **Date**: 2026-05-09
- **Branch**: `feat/first-screen-performance-optimization`
- **Node**: v24.15.0
- **Platform**: macOS (`darwin arm64`) —— MacBook M-series
- **Bundle**: `dist/cli.js` (`npm run bundle` 产物)
- **Profiler**: `QWEN_CODE_PROFILE_STARTUP=1` + `SANDBOX=1`（faked sandbox env）
- **Modes**: 两套 baseline，**两种都跑 4 fixture × 30 runs**：
  - **非交互** (`--prompt noop`)：覆盖 `module_load → before_render` + MCP（共享 init 路径）。
  - **交互** (`--interactive` via node-pty)：额外覆盖 `first_paint` / `input_enabled` / `config_initialize_dur`（仅在 AppContainer mount-effect 中才会被记录）。

PR2/3/4 提交时**两套都对照**：PR2/PR3 关注非交互 + 交互；PR4 主要 MCP 指标在交互 baseline 中数量级更大、信号更清晰。

### 11.2 Per-fixture 摘要 (p50, n=30, 单位 ms)

#### 11.2.A 非交互（base path）

| Fixture           | `processUptimeAtT0Ms` | `before_render` | `config_initialize_dur` | `mcp_first_tool` | `mcp_all_settled` | `gemini_tools_lag` |
| ----------------- | --------------------- | --------------- | ----------------------- | ---------------- | ----------------- | ------------------ |
| `no-mcp`          | 449                   | 79              | 24                      | —                | 94                | —                  |
| `one-fast-mcp`    | 459                   | 80              | 264                     | 336              | 336               | 8.8                |
| `three-mixed-mcp` | 462                   | 81              | **6679**                | 335              | **6734**          | **6425**           |
| `flaky-mcp`       | 456                   | 80              | **10045**               | —                | 10100             | —                  |

#### 11.2.B 交互（含 first_paint / input_enabled，n=30 each via node-pty）

| Fixture           | `first_paint` | `input_enabled` | `config_initialize_dur` | `mcp_first_tool` | `mcp_all_settled` | `gemini_tools_lag` |
| ----------------- | ------------- | --------------- | ----------------------- | ---------------- | ----------------- | ------------------ |
| `no-mcp`          | 420           | 480             | 70                      | —                | 469               | —                  |
| `one-fast-mcp`    | 422           | 875             | 464                     | 866              | 866               | 9.9                |
| `three-mixed-mcp` | 423           | **7101**        | **6688**                | 872              | **7077**          | **6235**           |
| `flaky-mcp`       | 413           | **10483**       | **10081**               | —                | 10467             | —                  |

**关键观察**：

- `first_paint` 在所有 fixture 中稳定在 ~420ms —— 因为它在 `config.initialize()` 之前完成（AppContainer 已 mount 但 effect 还没跑）。这正是 qwen-code "UI 早现 + 后台 init" 的设计；PR4 渐进式 MCP 不动这一行，只 PR3 能改善。
- `input_enabled` 与 `config_initialize_dur` 强相关：交互态下 `config.initialize()` 在 mount 后跑，包含 MCP discovery，因此一旦 MCP 慢就直接拖后 input_enabled。
- 交互 vs 非交互：one-fast-mcp 下 `config_initialize_dur` 交互 (464ms) 比非交互 (264ms) 多 200ms —— 说明 React render + AppContainer 副作用与 MCP 子进程 spawn 竞争 cycles。这块有额外优化空间（不在当前 4 个 PR 范围，记入 backlog）。
- `gemini_tools_lag` 6235ms（交互 three-mixed-mcp）—— **PR4 的 16ms batch flush 应把这个降到 ≤16ms（~390x 改善）**。

数据落盘：`baseline-data/<fixture>{,-interactive}.summary.json`。

### 11.2.0 Heisenberg 验证（profiler 自身开销）

`scripts/benchmark-heisenberg.mjs` 跑 3 配置 × 30 samples，全部带 `SANDBOX=1` 隔离 sandbox-relaunch 路径，仅切换 profiler 状态。结果（macOS arm64, Node 24.15）：

| Config             | p50 (ms) | Δ vs off | t-test p | 结论     |
| ------------------ | -------- | -------- | -------- | -------- |
| profiler-off       | 813.6    | —        | —        | baseline |
| profiler-on-noheap | 807.5    | -6.1     | 0.079    | 噪声     |
| profiler-on-heap   | 804.5    | -9.1     | 0.092    | 噪声     |

p > 0.05，无法拒绝零假设，**profiler 开销在统计噪声内**（< 1%）。负号是测量方差，不构成"profiler 反而更快"的可信结论。验证 § 9.3 退出条件通过。

数据落盘：`baseline-data/heisenberg.{summary.json,report.md}`。

> **Foot-gun 提示**：harness 的所有配置必须保留 `SANDBOX=1`。删了 `SANDBOX=1` 的话 cli 会触发真实 sandbox 子进程 spawn（约 +700ms），完全淹没 profiler 开销信号。第一版 harness 没保留这一点，跑出来"profiler-off 比 on 慢一倍"的离谱数字 —— 注释已加进 `benchmark-heisenberg.mjs` 防止再踩。

### 11.2.1 已知现象：`gemini_tools_updated` 在启动期触发两次

baseline trace 中 `gemini_tools_updated` 在间隔约 0.02ms 内触发两次。诊断结果：

1. **第 1 次**：`client.initialize()` → `startChat()` (`client.ts:438`) → `setTools()` —— 初始 chat 带内置工具。
2. **第 2 次**：`SkillTool` 构造器 fire-and-forget 调用 `refreshSkills()` (`tools/skill.ts:98`)，加载完技能后触发 `setTools()` 更新描述。

不是 bug —— 是 SkillTool 异步注册的副作用。**反过来印证 PR4 的 16ms batch flush 是正确选择**：这种"短时间内多次 setTools"的模式在引入 MCP per-server-ready 后会更频繁，batch flush 会自然合并这类调用，避免重复刷新模型 tools declaration。

PR4 落地后期望：`gemini_tools_lag` 仅记录到 1 次 setTools（合并后）。

### 11.3 解读（无决策，仅观察）

- **V8 module-eval (`processUptimeAtT0Ms` ≈ 450ms)** 是单一最大固定成本。PR3（入口动态 import + 冷路径裁剪）直接命中。
- **`before_render` ≈ 80ms** 较小；PR2（loadSettingsAsync）+ PR3（initializeApp 并行化）目标。现实预期上限 30-50ms p50 改善。
- **`config_initialize_dur`** 与 MCP discovery 线性相关：24ms（无 MCP）→ 264ms（1 fast）→ 6.7s（1 slow + 2 fast）→ 10s（1 hung server）。PR4 把这变成 O(fast servers) 而非 O(slowest server)。
- **`gemini_tools_lag`**：在 three-mixed-mcp fixture 中，模型必须等**6.4 秒** —— 这是 PR4 的标志性靶点（100x 改善）。

### 11.4 PR2-4 如何使用此基线

每个 PR 跑同一命令：

```bash
scripts/benchmark-startup.mjs \
  --fixture <name> \
  --runs 30 \
  --out /tmp/<pr>-after \
  --baseline docs/design/first-screen-performance-optimization/baseline-data/<name>.summary.json
```

生成的 `.report.md` 含 Δp50 + Welch's t-test p-value + verdict（improve / regress / noise）。PR 有效仅当：

1. 任何 fixture 下任何指标退化 ≤ 5% p50。
2. PR 声明优化的指标改善 p < 0.05 且 p50 减少 ≥ 10% 或 ≥ 50ms。

详细标准见 § 10。
