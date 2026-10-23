# 统一 agent loop

[English](2026-10-23-unified-agent-loop.md) | [简体中文](2026-10-23-unified-agent-loop.zh-CN.md)

- **状态**：提案。本文档是 PR 0，不改动代码。PR 1（headless）尚未开始。
- **日期**：2026-10-23，基于 upstream `779a4d5d0d`。
- **相关**：
  - tracking issue #15327；
  - 早先的提案 #8775；
  - 对比各 loop 时发现的缺陷：#15324、#15325、#15326；
  - [loop protection 设置](2026-10-21-loop-protection-setting.zh-CN.md)。

## 问题

agent loop 指这样一个循环：发送提示、流式接收回复、执行模型请求的工具、把工具结果发回模型，直到模型不再调用工具为止。Qwen Code 里这个循环有七份实现，每个入口至少一份。

`LlmClient.sendMessageStream` 只负责一次模型请求，外加它自己处理的几种续发：Stop hook、模型边界处的 steering，以及 next-speaker 检查。它从不执行工具。因此每个入口都要自己实现“执行工具、发回结果、继续下一轮”这部分，其中三个入口完全绕过了 `LlmClient`。

这些副本已经各自走样。#15324、#15325、#15326 是只有对比各副本才发现的行为缺陷；#14114、#12209、#12020、#8542、#13851、#12113 也源于同样的分裂。每加一项 loop 层的新行为，都要在每份副本里分别接线。例如 loop-protection 的提醒不得不分别注入到 `client.ts`、`agent-core.ts` 和 `Session.ts` 三处；Mod 工具检查也只覆盖了七份 loop 中的三份。

## 现状

### 分层

| 层          | 文件                                 | 负责                                                                                                                                                                                                              |
| ----------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LlmChat`   | `packages/core/src/core/llm-chat.ts` | provider 请求、重试、模型回退、max-tokens 升级与输出恢复、自动压缩、历史                                                                                                                                          |
| `Turn`      | `packages/core/src/core/turn.ts`     | 把一次模型调用的原始 chunk 转成带类型的事件（`Content`、`Thought`、`ToolCallRequest`、`Retry`、`ModelFallback`、`Finished`…）；把调用参数标记为被截断（`wasOutputTruncated`）或不完整（`hadIncompleteArguments`） |
| `LlmClient` | `packages/core/src/core/client.ts`   | 一个交互步骤：UserPromptSubmit、Goal 准入、各类提醒、IDE 上下文、循环检测、会话轮数上限，以及之后的 Stop hook、steering 与 next-speaker 续发                                                                      |
| 入口        | 见下表                               | 模型带着工具调用停下之后的一切                                                                                                                                                                                    |

### 现有的 loop

| 入口                                                            | loop 位置                                                                                             | 模型调用                                    | 工具执行                                                                                            |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Ink TUI                                                         | `packages/cli/src/ui/hooks/use-llm-stream.ts`                                                         | `LlmClient`                                 | 基于 `CoreToolScheduler` 的 `InteractiveModToolScheduler`；完成回调里调用 `submitQuery(ToolResult)` |
| OpenTUI                                                         | `packages/cli/src/ui/opentui/live-session.ts`                                                         | `LlmClient`                                 | 每批新建一个 `InteractiveModToolScheduler`                                                          |
| Headless `-p` 与 stream-json SDK 传输                           | `packages/cli/src/nonInteractiveCli.ts`，drain turn 中还有一份副本（`:2888-3066`）                    | `LlmClient`                                 | 每个调用走一次 `executeToolCall`，另外自行实现分批、并发上限和按序收尾                              |
| ACP：Zed、VS Code companion、`qwen serve` / Web Shell、channels | `packages/cli/src/acp-integration/session/Session.ts`，内含四份 loop（主循环、Stop 续发、cron、通知） | 直接调用 `LlmChat`                          | 自带执行器 `runToolCalls` / `runTool`                                                               |
| Hosted Harness                                                  | `packages/cli/src/serve/hosted-harness-model.ts:828-1143`                                             | `LlmClient`，但 13 种 hook 事件由它自己触发 | 写日志的串行调度（`hosted-workspace-tool-turn.ts`）                                                 |
| Subagent、后台与 fork agent、workflow、进程内 team              | `packages/core/src/agents/runtime/agent-core.ts`                                                      | 直接调用 `LlmChat`，并自行解析 chunk        | 每轮一个 `CoreToolScheduler`                                                                        |
| Speculation                                                     | `packages/core/src/followup/speculation.ts`                                                           | 直接调用 `LlmChat`                          | 直接执行工具，不经过 scheduler                                                                      |

以下不是 loop，不在本设计范围内：fork agent 的缓存路径（一次请求，没有工具）、Omni 固定策略编排器（不调用模型）、ACP bridge、SDK 与 channel 包（它们是传输层）。

### 副本之间的差异

- **会话轮数上限。**
  - `LlmClient` 在 `max > 0 && count > max` 时停止（`client.ts:4529-4531`）。
  - headless 在 `max >= 0 && count > max` 时停止（`nonInteractiveCli.ts:663`），用的是它自己的、按调用计数的计数器。
  - Hosted Harness 在 `max > 0 && round >= max` 时停止（`hosted-harness-model.ts:841`）。
  - ACP 没有上限。

  其后果就是 #15325：在 stream-json 中，超过上限的消息仍返回成功，内容却是上一条消息的回答。

- **重复的 provider 工具调用。** 过滤逻辑被组装了四次（`nonInteractiveCli.ts:1962`、`use-llm-stream.ts:3236`、`Session.ts:14096`、`agent-core.ts:2085`），键的回退规则有三种。
- **并发。**
  - 并发上限实现了四次（`coreToolScheduler.ts:5486`、`nonInteractiveCli.ts:2264`、`Session.ts:14375` 和 `:17041`）。
  - scheduler 会并行执行所有并发安全的调用；ACP 只并行连续的 Agent 调用。
- **重试与回退。** 遇到 `Retry` 或 `ModelFallback` 时，Ink 和 headless 会丢弃之前收集的工具调用，OpenTUI 不会（#15326）。
- **不完整的编辑。** 参数被截断或不完整的 Edit 调用会被 scheduler 拒绝，ACP 的执行器却不会（#15324）。
- **记录。**
  - 六个 loop 各自调用 `finalizeToolResponses`，scheduler 内部还另有一次调用。
  - OpenTUI 只在有 Mod 参与时才记录原生工具结果（#15326）。
- **Hook 与 Mod。**
  - ACP 自己重新实现了 UserPromptSubmit、Stop hook 和 MessageDisplay。
  - Hosted Harness 自己触发这些 hook；Stop 续发以 `ToolResult` 类型发送，而 `LlmClient` 用的是 `Hook`。
  - Mod 工具检查只覆盖 Ink、OpenTUI 和 headless。
- **ACP 缺失的部分。** ACP 没有 next-speaker 检查、没有会话轮数上限、没有内容循环启发式，也没有会话中途的 MCP/skill 提醒（#14114）。

## 目标与范围

目标：

- 在 `packages/core` 中只保留一份 loop 实现，涵盖模型轮、工具批、续发和带类型的结果，所有入口共用。
- 通过一个设置分阶段、可选择地引入。设置关闭时，每个入口保留现有 loop，行为不变。
- 只有当对拍测试证明某个入口的请求和输出都与它现有的 loop 一致（列出的差异除外），这个入口才算完成迁移。
- 为 loop 层行为提供唯一的接入点，例如 hook、Mod、loop protection、记录和遥测。

本轮不包括：

- 会话层调度，即通知、cron、Goal 轮次和 teammate 消息何时启动一轮 loop——由各入口自行处理；
- Hosted Harness，在其他入口之后单独评估；
- `LlmChat` 与 provider 层；
- loop 所需钩子之外的 `CoreToolScheduler` 内部逻辑；
- UI 渲染与通信协议；
- 在本轮修改任何默认值。

## 设计

### 分层

```text
入口：Ink · OpenTUI · headless/SDK · ACP · AgentCore · speculation
   │  输入、事件出口、scheduler 接线、中途输入、入口策略
   ▼
共享 agent loop（packages/core）
   模型轮：主会话用 LlmClient.sendMessageStream；
           subagent 与 speculation 在各自的 LlmChat 上使用 Turn
   工具批：重复调用处理 → 调度 → 按序输出结果
   续发：  finalizeToolResponses → 记录 → 中途输入 → ToolResult
   结果：  带类型的停止原因
   ▼
LlmClient → Turn → LlmChat（不改）
```

loop 是一个异步生成器。它原样 yield 每个模型事件，另外 yield 工具生命周期事件，因此现有的入口适配层可以继续工作。它返回一个结果，入口把其中的停止原因映射成自己的结果。由入口决定的事项以回调形式提供。

### 模型轮

1. loop 向入口询问本轮的发送选项，例如发送类型、模型覆盖、首轮字段（如 `humanInput`）和 Goal 字段。
2. loop 调用模型轮，把每个事件按顺序转发给入口。
   - 它收集 `ToolCallRequest` 事件。
   - 遇到 `Retry` 或 `ModelFallback` 时，它丢弃已收集的调用并通知入口，由入口重置已输出的部分内容。
3. client 的终止事件都会转成停止原因，入口因此无法再丢弃它们：`MaxSessionTurns`、`SessionTokenLimitExceeded`、`UserPromptSubmitBlocked`、`LoopDetected` 和 `Error`。
4. 如果本轮结束时没有工具调用，loop 以 `completed` 停止。此时 Stop hook、steering 与 next-speaker 续发都已在 `LlmClient` 内部执行完毕。

主会话的模型轮就是 `LlmClient.sendMessageStream`。AgentCore 和 speculation 需要在各自的 `LlmChat` 上运行模型轮，这由 PR 5 基于 `Turn` 加入，届时 chunk 只在 `turn.ts` 中解析。loop 与模型轮之间的接口等到出现第二种实现时，在那个 PR 中引入。

### 工具批

1. **重复调用。** 重复 call id 的调用不会再次执行。provider 重放的调用得到重复响应；同一个 provider id 再次出现时，loop 以 `duplicate_provider_call` 停止。这些都使用 `turn.ts` 和 `toolCallIdUtils.ts` 中已有的辅助函数。
2. **选择。** 入口可以限制哪些调用执行（headless 的 structured output）。每个没有执行的调用也都会得到响应。
3. **进入 plan mode。** 如果这一批调用会进入 plan mode，同批的其他调用通过已有的 `findPlanModeEntryBatchBoundaryIndex` 跳过。
4. **调度。** 整批调用交给同一个 scheduler 调度。
   - 默认使用 `CoreToolScheduler`。它已经具备按并发安全性分批、并发上限、审批、hook、不完整编辑守卫、Mod 工具检查和运行时视图。
   - 入口提供它现在自己负责的 scheduler 选项：审批接线、进度输出，以及整轮模型回调。
   - 如果某个入口的 Mod 带有工具 hook，它就传入现在使用的、能感知 Mod 的 scheduler（`schedule` 契约相同），因此 Mod 的行为不变：Ink 和 OpenTUI 用 `InteractiveModToolScheduler`，headless 用逐个调用的 Mod 执行器。
5. **启动钩子。** 给 `CoreToolScheduler` 新增一个选项 `beforeToolLaunch(call)`。它在每次启动调用之前，按请求顺序串行执行，并发批次中也是如此。返回 `false` 时该调用不执行。headless 需要它来实现：
   - `--max-tool-calls` 的精确计数（启动前计数）；
   - “第一个有效的 `structured_output` 结束会话”。
6. **按序输出结果。** 一旦某个调用之前的所有调用都已完成，它的结果就按请求顺序 yield 出去。工具进度也走同一个队列，因此 stream-json 帧保持现在的顺序。

### 续发

1. 整批响应只经过一次 `finalizeToolResponses`，每个结果只记录一次。记录时带上 Goal 来源信息，并为每个调用执行 `recordCompletedToolCall`。
2. 入口可以在结果之后追加工具边界处取得的输入：
   - headless 合并 teammate 消息，并以 `Teammate` 类型发送这一轮；
   - 之后 Ink 会排空它的消息队列，ACP 会调用 `craft/drainMidTurnQueue`。
3. 如果某个结果带有 `terminateTurn`，loop 以 `tool_ended_turn` 停止，由入口结束它的 Goal 轮次。
4. 否则 loop 把这些内容作为下一轮发送，类型为 `ToolResult`。

### 结果

结果包含停止原因、轮数和最后一个 `Turn`。停止原因有：

- `completed`；
- `cancelled`；
- `loop_detected`；
- `duplicate_provider_call`；
- `tool_ended_turn`；
- `surface_ended`——由某个回调结束了 loop，例如 structured output 成功；
- `max_session_turns`；
- `session_token_limit`；
- `user_prompt_blocked`；
- `error`。

由入口映射停止原因：headless 映射成退出码和结果，之后 ACP 映射成 `stopReason`，AgentCore 映射成 `terminateMode`。

### 入口策略

只有部分入口具备的行为，作为策略传给 loop，而不是复制一份 loop。例如：

- `--max-tool-calls` 计数；
- structured output；
- 模型覆盖的优先级；
- teammate 消息合并；
- 以及之后的 daemon 工具循环守卫和 Todo stop guard。

策略只影响传入它的那个入口。

### 设置

`experimental.unifiedAgentLoop` 是布尔值，默认 `false`，重启后生效。`QWEN_CODE_ENABLE_UNIFIED_AGENT_LOOP=1` 可以覆盖它，便于 CI 和脚本在共享 loop 下运行测试。两者沿用 `experimental.agentTeam` / `QWEN_CODE_ENABLE_AGENT_TEAM` 的写法。

由 `Config.isUnifiedAgentLoopEnabled()` 暴露该设置。每个入口在其 loop 的启动处读取它：

```ts
if (config.isUnifiedAgentLoopEnabled()) {
  return runOnSharedLoop(...);
}
// 现有 loop，保持不变
```

现有 loop 作为 `else` 分支保留，在该设置存在期间不做重构。尚未迁移的入口忽略这个设置，设置的说明会列出它覆盖的入口。`qwen serve` 启动的 ACP 子进程读取同一份设置，所以 ACP 迁移后，daemon 和 Web Shell 也会遵循这个设置。

### Headless 迁到共享 loop（PR 1）

| headless 现状                                                            | 设置开启后                                                                             |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `while (true)` 轮次循环，`drainBatch` 中还有第二份副本                   | 每次交互调用一次 loop；每个 drain 条目是另一次调用，使用各自的发送类型                 |
| `limitedTurnCount` 门限（退出码 53）                                     | 不变；client 发出的 `MaxSessionTurns` 现在以相同的错误结果结束，而不是假成功（#15325） |
| 遇到 `Retry` / `ModelFallback` 时的 `discardAbandonedAttempt`            | 由 loop 丢弃调用；入口重启本次尝试并写出 retry 帧                                      |
| `processToolCallBatch` 的重复调用与重放处理                              | 由 loop 负责                                                                           |
| `structured_output` 预扫描与首次成功即结束                               | 入口策略：调用选择，加上一个可以结束 loop 的结果回调                                   |
| 进入 plan mode 时跳过同批调用                                            | 由 loop 负责                                                                           |
| 每个调用一次 `executeToolCall`、`partitionHeadlessToolCalls`、并发上限   | 每轮一个 scheduler，分批规则与上限相同                                                 |
| 启动前计数                                                               | `beforeToolLaunch`                                                                     |
| Mod 带工具 hook 时串行执行                                               | 用逐个调用的 Mod 执行器作为批次 scheduler                                              |
| 按序收尾、`finalizeToolResponses`、带 Goal 来源信息的 `recordToolResult` | 由 loop 负责                                                                           |
| 模型覆盖的优先级（内联 `/model` > 整轮视觉 > `\0` 哨兵）                 | 入口策略                                                                               |
| teammate 文本合并进工具结果轮                                            | 工具边界处的输入，以 `Teammate` 类型发送                                               |
| Goal 的 `terminateTurn`                                                  | 停止原因 `tool_ended_turn`                                                             |
| `LoopDetected` → 退出码 1；重复出现的 provider id → loop-detected 结果   | 停止原因 `loop_detected`、`duplicate_provider_call`                                    |
| 中止 → `routeAbort`（55 / 130）                                          | 停止原因 `cancelled`；中止仍由入口路由                                                 |
| 空闲阶段：下一个 Goal、teammate、cron、后台任务等待、记忆、最终结果      | 不变，留在 loop 之外                                                                   |

## 迁移计划

| PR  | 内容                                                                                              |
| --- | ------------------------------------------------------------------------------------------------- |
| 0   | 本设计                                                                                            |
| 1   | 共享 loop、`beforeToolLaunch`、设置项、headless（`-p` 与 stream-json）、对拍测试                  |
| 2   | ACP 会话；模型轮改为走 `LlmClient`，ACP 自己的重复实现不进入共享路径；可拆成模型轮与工具批两个 PR |
| 3   | Ink TUI                                                                                           |
| 4   | OpenTUI                                                                                           |
| 5   | AgentCore 改用基于 `Turn` 的模型轮（subagent、后台与 fork agent、workflow）                       |
| 6   | speculation                                                                                       |
| —   | Hosted Harness：单独评估                                                                          |
| 7   | 默认开启                                                                                          |
| 8   | 删除现有的 loop                                                                                   |

一个入口在设置开启时通过它的对拍测试，并列出了已知差异，才算完成迁移。默认值的修改，要等范围内所有入口都完成迁移，并且该设置已在 CI 中、由主动开启的用户使用了至少一个版本。现有 loop 的删除，要等默认开启发布至少一个版本之后。

## 对拍测试

`integration-tests/fake-openai-server.ts` 已经会记录每个请求体。

**运行方式。** 对拍测试把每个脚本化场景在同一入口上跑两次：一次不设置 `QWEN_CODE_ENABLE_UNIFIED_AGENT_LOOP`，一次设为 `1`。比较两样东西：

- 模型看到的请求序列，比较前去掉时间戳、日期提醒、各类 id 和耗时；
- 入口的输出：headless 是 stream-json 帧，之后 ACP 是 `session/update` 通知。

出现差异即判该场景失败，除非这个差异已经列出并关联 issue。

**首批场景：**

- 纯文本；
- 单个工具；
- 并行只读批次；
- 安全与不安全调用混合；
- 审批通过与拒绝（stream-json 的 `can_use_tool`）；
- 工具执行中取消；
- 流中途重试与模型回退；
- 输出被截断的编辑；
- 循环检测；
- 阻断型 Stop hook；
- 预算边界上的 `--max-tool-calls`；
- 跨两条 stream-json 消息的 `--max-session-turns`；
- 带同批调用的 structured output；
- 合并进工具结果轮的 teammate 消息。

对拍测试在 integration 任务中运行。另有一个定时任务，在设置开启的情况下运行完整的 headless 集成测试。

## 兼容性

- 设置关闭时，任何入口都不变。唯一改动的共享代码是 scheduler 新增的可选项 `beforeToolLaunch`，不传入时它不起作用。
- 设置开启时，有意引入的差异是：
  - #15325（headless）的修复；
  - 以及之后的 #15324（ACP）、#15326（OpenTUI）、#14114 与 #12209（ACP）。

  每一项都会在对拍测试中列出。

- 不删除任何设置、协议字段或文件格式。

## 风险

| 风险                                                                                | 缓解措施                                                                           |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 整批调度改变 headless 的帧顺序或 `--max-tool-calls` 的精确计数                      | 按序流式输出结果；`beforeToolLaunch`；在预算边界上设对拍场景                       |
| ACP 改走 `LlmClient` 后会多出一些行为（上限、启发式、提醒），并可能让 hook 执行两次 | ACP 自己的那份实现不进入共享路径；对拍测试列出每一项新增行为；单独成 PR            |
| AgentCore 的延迟审批需要恢复四个 async-local 上下文帧                               | 把现有的契约测试随代码一起迁移；在 TUI 的 agent 视图中做一次真实的延迟审批（PR 5） |
| 设置存在期间，两套实现并存                                                          | 不重构现有 loop；对拍测试在 CI 中运行；计划中已安排删除                            |
| 大 PR 会改动 core                                                                   | 每个 PR 只迁移一个入口；PR 1 是位于默认关闭设置之后的功能 PR                       |

## 验收标准

每个入口的 PR：

- 设置关闭时，现有的单元测试与集成测试原样通过。
- 设置开启时，该入口通过它的对拍场景；每个差异都已列出并关联。
- 该入口与 loop 相关的测试，在设置开启时也要运行。

最终状态：

| 指标                                         | 现在                                      | 目标 |
| -------------------------------------------- | ----------------------------------------- | ---- |
| agent loop 实现数                            | 7 份，另加 headless 与 ACP 内部的额外副本 | 1    |
| 直接调用 `LlmChat.sendMessageStream` 的 loop | 3                                         | 0    |
| 在 `turn.ts` 之外解析流式 chunk 的 loop      | 3                                         | 0    |
| 调用 `finalizeToolResponses` 的 loop         | 6                                         | 1    |
| 会话轮数上限的算法                           | 3                                         | 1    |

## 待定问题

- `model.maxSessionTurns: 0` 应该表示“不允许任何轮次”，还是应该被拒绝？目前各 loop 的理解不一致（#15325）。
- 对于并发批次内部的工具进度帧，它们之间的相对顺序现在本来就不确定。对拍测试的输出比较是否应该容忍这类帧的位置变化？

## 后续工作

- 会话层调度：用同一处逻辑决定通知、cron、Goal 轮次或 teammate 消息何时启动一轮 loop。
- Hosted Harness 评估：它写日志的调度是否可以变成符合同一 `schedule` 契约的 scheduler。
