# 事件总线 agent 循环

[English](2026-11-11-event-bus-agent-loop.md) | [简体中文](2026-11-11-event-bus-agent-loop.zh-CN.md)

- **状态**：提议中。实现从 PR 1（总线原语）开始；不改变任何 surface 的默认行为。
- **日期**：2026-11-11，基于 `origin/main` `19f73eb7ec0a`。
- **关联**：
  - [Unified agent loop](2026-10-23-unified-agent-loop.zh-CN.md) —— 本设计对其做内部架构升级的已批准设计；跟踪 issue #15327，#15343 批准，headless 已在 #15369 合入，ACP 模型轮在 #15509 评审中；
  - 被移植架构的来源：`v1.0.0-preview` 分支 `587e3429cabf`，`packages/core/src/event-bus/`（19 个文件，6,237 行）；
  - preview 移植试点 issue #16896（file-history 硬化）—— 另一条更小的独立线。

## 问题

共享 agent 循环（`packages/core/src/core/agent-loop.ts`，620 行）是一个过程式 `for` 循环：`runModelRound` → `runToolBatch` → 续跑，所有 surface 决策都表达为 `AgentLoopHost` 上的可选回调。作为统一循环收敛的第一步这是对的：它让七个副本迁到同一实现的同时，每个 surface 适配器照常工作。

`v1.0.0-preview` 分支把同样的循环重新表达为事件驱动状态机，其形态具备过程式循环没有的性质：

- **显式事件词汇。** 十个总线事件（`query.submitted/output/cancelled/finished`、`llm.request/tool_use/settled`、`tool.cancel/settled`、`handler.failed`）为每次迁移命名。过程式循环里同样的迁移隐含在控制流中，新增循环级行为必须穿过函数主体接线。
- **投递保证。** 总线对同一订阅者同一 query 按发布顺序串行投递，不同 query 互不阻塞。监听器抛错会变成 `handler.failed` 事件，而不是未处理的 rejection。今天的回调除了「抛错即结束循环」外没有顺序与失败语义。
- **写者所有权。** 每 query 的状态被切分：Conversation 拥有决策与上下文，Llm 拥有选择与模型结果，Tool 拥有派发批次。过程式循环让三个关注点共享可变局部变量。
- **轮次作用域。** 每个事件携带 `roundId`；被放弃轮次的迟到事件由构造即丢弃（`currentRound`）。过程式循环靠临时检查处理（例如 `Retry`/`ModelFallback` 时丢弃已收集的调用）。
- **有界收尾。** 取消与消费者关闭在一个上限内收尾（preview 为 10 秒），而不是等待卡死的 handler。

我们希望 main 的共享循环获得这些性质，同时不打断已在进行的收敛，也不引入第二个相互竞争的循环。

## 当前行为

### main（在 `19f73eb7ec0a` 核实）

| 关注点       | 位置                                                                                                                                               | 形态                                                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 共享循环     | `core/agent-loop.ts:194` `runAgentLoop`                                                                                                            | 过程式 `for`；停止原因 `AgentLoopStopReason`（`:41`）                                                      |
| 模型轮       | `core/agent-loop.ts:256` `runModelRound`                                                                                                           | `LlmClient.sendMessageStream` 生成器；事件转发 `host.onModelEvent`；`Retry`/`ModelFallback` 丢弃已收集调用 |
| 工具批       | `core/agent-loop.ts:324` `runToolBatch`                                                                                                            | 去重/replay → `host.selectCalls`/`beforeToolLaunch` → 执行器 → `finalizeToolResponses`                     |
| 执行器接缝   | `core/agent-loop.ts:161` `AgentLoopToolExecutor`                                                                                                   | 可替换；默认包一个 `CoreToolScheduler`（`:564`）                                                           |
| Surface 接缝 | `core/agent-loop.ts:106` `AgentLoopHost`                                                                                                           | 可选回调，不是订阅                                                                                         |
| 模型事件     | `core/turn.ts:74` `LlmEventType`（22 种），`Turn.run`（`:764`）                                                                                    | 已是规范化事件流                                                                                           |
| 现有总线     | `confirmation-bus/message-bus.ts:15` `MessageBus`；`agents/runtime/agent-events.ts:285` `AgentEventEmitter`；`packages/acp-bridge/src/eventBus.ts` | hooks 请求/响应；subagent 作用域事件；带 replay 的传输层 fan-out —— 都不是循环控制总线                     |

各 surface：headless 跑 `runAgentLoop`（已合入，#15369）；ACP 用 `runModelRound` 加自己的工具步（#15509 评审中）；Ink TUI（`use-llm-stream.ts`）、OpenTUI、AgentCore、speculation 与 Hosted Harness 仍跑各自的循环，由 unified-agent-loop 迁移计划管辖。

### preview（在 `587e3429cabf` 核实）

`packages/core/src/event-bus/`：

- `bus.ts`（147 行）—— `QueryEventBus`：类型化发布/订阅，按 `queryId` 路由，按 `(订阅者, query)` 串行 promise 链，监听器失败重发布为 `handler.failed`，`eventId` 去重键。
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
   bus.ts          QueryEventBus：路由、串行投递、handler.failed
   events.ts       基于 main 类型的循环事件词汇
   state.ts        每 run 状态，写者所有权
   conversation.ts 决策：续跑 / 停止 / 下一轮
   llm.ts          每个 llm.request 一个模型轮（包装 runModelRound）
   tool.ts         每轮一个批次（包装 runToolBatch）
   ▼
LlmClient → Turn → LlmChat、CoreToolScheduler（不变）
```

适配器是兼容边界：它订阅总线，并完全按今天过程式循环的顺序调用 `AgentLoopHost` 回调；它把抛错的 host 回调转成循环的 error 结局，与今天「抛错即结束循环」一致。本设计中 surface 永远看不到总线。向 surface 暴露订阅是可能的后续步骤，不是这里的目标。

### 身份与事件映射

preview 按 `queryId` 路由、用 UUID `roundId` 标记轮次。main 的循环每次交互跑一次，带 `promptId` 与数字轮次计数。移植保留 main 的身份：

- `runId`：在 `runAgentLoop` 入口生成；路由键（一个 run = preview 的一个「query」）。`promptId` 只是归属信息，随事件携带，绝不作路由键 —— drain 轮可能跨 run 复用同一 prompt id。
- `roundId`：run 的轮次编号，由 Conversation 发布 `llm.request` 时赋值。迟到事件由同样的 `currentRound` 检查丢弃。

| 总线事件         | 载荷（main 类型）                              | 发布者                              |
| ---------------- | ---------------------------------------------- | ----------------------------------- |
| `loop.started`   | `{ promptId }`                                 | 适配器，状态创建后                  |
| `loop.output`    | `{ event: ServerLlmStreamEvent }` / 工具输出块 | Llm、Tool                           |
| `loop.cancelled` | `{ reason }`                                   | 适配器，signal 中止时               |
| `loop.finished`  | `{ result: AgentLoopResult }`                  | Conversation                        |
| `llm.request`    | `{ round, send: AgentLoopRound }`              | Conversation                        |
| `llm.tool_call`  | `{ call: ToolCallRequestInfo }`                | Llm，每个收集到的 `ToolCallRequest` |
| `llm.settled`    | `{ round, stop, calls, discardedCalls }`       | Llm，轮结束时                       |
| `tool.cancel`    | `{ reason }`                                   | Conversation                        |
| `tool.settled`   | `{ round, results: AgentLoopSettledCall[] }`   | Tool，批结束时                      |
| `handler.failed` | `{ source, round?, error }`                    | 总线，监听器失败时                  |

`llm.settled` 携带该轮的终止分类（今天 `runModelRound` 做的 `STOP_EVENTS` 映射），使 Conversation 仍是把模型结局映射为 `AgentLoopStopReason` 的唯一位置。去重/replay 记账留在 Tool handler，使用现有 `toolCallIdUtils` 助手，位置与今天 `runToolBatch` 完全一致。

### 状态与所有权

每 run 一个状态对象，由适配器创建、run 收尾时删除：

- **Conversation** 写：当前轮、续跑决策、待决停止原因。
- **Llm** 写：该轮收集的调用、`Retry`/`ModelFallback` 时丢弃的调用、轮结局。
- **Tool** 写：批次工作状态与其已收尾结果。

状态库拒绝同一 `runId` 的二次创建；`currentRound(state, roundId)` 对迟到事件返回 undefined —— 与 preview 让被放弃轮次无害化的构造相同。

### 投递与失败

`QueryEventBus` 基本原样移植（只依赖一个 logger）：按 `(订阅者, runId)` 串行链、跨 run 隔离、`handler.failed` 重发布、`eventId` 去重。两处适配：

- logger 换成 main 的 `debugLogger`/`runLogger` 约定。
- 来自 **host 回调**（由适配器调用）的 `handler.failed` 以 error 结局结束 run，保持今天语义；来自内部 handler 的 `handler.failed` 属于 bug，同样结束 run，并在错误中点名来源。

### 取消

适配器完全按今天的方式拥有 run 的 `AbortController` 接线（`signal`、`toolSignal`）。中止时发布 `loop.cancelled`；Tool 通过执行器 signal 取消在飞批次；Conversation 在 Llm 与 Tool 安静后收尾一次。preview `QueryListener` 的收尾上限（10 秒，surface 有 deadline 时取其界）守护收尾等待，使卡死的 handler 无法挂住 run。

### 为什么不复用现有总线

- `MessageBus`（confirmation-bus）：同步 `EventEmitter`、请求/响应关联、无按 run 串行、无失败事件；今天只承载 hooks。其用途是策略消息，不是循环控制。
- `AgentEventEmitter`：词汇与生命周期都限于 subagent 运行时。
- acp-bridge `eventBus`：带 replay 环与字节预算的传输层 fan-out；它位于循环之上，不在循环之内。

没有任何一个提供 query 路由 + 串行异步投递 + 失败事件，而这些正是被移植的性质。新模块约 450 行原语；handler 是对 `agent-loop.ts` 已有逻辑的重新表达，不是新行为。

## 迁移（PR 切片）

每个切片保持 parity 套件绿，不改变任何 surface 默认。

1. **PR 1 —— 原语。** `event-bus/{bus,events,state}.ts` + 单元测试（移植 preview 的 `bus.test.ts`；新增串行投递、跨 run 隔离、失败重发布、迟到轮次测试）。尚无消费方；零行为变化。本设计文档随此 PR 落地。`runtime.ts`（handler 接线）与 `handler-support.ts` 随 PR 2 的 handler 一起到来。
2. **PR 2 —— 现有门控后的 handler。** 在 `experimental.unifiedAgentLoop` 下把 `runAgentLoop` 内部重新表达为 Conversation/Llm/Tool handler 加 host 适配器。`runModelRound`/`runToolBatch` 保留导出与签名（ACP #15509 依赖它们）。headless parity 套件与 ACP 轮测试是验收门；为每个停止原因新增 handler 级单元测试。
3. **PR 3 —— 流式派发评估（可选，独立门控）。** preview 在流仍在运行时执行 `tool_use` 块。main 在轮结束后跑批次，且审批按批排序；流式派发改变审批时机与输出交错。此切片先写下 parity 差异并取得明确决定；架构移植本身不依赖它。
4. **后续 —— surface 收敛**继续在 unified-agent-loop 计划下进行（TUI、OpenTUI、AgentCore、speculation、Hosted）。总线让循环级挂接（hooks、Mods、保护、录制）成为单点，这正是该计划的既定目标；这里不排任何 surface 工作。

## 测试

- 单元：总线原语（移植 + 新增）、状态所有权与迟到轮次丢弃、每个 handler 的迁移、适配器的回调顺序/抛错语义。测试与源码同置（`*.test.ts`），vitest。
- Parity：统一循环套件（headless 已合入；ACP 轮评审中）对 PR 2 原样运行 —— 它们是 surface 无感知的证明。
- E2E：按 feat-dev 流程在 `.qwen/e2e-tests/` 下写计划，覆盖设置开/关两种状态的 headless 与 ACP prompt 轮；实现前先做基线 dry-run。

## 风险与未决问题

- **回调顺序是契约。** surface 依赖 `onModelEvent`/`onToolResult`/输出回调的精确顺序。适配器必须保持；parity 套件是检查，PR 2 另加显式顺序测试。
- **`runModelRound`/`runToolBatch` 是公共接缝。** ACP 在飞 PR 直接使用它们；PR 2 把它们保留为 handler 的内部实现，而不是删除。
- **轮次身份。** 数字轮次比 preview 的 UUID 简单且与 main 日志一致；若未来 surface 需要全局唯一轮次 id，事件载荷可同时携带两者而不改路由。
- **流式派发**仍是未决产品决策（时延收益 vs 审批/顺序语义）；Phase 3 的存在就是把这个决策显式化，而不是夹带进来。
- **重复劳动风险。** 1.0 线最终可能整体替换 main；只要 main 的统一循环计划继续，本移植就是正当的。它复用 main 的类型与契约，正是为了让工作不绑定 preview。

## 受影响文件

- 新增：`packages/core/src/event-bus/{bus,events,state}.ts` 及同置测试（PR 1）；`runtime.ts`、`handler-support.ts`、`conversation.ts`、`llm.ts`、`tool.ts`、`adapter.ts`（PR 2）。
- 修改：`packages/core/src/core/agent-loop.ts` 内部（PR 2）；其公共类型与导出不变。
- 文档：本双语对；PR 2 落地后 unified-agent-loop 文档增加交叉引用。
