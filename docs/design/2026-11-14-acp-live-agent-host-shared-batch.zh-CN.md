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

`AcpToolBatchHost` 增加一个输入，携带会话的三个可信 live 工具实例
（按身份，不按名字）。批的 `beforeToolLaunch` 恰好对这些实例跳过只读
拒绝和调用围栏；L1 enablement 和权限申请已经由调度器按工具声明的信任
处理，批内无需重复豁免。它们的执行通道是会话的 daemon `extMethod`，
由 `setLiveConversationActive` 生命周期约束，所以模型调用它们时不会真的
产生审批提问。信任按工具实例引用相等，不让同名的 MCP 工具继承。

### Agent Host 的只读与调用围栏

两个主机行为，作用域仍是 `sourceType === 'agent-host'`：

1. 每个到达批的 `beforeToolLaunch` 且不属于 live 信任的调用，都用会话
   只读的提示拒绝，不发 `session/request_permission`（不走
   `#requestPermissionQueued`）。
2. `createAgentHostToolInvocationGuard` 作为批的宿主输入传入，在
   `beforeToolLaunch`、调度器 build 之前评估。build 失败的调用仍走
   scheduler 的重试路径，与当前 ACP executor 一致。

集成测试断言会话没有发出 `session/request_permission`。验收不区分是
plan 端先拒还是执行端 deflect；倾向在 launch 前拒。

### 去掉 flag

两类会话迁到共享批之后，`#runsToolsOnSharedBatch()` 直接删除（两个
调用点并入共享路径）。`toolLoopGuardsByHost` 从 `SendMessageOptions`
删除，core 的 loop guards、todo reminder 和结果感知去重对每个 ACP
轮次生效。`checkAlwaysOnSafeties`（整轮次数上限、连续相同调用守卫——
含后台任务豁免）接管该轮；TUI 依赖的重复停止（#14590，含 YOLO 后台
任务）在统一 loop 下由批的 `keepCancelledResults: true` 保持对等的
覆盖形态。

### 测试计划

测试按价值驱动，不为覆盖率凑数。设计上是抬升现有单一来源，不新增平行
case 列表：

- 单元：`Session.test.ts` 复用现有 harness。此前断言
  `toolLoopGuardsByHost: true` 且 `runAcpToolBatch` 未被调用的用例随
  分支翻转；每个用例以行为断言驱动（live 工具免审批、agent-host 在
  launch 前拒绝、guards 恢复）而不是按 flag 传给 core 的样子。共享批
  harness 对截断响应的请求显式打 `wasOutputTruncated`，与真实 client
  在轮次上的标记一致。
- core 侧按价值闸门：`checkAlwaysOnSafeties`、tool-result 那部分不再
  re-mock，增强写进拥有该不变式的单一来源；如果现有 harness 表达不了
  live 任务长轮询的 sentinel，再补。

## 风险与边界

- **重复停止回归（#14590）。** TUI 的后台任务重复停止现由
  `checkAlwaysOnSafeties` 提供。统一 loop 下，executor 返回打捞结果，
  cancelled 批的缺失响应合成为 cancellation。`keepCancelledResults: true`
  的形态与该停止等价；daemon cancelled 批路径上的等价用例是合并前
  的守门。
- **live 任务轮询。** always-on 连续相同调用守卫不区分结果是否改变
  （#9450 的豁免在 core 的结果感知去重里）。若出现真实回归，把 live
  任务工具的 sentinel 按实例身份写进批的重复处理，而不是扩 core 豁免。
- **Agent Host 的 glob/grep。** executor deflect Agent Host 围栏拒绝的
  路径搜索；信任只作用于工具的执行通道。
- **#17181 依赖。** 分支基于 `SharedLoopRound` / `beforeToolLaunch`
  形状。若 #17181 落地时形状不同，本设计跟随其终形状，不另改 loop
  契约。

## 验收

- `#runsToolsOnSharedBatch()` 删除；`toolLoopGuardsByHost` 从
  `SendMessageOptions` 及其读点消失。
- live 会话与 Agent Host 会话都走共享批；单元 harness 驱动截断的 edit
  走该批、可信 live 工具不经权限提问、普通工具仍走完权限往返。
- daemon cancelled 批的重复停止保持等价（批的 `keepCancelledResults`
  保持该停止的覆盖形态）。

后续：每类会话一个全栈集成场景（live 用 fake ACP client + fake daemon
`extMethod`；Agent Host 断言被拒 edit 且零次外发
`request_permission`）随本行的下一片段落地。
