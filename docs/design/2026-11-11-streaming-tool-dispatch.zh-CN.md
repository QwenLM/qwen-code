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

3. **`runToolBatch` 不止是执行。** 它做去重/replay 抑制、入口选择、启动钩子、有序结果、`finalizeToolResponses` 和带 Goal 溯源的记录（`core/agent-loop.ts:503`）。后续实现需要在批次准备启动调用时接入提前执行的结果，让批次继续负责这些决策和轮次收尾。

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

上表描述不加限制的流式派发会改变的行为。后续设计保留现有的审批时机和批次结果处理。批次仍可能跳过已花时间执行的读取，这次读取也可能留下工具调用日志。

## 决定（2026-11-13）

2026-11-13，#17045 将流式派发纳入 S 块，范围限定为只读且无需审批的调用。评估发现，主要 provider 路径能节省的时间有限。实现移到后续 issue，采用下文的设计。

- **Chat Completions 在结束帧发出工具调用。** Qwen 和百炼的预设以及对拍套件的假服务器使用该协议。Main 的转换层在 `finish_reason` 到达时一次性发出调用（`openaiContentGenerator/converter.ts:2058`）。Provider 可能交错或复用索引，因此不能把下一个 `index` 当作调用边界。Preview 同样在 `finish_reason` 关闭工具块，此时执行可以与用量帧等流尾数据的接收重叠。
- **生成器及时转发调用时，单调用结束事件才有帮助。** Preview 可以根据 Messages 的 `content_block_stop` 和 Responses 的 `response.output_item.done` 派发调用。它的 Qoder provider 使用 Responses。Main 的 Anthropic 生成器会缓存已完成的调用，成功响应要等停止原因到达才发出（`anthropicContentGenerator/anthropicContentGenerator.ts:1610`）。Responses 转换层在 `response.output_item.done` 发出调用（`openaiResponsesContentGenerator/responses-converter.ts:278`）。即使是唯一或最后一个调用，也能和 `response.completed` 之前的工作重叠。Gemini 直接转发 SDK 的流式分片，可重叠的时间取决于分片何时携带完整调用。
- **符合条件的调用范围有限。** 读取、搜索和前台只读 shell 命令可提前启动。Agent、需要审批的获取工具、会写入的命令和后台命令等到批次执行。
- **丢弃结果可能影响后续调用。** 完整的 `read_file` 在结果进入历史前就会更新文件读取缓存。结果被丢弃后，再读同一文件可能返回 `file_unchanged`，指向模型从未见过的正文，后续编辑也可能通过先读检查。执行还可能留下工具调用日志。

评估中的三个决策点，按后续 issue 的做法答复如下：

1. **重试。** 丢弃契约保持不变。main 在 chat 层内部重试：被放弃那次尝试的调用从不写进历史，重试的那次尝试会重新发出它的调用，所以从被放弃的尝试保留下来的结果没有可配对的调用。遇到 `Retry` 或 `ModelFallback` 时，提前启动的调用如果还在运行就取消，结果丢弃，与今天批处理路径丢弃被放弃尝试的调用相同。
2. **审批。** 流式过程中不请求任何审批。只有不需要审批的调用才提前启动；其余调用都等回复结束后作为工具批运行，与今天相同。
3. **时延与复杂度。** 对今天 main 上收窄后的形式不值得。对于在流式过程中就结束每个调用的 provider 路径，或者要覆盖需要审批或会写入的调用时，值得再评估。

## 设计（供后续 issue 使用）

**哪些调用提前启动。** Headless 通过 `--max-tool-calls` 或 `model.maxToolCalls` 配置有限预算时走正常批处理。预算限制实际执行次数，事后丢弃结果无法挽回超额执行。符合条件的运行按流的顺序派发回复开头的调用，遇到第一个不符合条件的调用就停止，以免后续读取越过可能写入的调用。每个提前启动的调用都须满足以下条件。

- 执行读取、搜索或获取，或运行通过 scheduler 只读检查的前台 shell 命令。后台 shell 调用（`is_background: true`）会注册任务、将输出写入磁盘，并使用独立于本次尝试的 signal。Agent 调用也等到批次执行。
- 通过入口原有的执行准入检查，包括 AgentCore 的工具声明和执行白名单检查。Scheduler 的完整权限判断必须允许直接执行，无需确认或调用模型。凡是无法在本地确定可直接执行的调用，都留给批处理，包括 `AUTO` 模式下因 `permissions.autoMode.classifyAllShell` 而必须交给分类器的 shell 调用。
- 没有注册任何工具事件的 hook（PreToolUse、PostToolUse、PostToolUseFailure、PostToolBatch、PermissionRequest），也没有 Mod 的工具检查。它们可能询问、拒绝或替换调用的输入，且触发时外部可见。
- 调用 ID 在本次尝试中首次出现，且调用通过现有的重放检查。

**由工具批取用结果。** 执行器适配器在符合条件的调用到达时启动它，并暂存结果和输出。轮次结束后，工具批继续负责去重和 `selectCalls`。在正常的启动环节，按批次顺序对选中的调用各执行一次 `beforeToolLaunch`，包括已经提前启动的调用。适配器在此处交付提前执行的结果，必要时等待完成，其余调用照常运行。工具批跳过调用时，例如 `enter_plan_mode` 的同批调用、被 `structured_output` 排除的调用，或宿主拒绝启动的调用，丢弃提前结果并采用正常的批处理结果。批次按原有顺序通过 `onToolResult` 交付接纳的结果。已接纳调用的入口通知和暂存输出按正常批处理阶段发出。被丢弃的调用仍可能留下执行日志。

**读取缓存。** 提前读取产生的缓存更新在共享文件读取缓存之外暂存。批次接纳结果时，先提交供先读检查使用的更新，再运行依赖该读取的后续批次工作。使用读取时捕获的文件身份和指纹，并遵循尝试期间的缓存失效。正文进入模型历史后，再标记读取结果在历史中可用。结果被拒绝或所在尝试被放弃时，一并丢弃暂存的更新。

**事件。** 设置开启时，Llm handler 在流送达每个调用时发布 `llm.tool_call`，Tool handler 启动其中符合条件的调用。`tool.request` 仍在轮次结束时携带该轮调用并运行工具批。尝试被放弃（`Retry`、`ModelFallback`）或请求失败时，用 `tool.cancel` 取消提前调用。按运行、轮次和尝试定位提前调用及其结果，确保重试复用调用 ID 时取不到已丢弃的结果。

**收尾与取消。** 每次尝试提前启动的调用使用从运行的工具 signal 派生的 signal。重试取消被放弃的尝试，运行中止取消所有尝试。取消批次跳过的调用，以及轮次停止而没有进入批次的调用，并持续跟踪尚未结束的提前调用，直至清理完成。Handler 抛错时，循环适配器保留原始错误，取消未完成的提前调用，等待收尾，再抛出错误并清理总线。K 块（#17145）的计时器由运行中止触发，因此运行 signal 尚未中止时，终止清理也须有 10 秒上限。运行已中止时沿用已有截止时间。到期时交付已记录的终止结果，并丢弃迟到的结果和通知。

**入口。** 内核在轮次开始前创建 headless 的默认执行器，headless 可以基于它接入。AgentCore 也在轮次开始前提供执行器。启用前，执行器须改用传入的尝试 signal，并将直接发布的 `TOOL_CALL` 和 `TOOL_RESULT` 事件留到批次接纳调用后再发。这两个事件会进入 AgentCore 的会话记录。Ink TUI 和 OpenTUI 在 `onRoundEnd` 中交出 scheduler，ACP 分开运行模型轮和工具批。这些入口须先能在轮次开始时提供执行器。

**设置与验收测试。** `experimental.streamingToolDispatch` 默认关闭，只在内核上读取（`experimental.eventBusAgentLoop`）。对照开关两种状态，验证符合条件的调用前缀、启动钩子的调用次数和结果顺序。验证只读后台 shell、`AUTO` 模式下须经分类的 shell，以及 AgentCore 未声明或禁止执行的工具都不会提前启动。覆盖 headless 的有限预算（含零）、完整读取结果被丢弃后再次读取同一文件，以及调用被跳过时 AgentCore 会话记录的一致性。验证重试复用尚在执行的调用 ID、有提前调用在执行时中止，以及运行 signal 尚未中止、执行器忽略取消时的请求抛错。检查原始错误仍可返回，且清理在截止时间内完成。

## 2026-11-11 的建议

2026-11-13 的决定维持这一决断：**本切片不实现流式派发。落地本评估，并把流式作为统一循环各 surface 收敛之后的一个独立 opt-in 实验切片来实现。** 理由，接地于上述代码：

- 架构移植（PR 1 + PR 2）交付了 event-bus 循环，自身成立；流式是可选的时延优化，不是前置条件。
- 初始评估确定，接入流式派发前要核对重试、审批和输出顺序这三项批处理契约。后续 opt-in 实现需要为每个启用的入口提供等价性证据。
- 执行器适配器、缓存暂存和失败清理需要独立的验收测试。结果收尾、去重和记录仍由工具批负责。

上面的设计保住了两个契约，重试仍然丢弃，审批仍然按批进行，并由工具批直接取用提前运行的结果，而不是增量复刻 `runToolBatch`。

## 范围

- 在内：本评估、parity 差异记录、决定，以及供后续 issue 使用的设计。
- 在外（后续 issue）：实现、设置及其测试。
