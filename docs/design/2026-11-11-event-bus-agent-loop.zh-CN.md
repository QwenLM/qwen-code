# 事件总线 agent 循环

[English](2026-11-11-event-bus-agent-loop.md) | [简体中文](2026-11-11-event-bus-agent-loop.zh-CN.md)

- **状态**：PR 1–3 已合入（#16935 原语、#16938 handler、#16949 流式评估）；PR 4（headless opt-in 设置）已在 #16994 合入；从统一 loop 的 PR 5c 起，同一设置下 AgentCore 的轮次也跑在内核上；不改变任何 surface 的默认行为。
- **日期**：2026-11-11，基于 `origin/main` `da270e434957`。
- **关联**：
  - [Unified agent loop](2026-10-23-unified-agent-loop.zh-CN.md) —— 本设计对其做内部架构升级的已批准设计；跟踪 issue #15327，#15343 批准，headless 已在 #15369 合入，ACP 模型轮已在 #15509 合入；
  - 被移植架构的来源：`v1.0.0-preview` 分支 `587e3429cabf`，`packages/core/src/event-bus/`（20 个文件，6,237 行）；
  - preview 移植试点 issue #16896（file-history 硬化）—— 另一条更小的独立线。

## 问题

共享 agent 循环（`packages/core/src/core/agent-loop.ts`，660 行）是一个过程式 `for` 循环：`runModelRound` → `runToolBatch` → 续跑，所有 surface 决策都表达为 `AgentLoopHost` 上的可选回调。作为统一循环收敛的第一步这是对的：它让七个副本迁到同一实现的同时，每个 surface 适配器照常工作。

`v1.0.0-preview` 分支把同样的循环重新表达为事件驱动状态机，其形态具备过程式循环没有的性质：

- **显式事件词汇。** 十个总线事件（`query.submitted/output/cancelled/finished`、`llm.request/tool_use/settled`、`tool.cancel/settled`、`handler.failed`）为每次状态转换命名。过程式循环里同样的状态转换隐含在控制流中，新增循环级行为必须穿过函数主体接线。
- **投递保证。** 总线对同一订阅者同一 query 按发布顺序串行投递，不同 query 互不阻塞。监听器抛错会变成 `handler.failed` 事件，而不是未处理的 rejection。今天的回调除了「抛错即结束循环」外没有顺序与失败语义。
- **写者所有权。** 每 query 的状态被切分：Conversation 拥有决策与上下文，Llm 拥有选择与模型结果，Tool 拥有派发批次。过程式循环让三个关注点共享可变局部变量。
- **轮次作用域。** 轮次作用域事件携带 `roundId`；被放弃轮次的迟到事件由构造即丢弃（`currentRound`）。过程式循环靠临时检查处理（例如 `Retry`/`ModelFallback` 时丢弃已收集的调用）。
- **有界收尾。** 取消与消费者关闭在一个上限内收尾（preview 为 10 秒），而不是等待卡死的 handler。

我们希望 main 的共享循环获得这些性质，同时不打断已在进行的收敛，也不引入第二个相互竞争的循环。

## 当前行为

### main（在 `da270e434957` 核实）

| 关注点       | 位置                                                                                                                                               | 形态                                                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 共享循环     | `core/agent-loop.ts:200` `runAgentLoop`                                                                                                            | 过程式 `for`；停止原因 `AgentLoopStopReason`（`:40`）                                                      |
| 模型轮       | `core/agent-loop.ts:262` `runModelRound`                                                                                                           | `LlmClient.sendMessageStream` 生成器；事件转发 `host.onModelEvent`；`Retry`/`ModelFallback` 丢弃已收集调用 |
| 工具批       | `core/agent-loop.ts:351` `runToolBatch`                                                                                                            | 去重/replay → `host.selectCalls`/`beforeToolLaunch` → 执行器 → `finalizeToolResponses`                     |
| 执行器接缝   | `core/agent-loop.ts:162` `AgentLoopToolExecutor`                                                                                                   | 可替换；默认包一个 `CoreToolScheduler`（`:613`）                                                           |
| Surface 接缝 | `core/agent-loop.ts:110` `AgentLoopHost`                                                                                                           | 可选回调，不是订阅                                                                                         |
| 模型事件     | `core/turn.ts:78` `LlmEventType`（21 种），`Turn`（`:752`）                                                                                        | 已是规范化事件流                                                                                           |
| 现有总线     | `confirmation-bus/message-bus.ts:15` `MessageBus`；`agents/runtime/agent-events.ts:296` `AgentEventEmitter`；`packages/acp-bridge/src/eventBus.ts` | hooks 请求/响应；subagent 作用域事件；带 replay 的传输层 fan-out —— 都不是循环控制总线                     |

各 surface：headless 跑 `runAgentLoop`（已合入，#15369）；ACP 用 `runModelRound` 加自己的工具步（#15509 已合入）；Ink TUI（`use-llm-stream.ts`）、OpenTUI、AgentCore、speculation 与 Hosted Harness 仍跑各自的循环，由 unified-agent-loop 迁移计划管辖。

### preview（在 `587e3429cabf` 核实）

`packages/core/src/event-bus/`：

- `bus.ts`（147 行）—— `QueryEventBus`：类型化发布/订阅，按 `queryId` 路由，按 `(订阅者, query)` 串行 promise 链，监听器失败重发布为 `handler.failed`，`eventId` 标识（供消费方去重，总线本身不去重）。
- `events.ts`（114）—— 事件映射与原因枚举（`RequestReason`、`LlmFailureKind`、取消原因）。
- `state.ts`（292）—— `QueryStateStore` 与上述所有权切分。
- `conversation-handler.ts` + `conversation/`（约 2,400）—— 唯一决策者：submit、model-settled、tool-settled、失败收尾。
- `llm-handler.ts` + `llm/`（约 2,100）—— 每个 `llm.request` 一次模型请求：准备、推理、结果分类。
- `tool-handler.ts`（347）—— 通过注入的 `ToolExecutor` 执行派发调用；取消与等待竞速（`waitOrStop`）。
- `query-stream.ts`（534）—— 把总线桥成 `AsyncGenerator<QueryEvent, Terminal>`，四种取消源与 10 秒收尾上限。
- `core/agent-loop.ts`（85）—— 入口只做校验并委托。

preview 的两个行为**故意不**进入首次移植：流式工具派发（`tool_use` 块在模型流仍在运行时即执行）与 qoder 业务上报路径。两者都改变 main 今天没有的语义；见「范围」。

## 目标与范围

目标：

- 把总线、事件词汇、状态库与 handler 分解移植进 `packages/core`，作为**现有共享循环的内部架构**。
- 统一循环的每个对外契约保持不变：`runAgentLoop`、`runModelRound`、`runToolBatch`、`AgentLoopHost`、`AgentLoopToolExecutor`、`AgentLoopOptions`、`AgentLoopResult`，以及 `experimental.unifiedAgentLoop` 灰度。
- 每一步都保持统一循环 parity 套件绿；surface 无感知。
- 架构按可评审切片落地，每片自带测试。

范围之外：

- 第二个循环或新的 `query()` 入口。统一设计的「一个实现」目标不变。
- `LlmChat`、`Turn`、provider 层与 `CoreToolScheduler` 内部 —— handler 包装它们，不重写。
- 历史/transcript 模型、hooks（留在 `MessageBus`）、压缩、telemetry、UI 与线缆协议。
- preview 的 qoder business-info/上报、`protocol/`、`provider/`、`compression-v2/` 模块 —— main 保留自己的对应物。
- 首次移植中的流式工具派发（Phase 3 单独评估，独立门控）。
- surface 迁移本身（TUI、OpenTUI、AgentCore、speculation、Hosted）—— 仍归 unified-agent-loop 计划；本设计只改变共享循环的内部形态。

## 设计

### 分层

```text
Surfaces（不变）：AgentLoopHost 回调、AgentLoopToolExecutor、scheduler 接线
   ▼
runAgentLoop（签名不变）—— 适配器：hosts ↔ 总线订阅
   ▼
event-bus/（新增，packages/core/src/event-bus/）
   bus.ts          LoopEventBus：路由、串行投递、handler.failed
   events.ts       基于 main 类型的循环事件词汇
   state.ts        每 run 状态，写者所有权
   conversation.ts 决策：续跑 / 停止 / 下一轮
   llm.ts          每个 llm.request 一个模型轮（包装 runModelRound）
   tool.ts         每轮一个批次（包装 runToolBatch）
   ▼
LlmClient → Turn → LlmChat、CoreToolScheduler（不变）
```

适配器是兼容边界：它负责创建 run 状态，并只订阅 `loop.finished`/`handler.failed`。**由 handler** 按过程式顺序 firing `AgentLoopHost` 回调——Conversation firing 边界回调（`onRoundStart`/`onRoundEnd`/`nextRound`），Llm 与 Tool 通过 `runModelRound`/`runToolBatch` 驱动其余回调——并把抛错的 host 回调转成循环的 error 结局，与今天「抛错即结束循环」一致。保持的是回调**顺序**而非精确 tick：首个回调在 `runAgentLoop` 返回后一个总线投递跳才触发，而非在调用内同步触发——标志关闭时没有 surface 能观察到这一点。本设计中 surface 永远看不到总线。向 surface 暴露订阅是可能的后续步骤，不是这里的目标。

### 身份与事件映射

preview 按 `queryId` 路由、用 UUID `roundId` 标记轮次。main 的循环每次交互跑一次，带 `promptId` 与数字轮次计数。移植保留 main 的身份：

- `runId`：在 `runAgentLoop` 入口生成；路由键（一个 run = preview 的一个「query」）。`promptId` 只是归属信息，随事件携带，绝不作路由键 —— drain 轮可能跨 run 复用同一 prompt id。它是 **run 级**的：取自 `first.promptId` 一次设定，因此即使 host 的 `nextRound` 返回不同的 promptId，续跑轮次的事件仍带 run 的首个 `promptId`（host 回调报告该轮的 `promptId`）。`promptId` 是否应改为跟随轮次，是暴露订阅那个切片要定的决策。
- `round`：run 的轮次编号，由 Conversation 发布 `llm.request` 时赋值。迟到事件由同样的 `currentRound` 检查丢弃。

| 总线事件         | 载荷（main 类型）                      | 发布者                          |
| ---------------- | -------------------------------------- | ------------------------------- |
| `loop.started`   | `{ promptId }`                         | 适配器，状态创建后              |
| `loop.cancelled` | `{ reason: 'abort' }`                  | 适配器，signal 中止时           |
| `loop.finished`  | `{ result: AgentLoopResult }`          | Conversation                    |
| `llm.request`    | `{ round, send: AgentLoopRound }`      | Conversation                    |
| `llm.tool_call`  | `{ call: ToolCallRequestInfo }`        | 规划中（流式切片）              |
| `llm.settled`    | `{ round }`                            | Llm，轮结束时                   |
| `tool.request`   | `{ round, calls }`                     | Conversation，`onRoundEnd` 之后 |
| `tool.cancel`    | `{ reason }`                           | 规划中（流式切片）              |
| `tool.settled`   | `{ round }`                            | Tool，批结束时                  |
| `handler.failed` | `{ source, eventType, round?, error }` | 总线，监听器失败时              |

标记*规划中*的事件已在词汇表中，但尚未发射；它们随流式派发（#17045 S 块）到来。preview 的 `query.output` 在这里没有对应：main 的各入口通过宿主回调得知轮次的内容，因此 `loop.output` 已从词汇表中删除，等有使用方时再加。

`llm.settled` 是轮结束信号；终止分类（今天 `runModelRound` 做的 `STOP_EVENTS` 映射）存于 run 状态（`state.model.stop`），Conversation 是把该轮末状态转成循环结果的唯一位置。去重/replay 记账留在 Tool handler，使用现有 `toolCallIdUtils` 助手，位置与今天 `runToolBatch` 完全一致。事件载荷只携带路由与决策数据；完整的模型结果与工具批按所有权存于 run 状态的对应槽位，总线不重复承载它们。

### 状态与所有权

每 run 一个状态对象，由适配器创建、run 收尾时删除：

- **Conversation** 写：当前轮、续跑决策、最终结果。
- **Llm** 写：该轮的 model 槽位 —— 收集的调用、turn、以及任何终止停止原因。
- **Tool** 写：该轮已收尾的工具批。

状态库拒绝同一 `runId` 的二次创建；`currentRound(state, round)` 对迟到事件返回 undefined —— 与 preview 让被放弃轮次无害化的构造相同。

### 投递与失败

总线（`LoopEventBus`）基本原样移植（只依赖一个 logger）：按 `(订阅者, runId)` 串行链、跨 run 隔离、`handler.failed` 重发布，以及供消费方去重的 `eventId` 标识 —— 总线本身不去重，相同 id 的两次发布都会投递。两处适配：

- logger 换成 main 的 `debugLogger` 约定（main 没有 `runLogger`）。
- 在 `handler.failed`（含来自 **host 回调**）时，适配器以**原始抛值**拒绝，保持今天「抛错即结束循环」的语义；`source` 字段仅存在于事件载荷中（供日志），适配器拒绝时丢弃它，不会传给调用方。

### 取消

handler 按今天的方式读取 run 的 `signal` 与 `toolSignal` 并传给 `runModelRound`/`runToolBatch`；Tool 通过执行器 signal 取消在飞批次，Conversation 在 Llm 与 Tool 安静后收尾一次。run 在 `loop.finished` 到达时结算。

signal 中止时，适配器发布一次 `loop.cancelled`。Conversation 在独立的投递队列中启动 10 秒收尾计时器，因此等待轮次结束回调时也能启动计时。上限内按过程式循环处理取消，入口要求保留被打断批次的结果时仍会保留。到上限仍未结算时以 `cancelled` 结束，不带工具结果。挂起的 handler 恢复时会停止读取模型流、拒绝后续工具启动，并在循环边界丢弃工具进度和结果。已经开始的工具或回调仍可能执行完毕。运行结算后，适配器移除 abort 监听并清除计时器。过程式路径会等待模型轮或工具批结束。

`runAgentLoop` 返回 promise。暴露事件流的入口可以在消费方停止读取时中止对应运行。OpenTUI 为模型流使用本轮的 signal，工具批次继续使用父 turn 的 signal，因此同一个 turn 的多个轮次共享工具资源额度。提供方关闭流时卡住也受上限约束。handler 在上限内结算并失败时，仍以原始错误拒绝。

达到上限后，默认调度器和各入口自己的调度器停止转发工具进度和结果，调度器仍可完成清理。批量结果整理在开始持久化前和每次写入后检查运行状态。

### 为什么不复用现有总线

- `MessageBus`（confirmation-bus）：同步 `EventEmitter`、请求/响应关联、无按 run 串行、无失败事件；今天只承载 hooks。其用途是策略消息，不是循环控制。
- `AgentEventEmitter`：词汇与生命周期都限于 subagent 运行时。
- acp-bridge `eventBus`：带 replay 环与字节预算的传输层 fan-out；它位于循环之上，不在循环之内。

没有任何一个提供 query 路由 + 串行异步投递 + 失败事件，而这些正是被移植的性质。新模块约 300 行原语；handler 是对 `agent-loop.ts` 已有逻辑的重新表达，不是新行为。

## 迁移（PR 切片）

每个切片保持 parity 套件绿，不改变任何 surface 默认。

1. **PR 1 —— 原语。** `event-bus/{bus,events,state}.ts` + 单元测试（移植 preview 的 `bus.test.ts`；新增串行投递、跨 run 隔离、失败重发布、迟到轮次测试）。尚无消费方；零行为变化。本设计文档随此 PR 落地。`runtime.ts`（handler 接线）与 `handler-support.ts` 随 PR 2 的 handler 一起到来。
2. **PR 2 —— opt-in 标志后的 handler。** 把 `runAgentLoop` 内部重新表达为 Conversation/Llm/Tool handler 加 host 适配器，由新增的 `AgentLoopOptions.useEventBus` 标志选择（默认关，因此在统一循环内过程式路径仍是默认，直到 parity 被证明）。`runModelRound`/`runToolBatch` 保留导出与签名（ACP #15509 依赖它们），并被 handler 原样复用。一个等价测试对脚本化场景同时跑两条路径，断言结果与 host 回调顺序完全一致；headless parity 套件与 ACP 轮测试是验收门。
3. **PR 3 —— 流式派发评估（可选，独立门控）。** preview 在流仍在运行时执行 `tool_use` 块。main 在轮结束后跑批次，且审批按批排序；流式派发改变审批时机与输出交错。此切片先写下 parity 差异并取得明确决定；架构移植本身不依赖它。
4. **PR 4 —— headless opt-in。** `experimental.eventBusAgentLoop` 设置（环境变量覆盖 `QWEN_CODE_ENABLE_EVENT_BUS_AGENT_LOOP=1`，由 `Config.isEventBusAgentLoopEnabled()` 读取）最先让 headless 的共享循环轮次传入 `useEventBus`。AgentCore 和 OpenTUI 在统一循环迁移的后续阶段接入。该设置默认关闭，生效需要同时开启 `experimental.unifiedAgentLoop`。开启 `QWEN_DEBUG_LOG_FILE` 后，适配器记录带 prompt ID 的 `[EVENT_BUS]` 执行标记。
5. **取消与有界收尾**（#17045 K 块）。`loop.cancelled` 和*取消*一节所述的收尾上限；`loop.output` 从词汇表中删除。
6. **后续 —— surface 收敛**继续在 unified-agent-loop 计划下进行（TUI、OpenTUI、AgentCore、speculation、Hosted）。总线让循环级挂接（hooks、Mods、保护、录制）成为单点，这正是该计划的既定目标；这里不排任何 surface 工作。

## 测试

- 单元：总线原语（移植 + 新增）、状态所有权与迟到轮次丢弃、每个 handler 的状态转换、适配器的回调顺序/抛错语义。测试与源码同置（`*.test.ts`），vitest。
- Parity：统一循环套件（headless 已合入；ACP 轮已合入）对 PR 2 原样运行 —— 它们是 surface 无感知的证明。
- E2E：按 feat-dev 流程在 `.qwen/e2e-tests/` 下写计划，覆盖设置开/关两种状态的 headless 与 ACP prompt 轮；实现前先做基线 dry-run。

### 真实场景证据（PR 4）

headless 对确定性 mock OpenAI 端点的运行（真实工具执行、真实重试、真实 SIGINT 取消）：off = 过程式共享循环，on = 总线共享循环，两臂均开启 `experimental.unifiedAgentLoop`。总线路径由适配器的 `[EVENT_BUS] runAgentLoopOnBus started` 调试标记确认（`QWEN_DEBUG_LOG_FILE=1`）——每个 off run 记录 0 条标记，每个 on run 至少一条——因此 parity 不是假绿。输出在规范化运行身份与时延字段后完全一致。

| 场景                      | 结果（off = on）               | 标记 off/on |
| ------------------------- | ------------------------------ | ----------- |
| G1 单轮                   | MOCK_OK                        | 0 / 1       |
| G2 工具循环（glob）       | TOOL_LOOP_DONE，1 个工具结果   | 0 / 2       |
| G3 重试（500 → ok）       | RETRY_OK                       | 0 / 1       |
| G4 模型流中取消           | exit 130，无挂起               | 0 / 1       |
| G5 设置文件启用（无 env） | MOCK_OK                        | 0 / 1       |
| G6 多工具批 + 两个工具轮  | MULTI_ROUND_DONE，3 个工具结果 | 0 / 3       |
| G7 工具错误收尾           | TOOL_ERROR_DONE，错误结果      | 0 / 2       |
| G8 stream-json 输出       | 信封流完全一致                 | 0 / 1       |
| G9 工具执行中取消         | exit 130，无挂起               | 0 / 1       |
| G10 同批重复调用          | DUPLICATE_DONE，重放响应       | 0 / 2       |

G5 通过隔离的用户设置文件启用两个标志、不用任何环境变量，证明设置到标志的链路。G9 在前台工具运行时取消（toolSignal 路径），与 G4 的流中取消互补。标记数大于 1 反映 headless 每轮调用一次循环。

## 验收标准

- PR 1（原语）：bus/state/events 模块带单测落地、无运行时消费方、零行为变化（在无消费方时循环路径不变）；`tsc --build`、ESLint、Prettier 干净。
- PR 2（handler，opt-in）：等价套件证明总线与过程式两条路径在脚本化场景下结果与有序回调日志完全一致，且既有 agent-loop 测试保持全绿；标志默认关，任何 surface 行为不变；`tsc --build`、ESLint、Prettier 干净。
- 每个切片都把它的实现与测试放进同一个 PR，且双语设计文档保持同步（结构、决策、约束与本验收标准节）。
- PR 4（headless opt-in）：设置默认关，不改变任何 surface 默认行为；两个实验标志同时开启时，headless run 走总线路径，由适配器的 `[EVENT_BUS]` 调试标记确认；下述真实场景 parity 成立；`tsc --build`、ESLint、Prettier 干净。
- 真实 headless 场景（单轮、工具循环、重试、取消）在标志开/关下两路径 parity 成立，且总线路径由执行标记确认而非假设。PR 4 交付启用与标记；场景证据汇总于上方「测试」节（完整日志在 `.qwen/e2e-tests/` 下的本地 E2E 计划中）。

## 风险与未决问题

- **回调顺序是契约。** surface 依赖 `onModelEvent`/`onToolResult`/输出回调的精确顺序。适配器必须保持；parity 套件是检查，PR 2 另加显式顺序测试。
- **`runModelRound`/`runToolBatch` 是公共接缝。** ACP 已合入的轮次步（#15509）直接调用它们；PR 2 把它们保留为 handler 的内部实现，而不是删除。
- **轮次身份。** 数字轮次比 preview 的 UUID 简单且与 main 日志一致；若未来 surface 需要全局唯一轮次 id，事件载荷可同时携带两者而不改路由。
- **流式派发**仍是未决产品决策（时延收益 vs 审批/顺序语义）；Phase 3 的存在就是把这个决策显式化，而不是夹带进来。
- **重复劳动风险。** 1.0 线最终可能整体替换 main；只要 main 的统一循环计划继续，本移植就是正当的。它复用 main 的类型与契约，正是为了让工作不绑定 preview。

## 受影响文件

- 新增：`packages/core/src/event-bus/{bus,events,state}.ts` 及同置测试（PR 1）；`runtime.ts`、`handler-support.ts`、`conversation.ts`、`llm.ts`、`tool.ts`、`adapter.ts`（PR 2）。
- 修改：`packages/core/src/core/agent-loop.ts` 内部（PR 2）；其公共类型与导出不变。
- PR 4：`packages/core/src/config/config.ts`（参数 + `isEventBusAgentLoopEnabled`）、`packages/core/src/event-bus/adapter.ts`（调试执行标记）、`packages/cli/src/config/config.ts` 与 `settingsSchema.ts`（设置 + 接线）、`packages/cli/src/nonInteractiveCli.ts`（`useEventBus`）、`packages/web-shell/client/settings.ts` 与 `settings/messages.ts`（公开别名 + 中文条目），以及重新生成的 `packages/vscode-ide-companion/schemas/settings.schema.json`；测试与各改动同置。
- 文档：本双语对；PR 2 落地后 unified-agent-loop 文档增加交叉引用。
