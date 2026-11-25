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

- `mcp/sessionControl.ts`：无状态会话级 MCP 命令适配器；授权 pull-flow 与 opener 归
  `SessionMcpManager`，这里只做调用与 CLI settings/plugin 刷新。
- `mcp/admin/`：进程级 MCP 管理（用户 settings、池同步、daemon 级 OAuth）；brokered 判定
  由 `McpManager.authMethodOf` 的产品子类提供。
- `open/createForkTranscript.ts`：fork transcript 与关联恢复数据的准备、失败回滚。
- `thread-session/contract/`：open/resume、initialize 声明、返回值、事件和宿主端口契约。
- `thread-session/handlers/`：模型、权限、goal、任务、MCP、配置、回滚等会话能力。
  handler 操作会话语义，宿主负责将返回结果编码成协议回包。
- `thread-session/host/`：宿主 Agent/MCP 注册、Hook 回调、权限询问与 elicitation。
- `thread-session/turn/`：Hook、广播、压缩状态、推理就绪、后台收尾等生命周期协作者。
- `thread-session/initialize/`：initialize 声明处理、运行快照、模型策略和 artifact 查询。
- `thread-session/phase-log/`：本地会话阶段耗时与首输出记录。
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
