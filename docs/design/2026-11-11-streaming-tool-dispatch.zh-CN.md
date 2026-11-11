# 流式工具派发 —— 评估与设计

[English](2026-11-11-streaming-tool-dispatch.md) | [简体中文](2026-11-11-streaming-tool-dispatch.zh-CN.md)

- **状态**：评估完成；建议见下。这是 [event-bus agent 循环](2026-11-11-event-bus-agent-loop.zh-CN.md) 移植的第三片（PR 1 #16935 已合入，PR 2 #16938 评审中）。它是该设计所指名的「评估并决策」切片：记录 parity 差异与实现设计，并对是否/何时实现做出决断。
- **日期**：2026-11-11。行号引用在 `feat/event-bus-handlers`（PR 2 #16938，基于 `origin/main` `1fe1f197781c`）上核实。
- **行为来源**：`v1.0.0-preview` `587e3429cabf`，`event-bus/llm/inference-round.ts`、`event-bus/tool-handler.ts`、`tool-executor/`。

## 行为差异

main 把一个模型轮跑完、收集其工具调用，然后作为一批执行（`runAgentLoop` → `runModelRound` → `runToolBatch`）。preview 在**模型流仍在运行时**就把每个 `tool_use` 块派发给工具执行器（`inference-round.ts` 逐块发布 `llm.tool_use`；`tool-handler.ts` 在该事件上执行、在 `llm.settled` 上收尾）。收益是时延：工具在模型吐完剩余响应之前就开始。

## 代码实际要求什么（已核实）

流式派发不是「提前 schedule」。当前树里的三个事实决定了工作量：

1. **执行器接口形状不同。** main 的 `AgentLoopToolExecutor.run(requests, signal, hooks)`（`core/agent-loop.ts:163`）是批处理形：`createSchedulerExecutor`（`:623`）建一个 `CoreToolScheduler` 并以整批调 `schedule(requests, …)`，在 `onAllToolCallsComplete` 上 resolve。preview 的 `ToolExecutor` 是流式形：逐调用 `execute(block)`、`waitForExecutions(batch)`、`stopExecution(batch)`。流式路径需要一个新的执行器适配器，而不是在现有执行器上加个标志。

2. **`CoreToolScheduler` 可增量调度，但其完成信号是基于空闲的。** `schedule`（`coreToolScheduler.ts:3090`）在调度器运行中时把请求入队、空闲时排空。因此可以逐个喂入调用。但 `onAllToolCallsComplete` 在调度器带着全部已收尾调用进入空闲时就触发——这在流式调用之间就会发生。所以流式执行器必须自己跟踪 dispatched 与 settled 的 call id，仅当一个轮已收尾**且**每个 dispatched 调用都终态时才 resolve 该轮；不能只依赖 `onAllToolCallsComplete`。

3. **`runToolBatch` 不止是执行。** 它做去重/replay 抑制、surface 选择、launch 钩子、有序结果、`finalizeToolResponses`、以及带 Goal 溯源的录制（`core/agent-loop.ts:361`）。流式路径必须增量复刻所有这些——preview 用独立的流式 tool-executor 与 `completeToolExecutions` 实现，而不是调批处理函数。原样复用 `runToolBatch` 与流中派发不兼容。

## 流式路径引入的 parity 差异

| 关注点                 | 批处理（今天）                                                 | 流式                                                                                       | 后果                                                                                        |
| ---------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| 审批时机               | 整批在任何调用启动前审批                                       | 每个调用在流中到达时审批                                                                   | 拒绝更早落地、对后续流式调用影响不同；按批审批的 surface 必须适配                           |
| 重试 / 回退            | `Retry`/`ModelFallback` 在任何执行**前**丢弃已收集调用         | 重试前已派发的调用已经运行                                                                 | 已执行工具无法撤销；preview 保留它们（`dispatchedToolUseBlocks`），main 的丢弃契约不再成立  |
| 输出交错               | 模型流结束，然后工具输出                                       | 工具输出与剩余模型流交错                                                                   | UI 顺序改变；等价 harness 的有序回调日志会按设计不同                                        |
| 去重 / replay          | 调度前批级去重                                                 | 派发时逐调用去重                                                                           | 去重窗口缩小；replay 记账须移到派发时                                                       |
| Plan-mode 兄弟跳过     | 整批检查：`enter_plan_mode` 的所有兄弟调用（含先到的）都被跳过 | 后到的入口可能在先到的调用已运行后才到达，无法撤销                                         | 逐派发强制无法保住契约；需保守缓冲或显式放宽                                                |
| 批次级 hook / 输出预算 | `PostToolBatch` 每批一次、以该批已完成调用触发                 | 逐派发会变成逐调用触发（`[A]`、`[B]` 而非 `[A, B]`），改变按数量敏感的 hook 输出与停止决策 | 批次级 hook/预算/录制延迟到轮次结算、按整轮已完成调用一次性执行，否则把拆批列为额外语义变化 |

这些不是要修的 bug；它们就是流式的语义。重试那一行是承重的：它改变了 main 的 surface 与测试所依赖的一个正确性契约（重试即丢弃）。

## 实现设计（实现时）

- 一个 `StreamingToolExecutor` 适配器，每轮包一个 `CoreToolScheduler`：`dispatch(call)` 增量调度并记录 call id；`onToolCallsUpdate` 仅作进度。`settle()` 仅在每个 dispatched 调用都走过**最终完成**阶段（`onAllToolCallsComplete` 等价：资源释放、`PostToolBatch` 钩子、输出预算与录制）后 resolve，而非仅状态为终态。`cancel()` 中止轮 signal 并停止排队调用。
- 它增量复刻 `runToolBatch` 的去重/选择/launch 钩子/finalize/录制（preview `completeToolExecutions` 的对应物），且批次级 `PostToolBatch` 钩子、输出预算与录制在**结算时按整轮已完成调用一次性执行**（而非逐派发），从而保住批次级 hook 语义，并使**排除 plan-mode 批次**的非重试情形结果与录制与批处理路径一致。
- `runModelRound` 增加一个增量可选 `onToolCall` 回调（现有调用方不受影响）；流式开启时 Llm handler 逐收集调用发布 `llm.tool_call`；Tool handler 在 `llm.tool_call` 上派发、在 `llm.settled` 上收尾。**Conversation 不能保持不变**：它必须跟踪已派发调用并等待其最终结算，而非在 `model.stop` 或空调用列表时收尾——否则一次清空已收集调用的重试会在已派发工具仍在执行时就结束循环并丢失其结果。它还负责流式路径如何处理原有的 `tool.request`。
- 一个 `streamingToolDispatch` 选项，仅与 `useEventBus` 一起生效，默认关。当前四个未发射的总线事件（`llm.tool_call`、`tool.cancel`、`loop.output`、`loop.cancelled`）在此获得发射点。
- 重试后派发遵循 preview：已派发调用保留其结果；丢弃即重试契约对流式路径显式放宽，并逐 surface 记录。

## 建议（决断）

**本切片不实现流式派发。落地本评估，并把流式作为统一循环各 surface 收敛之后的一个独立 opt-in 实验切片来实现。** 理由，接地于上述代码：

- 架构移植（PR 1 + PR 2）交付了 event-bus 循环，自身成立；流式是可选的时延优化，不是前置条件。
- 流式改变一个正确性契约（重试即丢弃）与审批时机。现在就落地——而只有 headless 与部分 ACP 在共享循环上、等价 harness 也只覆盖这些——会在 parity harness 覆盖那些真正依赖批处理契约的 surface（Ink、OpenTUI、AgentCore、Hosted）之前就把语义锁死。
- 执行器适配器加上对 `runToolBatch` finalize/去重/录制的增量复刻，是一个 substantial、对正确性敏感的改动；它应配完整 parity harness 独立成片，而不是塞进架构移植里的原型。

实现时，它藏在 `streamingToolDispatch`（默认关）之后，重试后派发的放宽予以记录，并有一个等价测试：断言**排除 plan-mode 批次**的非重试情形结果 parity（其兄弟跳过边界须由保守缓冲保住），并显式钉住改变后的重试/审批语义、批次级 `PostToolBatch` hook/预算的作用域（结算时按整轮已完成调用执行），及「已派发→重试→无新调用」与「模型终止时仍有工具执行」的收尾路径。

## 决策点（供后续启用它的维护者）

1. 接受流式路径的重试后派发放宽（已执行工具在重试后存活）？
2. 接受逐调用流中审批时机，并适配按批审批的 surface？
3. 确认一旦 parity harness 覆盖所有 surface，时延收益足以证明新增执行器复杂度的合理性？

## 范围

- 在内：本评估、parity 差异记录、实现设计、建议。
- 在外（延后到实现切片）：`StreamingToolExecutor`、`onToolCall` 发射、`streamingToolDispatch` 标志、流式等价测试。
