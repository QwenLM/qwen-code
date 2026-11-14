# Hosted Harness 代理循环 —— 迁移评估

[English](2026-11-14-hosted-harness-loop-evaluation.md) | [简体中文](2026-11-14-hosted-harness-loop-evaluation.zh-CN.md)

- **状态**：仅评估；不做实现、不引入开关。本文记录 Hosted Harness 循环与共享代理循环之间的 parity 差异，并区分两条迁移路径：journal 化工具批处理必须保留，而模型轮可以作为独立的 opt-in 切片迁到共享 `runModelRound`。这是[统一代理循环](2026-10-23-unified-agent-loop.md)计划（跟踪 issue #15327）最后一个表面的评估——该设计明确将 Hosted Harness 留待「其他表面之后单独评估」。本文沿用[流式工具派发评估](2026-11-11-streaming-tool-dispatch.md)（#16949）的纯文档切片形态。2026-11-14 的首轮评审修正了两处前置条件——executor 适配器不是模型轮迁移的依赖、hook 隔离已经存在——本版本已反映这些修正。
- **日期**：2026-11-14，评审修正 2026-11-14。行号引用已在 `main` `af312d610143` 上核实。
- **行为来源**：`packages/cli/src/serve/hosted-harness-model.ts`（1,599 行）与 `packages/cli/src/serve/hosted-workspace-tool-turn.ts`（10,908 行）。
- **相关**：
  - [统一代理循环](2026-10-23-unified-agent-loop.md)——已接受的设计；其「Loops」表将 Hosted Harness 列为 `LlmClient` 加自触发 hook、以及 journal 化串行派发；
  - [Event-bus 代理循环](2026-11-11-event-bus-agent-loop.md)——共享循环的事件驱动实现；Hosted Harness 不在其已启用表面之列；
  - [流式工具派发评估](2026-11-11-streaming-tool-dispatch.md)——「推迟并附设计」评估切片的先例。

## 行为差异

共享代理循环（`packages/core/src/core/agent-loop.ts`）暴露两个接缝。`runModelRound`（`:401`）跑一个模型轮：把模型事件转发给表面、收集工具调用、返回停止原因。`runAgentLoop`（`:301`）驱动整个循环——若干轮加上在一个 `CoreToolScheduler`（`createSchedulerExecutor`，`:807`）上的 `runToolBatch`（`:512`），接着 `finalizeToolResponses`（`:709`）与记录（`:671`）。表面可任选其一：经 `runAgentLoop` 接管整个循环，或仅经 `runModelRound` 接管模型轮而保留自己的工具步骤。

Hosted Harness 在 `runPreparedHostedHarnessTextTurn`（`hosted-harness-model.ts:524`，经由 `runHostedHarnessTextTurn` `:380` 进入）中跑自己的循环。其轮循环（`:1174-1178`）发送模型请求、收集调用、在停止点自触发 Stop 与 MessageDisplay hook，然后把调用交给 `input.toolTurn.execute`（`:1564`）。该 tool turn 是 `HostedWorkspaceToolTurn`（`hosted-workspace-tool-turn.ts:2138`）：一个**持久化、journal 化、exactly-once、串行**的派发，而非内存中的调度器批处理。关键差异是分裂的：Hosted 的**工具执行**是一套共享工具批处理所不具备的恢复系统，但 Hosted 的**模型轮**已经就是共享轮所用的同一个 `LlmClient.sendMessageStream`。

## 代码实际要求（已核实）

当前代码树中有六个事实决定了这项工作的形态。每一条都是迁移必须保留的契约，而非可以丢弃的细节。

1. **共享轮接缝是仅模型轮的。** `runModelRound`（`agent-loop.ts:401`）调用模型来源、把每个事件转发给 `host.onModelEvent`、收集 `ToolCallRequest` 调用（丢弃被 `Retry`/`ModelFallback` 替换的那些），并返回 `{ turn, calls, stop }`。其文档注释写道「A surface that still runs its own tool step calls it directly」（`:396-400`）。它不跑 `runToolBatch`、`finalizeToolResponses`、记录或 `maxRounds` 检查——那些属于 `runAgentLoop`（`:301`）与 `runToolBatch`（`:512`）。ACP 已经这样用（`Session.ts:8992-9013`：轮不在共享工具批处理上时用 `runModelRound`），speculation 也把它的轮迁了上去（`speculation.ts:300-305`）。因此一个表面可以在不采用共享工具批处理的前提下采用共享模型轮。

2. **Hosted 模型轮是带持久 feed 撤回的 `LlmClient.sendMessageStream`，外加一个 prepared-recovery `Turn`。** 该轮调用 `client.sendMessageStream`（`hosted-harness-model.ts:1345`）并带 `retractDeliveredOutputOnRetry: true`（`:1353`）；遇到非 continuation 的 `Retry`（`:1381`）或 `ModelFallback`（`:1390`）时，从持久 feed 撤回孤儿前缀（`textDeltas.retract()`）并清空文本。这是 #13319 契约：已发布的 delta 无法事后剥离，因此已经投递内容的截断会重放请求并撤回前缀。`preparedRecovery` 则改为通过 `new Turn(client.getChat(), …).run(…)`（`:1331`）恢复一个 prepared 请求。共享 `runModelRound` 转发相同事件、并在 `Retry`/`ModelFallback` 时丢弃已收集的调用，但它没有持久 feed 或 prepared recovery 的概念；两者都必须落在表面的 `onModelEvent` 以及轮外层包装里。这些是模型轮迁移的依赖；完整清单见下文迁移形态。

3. **Hosted 工具批处理是持久化、journal 化、exactly-once 的串行派发。** `execute`（`hosted-workspace-tool-turn.ts:3439`）先跑 `executeNative`（`:4590`）再跑 `completeHookResults`（`:3450`）。`executeNative` 准备请求（allowlist、plan-mode、截断拒绝），然后在串行循环（`:6425`）中逐个派发：shell 走 broker（`execute` `:6952`、`executeV3` `:6889`）、memory（`:6550`）、子代理、team 工具、会话命令、question 与 plan exit，每个都把自己的 `tool_result` 提交进 journal。Exactly-once 依赖 journal 集合而非进程：`journaledToolResultIds`（`:1903`）读取以 `functionResponse` id 为键的持久 `tool_result` 记录，重放只跳过提交（`if (!journaled?.has(callId)) await this.commit('tool_result', …)`，`:8922`），而重放安全的 acceptance 仍会执行。诸如 `resumeAgentWaitRuns` 的恢复分支会为 checkpoint 仍欠的每个 run 重新进入等待。共享 `runToolBatch` 把整批调度到一个 `CoreToolScheduler` 上、对并发安全的调用并行执行。它在内存中去重并抑制重放（`agent-loop.ts:536-571`），但该状态无法在重启后存活：没有持久 journal、没有重启恢复。它无法在不丢失持久性的前提下替换这套派发——而持久性正是 Hosted Harness 的核心价值。这是工具批处理的阻塞项，与模型轮无关。

4. **十四个自触发 hook 已经与客户端隔离。** `HOSTED_EXPLICIT_HOOK_EVENTS`（`hosted-harness-model.ts:74-88`）列出十三个事件——SessionStart、SessionEnd、SessionDelete、UserPromptSubmit、UserPromptExpansion、Stop、StopFailure、MessageDisplay、PreToolUse、PostToolUse、PostToolUseFailure、PostToolBatch、PermissionRequest——此外 harness 还触发 InstructionsLoaded（`:849`、`:872`）。它自行触发这些 hook 并以 occurrence-id 去重（`hasCompletedOccurrence`，如 SessionStart `:837-842`）。隔离已经就位：harness 传给 `config.initialize` 的 managed dispatcher（`:668`）对 `HOSTED_EXPLICIT_HOOK_EVENTS` 中的每个事件都让 `hasHooksForEvent` 返回 `false`（`:598-604`）；`HookSystem.hasHooksForEvent` 委托给该 dispatcher（`hookSystem.ts:338-340`）；`config.hasHooksForEvent` 委托给 `HookSystem`（`config.ts:11882`）；而客户端的 Stop 分支仅在 `config.hasHooksForEvent('Stop')` 为真时触发（`client.ts:6048`）。因此客户端本来就看不到 Stop hook、也不会触发这十四个 hook——一个 Hosted 测试正是这样断言的（`hosted-harness-model.test.ts:2058`）。Stop continuation 由 Hosted 外层循环以 `SendMessageType.ToolResult` 发送（`:1346-1349`）。由于 `runModelRound` 原样传递 `round.options`、且不替换 dispatcher，把模型轮迁上去不会重复触发这些 hook，也无需新增 send option。

5. **轮数上限是第三个公式，且以抛错收场。** Hosted Harness 在 `maxRounds > 0 && round >= maxRounds`（`hosted-harness-model.ts:1187-1188`，`maxRounds = config.getMaxSessionTurns()` `:1173`）处停止并抛出 `HostedModelRoundLimitError`。`round` 从 0 起算，并从 `input.resumeModel?.round ?? input.initialRound ?? 0`（`:1175`）恢复。这不同于 `LlmClient` 的 `max > 0 && sessionTurnCount > max`（`client.ts:4995-4996`，yield 一个 `MaxSessionTurns` 事件），也不同于 `runAgentLoop` 的 `options.maxRounds !== undefined && rounds >= options.maxRounds`（`agent-loop.ts:337`，返回 `next_round` 停止原因）。三个边界、三种结果。就迁移而言：`runModelRound` 没有上限检查，因此仅模型轮迁移会原样保留 Hosted 外层循环的上限；只有完整迁到 `runAgentLoop` 才需要调和这三个公式与调用方捕获的错误类型。

6. **恢复与 resume 是一等公民。** 该轮从 `resumeModel.round` / `initialRound`（`:1175`）恢复，在 hook 有未完成操作（`HostedHookRecoveryRequiredError`，`:1181`）或设置了 hook stop reason（`:1183`）时拒绝启动，并把带未决工具结果的失败包装为 `HostedToolRecoveryRequiredError`（`:1577-1579`）。一个 client 发起的 skill 调用会在轮循环之前执行（`:1113`）。共享循环没有 resume 或恢复概念；这些将保留为任何共享轮之外的 Hosted 专属包装。prepared-recovery `Turn` 路径（事实 2）是模型轮迁移必须适配的部分。

## parity 差异及其归属

| 关注点                  | Hosted Harness（现状）                                                                                                        | 共享循环                                                                                                    | 归属                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 工具执行                | 持久化、journal 化、exactly-once 串行派发，带 broker 执行与重启恢复（`hosted-workspace-tool-turn.ts:6425`、`:1903`）          | 单个内存 `CoreToolScheduler` 批处理，对并发安全调用并行（`agent-loop.ts:807`）                              | **阻塞工具批处理迁移**：共享去重在内存中、而非持久 journal；tool turn 保留                |
| 记录 / finalize         | 每个分支把自己的 `tool_result` 提交进 journal；`completeHookResults` 读取 journal 化 hook 记录                                | `runToolBatch` 每批跑一次 `finalizeToolResponses`（`:709`）与 `recordCompletedToolCall`（`:671`）           | **阻塞工具批处理迁移**：journal 保持记录权威；共享 finalize/record 会重复记录             |
| Retry / fallback 撤回   | 从持久 feed 撤回孤儿前缀并清空文本（`:1353`、`:1381`、`:1390`）                                                               | 丢弃已收集调用，无持久 feed 副作用（`agent-loop.ts:441-444`）                                               | **模型轮依赖**：在 `onModelEvent` 中保留 #13319 撤回                                      |
| Prepared recovery       | 通过一个 `Turn` 恢复 prepared 请求（`:1331`）                                                                                 | `runModelRound` 经来源的 `sendMessageStream` 发送                                                           | **模型轮依赖**：经 `turnModelRound` 或包装适配                                            |
| Hook                    | 14 个自触发、journal 化 exactly-once；Stop continuation 以 `ToolResult` 发送（`:74-88`、`:1495`、`:1346`）                    | 客户端 hook 链，但 managed dispatcher 把这 14 个事件对其隐藏（`:598-604`）                                  | **已经隔离**：无需新 send option；Stop continuation 仍为 `ToolResult`，因为外层循环拥有它 |
| 轮数上限                | `max > 0 && round >= max`，抛 `HostedModelRoundLimitError`（`:1187`）                                                         | `runAgentLoop` 返回 `next_round`（`agent-loop.ts:337`）；client yield `MaxSessionTurns`（`client.ts:4995`） | **仅模型轮迁移时保留在 Hosted 外层循环**；只有完整迁移才调和它                            |
| Resume / 恢复、每轮准备 | resume、hook/tool 恢复、drain 用户消息、重新声明工具、刷新 system instruction（`:1175`、`:1181`、`:1189-1226`、`:1577-1579`） | 无此概念                                                                                                    | **仅模型轮迁移时保留在 Hosted 外层循环**                                                  |

前两行是承重的工具批处理阻塞项：Hosted 工具执行是一套持久性系统，而共享批处理不是。第三、四行是模型轮依赖。后三行在仅模型轮迁移中随 Hosted 外层循环与 tool turn 保留，因此不是它的前置条件。

## 考虑过的迁移形态

**完整迁移（迁到 `runAgentLoop`，模型轮与工具批处理）。** 受阻。共享 `runToolBatch` 无法拥有 journal 化 exactly-once 派发，除非要么在共享批处理内重新实现 journal（这会把 Hosted 专属持久性塞进 `packages/core`、强加给每个表面），要么丢弃持久性（Hosted profile 无法接受——它承诺到一个没有 undo 备份的远端 Workspace，`hosted-workspace-tool-turn.ts:4641-4644`）。两者都不可接受。

**仅模型轮迁移（迁到 `runModelRound`，保留 Hosted 外层循环与 tool turn）。** 可行——这正是 ACP 与 speculation 的形态。Hosted 轮已经使用主会话 `LlmClient`——它正是共享轮的主会话来源——因此可以经由 `runModelRound(client, …)` 运行，同时外层循环保留轮数上限、每轮准备、Stop/MessageDisplay hook、resume/recovery 路径、以及 `input.toolTurn.execute`。其真实依赖是：

- 在 `onModelEvent` 中保留持久 feed 撤回（#13319）（事实 2）；
- 适配 prepared-recovery `Turn` 路径，经 `turnModelRound` 或包装（事实 2 与 6）；
- 把 `runModelRound` 返回的调用与停止原因映射回外层循环，包括目前在 `Finished`/`ModelFallback` 上做的 usage 与 model-scope 处理；
- 上述各项的 parity 证据。

它**不**依赖 durable-executor 适配器（工具批处理保留）、不依赖新的 hook send option（dispatcher 已隔离 hook，事实 4）、也不依赖轮数上限调和（外层循环保留其上限，事实 5）。那些属于完整迁移、或已被处理。本评估的早期草稿曾把它们列为模型轮阻塞项；2026-11-14 的评审修正了这一点，上面的区分即修正结果。

## 建议

**保留 journal 化工具批处理；仅迁移模型轮，作为独立的 opt-in 切片。** 理由基于上述代码：

- Hosted 工具执行是 journal 化 exactly-once 恢复系统；共享内存批处理无法替换它，除非用 Hosted 专属持久性污染 `packages/core`、或削弱 Hosted profile 的保证。因此 Hosted Harness 不会完整收敛到 `runAgentLoop`，工具批处理迁移保持推迟。
- Hosted 模型轮已经就是共享的 `LlmClient` 轮。把它迁到 `runModelRound`、同时保留外层循环与 tool turn，正是 ACP 与 speculation 已在用的形态。它可行，且不受制于 executor 适配器或 hook send option。其真实工作是撤回、prepared-recovery 与停止原因映射的适配，外加 parity 证据。
- 本 PR 是评估：不新增开关、不改变默认、不移动任何代码。仅模型轮的实现及其 parity 套件是后续切片；工具批处理迁移仍推迟。

## 留给后续的决定点

1. **模型轮依赖（真实工作）。** 在 `onModelEvent` 中保留 #13319 持久 feed 撤回；适配 prepared-recovery `Turn` 路径；把返回的调用与停止原因、以及 usage/model-scope 处理映射回 Hosted 外层循环。
2. **Hook 归属。** 已经由 managed dispatcher 过滤隔离；采用共享模型轮无需 send option。只有当某次迁移想把 hook 归属移交给客户端时，这才是一项需要单独论证的选择，且它会改变持久 feed 与 occurrence-id 语义。
3. **工具批处理接缝（仅当工具批处理真要迁移时）。** `AgentLoopToolExecutor`（`agent-loop.ts:244`）能否包装 journal 化派发，使 journal 保持唯一记录权威、且绕过共享的 `finalizeToolResponses`/`recordCompletedToolCall`？这不是仅模型轮路径的前置条件。
4. **轮数上限（仅完整迁到 `runAgentLoop` 时）。** 调和 `max > 0 && round >= max`（抛 `HostedModelRoundLimitError`）与共享的 `next_round`/`max_session_turns` 停止原因，保留从 0 起算的 resume 边界与调用方捕获的错误类型。仅模型轮路径保留 Hosted 上限。
5. **Parity 证据。** 一套 Hosted parity 套件必须在开关开启时证明：请求、持久 feed、journal 提交、hook occurrence 计数与恢复结果与当前循环一致（列出的差异除外）——包括一次撤回已投递前缀的 retry、以及一次 prepared-recovery resume。批处理中途重启属工具批处理关注点，且因 tool turn 保留而不变。

## 范围

- 在内：本评估、parity 差异记录、两条迁移路径及其真实依赖、建议、以及留给后续的决定点。
- 在外（后续）：仅模型轮的实现、其开关及其 parity 测试；工具批处理迁移（仍推迟）。
