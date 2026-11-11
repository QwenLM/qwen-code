# ThreadManager 和 ThreadSession

本目录提供进程内多会话的生命周期、执行编排与能力路由。SDK、ACP、headless 等宿主
负责协议适配；会话运行时负责隔离每个会话的状态、队列、turn 与资源清理。

## 当前边界

- `threadManager.ts` 管理会话注册表、open/resume/fork、close、initialize 与能力路由。
  同一 sessionId 同时只能有一个在世会话；装配期间发生的终止不得丢失，也不得早于
  opened 通知；每个会话的终止只能上报一次。
- `thread-session/threadSession.ts` 装配会话 Config、执行内核、权限通道、Hook、MCP
  与生命周期协作者。会话状态和中止控制器不得改成进程级单例。
- `thread-session/contract/hostContext.ts` 定义 `ThreadHost`、出站事件和
  `ThreadHostRequests`。宿主处理分帧、请求关联、协议字段映射和能力声明；会话不反向
  import SDK Server、daemon host 或 worker 的协议实现。
- 产品认证、推理身份准备、模型目录和代理重建通过宿主的 `ensureAuthReady`、
  `prepareInference`、`prepareProxy` 等端口提供。缺省行为遵循契约，不回退加载产品包。
  memory / skill evolution 也消费宿主提供的实现，未提供时不启用对应能力。
- SDKMessage 是 Core 的共享出站消息类型，可以作为执行投影使用；不要为了隐藏这个
  类型再建立第二套重复消息模型。其他 wire 键的映射仍由宿主完成。

## 配置与共享依赖

- ThreadManager 和 ThreadSession 当前直接复用 CLI 的 `config/`、SettingsService
  装配入口与共享 `session/` 模块。这里不存在 Config/support 逐字镜像目录，
  不要恢复镜像生成器、漂移门禁或第二套 Settings 解析与加载逻辑。
- `config/sessionFlagSettings.ts` 处理本会话 flag settings。保持会话投影与进程共享
  settings/resource 服务的边界，不能用一次会话的参数覆盖其他会话。
- 会话通过 `loadCliConfig` 装配 Config，并在 `config.initialize()` 前接入
  `ThreadOpenRequest` 声明的动态 MCP server 和宿主文件系统包装。
- 用户、项目、flag settings 的来源、trust、权限与产品兼容行为保持既有语义。
  不要为了取得自定义 Provider 配置而放开全部用户配置。

## 执行链

```text
threadManager.ts
  -> thread-session/threadSession.ts
  -> thread-session/command/sessionCommandManager.ts
  -> thread-session/query/sessionQueryRunner.ts
  -> @qwen-code/core query()
  -> thread-session/query/queryProjection.ts
  -> ThreadHost.events
```

- `thread-session/query/sessionQueryRunner.ts` 持有消息历史、turn 计数、累计用量、
  transcript 写入游标和 session state，驱动 Core 的 `query()`。
- `thread-session/query/queryProjection.ts` 将 QueryEvent 投影为 SDKMessage。
  生命周期、状态持久化和协议投影不要混成一个新的执行内核。
- `thread-session/command/` 持有会话级命令队列、执行状态和终态去重。
  command 的排队与工具执行调度是不同职责。
- 后台 Subagent 的进度与完成通知经
  `thread-session/query/backgroundSubagentEvents.ts` 过滤和 drain，保留 task/session
  身份隔离，不把另一个会话的后台消息投进当前会话。

## 文件组织

- `open/createForkTranscript.ts`：fork transcript 与关联恢复数据的准备、失败回滚。
- `thread-session/contract/`：open/resume、initialize 声明、返回值、事件和宿主端口契约。
- `thread-session/handlers/`：模型、权限、goal、任务、MCP、配置、回滚等会话能力。
  handler 操作会话语义，宿主负责将返回结果编码成协议回包。
- `thread-session/host/`：宿主 Agent/MCP 注册、Hook 回调、权限询问与 elicitation。
- `thread-session/turn/`：Hook、广播、压缩状态、推理就绪、后台收尾等生命周期协作者。
- `thread-session/initialize/`：initialize 声明处理、运行快照、模型策略和 artifact 查询。
- `thread-session/telemetry/`：会话阶段耗时与首输出记录。
- `support/protocolError.ts`：供会话使用的共享错误属性判断。

## 修改要求

- 先确定改动归属：协议适配归宿主，会话生命周期与执行归本目录，通用推理、工具和
  资源能力复用 Core / Resource；不因历史 SDK 命名把产品逻辑塞进共享会话实现。
- 修改 `ThreadHostRequests` 或会话声明时，同时检查调用方和缺省行为；不得擅自改变
  Core ModelProvider 的 select/inference 接口。
- Hook、权限询问、取消、resume/fork、后台收尾和终止去重都要覆盖失败分支。
- 执行结束前保留 transcript 刷盘与后台任务的既有有界等待；不要用无限等待替代。
- 优先运行本目录已有的相关测试。所有命令从 `packages/cli` 目录执行，例如：

```bash
npx vitest run src/thread-manager/threadManager.test.ts
npx vitest run src/thread-manager/thread-session/threadSession.lifecycle.test.ts
npx vitest run src/thread-manager/thread-session/query/sessionQueryRunner.resume.test.ts
```

慢测试需带 `QWEN_RUN_SLOW_TESTS=1`；只运行本次改动对应的文件或用例。
| 路径                                                                                                                                                                       | 定位                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `globalRuntime.ts`                                                                                                                                                         | 进程级 runtime 初始化（HTTPDNS / proxy / VPC）。cli `utils/` 下 runtime 模块的全量逐字镜像——三个变体的差别是行为差别（是否做 `syncEndpointAsync` 端点选举、是否等），少一个就静默改语义。                                                                                                                                                  |
| `pluginRefresh.ts`                                                                                                                                                         | 插件热重载与 daemon 级在途去重。`utils/refreshActivePluginsCli.ts` 的逐字镜像。                                                                                                                                                                                                                                                              |
| `sessionConfig.ts`                                                                                                                                                         | 会话 Config 装配。镜像自 `config/config.ts`，`loadCliConfig` → `buildSessionConfig`、`CliArgs` → `ThreadSessionOptions`。argv 的**解析**不在这里（归 `sdk/thread/parseWorkerArgs.ts`，argv 形状是 SDK 上游 wire 契约）；`sdk/thread/openSessionParams.ts` 负责 `CliArgs` → `ThreadSessionOptions` 的翻译，并用编译期同构断言钉住两侧不漂移。 |
| `sessionSettings.ts`                                                                                                                                                       | 会话 settings 加载。镜像自 `config/settings.ts`，两类改动：去掉两个主题值导入、把 `DefaultLight.name` / `DefaultDark.name` 就地字面量化（这一处切断整条 1301 行 `ui/themes/*` 尾巴）；以及 `loadSettings` 增加可选 flag 路径覆盖并纳入缓存键——**镜像里唯一一处语义分歧**，为的是 flag 层会话化。                                             |
| `sessionFlagSettings.ts` | 解析会话的 `--settings`。内联 JSON 保留为内存对象，显式文件路径相对会话 cwd 解析。输入错误通过会话协议返回。 |
| `settingsSchema.ts` / `settings-validation.ts` / `settingsCompatibility.ts` / `settingsContentValidator.ts`                                                                | settings 的数据契约与校验，逐字镜像。                                                                                                                                                                                                                                                                                                        |
| `permissionMode.ts` / `cliEnvironment.ts` / `trustedFolders.ts` / `localSettings.ts` / `externalImportApproval.ts` / `securityPluginConfig.ts` / `enabledPluginsHelper.ts` | 装配用到的小依赖，逐字镜像。                                                                                                                                                                                                                                                                                                                 |
| `mcp/`                                                                                                                                                                     | MCP 三源合并、enablement 单例、project 审批与 `.mcp.json` 读取，逐字镜像。                                                                                                                                                                                                                                                                   |
| `support/`                                                                                                                                                                 | 装配用到的 `utils/` / `services/plugins/` 依赖，逐字镜像。                                                                                                                                                                                                                                                                    |
| （门禁已上移）                                                                                                                                                             | 漂移门禁现在覆盖 `config/` 与 `support/` 两个批次，见 `../mirrorDrift.test.ts`。                                                                                                                                                                                                                                                             |

### support/

会话链用到的纯投影与协议助手，全部是 cli 旧模块的**逐字镜像**，与 `config/` 批次同一个
生成器产出、同一道漂移门禁（`../mirrorDrift.test.ts`）。分两批：

- **A 批（零尾巴）**：模块本身不 import 任何 cli 内部模块。`controlProtocol`（control_response
  信封与错误 code 归一）、`goalControlProtocol` / `planModeControlProtocol`（只镜像纯快照函数，
  `install*EventBridge` 那些订阅进程级 `coreEvents` 的没镜像）、`contextWindow`、
  `transcriptMetadata`、`runtimeConfigTranscript`、`sdkMemory`、
  `sdkSkillEvolution`、`startupModePolicy`、`remoteWorkerToolRegistry`、
  `artifacts/sdkArtifactResolver`。
- **B 批（尾巴在组内闭合）**：`permissionMode`、`modelInfo`、`remoteTypes`、`remoteProjection`、
  `buildRemoteModelList`、`availableModelsSnapshot`、`formatCreditFactor`、`analyzeContext`、
  `contextUsage{Collector,Projection}`、`artifacts/` 整个子树。

⚠️ 镜像里 **wire 契约**集中的几处（`controlProtocol` 的错误 code、`transcriptMetadata` 的
`'cli'` 入口串、`remoteTypes`
的 `RemoteModelInfo` 形状、`sdkMemory` 的 permission update 形状）一旦与源分叉，SDK 另一端
会看到两种模式下行为不一致，且不报错。改源必须跑 `npm run gen:tm-mirror`。

### thread-session/contract/

| 路径                    | 定位                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `hostContext.ts`        | 出站 `ThreadEvent` / `ThreadNotice` 与反向 `ThreadHostRequests` 的契约。载荷一律是产品数据，不是 wire 投影。       |
| `threadSessionTypes.ts` | `initialize` 声明袋与二十来个能力返回值的类型。声明袋字段是中立名，wire 键映射在宿主胶水里做。                     |
| `handlerContract.ts`    | `ThreadSessionInternals`——handler 能看到的会话内部面，以及 `ThreadCapabilityError`（文案是 wire 契约，逐字保留）。 |

### thread-session/handlers/

会话能力的内部包，按域分组：`goalHandlers` / `modeHandlers` / `modelHandlers` /
`contextHandlers` / `configurationHandlers` / `taskHandlers` / `metaHandlers` /
`mcpHandlers` / `initializeHandlers` / `sessionState`。handler 不做协议、不做 wire 翻译，
失败抛 `ThreadCapabilityError`。

### thread-session/command/

以 `commandUuid` 为键的东西都在这——提交进来的 command 从入队、派发、执行记账到终态
上报的完整流程。判据是硬的：会话的**六个生命周期上报点全部以 `commandUuid` 为键，无一
例外**（queued / started / 队列派发终态 / 重复投递补报终态 / teardown discarded / 引擎
回放的 `command_lifecycle` 被 filter）。统一它们的概念是 command，不是 scheduling、也不是
wire 投影。

| 路径                       | 定位                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionCommandManager.ts` | 命令管理：收拢原先散在 `ThreadSession` 里、隔了上千行的四个簇（入站与派发 / turn 记账 / teardown / 后台收尾）。**结构性收益**：`turnRunning` 与 `turnController` 是它的 private 字段，会话与 handler 在类型层面就拿不到，于是「turn 记账只在一处发生」由结构保证而不靠注释。6 个注入依赖是本次重构的真实成本（它是 `ThreadSession` 的一个切片、切口暴露在外），逐个对应一条真实存在的缝。 |
| `sessionCommandQueue.ts`   | 命令队列，**会话归属是强制的**。headlessSession 的队列是模块级单槽，进程内多会话时 A 的命令会被 B 派发。（自 `turn/` 移入，实现未变）                                                                                                                                                                                                                                                     |
| `commandLifecycle.ts`      | 命令生命周期终态去重。这份状态属于会话不属于宿主：重复上报的成因是会话内部三条并发路径（队列派发 / turn 循环 / teardown）。（原 `query/lifecycleDedupe.ts`；它当初被放进 `query/` 是因为一个输入来自 `SDKMessage` 流——那是「数据从哪来」，不是「它讲的是什么」。实现未变，只改了名与位置）                                                                                                |

**刻意避开的名字**：任何含 `Scheduler` 的名字。本仓 `Scheduler` 已被**工具调度器**占用
（`core/src/scheduler/scheduler.ts`、`ThreadSession.scheduler`），叫 `commandScheduler`
会让人误以为同族，而两者毫无关系。

### thread-session/query/

| 路径                            | 定位                                                                                                                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionQueryRunner.ts`         | 执行内核：会话对话状态 + 直驱 core `query()`。`QueryEngine` 已删除；`compressNow` 由 `turn/sessionCompactCommand.ts` 消费。 |
| `queryProjection.ts`            | `QueryEvent` → `SDKMessage` 的纯函数投影，含 `result` 帧的精度字段累计器。不碰会话状态。                                                                                                      |
| `backgroundSubagentEvents.ts`   | 后台子 Agent 事件的过滤与 drain：按 TaskRegistry 的后台任务身份从 core 的 `subagent-sdk-events` 队列取 progress/正文增量，供 `ThreadSession` 在 turn 外持续投影；`task_started` 仍归 engine。 |

### thread-session/turn/

| 路径                                       | 定位                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionHooks.ts` / `sessionHookEvents.ts` | SessionStart / SessionEnd 的触发与一次性记账；hook 帧的订阅与转发。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `sessionSlashCommands.ts`                  | 会话自己的 slash 处理。对标 worker 的 `createNonInteractiveProcessSlashHandler` 但**去掉 `/plan` 封禁**——worker 硬编码回 `'Plan mode is not available in headless mode.'`，而本链自己实现了 `plan_mode_v1`，照搬会留下「控制请求能切进 plan 模式、用户打 /plan 却被告知这个模式不存在」的矛盾。`SessionBridgeSlashDecider` 按会话缓存 `CommandService` 并用会话的 `sessionAbort.signal`（worker 版每条消息新建一个、signal 建完即丢）。准入策略刻意共享 `utils/bridgeCommandUtils`：那是 TUI 与 worker 同一份 wire 文案，复制等于凭空多一个契约源。 |
| `sessionCompactCommand.ts`                 | 手动 `/compact` 的会话链执行器（异步生成器）。`ThreadSession.runTurn` 在 `submitMessage` 之前拦截 `/compact`（对齐 worker headlessSession.ts:7223 的拦截位置），逐帧产出与 worker `runCompact` 相同的帧序：`system/status('compacting')` → 压缩 → `system/status(null)` → 新历史投影（`compact_boundary trigger=manual`）→ `Compacted` 回显 → `num_turns:0` 合成 `result`。帧构造器直接 import cli 的 `utils/compactWireFrames.ts`——那是 worker 链与会话链共用的唯一契约源，复制一份等于凭空多出第三个必须手工同步的 wire 契约。压缩执行体是中立端口 `SessionManualCompactor`，`SessionQueryRunner.compressNow` 结构满足它。 |
| `sessionCompressionStatus.ts`              | 自动压缩状态桥：监听 core 的 `CompressionProgress`，按 root session 与 `target=main` 过滤（manual 仍归 `sessionCompactCommand`），把 `starting` / `done|failed` 投影成 `system/status('compacting'|null)`；turn 结果帧与 `retire` 兜底清理残留状态。 |
| `sessionAgentsMdSizeWarning.ts`            | AGENTS.md 体积超限桥：监听 core 的 `AgentsMdSizeEvaluated`，init 后按本会话与 `notifyWarning !== false` 投影成 `system/agents_md_size_warning`，字段与 worker 的 `installSdkAgentsMdSizeWarning` 逐字对齐。 |
| `forkTranscriptMirror.ts`                  | fork 会话的初始 `transcript_mirror`：按 512 KiB 分片读取 fork transcript 已有 entries，供 `ThreadSession.start` 在 `--session-mirror` 下补发继承历史。 |
| `sessionBroadcast.ts`                      | 四类 system 广播帧。必须按会话重建——`coreEvents` 是进程级总线。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `backgroundWindDown.ts`                    | 退出前的后台收尾。硬界为什么是 10s 而不是那个 600s，写在文件头。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `inferenceReadiness.ts`                    | 绑 auth → 等目录可信 → 对齐会话模型。三步为什么必须成对发生见文件头与方案 §15.8 / §15.9。                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### thread-session/host/

| 路径                          | 定位                                                                                                                                                                                                                                                                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionHostHooks.ts`         | 宿主在 `initialize` 里注入的 runtime hook 注册（`hook_callback` 反向 RPC）。                                                                                                                                                                                                                                                 |
| `sessionHostMcpServers.ts`    | 宿主注入的 in-process MCP server 注册（`mcp_message` 传输层包装）。                                                                                                                                                                                                                                                          |
| `sessionHostAgents.ts`        | 宿主注入的 agents 注册与 `applySessionAgent` 补偿。                                                                                                                                                                                                                                                                          |
| `sessionMcpControl.ts`        | 会话的 MCP 控制通道（8 个 `mcp_*`）。派生自 `structuredIOMcpControl.ts` 但**去掉 worker 专用的那一半**（`tryHandle` 与 `writeControlResponse` sink）——会话的回包一律走能力返回值由宿主装帧。cli 那份已回退到解耦前的形态，所以这是**手工维护**的镜像、不走生成器；`ok:false` 的 `error` 文案是两份必须手工同步的 wire 契约。 |
| `elicitationBridge.ts`        | MCP elicitation 桥：`elicit` 反向请求与 `elicitationCompleted` 通知。                                                                                                                                                                                                                                                        |
| `sessionPermissionChannel.ts` | 权限询问通道：把 core 的 permission 系统接到宿主的 `canUseTool` 反向请求，落定判决、deny 带 interrupt 时中止本会话 turn。wire 投影归宿主。                                                                                                                                                                                   |
| `sessionPermissionPrompt.ts`  | 权限提示的产品内容（title / description / details 计算）。旧 headlessSession 的同名拷贝已随文件删除。                                                                                                                                                                                                                          |

### thread-session/memory/

| 路径                       | 定位                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `sessionMemoryPipeline.ts` | `initialize` 的 `memory` / `evolution` 声明解析与装配，及 `refresh_memory` 的实现体。                               |
| `sessionTurnReview.ts`     | turn 结束后的记忆 / 技能演进复核；`memory_should_generate` / `skill_evolution_should_review` 两条门禁的唯一调用方。 |

### thread-session/initialize/

| 路径                           | 定位                                                                                                                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionInitializeSnapshot.ts` | `initialize` 回包的产品快照采集（commands / agents / skills / output style / 模型目录 / 账号快照 / tier 预填）。wire 回包体组装在宿主（`sdk/thread/initializeResponse.ts`）。 |
| `sessionArtifactResolver.ts`   | `resolve_session_artifacts` 的会话侧刷新器（自带超时与会话中止合成信号）。                                                                                                    |
| `sessionModelPolicy.ts`        | `get_model_policy` 拉取式模型策略：请求负载组装、超时竞速、三态归一化与外部 provider 就绪检查。`toSdkModelInfo` 投影在宿主 spec encode。                                      |

## cli 根部共享产品模块的命名债（刻意保留）

`src/sdkMemory.ts` 与 `src/sdkSkillEvolution.ts` 是 cli 根部的共享产品模块，当前由本模块
（`sessionMemoryPipeline.ts` / `sessionTurnReview.ts`）消费。它们的 `Sdk*` 文件名与导出名
（`SdkMemoryConfig`、`parseSdkMemoryConfig` 等）是历史命名，不代表归属。旧 worker 路径
删除后可以统一去前缀，但改名不属于本次迁移范围。除此之外，沉入本模块的代码不得再携带
`sdk` 属性——文件名与符号名一律用 `Session*` / `Host*` 等中性命名。

## 已知的不对称

- `turn/` 搬走 `sessionCommandQueue.ts` 之后剩五个成员，**仍然没有统一主题**：分属会话级
  hook 生命周期、命令面 slash、出站广播、退出收尾、启动前推理面就绪五个主题，唯一共同点
  是「不属于 `query/` 的执行流，也不属于 `host/` / `handlers/` / `memory/` /
  `initialize/`」。名字暗示「一轮对话」，但 `inferenceReadiness`（启动前）与
  `backgroundWindDown`（退出时）明显不在 turn 内。本轮不解决，只记录。
  （刻意接受，别顺手「修好」）

- 管理面方法（`close(sessionId)` / `open(request)` / `listSessions(projectDir)`）
  **不带 ctx**，与会话面的 `(ctx, sessionId, …)` 不统一。宿主侧因此拿不到统一的
  签名反推，只能宽松类型化。
- `ThreadManager` 上 8 个 MCP 透传的返回类型是 `Promise<unknown>`（会话侧已收紧成
  `ThreadMcpResult`，Manager 侧没跟着改）。
