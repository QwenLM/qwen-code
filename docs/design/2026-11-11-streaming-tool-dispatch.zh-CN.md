# 流式工具派发 —— 评估与设计

[English](2026-11-11-streaming-tool-dispatch.md) | [简体中文](2026-11-11-streaming-tool-dispatch.zh-CN.md)

- **状态**：2026-11-13 已决定：不在 #17045 中实现；实现连同下面的设计移到它的后续 issue。这是 [event-bus agent 循环](2026-11-11-event-bus-agent-loop.zh-CN.md) 移植的第三片（PR 1 #16935 已合入，PR 2 #16938 已合入）。它记录 parity 差异、决定和供后续 issue 使用的设计，并保留 2026-11-11 推迟实现的建议。
- **日期**：2026-11-11，决定于 2026-11-13。行号引用在 `main` `0207b03518` 上核实。
- **行为来源**：`v1.0.0-preview` `587e3429cabf`，`event-bus/llm/inference-round.ts`、`event-bus/tool-handler.ts`、`tool-executor/`。

## 行为差异

main 把一个模型轮跑完、收集其工具调用，然后作为一批执行（`runAgentLoop` → `runModelRound` → `runToolBatch`）。preview 在**模型流仍在运行时**就把每个 `tool_use` 块派发给工具执行器（`inference-round.ts` 逐块发布 `llm.tool_use`；`tool-handler.ts` 在该事件上执行、在 `llm.settled` 上收尾）。收益是时延：工具在模型吐完剩余响应之前就开始。

## 代码实际要求什么（已核实）

流式派发不是「提前 schedule」。当前树里的三个事实决定了工作量：

1. **执行器接口形状不同。** main 的 `AgentLoopToolExecutor.run(requests, signal, hooks)`（`core/agent-loop.ts:241`）是批处理形：`createSchedulerExecutor`（`:798`）建一个 `CoreToolScheduler` 并以整批调 `schedule(requests, …)`，在 `onAllToolCallsComplete` 上 resolve。preview 的 `ToolExecutor` 是流式形：逐调用 `execute(block)`、`waitForExecutions(batch)`、`stopExecution(batch)`。流式路径需要一个新的执行器适配器，而不是在现有执行器上加个标志。

2. **`CoreToolScheduler` 可增量调度，但其完成信号是基于空闲的。** `schedule`（`coreToolScheduler.ts:3094`）在调度器运行中时把请求入队、空闲时排空。因此可以逐个喂入调用。但 `onAllToolCallsComplete` 在调度器带着全部已收尾调用进入空闲时就触发——这在流式调用之间就会发生。所以流式执行器必须自己跟踪 dispatched 与 settled 的 call id，仅当一个轮已收尾**且**每个 dispatched 调用都终态时才 resolve 该轮；不能只依赖 `onAllToolCallsComplete`。

3. **`runToolBatch` 不止是执行。** 它做去重/replay 抑制、surface 选择、launch 钩子、有序结果、`finalizeToolResponses`、以及带 Goal 溯源的录制（`core/agent-loop.ts:503`）。流式路径必须增量复刻所有这些——preview 用独立的流式 tool-executor 与 `completeToolExecutions` 实现，而不是调批处理函数。原样复用 `runToolBatch` 与流中派发不兼容。

## 流式路径引入的 parity 差异

| 关注点                 | 批处理（今天）                                                                                             | 流式                                                                                       | 后果                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| 审批时机               | 整批在任何调用启动前审批                                                                                   | 每个调用在流中到达时审批                                                                   | 拒绝更早落地、对后续流式调用影响不同；按批审批的 surface 必须适配                           |
| 重试 / 回退            | `Retry`/`ModelFallback` 在任何执行**前**丢弃已收集调用                                                     | 重试前已派发的调用已经运行                                                                 | 已执行工具无法撤销；preview 保留它们（`dispatchedToolUseBlocks`），main 的丢弃契约不再成立  |
| 输出交错               | 模型流结束，然后工具输出                                                                                   | 工具输出与剩余模型流交错                                                                   | UI 顺序改变；等价 harness 的有序回调日志会按设计不同                                        |
| 去重 / replay          | 调度前批级去重                                                                                             | 派发时逐调用去重                                                                           | 去重窗口缩小；replay 记账须移到派发时                                                       |
| Plan-mode 兄弟跳过     | 整批检查：`enter_plan_mode` 的所有兄弟调用（含先到的）都被跳过                                             | 后到的入口可能在先到的调用已运行后才到达，无法撤销                                         | 逐派发强制无法保住契约；需保守缓冲或显式放宽                                                |
| Structured-output 选择 | headless `selectCalls` 读整批：同批出现 `structured_output` 时只运行这些调用，其它调用（含先到的）全部跳过 | 后到的 `structured_output` 可能在先到的调用已运行后才到达，无法撤销                        | 与 plan-mode 同形：逐派发无法保住契约；需保守缓冲或显式放宽                                 |
| 批次级 hook / 输出预算 | `PostToolBatch` 每批一次、以该批已完成调用触发                                                             | 逐派发会变成逐调用触发（`[A]`、`[B]` 而非 `[A, B]`），改变按数量敏感的 hook 输出与停止决策 | 批次级 hook/预算/录制延迟到轮次结算、按整轮已完成调用一次性执行，否则把拆批列为额外语义变化 |

这些不是要修的 bug；它们就是流式的语义。重试那一行是承重的：它改变了 main 的 surface 与测试所依赖的一个正确性契约（重试即丢弃）。下面保留给后续 issue 的设计，对它会提前启动的调用避开了每一行。

## 决定（2026-11-13）

2026-11-13 #17045 把流式派发作为 S 块接下来，范围收窄到只读且无需审批的调用。对照 main 核对后，这种收窄后的形式几乎省不下时间，所以不在 #17045 中实现。实现连同下面的设计移到后续 issue。决定基于三个发现：

- **在主要的 provider 路径上，调用很晚才到达 loop。** chat-completions 协议没有结束单个工具调用的事件：调用以按 `index` 区分的增量到达，只有回复的 `finish_reason` 能可靠地结束它们。因此 main 的转换层在 `finish_reason` 到达时才发出回复中的工具调用（`openaiContentGenerator/converter.ts:2058`）。把下一个 `index` 的出现当作上一个调用的结束并不安全，因为解析器还要处理交错或重复使用 index 的 provider。1.0 也是这样：它的 chat-completions 工厂只在 `finish_reason` 时关闭工具块，所以 1.0 在这条路径上同样不会提前派发。Qwen 和百炼的预设以及对拍套件的假服务器都走这条路径。Messages 和 Responses 协议用各自的事件结束每个调用（`content_block_stop`、`response.output_item.done`），1.0 的提前派发正来自这里；它的 Qoder provider 用的是 Responses。main 的 Anthropic、Responses API 和 Gemini 生成器也在每个调用完成时就发出它，但即使在那里，也只有回复中最后一个调用之前的调用能提前启动。
- **能提前运行的调用恰好是快的那些。** 读取和搜索工具以及只读的 shell 命令大多在一秒内就完成。慢的工具，例如 agent、需要询问的获取、会写入的命令，都被排除在外。
- **提前运行后被丢弃的那次运行并非不可见。** 读取会把文件记入文件读取缓存，之后编辑时检查是否先读过会查它；每次运行也都会写进工具调用日志。

评估中的三个决策点，按后续 issue 的做法答复如下：

1. **重试。** 丢弃契约保持不变。main 在 chat 层内部重试：被放弃那次尝试的调用从不写进历史，重试的那次尝试会重新发出它的调用，所以从被放弃的尝试保留下来的结果没有可配对的调用。遇到 `Retry` 或 `ModelFallback` 时，提前启动的调用如果还在运行就取消，结果丢弃，与今天批处理路径丢弃被放弃尝试的调用相同。
2. **审批。** 流式过程中不请求任何审批。只有不需要审批的调用才提前启动；其余调用都等回复结束后作为工具批运行，与今天相同。
3. **时延与复杂度。** 对今天 main 上收窄后的形式不值得。对于在流式过程中就结束每个调用的 provider 路径，或者要覆盖需要审批或会写入的调用时，值得再评估。

## 设计（供后续 issue 使用）

**哪些调用提前启动。** 一个回复中按流的顺序排在最前面的调用，直到第一个不符合条件的调用为止。这一轮中它之后的调用都不提前启动，因为工具批会在一个可能写入的调用之后才运行它们。符合条件的调用需要满足：

- 只读：读取、搜索或获取类工具，或者通过 scheduler 只读检查的 shell 命令；agent 虽然会被 scheduler 并行运行，但不在此列；
- 工具的默认权限和权限规则不经询问即允许它；这项检查不调用任何模型；
- 没有注册任何工具事件的 hook（PreToolUse、PostToolUse、PostToolUseFailure、PostToolBatch、PermissionRequest），也没有 Mod 的工具检查，因为它们可能询问、拒绝或替换调用的输入，而且触发时外部可见；
- 不是重放，也不是重复的 id。

**由工具批取用结果。** 提前启动的调用在到达时通过入口的 executor 运行。这一轮结束时，工具批照今天的方式运行：去重、`selectCalls`、按顺序对每个调用执行 `beforeToolLaunch`、结果和记录。工具批要启动的调用如果已经提前启动，它就取用这个调用的结果（还在运行就等待），只运行没有提前启动的调用。工具批不会启动的调用（`enter_plan_mode` 的同批调用、被 `structured_output` 挤掉的调用、宿主拒绝启动的调用、`--max-tool-calls` 预算），提前运行的结果被丢弃，这个调用按今天的方式处理。被丢弃的运行会花掉它的时间，并留下上面提到的影响。结果在这一轮结束后按工具批的顺序交给 `onToolResult`，因此设置开和关时宿主回调相同。提前运行时，调用的实时输出不会转发，而是随结果一起到达。

**事件。** 设置开启时，Llm handler 在流送达每个调用时发布 `llm.tool_call`，Tool handler 启动其中符合条件的调用。`tool.request` 仍在这一轮结束时携带这一轮的调用并运行工具批。某次尝试被放弃（`Retry`、`ModelFallback`）或请求失败时，如果有提前启动的调用还在运行，就发布 `tool.cancel`，由 Tool handler 取消它们。

**收尾与取消。** 每次尝试中提前启动的调用在一个由运行的工具 signal 派生的 signal 下执行，所以重试只取消这次尝试的调用，中止则取消全部。提前启动的调用还在运行时，运行不会结束：如果这一轮结束时没有工具批来取用这个调用（重试后没有剩下调用、请求失败、停止），就取消这个调用并等它结束，与今天等待工具批里的工具相同。中止之后，被取消运行的 10 秒上限（K 块，#17145）限制这段等待。

**入口。** headless 和 AgentCore 在调用 `runAgentLoop` 时就交出 executor，所以它们的轮次可以在流式过程中派发。Ink TUI 和 OpenTUI 只在 `onRoundEnd` 中交出 scheduler，ACP 分开运行模型轮和工具批；它们需要先能在一轮开始时交出 executor。

**设置。** `experimental.streamingToolDispatch`，默认关闭，只在内核上读取（`experimental.eventBusAgentLoop`）。测试比较它开和关，并钉住符合条件的前缀、提前启动的调用还在运行时发生重试、工具批不启动的调用，以及提前启动的调用还在运行时中止。

## 2026-11-11 的建议

2026-11-13 的决定维持这一决断：**本切片不实现流式派发。落地本评估，并把流式作为统一循环各 surface 收敛之后的一个独立 opt-in 实验切片来实现。** 理由，接地于上述代码：

- 架构移植（PR 1 + PR 2）交付了 event-bus 循环，自身成立；流式是可选的时延优化，不是前置条件。
- 流式改变一个正确性契约（重试即丢弃）与审批时机。现在就落地——而只有 headless 与部分 ACP 在共享循环上、等价 harness 也只覆盖这些——会在 parity harness 覆盖那些真正依赖批处理契约的 surface（Ink、OpenTUI、AgentCore、Hosted）之前就把语义锁死。
- 执行器适配器加上对 `runToolBatch` finalize/去重/录制的增量复刻，是一个相当大的、对正确性敏感的改动；它应配完整 parity harness 独立成片，而不是塞进架构移植里的原型。

上面的设计保住了两个契约，重试仍然丢弃，审批仍然按批进行，并由工具批直接取用提前运行的结果，而不是增量复刻 `runToolBatch`。

## 范围

- 在内：本评估、parity 差异记录、决定，以及供后续 issue 使用的设计。
- 在外（后续 issue）：实现、设置及其测试。
