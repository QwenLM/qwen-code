# 统一 agent loop

[English](2026-10-23-unified-agent-loop.md) | [简体中文](2026-10-23-unified-agent-loop.zh-CN.md)

- **状态**：已在 #15343 中通过。PR 1（headless）已在 #15369 合入。PR 2a（ACP prompt 轮次的模型轮）正在 #15509 中评审。
- **日期**：2026-10-23，基于 upstream `779a4d5d0d`。
- **相关**：
  - tracking issue #15327；
  - 早先的提案 #8775，它从 AgentCore 和 headless 入手；本设计把它的目标扩展到全部七份 loop，其中 AgentCore 这一步是 PR 5；
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
- 在入口满足[迁移计划](#迁移计划)中的条件之前修改它的默认值。

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

loop 是一个异步函数。每个模型事件都通过回调原样交给入口，因此现有的入口适配层可以继续工作；工具结果和工具的实时输出也以同样方式送达。由入口决定的事项同样以回调形式提供。loop 返回一个结果，入口把其中的停止原因映射成自己的结果。

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
3. **调度。** 整批调用交给同一个 scheduler 调度。
   - 默认使用 `CoreToolScheduler`。它已经具备按并发安全性分批、并发上限、审批、hook、不完整编辑守卫、Mod 工具检查和运行时视图。它还会跳过进入 plan mode 那个调用的同批调用；headless 现在自己做这件事，只是因为它一次只调度一个调用。
   - 工具在入口提供的工具信号下运行，这个信号可以与 loop 自身的信号不同：headless 只为工具额外加上 Goal 轮次的信号。
   - 入口提供它现在自己负责的 scheduler 选项：审批接线、进度输出，以及整轮模型回调。
   - 如果某个入口的 Mod 带有工具 hook，它就传入现在使用的、能感知 Mod 的 scheduler（`schedule` 契约相同），因此 Mod 的行为不变：Ink 和 OpenTUI 用 `InteractiveModToolScheduler`，headless 用逐个调用的 Mod 执行器。
4. **启动钩子。** 给 `CoreToolScheduler` 新增一个选项 `beforeToolLaunch(call)`。它在每次启动调用之前按请求顺序串行执行。在并发批次中，scheduler 先对能同时运行的每个调用执行它，再一起启动这些调用，因此拒绝会在同组其他调用开始之前生效，与 headless 现在的行为一致。返回 `false` 时该调用不执行。`exec` 脚本内发起的调用不经过它；现在的 headless 也不计入这些调用。loop 会把批次中的每个调用按请求顺序交给入口询问一次；scheduler 没有启动就已结束的调用（参数无效、被拒绝）在轮到它时询问。headless 需要它来实现：
   - `--max-tool-calls` 的精确计数：每次启动前计数，失败的调用也计入；
   - “第一个有效的 `structured_output` 结束会话”。
5. **批次结束时输出结果。** 整批完成后，结果按请求顺序交给入口：先是重放调用，然后是执行过的调用、未执行的调用和重复 call id 的调用。等到整批完成，scheduler 才能先应用批次级 hook 的输出和批次输出预算，入口报告的内容因此与模型收到的完全一致。工具的实时输出仍然在发生时立即流出。

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
- `next_round`——达到 `maxRounds`，结果中带有待发送的工具结果；
- `cancelled` —— loop 自己的 signal 被中止；如果取消只来自 client 合并进来的其他 signal（例如 Goal 轮次的 signal），这一轮按模型没有发起调用来结束，与 headless 现在的行为一致；
- `loop_detected`；
- `duplicate_provider_call`；
- `tool_ended_turn`；
- `surface_ended`——由某个回调结束了 loop，例如 structured output 成功；
- `max_session_turns`；
- `session_token_limit`；
- `user_prompt_blocked`；
- `error`。

由入口映射停止原因：headless 映射成退出码和结果，之后 ACP 映射成 `stopReason`，AgentCore 映射成 `terminateMode`。

headless 的主循环以 `maxRounds: 1` 运行。因此它为每一轮做的准备（teammate 消息、轮数上限、发送类型）保留在现在的位置，而这一轮本身由 loop 负责。drain 条目则在一次调用中跑完它的所有轮次。

### 入口策略

只有部分入口具备的行为，作为策略传给 loop，而不是复制一份 loop。例如：

- `--max-tool-calls` 计数；
- structured output；
- 模型覆盖的优先级；
- teammate 消息合并；
- 以及之后的 daemon 工具循环守卫和 Todo stop guard。

策略只影响传入它的那个入口。

### 宿主自持的发送选项

有些入口在迁移前自己做了交互步骤中的一部分工作，迁到共享路径后还会继续自己做一段时间。这时用一个发送选项告诉 client 跳过这部分，避免执行两次。这类选项只是迁移期的过渡手段，不是长期 API。下表逐项列出，并写明由哪一步把它删除或改成输入。

| 选项                     | 宿主为什么保留这部分                                                                                                                                                                                                                                             | 由哪一步移除                                                                                                                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toolLoopGuardsByHost`   | ACP 的工具步骤运行 daemon 工具循环守卫：每轮工具调用上限、重复调用、探索提醒，以及重复工具失败守卫                                                                                                                                                               | PR 2b 迁移全新 prompt 的工具批：client 的守卫生效，只有 ACP 才有的守卫，即它的参数错误、半截编辑和重复工具失败停止，作为 ACP 的策略保留。带 live 工具的会话和 Agent Host 会话保留 ACP 的工具步骤和这个选项，直到 PR 2d |
| `interactionSpanByHost`  | ACP 的 span 挂在 daemon 的 trace 下                                                                                                                                                                                                                              | 改为输入：client 加入宿主为该 prompt 开启的 span；ACP 修改默认值之前完成                                                                                                                                               |
| `userTurnRecordedByHost` | ACP 在 slash 命令执行前，按用户输入的原样记录 prompt，连同显示文本、附件、resource link 和 daemon prompt id 一起记录，并在首次发送前为这一轮建立文件历史快照，所以发出前就被取消的 prompt 也有快照；在 retry、continue 或 restore 上，宿主已经启动了 todo 工作链 | 改为输入：宿主传入这条记录，由 client 写入；ACP 修改默认值之前完成                                                                                                                                                     |

`toolCallPreparations`、`memoryRecallQuery`、`stopPolicies` 和 `historyPromptId` 不在表中：第一个只是请求一个额外的事件，第二个把宿主在发送前展开的 prompt 原文交给召回，第三个加入宿主在 stop 点继续的理由（见 [stop 点续发](#stop-点续发)），第四个让 `Retry` 沿用它所替代那次尝试的历史标识；四者都不关闭任何行为。PR 2c-1 删除了 `stopHookRunByHost`，ACP 原来用它在自己的 Stop 循环里触发 Stop hook。

新增任何为某个宿主关闭 client 部分工作的选项，都必须在这里登记一行。入口在表中还有未关闭的行时，不修改它的默认值。

### stop 点续发

回复结束且没有工具调用时，由 `LlmClient` 决定这一轮是否继续，依据是 steering、Stop hook 和 next-speaker 检查。Ink、OpenTUI 和 headless 原样依赖这条链。PR 2c-1 之前，ACP 在同一个点上还有更多继续的理由，由它自己的 Stop 循环处理，Stop hook 也在这个循环里触发：Todo Stop Guard、当前轮次的后台结果，以及轮次中途到达的输入。

stop 点是 loop 的一步：先运行 Stop hook；只有部分入口才有的检查，在 Stop hook 允许回复停下之后才按顺序运行。每一项都可以用一条消息继续这一轮，或者让它结束。排队的输入和后台任务通知在一批工具之后才被吸收；到了 stop 点，它们不会让这一轮继续，而是由下一轮接手。这样由唯一一处决定一轮是否继续，入口加入自己的理由时，也不需要在 client 外面再套一层循环。

因此 client 的这条链接受按顺序排列的入口 stop 策略（`SendMessageOptions.stopPolicies`）：

- Stop hook 允许回复停下后，或者没有配置 Stop hook 时，链条按顺序询问每个策略；
- 策略返回用于继续的请求时，链条按发送 Stop hook 续发的方式发送它（`Hook` 类型，沿用这一轮的 prompt id，并有自己的工具预算）；策略什么都不返回时，询问下一个策略；
- Stop hook 的拦截上限结束这一轮时，链条通知各策略（`onStopHookCap`），不再询问它们。

ACP 只传入一个策略：Todo Stop Guard。当前轮次的后台结果和中途排队的输入不再在 stop 点让这一轮继续：ACP 仍在工具边界吸收它们，否则它们开启下一轮，即后台通知轮次或宿主的下一个 prompt。其他入口不传策略，行为不变。

### 设置

`experimental.unifiedAgentLoop` 是布尔值，默认 `false`，重启后生效。`QWEN_CODE_ENABLE_UNIFIED_AGENT_LOOP=1` 可以覆盖它，便于 CI 和脚本在共享 loop 下运行测试。两者沿用 `experimental.agentTeam` / `QWEN_CODE_ENABLE_AGENT_TEAM` 的写法。

由 `Config.isUnifiedAgentLoopEnabled()` 暴露该设置。每个入口在其 loop 的启动处读取它：

```ts
if (config.isUnifiedAgentLoopEnabled()) {
  return runOnSharedLoop(...);
}
// 现有 loop，保持不变
```

现有 loop 作为 `else` 分支保留，在该设置存在期间不做重构。尚未迁移的入口忽略这个设置，设置的说明会列出它覆盖的入口。`qwen serve` 启动的 ACP 子进程读取同一份设置，所以对已迁移的 ACP 轮次，daemon 和 Web Shell 也会遵循这个设置。从 PR 2a 起，Web Shell 设置面板会列出这个设置。

各入口分别修改默认值之后，这个设置不再有 schema 默认值。`Config.isUnifiedAgentLoopEnabled(surface)` 在设置有值时返回该值，否则返回该入口自己的默认值。环境变量仍然优先于两者。

### Headless 迁到共享 loop（PR 1）

| headless 现状                                                            | 设置开启后                                                                             |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `while (true)` 轮次循环，`drainBatch` 中还有第二份副本                   | 每次交互调用一次 loop；每个 drain 条目是另一次调用，使用各自的发送类型                 |
| `limitedTurnCount` 门限（退出码 53）                                     | 不变；client 发出的 `MaxSessionTurns` 现在以同样的方式结束运行，而不是假成功（#15325） |
| 遇到 `Retry` / `ModelFallback` 时的 `discardAbandonedAttempt`            | 由 loop 丢弃调用；入口重启本次尝试并写出 retry 帧                                      |
| `processToolCallBatch` 的重复调用与重放处理                              | 由 loop 负责                                                                           |
| `structured_output` 预扫描与首次成功即结束                               | 入口策略：调用选择，加上一个可以结束 loop 的结果回调                                   |
| 进入 plan mode 时跳过同批调用                                            | 由 scheduler 对整批处理；逐个调用的 Mod 执行器自己处理                                 |
| 每个调用一次 `executeToolCall`、`partitionHeadlessToolCalls`、并发上限   | 每轮一个 scheduler，分批规则与上限相同                                                 |
| 启动前计数                                                               | `beforeToolLaunch`                                                                     |
| 审批：stream-json 的 `can_use_tool`，一次一个调用                        | 同一个回调，在整批执行前为整批请求                                                     |
| Mod 带工具 hook 时串行执行                                               | 用逐个调用的 Mod 执行器作为批次 scheduler                                              |
| 按序收尾、`finalizeToolResponses`、带 Goal 来源信息的 `recordToolResult` | 由 loop 负责                                                                           |
| 模型覆盖的优先级（内联 `/model` > 整轮视觉 > `\0` 哨兵）                 | 入口策略                                                                               |
| teammate 文本合并进工具结果轮                                            | 工具边界处的输入，以 `Teammate` 类型发送                                               |
| Goal 的 `terminateTurn`                                                  | 停止原因 `tool_ended_turn`                                                             |
| `LoopDetected` → 退出码 1；重复出现的 provider id → loop-detected 结果   | 停止原因 `loop_detected`、`duplicate_provider_call`                                    |
| 中止 → `routeAbort`（55 / 130）                                          | 停止原因 `cancelled`；中止仍由入口路由                                                 |
| 空闲阶段：下一个 Goal、teammate、cron、后台任务等待、记忆、最终结果      | 不变，留在 loop 之外                                                                   |

### ACP prompt 轮次迁到共享模型轮（PR 2a）

PR 2 分步迁移 ACP。PR 2a 迁移全新用户 prompt 的模型轮：不是 retry、continue 或 restore，也不是 Goal、channel 或 Goal 提案审批轮次的 prompt（后五类由 PR 2c-2 迁移）。模型轮就是共享 loop 自己的 `runModelRound`：一次 `LlmClient.sendMessageStream` 调用，事件交给 ACP，终止事件变成停止原因。ACP 保留自己的工具步骤（`runToolCalls`、工具之后的下一条消息、daemon 工具循环守卫）以及轮次前后的全部逻辑。PR 2b 把这些轮次的工具批迁到 scheduler 上，PR 2c-1 把它们的 stop 点迁到 client 的链上。PR 2c-2 到 2c-4 再迁移其他轮次，因此 ACP 的每份 loop 主体只改动一次。

| ACP 现在                                                                    | 设置开启后                                                                                                                                                                                      |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 通过 `#sendMessageStreamWithAutoCompression` 调用 `chat.sendMessageStream`  | 通过 `runModelRound` 调用 `LlmClient.sendMessageStream`：第一轮是 `UserQuery`，工具之后的一轮是 `ToolResult`，回复流式输出期间收到的输入是 `Steer`                                              |
| 原始 chunk：文本、thought、usage、函数调用、工具调用准备                    | client 的事件：`Content`、带原始 `text` 的 `Thought`、`Finished` 上的 usage、带来源 `functionCall` 的 `ToolCallRequest`、`ToolCallPreparation`                                                  |
| 经 message bus 触发 UserPromptSubmit                                        | `admitUserPrompt`，输入和时机都不变；第一轮应用这个结果，被拦截的 prompt 由这一轮报告，不发请求                                                                                                 |
| 用户消息记录、todo 工作链和文件历史快照                                     | 仍由 ACP 处理；第一轮用 `userTurnRecordedByHost` 告知 client                                                                                                                                    |
| 记忆召回、plan、arena 与 output-style 提醒、workflow intent、MessageDisplay | 由 client 处理                                                                                                                                                                                  |
| 发送前压缩及其提示；session token 限制                                      | client 在发送过程中压缩，收到 `ChatCompressed` 时显示同样的提示；限制由 client 检查，报告方式不变（`max_tokens`）                                                                               |
| 外部 Stop hook、它的上限和续发                                              | 仍由 ACP 的 Stop 循环处理，这个循环也负责 Todo Stop Guard 和当前轮次的后台结果；模型轮用 `stopHookRunByHost` 告知 client，直到 PR 2c-1 把 stop 点迁到 client 的链上                             |
| 请求失败时的 StopFailure hook 和 429 映射                                   | 仍由 ACP 处理，流中的 `Error` 事件也一样，抛出的是 provider 原本抛出的错误                                                                                                                      |
| 轮次结束后的托管记忆任务                                                    | 轮次按现有条件结束时由 ACP 通过 client 的 `runManagedAutoMemoryBackgroundTasks` 安排；PR 2c-1 之前，在 `stopHookRunByHost` 下 client 不安排，因为 ACP 的 Stop 循环还可能继续这个轮次            |
| interaction span                                                            | 仍由 ACP 处理；模型轮用 `interactionSpanByHost` 告知 client                                                                                                                                     |
| daemon 工具循环守卫：每轮工具调用上限、重复调用、探索提醒                   | 仍由 ACP 处理；模型轮用 `toolLoopGuardsByHost` 告知 client，client 因此不检查工具调用模式，也不添加探索提醒和 ACP 消息里已有的 todo 提醒                                                        |
| 没有内容和 thought 循环启发式检测，也没有会话轮数上限                       | `model.skipLoopDetection` 为 false 时启用 client 的内容和 thought 启发式检测，它的 `LoopDetected` 以循环为由拒绝这个 prompt（`LOOP_DETECTED`）；`MaxSessionTurns` 以 `max_turn_requests` 结束它 |

这一步对 core 的改动都是增量的，不使用它们的调用方不受影响：

- `Turn` 给 `Thought` 带上 chunk 的原始 `text`，给 `ToolCallRequest` 带上它所依据的 `functionCall`；发送时用 `toolCallPreparations` 要求后，模型开始流式输出一个调用时会产出 `ToolCallPreparation`；
- `SendMessageOptions.userTurnRecordedByHost`、`stopHookRunByHost`、`interactionSpanByHost` 和 `toolLoopGuardsByHost`，以及循环检测器的检查选项 `toolCallPatterns`；
- `SendMessageOptions.memoryRecallQuery`：`UserQuery` 的记忆召回用它代替请求作为查询；
- `getStructuredErrorCause` 返回 `Turn` 的 `Error` 事件所依据的原始错误；
- `admitUserPrompt` 接受 hook 的 `submitted_prompt` 和取消信号；
- 导出 `runModelRound`。

### ACP 工具批迁到共享工具批（PR 2b）

PR 2b 迁移 PR 2a 所迁轮次的工具批。工具批就是共享 loop 自己的 `runToolBatch`，跑在一个 `CoreToolScheduler` 上：重复与 replay 处理、调度、按请求顺序排列的结果、`finalizeToolResponses` 和记录。工具批外面的 loop 仍由 ACP 处理：工具之后的下一条请求、中途输入和后台结果，以及在 PR 2c-1 之前的 Stop 循环。

ACP 这边只负责翻译 scheduler 的状态变化：

| ACP 现在的执行器                                                                                                                                                        | 设置开启后                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runToolCalls` / `runTool`：自己做工具查找、校验、半截编辑守卫、PreToolUse、PermissionRequest、权限流程、AUTO 模式、plan 模式的 shell 规则、PostToolUse、图片处理和遥测 | 由 scheduler 处理                                                                                                                                                   |
| 只有相邻的 Agent 调用并发执行                                                                                                                                           | 按 scheduler 的分批：所有并发安全的调用（Read、Search、Fetch、只读 shell、Agent）并发执行，并发上限不变                                                             |
| 轮到某个调用时才发权限请求                                                                                                                                              | scheduler 把调用置为 `awaiting_approval` 时，经 ACP 的权限队列为每个调用发 `session/request_permission`，都在这一批的任何调用执行之前；答复交给该调用的 `onConfirm` |
| 请求被拒绝或失败时，这个调用之后停止轮次，批中后面的调用被跳过                                                                                                          | 同样停止；批中其他调用在执行前被取消                                                                                                                                |
| `runTool` 内部发出的 `tool_call` 开始、生命周期、shell 心跳、子代理和结果更新                                                                                           | 同样的更新，改由 scheduler 的回调发出：调用启动时发开始，结束时发结果，执行前被拒绝的调用发错误更新                                                                 |
| 每轮工具调用上限、重复调用和探索提醒                                                                                                                                    | 由 client 处理，模型轮不再带 `toolLoopGuardsByHost`                                                                                                                 |
| 按轮次计数的参数错误停止和半截编辑停止，以及重复工具失败守卫                                                                                                            | 仍由 ACP 处理，依据这一批的结果                                                                                                                                     |
| Goal 审批的归属、standalone worktree 限制                                                                                                                               | 仍由 ACP 处理，通过 scheduler 的 `refuseToolCall`                                                                                                                   |
| PermissionPrompt Notification hook 返回的终端序列                                                                                                                       | hook 由 scheduler 触发；ACP 转发它报告的序列                                                                                                                        |
| Managed 会话的批次收尾、记忆写入后的记忆刷新                                                                                                                            | 仍由 ACP 处理，在这一批之后                                                                                                                                         |

带 live 工具的会话（ACP 不经权限流程就信任这些工具）和只读的 Agent Host 会话（拒绝一切审批）在 PR 2d 之前保留 ACP 的执行器和 `toolLoopGuardsByHost`。

这一步对 core 的改动都是增量的：

- 导出 `runToolBatch`，并新增 `keepCancelledResults`：被 loop 信号取消的批次仍会收尾、记录并返回结果，因为 ACP 会把被取消轮次的结果保留在历史中；
- `CoreToolScheduler` 新增选项 `refuseToolCall`（owner 在调用构建之前自行拒绝）和 `onPermissionPromptTerminalSequence`。

### ACP 的 stop 点迁到 client 的链上（PR 2c-1）

PR 2c-1 把 PR 2a 所迁轮次的 stop 点迁到 client 的链上。只有尚未迁移的轮次还保留 ACP 的 Stop 循环。

| ACP 现在的 Stop 循环                                                                  | 设置开启后                                                                                                                                              |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACP 触发 Stop hook，自己处理上限，续发使用 `_stop_hook_N` prompt id                   | 使用 client 的 Stop hook 和上限；续发是沿用这一轮 prompt id 的 `Hook` 发送；ACP 显示 hook 的 system message，并从第二次拦截起显示 Stop hook 循环更新    |
| Todo Stop Guard，两者同时适用时与 hook 的续发合并                                     | 一个 stop 策略，在 Stop hook 允许回复停下后才被询问；它向宿主认领续发，宿主有排队的 prompt 时让位，用完尝试次数后停止                                   |
| 当前轮次的后台结果让 prompt 继续（`_background_result_N`）                            | 不在 stop 点续发；它们开启一个后台通知轮次                                                                                                              |
| Todo Stop Guard 生效时，中途排队的输入在 stop 点被取出，并让 prompt 继续              | 不在 stop 点取出；宿主把它作为下一个 prompt 发送，guard 为它让位                                                                                        |
| Stop hook 运行期间到达的输入会作废它的决定                                            | hook 的决定保持有效                                                                                                                                     |
| guard 续发中的工具执行完后，下一条请求还需要 guard 再给一次尝试，否则结果只保存不发送 | 工具结果像任何一批工具之后一样发回，由 guard 在下一个 stop 点再做决定                                                                                   |
| 每次续发都走 ACP 的旧发送路径，并运行 ACP 的工具步骤                                  | 与这一轮其余部分一样，使用 client 的模型轮和共享工具批                                                                                                  |
| ACP 在 Stop 循环之后执行托管记忆任务                                                  | 这一轮最后一个回复自行停下时由 client 执行；这一轮以其他方式结束时由 ACP 执行，例如达到 Stop hook 拦截上限、结束在 Steer 轮次上，或某个工具结束了这一轮 |

client 在 Stop hook 续发中保留宿主的 span、工具守卫和 stop 策略选项，因此不会为续发另开 span，也不会为续发中的工具打开自己的守卫。每次 Stop hook 或 Todo Stop Guard 续发时，ACP 都重置自己的工具守卫状态，包括因 Live 工具而保留 ACP 工具执行器的情况。同一次续发中的工具结果请求沿用这一预算。

hook 诊断消息不会重新打开已结束回复的中断窗口。每个新的模型请求都会重新开始捕获最终答案；没有后续请求的诊断消息会保留前一个答案。

这一步对 core 的改动是新增 `SendMessageOptions.stopPolicies` 和 `StopPolicy` 接口，并删除只有 ACP 使用的 `stopHookRunByHost`。

### 重新进入轮次的 ACP prompt，以及 channel 和 Goal 提案轮次（PR 2c-2）

PR 2c-2 让另外五类 ACP 轮次使用共享模型轮、共享工具批和 client 的 stop 点。其中两类是 PR 2a 没有纳入的全新 prompt：channel prompt 和 Goal 提案审批轮次。另外三类重新进入会话中已有的轮次：retry、继续被打断的轮次（continue），以及恢复一个未回答的 `ask_user_question`（restore）。Goal 轮次、cron 和后台通知在 PR 2c-3 和 2c-4 中迁移。

| 轮次                     | 设置开启后                                                                                                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| channel prompt           | 与其他全新 prompt 一样是 `UserQuery`，和现在一样不带 submitted prompt 和 workflow 输入；它的回复不会被排队的输入打断，它的工具结果从不结束这一轮，重复工具失败守卫保持关闭       |
| Goal 提案审批            | `UserQuery`；会话和现在一样结算提案；Todo Stop Guard 让位或 Stop hook 达到上限时，提案不会启动 Goal                                                                              |
| retry                    | 和现在一样由 ACP 剥离失败的那次尝试，retry 一直没有发出时再把它放回；第一轮是 `Retry`，带上那次尝试的标识 `historyPromptId`，以及 `admitUserPrompt` 给出的 UserPromptSubmit 结果 |
| continue                 | 和现在一样由 ACP 剥离被打断的那段输入，或关闭被打断的调用；第一轮是 `Retry`，带 `historyPromptId`，不运行 UserPromptSubmit；第一条请求一直没有发出时，被打断的那段输入按原样放回 |
| 恢复 `ask_user_question` | ACP 用自己的工具步骤重新提问；回答作为第一轮，即一个 `Retry`；之后的批次使用共享工具批                                                                                           |

重新进入的轮次即使带着工具结果，第一轮也是 `Retry` 而不是 `ToolResult`：`ToolResult` 不会开启 client 的一次交互，上一个 prompt 的循环检测计数会延续下来，UserPromptSubmit 也会在这些结果上运行。headless 用 `ToolResult` 继续被打断的轮次，是因为它每次运行都是一个新进程。client 不给 `Retry` 加系统提醒，所以 ACP 和现在一样为它加上 plan、arena 和 output-style 提醒；ACP 取走的 todo 提醒就是 client 会取的那一条。

被恢复的问题保留 ACP 的工具步骤：共享工具批会记录每一个结果，而因超时没有回答的问题必须保持未记录，之后加载时才能再次提问。

这一步对 core 的改动：`userTurnRecordedByHost` 也覆盖 `Retry`，表示宿主已经启动了它的 todo 工作链；`Retry` 也接受 `promptAdmission`；新增输入 `historyPromptId`，即 `Retry` 的请求在历史中带的标识，由第一条请求使用。

## 迁移计划

| PR   | 内容                                                                                                      |
| ---- | --------------------------------------------------------------------------------------------------------- |
| 0    | 本设计                                                                                                    |
| 1    | 共享 loop、`beforeToolLaunch`、设置项、headless（`-p` 与 stream-json）、对拍测试                          |
| 1d   | headless：默认开启                                                                                        |
| 1r   | headless：删除现有 loop                                                                                   |
| 2a   | ACP：全新用户 prompt 的模型轮改为走 `LlmClient`；ACP 自己的重复实现不进入共享路径，ACP 保留自己的工具步骤 |
| 2b   | ACP：这些轮次的工具批迁到 scheduler 上；daemon 工具循环守卫改为 client 的守卫加一项入口策略               |
| 2c-1 | ACP：这些轮次的 stop 点迁到 client 的链上，Todo Stop Guard 作为 stop 策略；删除 `stopHookRunByHost`       |
| 2c-2 | ACP：channel、Goal 提案、retry、continue 和 restore 轮次                                                  |
| 2c-3 | ACP：Goal 轮次                                                                                            |
| 2c-4 | ACP：cron 和后台通知轮次                                                                                  |
| 2d   | ACP：默认开启，随后删除现有 loop                                                                          |
| 3    | Ink TUI                                                                                                   |
| 4    | OpenTUI                                                                                                   |
| 5    | AgentCore 改用基于 `Turn` 的模型轮（subagent、后台与 fork agent、workflow）                               |
| 6    | speculation                                                                                               |
| —    | Hosted Harness：单独评估                                                                                  |

PR 3–6 每一项之后，同样各自跟随默认开启和删除旧 loop 两步。

一个入口在设置开启时通过它的对拍测试，并列出了已知差异，才算完成迁移。之后每个入口各自修改默认值，不必等其他入口。修改默认值需要同时满足：

- 该设置对这个入口已经提供了至少一个版本；
- 在设置开启的情况下运行该入口集成测试的定时任务，已在 main 上连续通过两周；
- 该入口在[宿主自持的发送选项](#宿主自持的发送选项)中没有未关闭的行；
- release notes 列出了它在[兼容性](#兼容性)中的有意差异。

默认值修改发布一个版本之后，再删除该入口的现有 loop。在此之前，把 `experimental.unifiedAgentLoop` 设为 `false` 可以让这个入口回到现有 loop。

## 对拍测试

`integration-tests/fake-openai-server.ts` 已经会记录每个请求体。

**运行方式。** 对拍测试把每个脚本化场景在同一入口上跑两次：一次不设置 `QWEN_CODE_ENABLE_UNIFIED_AGENT_LOOP`，一次设为 `1`。比较两样东西：

- 模型看到的请求序列，比较前去掉时间戳、日期提醒、各类 id 和耗时；
- 入口的输出：headless 是 stream-json 帧；ACP 是 `session/update` 通知和每个 prompt 的停止原因，但不含按自己时机到达的 `available_commands_update`。

出现差异即判该场景失败，除非这个差异已经列出并关联 issue。

**首批场景：**

- 纯文本；
- 单个工具；
- 并行只读批次；
- 安全与不安全调用混合；
- 调用工具的 Code Mode `exec` 脚本；
- 审批通过与拒绝（stream-json 的 `can_use_tool`）；
- 工具执行中取消；
- 流中途重试与模型回退；
- 输出被截断的编辑；
- 循环检测；
- 阻断型 Stop hook；
- 预算边界上的 `--max-tool-calls`：并行批次、顺序批次、在执行前就被拒绝的调用，以及需要审批的批次；
- 跨两条 stream-json 消息的 `--max-session-turns`；
- 带同批调用的 structured output；
- 合并进工具结果轮的 teammate 消息。

**ACP 场景**（`integration-tests/cli/acp-agent-loop-parity.test.ts`）：

- 纯文本，以及带 thought 的流式文本；
- 一个工具，以及一次回复中的两个读取；两个读取在共享工具批上并发执行，因此按调用比较它们的更新；
- 两次读取之间一次获准的写入，以及一次被拒绝的写入，都在默认审批模式下；
- 超过每轮工具调用上限的读取，不比较被 client 上限停下的那次回复的结尾；
- 被输出上限截断的编辑；
- 中途断流后重试的流；
- 同一会话中的两个 prompt；
- 读取文件的 channel prompt；
- 模型报错之后的 retry；
- 模型报错；
- 拦截 prompt 的 UserPromptSubmit hook；
- 拦截一次的 Stop hook，以及一直拦截到上限的 Stop hook；
- Todo Stop Guard 在还有未完成 todo 时继续，直到用完尝试次数。

续发请求在现有 loop 上使用自己的 prompt id，在共享 loop 上沿用这一轮的 prompt id；对拍测试把两者视为相同。

对拍测试在 integration 任务中运行。另有一个定时任务，在设置开启的情况下运行完整的 headless 集成测试。

## 兼容性

- 设置关闭时，任何入口都不变。共享代码的改动都是增量的：scheduler 的可选项 `beforeToolLaunch`、从 PR 2a 起上文所列的 `Turn` 事件字段和发送选项，从 PR 2b 起导出的 `runToolBatch` 和 scheduler 的 `refuseToolCall`、`onPermissionPromptTerminalSequence`，以及从 PR 2c-1 起的 `stopPolicies`，不使用它们的调用方不受影响。
- 设置开启时，headless 与现在相比有以下有意的差异。其中大多数源于把一批调用作为一个整体调度，这也是 TUI 现在的做法：
  - 在 stream-json 中，超过 `--max-session-turns` 的消息会在会话轮数上限处结束运行，与 `-p` 相同（错误写到 stderr，退出码 53），而不是返回一个重复上一条回答的成功结果（#15325）；
  - 通知轮次（cron、monitor 等排队条目）的每一轮模型调用都计入 `--max-session-turns`，与主轮次相同，而不是整个条目只计一轮，因此通知轮次中调用工具的运行可能更早到达上限；
  - 一批调用的 PreToolUse hook 和审批（stream-json 的 `can_use_tool`）会在这一批的任何调用启动之前为所有调用执行，而不是一次一个调用；在 `--max-tool-calls` 下，超出预算的调用可能先被审批通过，然后在执行前被停下；
  - PostToolBatch hook 每批触发一次，带上这一批的所有调用，批次输出预算也按整批计算；现在每个调用都是单独的一批；
  - 遥测按整批记录，与 TUI 一致：进入 plan mode 那个调用的同批调用记为失败的工具调用（JSON 输出的 `stats` 也计入），启动前被拦下的调用仍有工具 span；带 Mod 工具 hook 时调用仍逐个调度，这两点都不适用；
  - 一批中有多个串行调用时，它们的结果在整批完成时输出，而不是每个调用完成后输出；
  - 配置了 PreToolUse 或 PermissionRequest hook 时，只读的 shell 调用可以并行执行，按 hook 处理后的输入判断，而不是总是单独执行；
  - 同批中排在前面的 skill 注册了 PreToolUse hook 时，后面的调用会被拦下，需要模型重新发起，而不是由新的 hook 检查；
  - 在 `--json-schema` 下，同一次回复中重复 call id 的 `structured_output` 调用按重复调用作答而不执行，因此有效的第二次提交要等到下一轮；之后的轮次以相同的 call id 和相同的参数重新提交时，也按重复调用作答，再提交一次则以 provider 重复循环结束运行，而不是每次都执行。

  对拍测试覆盖了保持不变的常见场景，并对 #15325 的停止和 `--max-tool-calls` 下被审批的调用做了断言。headless 单测在两份 loop 上运行通知轮次的计数和重新提交的 `structured_output`。

- 设置开启时，ACP 的 prompt 轮次与现在相比有以下有意的差异。其中大多数源于 client 为 ACP 做了它为其他入口做的事：
  - 日期与上次不同时，prompt 会带上 client 的日期提醒；系统提醒改由 client 生成，包括 advisor 与已暂停 Goal 的提醒，并且排在 ACP 一次性提示的前面，而不是后面；
  - UserPromptSubmit 也会为这一轮的工具结果请求运行，输入是请求的文本（请求只有工具结果时为空），与其他入口相同（#9511）；取消轮次会停止仍在这里运行的 hook；在这里被拦截时，轮次结束并显示拦截提示，这一轮的工具调用以“被 hook 拦截”的结果关闭，随结果一起取走的输入仍保留在历史中；
  - session token 限制在 client 压缩历史之前检查，而不是之后；
  - client 的会话轮数上限对 ACP prompt 生效；`model.skipLoopDetection` 为 false 时它的内容和 thought 循环启发式检测也生效，启用时 next-speaker 检查也一样（#14114）；
  - 工具结果请求会带上召回结果和排队的循环提醒，并运行 client 只按大小判断的 microcompaction，托管记忆任务（包括 skill review）由 client 执行，prompt 计入提交署名；
  - 每次压缩都会显示压缩提示，发送过程中的压缩也一样；
  - 从 PR 2b 起，一批工具调用作为一个整体调度，与 TUI 相同：这一批的审批都在它的任何调用执行之前请求，并发安全的调用并发执行，因此它们的更新会交错；
  - client 的每轮工具调用上限在回复流式输出时就把它停下，因此这次请求以 interrupted 结束，也不报告 usage；超出上限的调用仍显示为已跳过；
  - 被取消调用的结果是 `[Operation Cancelled] Reason: …`；审批被拒绝时，这一批的其他调用被取消，而不是带着 ACP 的权限取消提示被跳过；
  - ACP 的参数错误停止和半截编辑停止在这一批结束后才生效，因此批中其他调用仍会执行；provider 调用 id 重复导致轮次结束时，不再记录被跳过的结果；
  - 工具结果请求中的 todo 提醒和探索提醒改由 client 添加，client 把它们放在工具边界处取得的输入之后；
  - PostToolBatch hook 每批触发一次，批次输出预算也按整批计算；
  - PostToolUse hook 产生的 artifacts 随工具的结果更新一起发出，不再单独发 `artifact-event` 通知；
  - 从 PR 2c-1 起，当前轮次在最后一个回复之后才到达的后台结果，会开启一个后台通知轮次，而不是让 prompt 继续；Todo Stop Guard 生效时，中途排队的输入成为下一个 prompt，而不是让这一个继续；
  - Todo Stop Guard 只在 Stop hook 允许回复停下后才继续，并且使用单独的请求，不再与 hook 的理由合并；Stop hook 运行期间到达的输入不再作废它的决定；
  - Stop hook 和 Todo Stop Guard 的续发沿用这一轮的 prompt id，与 TUI 的续发一样运行 UserPromptSubmit；除 Live 和 Agent Host 会话保留 ACP 的工具调用守卫外，运行 client 的守卫；并像任何一批工具一样把工具结果发回；
  - 从 PR 2c-2 起，channel prompt 和 Goal 提案轮次在共享路径上得到与全新 prompt 相同的处理，包括日期提醒、系统提醒和 client 的召回；
  - retry、continue 和 restore 会开启 client 的一次交互：循环检测器、探索预算和轮次预算重新开始，它们的第一轮不计入会话轮数上限；
  - continue 的第一条请求一直没有发出时，被打断的用户输入按原样放回，而不是作为一条合并后的条目保留；

  ACP 对拍测试覆盖了保持不变的常见场景，并对日期提醒、工具结果上的 UserPromptSubmit、该 hook 运行时取消，以及一批的审批先于它的调用执行做了断言。

- 之后迁移的入口会带来各自的修复：#15324（ACP）、#15326（OpenTUI）、#14114 与 #12209（ACP）。

- 不删除任何设置、协议字段或文件格式。

## 风险

| 风险                                                                                | 缓解措施                                                                                                             |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 整批调度改变 headless 的帧顺序或 `--max-tool-calls` 的精确计数                      | 按序流式输出结果；`beforeToolLaunch`；在预算边界上设对拍场景                                                         |
| ACP 改走 `LlmClient` 后会多出一些行为（上限、启发式、提醒），并可能让 hook 执行两次 | ACP 自己的那份实现不进入共享路径；对拍测试列出每一项新增行为；单独成 PR                                              |
| AgentCore 的延迟审批需要恢复四个 async-local 上下文帧                               | 把现有的契约测试随代码一起迁移；在 TUI 的 agent 视图中做一次真实的延迟审批（PR 5）                                   |
| 设置存在期间两套实现并存，新的 loop 层行为需要在两边都接一次                        | 每个入口准备好后立即修改默认值并删除现有 loop，不必等所有入口完成迁移；在此期间不重构现有 loop；对拍测试在 CI 中运行 |
| 大 PR 会改动 core                                                                   | 每个 PR 只迁移一个入口；PR 1 是位于默认关闭设置之后的功能 PR                                                         |

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
- 对拍测试按顺序比较各帧，目前还没有场景并发运行带实时输出的调用；这类调用的进度帧在两份 loop 中都没有固定顺序。这类场景是否应该按调用分别比较进度帧？
- 被 `beforeToolLaunch` 拒绝的调用，对 PostToolBatch 来说仍是所在批次的成员，因此 hook 附加在它上面的停止指令或补充上下文不会到达模型。headless 只在运行结束时才拒绝调用，所以这在 headless 中不会表现出来。在其他入口使用 `beforeToolLaunch` 之前，应该让被拒绝的调用离开 hook 看到的批次，还是把 hook 的输出移到最后一个实际运行的调用上？

## 后续工作

- 会话层调度：用同一处逻辑决定通知、cron、Goal 轮次或 teammate 消息何时启动一轮 loop。
- Hosted Harness 评估：它写日志的调度是否可以变成符合同一 `schedule` 契约的 scheduler。
