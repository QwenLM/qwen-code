# Speculation 工具步 —— 保留自有（PR 6b 决策）

[English](2026-11-15-speculation-tool-step.md) | [简体中文](2026-11-15-speculation-tool-step.zh-CN.md)

- **状态**：为 #17045 的「Speculation PR 6b」块记录决策：speculation 保留自有工具步与自有投机循环；仅其模型轮运行在共享 loop 上（PR 6a，#17029）。本切片不改代码、不引入开关。
- **日期**：2026-11-15。行号引用已在 `main` `5f5035772b54` 上核实。
- **行为来源**：`packages/core/src/followup/speculation.ts`（848 行）。
- **相关**：[统一代理循环](2026-10-23-unified-agent-loop.md)（#15327）；[Event-bus 代理循环](2026-11-11-event-bus-agent-loop.md)；跟踪 issue #17045；Hosted Harness 评估（[2026-11-14](2026-11-14-hosted-harness-loop-evaluation.md)）是 Hosted 工具步「保留自有」的同类决策。

## 问题

#17045 要求 speculation 的 PR 6b「把工具步与运行迁到共享 loop，或记录保留自有的决定」。PR 6a（#17029）已把 speculation 的模型轮迁到 `runModelRound`。本决策覆盖工具步及其外围的投机循环。

## 代码实际要求（已核实）

Speculation 在后台以只读工具与 copy-on-write overlay 写跑在用户之前，其工具步正围绕此构建：

1. **直接执行，绕过调度器。** 每个调用经 `tool.build(args)` 与 `invocation.execute(signal)` 直接运行（`speculation.ts:456-517`），不走 `CoreToolScheduler`。permission-deferred 调用则 bail 回正常流（`:410-414`）。
2. **overlay 写，而非真实文件系统。** `redirect` 门把路径实参重写入 overlay（`rewritePathArgs`，`:446-454`）；overlay 仅在 accept 时拷回真实文件系统，reject 时丢弃。
3. **批中途 bail 的 boundary 门。** `evaluateToolCall` 返回 `boundary` / `redirect` / 放行；boundary（或重写失败、或 guard 拒绝）在该调用处停止投机运行并交回正常循环（`:433-454`、`:497-509`）。交回的是**部分批次**：保留已执行的响应、剥离未执行的调用，按序保留前 N 个 `functionCall` part 以与响应对应（`:609-657`）。
4. **不做已提交记录。** Speculation 会 finalize 响应（`finalizeToolResponses`，`:605`）但从不把它们记录为已提交工具调用；其结果是投机性的，不得进入已提交工具调用历史。
5. **顺序 + 提前 bail。** 调用逐个处理、遇首个 boundary 即停。

### 共享批处理接口已经允许什么

上述执行与记录机制**并非**共享接口的结构性阻塞。`runToolBatch` 接受调用方注入的 `executor`（`agent-loop.ts:476`），因此一个投机 executor 可以直接、顺序地运行调用；`client` 是可选的（`:467`），记录调用是 `client?.recordCompletedToolCall(...)`（`:671`），省略它即跳过该通道；`deferRecording`（`:488`）把每个结果的记录作为回调返回而不调用（`:755-759`），让表面只记录它发送的内容。直接执行、顺序执行、避免已提交记录，都能经此接口表达；它们本身并不构成保留独立工具步的理由。

## 决策

**保留 speculation 自有工具步与投机循环——依据是 boundary/部分批次与 overlay accept/reject 语义，而非执行或记录机制。** 不匹配之处在于：speculation 在批中途的首个 boundary 处停止并交回部分批次（保留已执行响应、剥离未执行调用），overlay 写则作为整体被 accept 或 discard。共享批处理整批 settle，没有「在 boundary 处 bail / 交回部分批次」的契约；要在其上表达 speculation 的批中途 bail 与 accept/reject，需要一个投机适配器，而对一个后台优化来说其成本不值得。这与 Hosted Harness 决策同形：模型轮共享，特化工具步保留。

模型轮按 PR 6a 已落地的方式留在共享 loop（`runSpeculationModelRound`，由 `isUnifiedAgentLoopEnabled('speculation')` 门控）；工具门、直接执行、overlay 写与 boundary 处理不变。

**编号说明。** 跟踪 issue #17045 的「PR 6b」即本工具步决策。它取代了较早的[统一代理循环](2026-10-23-unified-agent-loop.md)迁移表中「6b」的编号含义（该表原指 speculation 的默认开启与删除步骤）；该表现已链接本决策，并把默认开启/删除保留为独立条目。默认开启与遗留删除仍是 #17045 的门控步骤，不属于本决策。

## 集成门禁决策

今天没有集成测试运行 speculation。**记录决策：speculation 的单元 parity 套件即其门禁。** 该套件已对比共享轮 off/on（`speculation.test.ts` 的「speculation model round on the shared agent loop」与「speculation shared-round event semantics」），含一个分支标记钉住共享轮仅在开关开启时运行。确定性的端到端投机轮不是可行的集成门禁：speculation 是后台、依赖时序的优化，其 accept/boundary 结果取决于运行中途到达的用户输入。把关共享轮迁移的是单元 parity 套件，而非集成场景。

## 范围

- 在内：本决策记录（工具步保留自有；单元 parity 套件为门禁）。
- 在外：任何代码改动；speculation 的默认翻转与遗留删除仍是 #17045 的门控步骤。
