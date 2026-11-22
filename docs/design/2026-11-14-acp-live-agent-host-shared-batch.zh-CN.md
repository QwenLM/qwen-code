# ACP live 工具与 Agent Host 会话迁到共享工具批

[English](./2026-11-14-acp-live-agent-host-shared-batch.md)

## 背景

本项是 #17045 中 ACP 的一行 (`packages/cli/src/acp-integration/session/`)：
带 live 工具的会话和只读的 Agent Host 会话迁到共享工具批，并删除
`toolLoopGuardsByHost`。改动前 `#runsToolsOnSharedBatch()` (`Session.ts`)
对注册过 live 工具、以及 `getSessionSourceType()` 为 `agent-host` 的会话
返回 `false`，它们的轮次走 ACP 自己的工具步骤，并向 core 传
`toolLoopGuardsByHost: true` 让 core 的 loop guards、todo reminder 和
结果感知去重交给宿主侧。

这一行接着 #17070（`interactionSpanByHost`、`userTurnRecordedByHost` 成为
输入），在 #17181（ACP 第 3 步）之上展开；默认开关不变。

## 基线

对照 #17181 头 `447a0abe26`，接入点在 #17181 之后形状收敛：

- 共享 loop 的轮次用 `startSharedLoopRound` 启动，返回
  `{ model, runBatch, close }`。模型请求和工具批都在同一次
  `runAgentLoop` 里；批（含 replay）由 `runBatch` 交接后才推进，它运行
  在 `runBatch` 的 async 上下文中；turn 提前离开时关闭 round 的 loop。
- ACP 以 `deferRecording: false`、保留 cancelled 结果，用
  `createSchedulerExecutor` 走批；`runAcpToolBatch` 接受 round 的
  loop（`loop.runBatch`），stale plan 检查经 `beforeToolLaunch`；
  `Session.ts` 的 `#runSharedToolBatch` 通过 `SharedRound.onLoop` 接收
  `SharedLoopRound`。
- 本设计不改动交接机制本身：审批仍走 `session/request_permission`，更新
  仍走 ACP `tool_call`，内核 / event-bus 那档问题归 #17181。

## 方案

### live 工具的信任

`AcpToolBatchHost` 的 `isTrustedLiveTool` 输入（转发至
`CoreToolSchedulerOptions.isTrustedTool`）按实例身份（而非工具名）识别会话的
可信 live 工具实例：`capture_screen_context` 与五个 live 任务工具
（`list_threads`、`read_thread`、`wait_threads`、`send_message_to_thread`、
`create_thread`）——与 ACP 自己的 executor 当初旁路的那一组相同。
`speak_to_user` 不在其中：它和当初一样留在权限流程里，用户的
`permissions.deny` / `permissions.ask` 规则对它仍然生效。在
`CoreToolScheduler` 内，受信任的工具实例直接跳过
L1 `PermissionManager.isToolEnabled` / 旧版拒绝列表检查以及 L3→L4
`evaluatePermissionFlow` 权限评估，无需交互式审批
即可直接调度执行。PreToolUse hook 的 `ask` 是用户自己要的确认，不在旁路之列。它们的执行通道是会话的 daemon `extMethod`，已由
`setLiveConversationActive` 生命周期约束，因此模型调用它们时不会产生审批请求。
信任按工具实例引用相等判定，同一 live 会话中的普通工具或同名 MCP 工具仍走正常
ACP 权限流程。

### Agent Host 的只读行为

工作区路径围栏与只读工具策略仍由会话 `Config` 提供：其
`getToolInvocationGuard()`（`createAgentHostToolInvocationGuard`）由
`CoreToolScheduler` 在执行边界评估，违反工作区围栏或只读策略的调用以
`EXECUTION_DENIED`（`not_started`）及围栏拒绝原因结算。批不再另建或转发第二份
围栏。

`readOnlyRefusalMessage` 是唯一经 `AcpToolBatchHost` 转发给
`CoreToolSchedulerOptions` 的宿主行为，仅在调用真正到达交互式审批关口时
（`awaiting_approval` 之前、自动放行的只读检查与权限 hook 之后）触发。工作区内
自动放行的读工具——`read_file`、不带 `glob` 过滤的 `grep_search`、
`list_directory`，也就是会话注册的全部工具（`AGENT_HOST_TOOL_NAMES`）——正常
执行。`glob`、带 `glob` 过滤的 `grep_search`、`zoom_image` 与 `display_image`
被围栏无条件拒绝，与工作区内外无关：glob 展开发生在围栏之后，可能穿越符号链接
或花括号分支。任何仍需交互
审批的调用以 `EXECUTION_DENIED`（`not_started`）和消息
`Tool "<name>" requires approval, which is unavailable on this read-only Agent Host.`
拒绝，不发送 `session/request_permission`，也不中止整轮对话。

### 去掉 flag

两类会话迁到共享批之后，`#runsToolsOnSharedBatch()` 直接删除（两个调用点并入
共享路径）。`toolLoopGuardsByHost` 从 `SendMessageOptions` 删除；在共享 loop 上，
core 的 loop guards、todo reminder 和结果感知去重对每个 ACP 轮次生效。
`checkAlwaysOnSafeties`（整轮次数上限、连续相同调用守卫——按工具名加参数计数，
唯一的按结果豁免是 `task_list`）接管该轮；TUI 依赖的重复停止（#14590，含 YOLO
后台任务）在统一 loop 下由批的 `keepCancelledResults: true` 保持对等的覆盖形态。

删除它在当前默认（`UNIFIED_SURFACE_DEFAULTS.acp === false`）下也不会让任何工作
重复：那条路径根本不进 `LlmClient`。开关关闭时，轮次经会话自己的 chat 发送
（`#sendMessageStreamWithAutoCompression` → `chat.sendMessageStream`），自己拼
工具结果消息、只跑 ACP 的守卫。client 的提醒与守卫分支只能经会话用
`startSharedLoopRound` / `runModelRound` 起的轮次到达，也就是
`sharedModelRound` 那一支——而现在每种会话在那一支上都走共享批。所以这个选项
最后一个读点在本次删除之前就已不可达；守卫归属跟着轮次走，而不是跟着会话种类走。

### 测试计划

测试按价值驱动，在现有测试套件中补齐真实共享批的集成场景：

- `Session.test.ts` 翻转原先断言 `toolLoopGuardsByHost: true` 的用例，并在
  `kernel=false` 与 `kernel=true` 下通过真实 `runAcpToolBatch` 与
  `CoreToolScheduler` 运行两类集成场景：
  1. live 工具会话在同一共享批中同时调用可信的 `capture_screen_context` 与需审批的
     普通 `read_file` 工具，验证可信 live 工具跳过 `isToolEnabled` 与
     `requestPermission` 直接执行，而同一会话中的普通工具仍发出 ACP 权限请求。
  2. 只读 Agent Host 会话在 `ApprovalMode.DEFAULT` 下运行工作区内自动放行的
     `list_directory`、由会话 Config 的 `getToolInvocationGuard()` 拦截工作区外的
     `read_file`，以及由
     `readOnlyRefusalMessage` 拒绝工作区内需审批的 `read_file`（零次
     `requestPermission` 调用），并继续推进到下一模型轮。
  3. 以 `capture_screen_context` 之名注册的第二个实例，必须走到
     `isToolEnabled`，而 live 实例不走——若谓词改为按名比较，该用例必须变红。
  4. live 会话中命中 deny 规则的 `speak_to_user` 调用，必须由权限流程拒绝，
     而不是被授信放行。
- `acp-tool-batch.test.ts` 验证 `runAcpToolBatch` 将 `isTrustedLiveTool` 与
  `readOnlyRefusalMessage` 转发给 `createSchedulerExecutor`。

## 风险与边界

- **重复停止回归（#14590）。** TUI 的后台任务重复停止现由
  `checkAlwaysOnSafeties` 提供。统一 loop 下，executor 返回打捞结果，
  cancelled 批的缺失响应合成为 cancellation。`keepCancelledResults: true`
  的形态与该停止等价。
- **live 任务轮询。** always-on 连续相同调用守卫不区分结果是否改变
  （#9450 的豁免在 core 的结果感知去重里）。若出现真实回归，把 live
  任务工具的 sentinel 按实例身份写进批的重复处理，而不是扩 core 豁免：
  信任按实例身份判定，同名工具不继承。
- **Agent Host 的读工具。** 会话 `Config.getToolInvocationGuard()` 由
  `CoreToolScheduler` 在执行边界应用，因此 `read_file`、`grep_search`、
  `list_directory` 的工作区外路径在执行前被拦截，而 `glob`、带 `glob` 过滤的
  `grep_search`、`zoom_image`、`display_image` 无论指向哪里都被拒绝。
- **#17181 依赖。** 分支基于 #17181 的 `SharedLoopRound` 交接形状，并与 `main`
  合流。

## 验收

- `#runsToolsOnSharedBatch()` 删除；`toolLoopGuardsByHost` 从
  `SendMessageOptions` 及其读点消失。默认路径仍由 ACP 跑守卫，是因为它根本不进
  client，而不是因为轮次要求它这样做。
- live 会话与 Agent Host 会话都走共享批，并由共享批集成场景覆盖可信 live 工具
  免审执行、普通工具权限审批、Agent Host 自动放行只读工具、工作区外
  `getToolInvocationGuard()` 拦截，以及需审批调用的只读拒绝（零次外发
  `requestPermission`）。
