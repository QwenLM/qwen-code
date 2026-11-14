# Hosted Harness 代理循环 —— 迁移评估

[English](2026-11-14-hosted-harness-loop-evaluation.md) | [简体中文](2026-11-14-hosted-harness-loop-evaluation.zh-CN.md)

- **状态**：仅评估；不做实现、不引入开关。本文记录 Hosted Harness 循环与共享代理循环之间的 parity 差异，并建议**推迟** Hosted Harness 迁移。这是[统一代理循环](2026-10-23-unified-agent-loop.md)计划（跟踪 issue #15327）最后一个表面的评估——该设计明确将 Hosted Harness 留待「其他表面之后单独评估」。本文沿用[流式工具派发评估](2026-11-11-streaming-tool-dispatch.md)（#16949）的纯文档切片形态。
- **日期**：2026-11-14。行号引用已在 `main` `af312d610143` 上核实。
- **行为来源**：`packages/cli/src/serve/hosted-harness-model.ts`（1,599 行）与 `packages/cli/src/serve/hosted-workspace-tool-turn.ts`（10,908 行）。
- **相关**：
  - [统一代理循环](2026-10-23-unified-agent-loop.md)——已接受的设计；其「Loops」表将 Hosted Harness 列为 `LlmClient` 加自触发 hook、以及 journal 化串行派发；
  - [Event-bus 代理循环](2026-11-11-event-bus-agent-loop.md)——共享循环的事件驱动实现；Hosted Harness 不在其已启用表面之列；
  - [流式工具派发评估](2026-11-11-streaming-tool-dispatch.md)——「推迟并附设计」评估切片的先例。

## 行为差异

共享代理循环（`packages/core/src/core/agent-loop.ts`）先跑 `runModelRound`（`:401`）再跑 `runToolBatch`（`:512`）：一个模型轮的事件转发给表面，然后整批交给一个 `CoreToolScheduler`（`createSchedulerExecutor`，`:807`），接着 `finalizeToolResponses`（`:709`）与记录（`:671`），再进入下一轮。每个表面决策都是 `AgentLoopHost`（`:173`）上的可选回调。

Hosted Harness 在 `runPreparedHostedHarnessTextTurn`（`hosted-harness-model.ts:524`，经由 `runHostedHarnessTextTurn` `:380` 进入）中跑自己的循环。其轮循环（`:1174-1178`）发送模型请求、收集调用、在停止点自触发 Stop 与 MessageDisplay hook，然后把调用交给 `input.toolTurn.execute`（`:1564`）。该 tool turn 是 `HostedWorkspaceToolTurn`（`hosted-workspace-tool-turn.ts:2138`）：一个**持久化、journal 化、exactly-once、串行**的派发，而非内存中的调度器批处理。差异不在于「循环形状不同」，而在于 Hosted Harness 的工具执行是一套恢复系统，而共享循环的工具批处理不是。

## 代码实际要求（已核实）

当前代码树中有五个事实决定了这项工作的形态。每一条都是迁移必须保留的契约，而非可以丢弃的细节。

1. **模型轮是带持久 feed 撤回的 `LlmClient.sendMessageStream`，外加一个 prepared-recovery `Turn`。** 该轮调用 `client.sendMessageStream`（`hosted-harness-model.ts:1345`）并带 `retractDeliveredOutputOnRetry: true`（`:1353`）；遇到非 continuation 的 `Retry`（`:1381`）或 `ModelFallback`（`:1390`）时，从持久 feed 撤回孤儿前缀（`textDeltas.retract()`）并清空文本。这是 #13319 契约：已发布的 delta 无法事后剥离，因此已经投递内容的截断会重放请求并撤回前缀。`preparedRecovery` 则改为通过 `new Turn(client.getChat(), …).run(…)`（`:1331`）恢复一个 prepared 请求。共享 `runModelRound` 转发相同事件、并在 `Retry`/`ModelFallback` 时丢弃已收集的调用，但它没有持久 feed 或 prepared recovery 的概念；两者都必须落在表面的 `onModelEvent` 以及轮外层包装里。

2. **工具批处理是持久化、journal 化、exactly-once 的串行派发。** `execute`（`hosted-workspace-tool-turn.ts:3439`）先跑 `executeNative`（`:4590`）再跑 `completeHookResults`（`:3450`）。`executeNative` 准备请求（allowlist、plan-mode、截断拒绝），然后在串行循环（`:6425`）中逐个派发：shell 走 broker（`execute` `:6952`、`executeV3` `:6889`）、memory（`:6550`）、子代理、team 工具、会话命令、question 与 plan exit，每个都把自己的 `tool_result` 提交进 journal。Exactly-once 依赖 journal 集合而非进程：`journaledToolResultIds`（`:1903`）读取以 `functionResponse` id 为键的持久 `tool_result` 记录，重放只跳过提交（`if (!journaled?.has(callId)) await this.commit('tool_result', …)`，`:8922`），而重放安全的 acceptance 仍会执行。诸如 `resumeAgentWaitRuns` 的恢复分支会为 checkpoint 仍欠的每个 run 重新进入等待。共享 `runToolBatch` 把整批调度到一个 `CoreToolScheduler` 上、对并发安全的调用并行执行。它在内存中去重并抑制重放（`agent-loop.ts:536-571`），但该状态无法在重启后存活：没有持久 journal、没有重启恢复。它无法在不丢失持久性的前提下替换这套派发——而持久性正是 Hosted Harness 的核心价值。

3. **轮数上限是第三个公式，且以抛错收场。** Hosted Harness 在 `maxRounds > 0 && round >= maxRounds`（`hosted-harness-model.ts:1187-1188`，`maxRounds = config.getMaxSessionTurns()` `:1173`）处停止并抛出 `HostedModelRoundLimitError`。`round` 从 0 起算，并从 `input.resumeModel?.round ?? input.initialRound ?? 0`（`:1175`）恢复。这不同于 `LlmClient` 的 `max > 0 && sessionTurnCount > max`（`client.ts:4995-4996`，yield 一个 `MaxSessionTurns` 事件），也不同于共享循环的 `options.maxRounds !== undefined && rounds >= options.maxRounds`（`agent-loop.ts:337`，返回 `next_round` 停止原因）。三个边界、三种结果：抛出的类型化错误、终止事件、类型化停止原因。迁移必须调和边界，并保留 Hosted 调用方所捕获的错误类型，否则就得改动每一个调用方。

4. **十四个自触发 hook，以 exactly-once occurrence id 做 journal 化，且 Stop continuation 以 `ToolResult` 发送。** `HOSTED_EXPLICIT_HOOK_EVENTS`（`hosted-harness-model.ts:74-88`）列出十三个事件——SessionStart、SessionEnd、SessionDelete、UserPromptSubmit、UserPromptExpansion、Stop、StopFailure、MessageDisplay、PreToolUse、PostToolUse、PostToolUseFailure、PostToolBatch、PermissionRequest——此外 harness 还触发 InstructionsLoaded（`:849`、`:872`）。它自行触发这些 hook 并以 occurrence-id 去重（`hasCompletedOccurrence`，如 SessionStart `:837-842`），而非走 client 的 hook 链。在停止点它触发 Stop（`:1495`），若被阻塞则带着 hook 的理由继续；该 continuation 在下一轮以 `SendMessageType.ToolResult` 发出（`:1346-1349`），而 `LlmClient` 把 Stop continuation 以 `Hook` 发送。工具 hook（PermissionRequest、PreToolUse、PostToolUse、PostToolUseFailure、PostToolBatch）由 `completeHookResults` 从 journal 化的 `hook_execution` 记录触发。共享循环依赖 client 的 Stop/steering/next-speaker 链；把 Hosted 轮迁上去会重复触发这些 hook，除非新增 send option 关闭 client 的触发，而这些 option 将是统一设计「Send options a host owns」表中的过渡项。

5. **恢复与 resume 是一等公民。** 该轮从 `resumeModel.round` / `initialRound`（`:1175`）恢复，在 hook 有未完成操作（`HostedHookRecoveryRequiredError`，`:1181`）或设置了 hook stop reason（`:1183`）时拒绝启动，并把带未决工具结果的失败包装为 `HostedToolRecoveryRequiredError`（`:1577-1579`）。一个 client 发起的 skill 调用会在轮循环之前执行（`:1113`）。共享循环没有 resume 或恢复概念；这些将保留为任何共享轮之外的 Hosted 专属包装。

## 迁移引入的 parity 差异

| 关注点           | Hosted Harness（现状）                                                                                               | 共享循环                                                                                                           | 后果                                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| 工具执行         | 持久化、journal 化、exactly-once 串行派发，带 broker 执行与重启恢复（`hosted-workspace-tool-turn.ts:6425`、`:1903`） | 单个内存 `CoreToolScheduler` 批处理，对并发安全调用并行（`agent-loop.ts:807`）                                     | 共享批处理的去重在内存中、而非持久 journal；替换派发会丢失重启持久性。tool turn 必须保留，至多包装为 executor          |
| 记录 / finalize  | 每个分支把自己的 `tool_result` 提交进 journal；`completeHookResults` 读取 journal 化 hook 记录                       | `runToolBatch` 每批跑一次 `finalizeToolResponses`（`:709`）与 `recordCompletedToolCall`（`:671`）                  | 把 tool turn 包装为 `AgentLoopToolExecutor`（`:244`）会重复记录或与 journal 冲突，除非绕过共享批处理的 finalize/record |
| 轮数上限         | `max > 0 && round >= max`，抛 `HostedModelRoundLimitError`（`hosted-harness-model.ts:1187`）                         | `rounds >= maxRounds` 返回 `next_round`（`agent-loop.ts:337`）；client yield `MaxSessionTurns`（`client.ts:4995`） | 同一预算的三种写法：检查位置与结果种类不同；调用方捕获的是抛出的错误类型                                               |
| Retry / fallback | 从持久 feed 撤回孤儿前缀并清空文本（`:1353`、`:1381`、`:1390`）                                                      | 丢弃已收集调用，无持久 feed 副作用（`agent-loop.ts:441-444`）                                                      | 撤回（#13319）必须在 `onModelEvent` 中精确保留；共享循环不拥有该 feed                                                  |
| Hook             | 14 个自触发、journal 化 exactly-once；Stop continuation 以 `ToolResult` 发送（`:74-88`、`:1495`、`:1346`）           | client 触发自己的 Stop/UserPromptSubmit 链；Stop continuation 以 `Hook` 发送                                       | 除非新增 send option 关闭 client 的 hook，否则会重复触发；Stop continuation 的发送类型会改变                           |
| Resume / 恢复    | `resumeModel.round`、prepared-recovery `Turn`、hook/tool 恢复错误（`:1175`、`:1331`、`:1181`、`:1577-1579`）         | 无 resume 或恢复概念                                                                                               | 保留为 Hosted 包装；共享轮无法表达                                                                                     |
| 每轮准备         | 每轮 drain 用户消息、重新声明工具、注入 todo/workspace 上下文、刷新 system instruction（`:1189-1226`）               | `nextRound` / `onRoundEnd` 回调                                                                                    | 全部必须成为表面 policy；没有一条是共享循环提供的默认行为                                                              |

该表描述的是迁移必须调和的内容。前两行是承重项：Hosted Harness 的工具执行是一套持久性系统，而共享循环的批处理不是。

## 考虑过的迁移形态

**完整迁移（模型轮与工具批处理）。** 受阻。共享 `runToolBatch` 无法拥有 journal 化 exactly-once 派发，除非要么在共享批处理内重新实现 journal（这会把 Hosted 专属的持久性塞进 `packages/core`、强加给每个表面），要么丢弃持久性（Hosted profile 无法接受——它承诺到一个没有 undo 备份的远端 Workspace，`hosted-workspace-tool-turn.ts:4641-4644`）。两者都不可接受。

**仅模型轮迁移（如 speculation 在 #17029 所做）。** 可以设想，但依然超重。Speculation 把它的轮迁到 `runModelRound(turnModelRound(chat, model, …))`，因为它拥有一个 `LlmChat` 并自行解析 chunk。Hosted 轮已经使用主会话 `LlmClient`——它正是共享循环的主会话轮来源——因此轮本身可以经由 `runModelRound(client, …)` 运行。但它仍然需要以下全部：

- 一个 durable-executor 适配器，在批处理边界供给 journal 化派发，并绕过共享批处理的 `finalizeToolResponses`/记录，使 journal 保持唯一记录权威；
- 新增 send option 以关闭 client 的 hook 触发，同时 harness 继续触发其 14 个 journal 化 hook，并调和 Stop-continuation 的发送类型；
- 轮数上限调和，保留 `HostedModelRoundLimitError` 与从 0 起算的 resume 边界；
- 在 `onModelEvent` 中保留持久 feed 撤回（#13319），并把 prepared-recovery 与 hook/tool 恢复路径保留为共享轮之外的 Hosted 包装。

这是比任何先前表面迁移都更大的表面 policy 面，且触及 Hosted Harness 赖以存在的持久性保证。其收益——一份循环实现——在今天并不足以抵过该风险。

## 建议

**不要在本计划轮次迁移 Hosted Harness。落地本评估，仅在其他表面收敛、且出现 durable-executor 适配器之后再重新审视迁移。** 理由基于上述代码：

- 统一循环计划的价值，在于为那些工具执行是内存调度器批处理的表面提供一份共享循环。Hosted Harness 的工具执行是 journal 化 exactly-once 恢复系统；它是工具执行持久化、而非内存 executor 的唯一表面，强行迁移要么用 Hosted 专属持久性污染 `packages/core`，要么削弱 Hosted profile 的保证。
- 其他表面（headless、ACP、Ink、OpenTUI、AgentCore、speculation）已迁移或在评审中，其默认翻转等待 nightly 统一循环 E2E 门禁。Hosted Harness 在被评估之前明确不在该门禁范围内；本文就是那次评估。
- 仅模型轮迁移是唯一可行形态，且它受阻于 durable-executor 适配器、新的 hook 归属 send option、轮数上限调和、以及撤回/恢复契约。每一项在 Hosted 默认可以改变之前都需要各自的 parity 证据。

本评估保留统一设计的建议：Hosted Harness 单独评估，本文即该评估的记录。它不新增开关、不改变默认、不移动任何代码。

## 留给后续的决定点

当重新审视迁移时，以下是它必须按序做出的决定：

1. **Executor 接缝。** `AgentLoopToolExecutor`（`agent-loop.ts:244`）能否包装 journal 化派发，使共享批处理供给调用并取回结果，同时 journal 保持唯一记录权威、且绕过共享的 `finalizeToolResponses`/`recordCompletedToolCall`？若不能，仅模型轮形态也不可行。
2. **Hook 归属。** 哪些 send option 为 Hosted 轮关闭 client 的 hook 触发，以及 Stop-continuation 发送类型（`ToolResult` 对 `Hook`）如何在不改变持久 feed 的前提下调和？每个 option 都是统一设计表中的一行过渡项。
3. **轮数上限。** 调和 `max > 0 && round >= max`（抛 `HostedModelRoundLimitError`）与共享的 `next_round`/`max_session_turns` 停止原因，保留从 0 起算的 resume 边界与调用方捕获的错误类型。
4. **撤回与恢复。** 在 `onModelEvent` 中保留 #13319 持久 feed 撤回，并把 prepared-recovery、hook-recovery 与 tool-recovery 路径保留为共享轮之外的 Hosted 包装。
5. **Parity 证据。** 一套 Hosted parity 套件必须在开关开启时证明：请求、持久 feed、journal 提交、hook occurrence 计数与恢复结果与当前循环一致（列出的差异除外）——包括批处理中途重启、以及一次撤回已投递前缀的 retry。

## 范围

- 在内：本评估、parity 差异记录、考虑过的迁移形态、建议、以及留给后续的决定点。
- 在外（若建议被推翻，则属后续）：实现、durable-executor 适配器、send option、开关及其 parity 测试。
