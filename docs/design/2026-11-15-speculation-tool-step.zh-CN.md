# Speculation 工具步 —— 保留自有（PR 6b 决策）

[English](2026-11-15-speculation-tool-step.md) | [简体中文](2026-11-15-speculation-tool-step.zh-CN.md)

- **状态**：为 #17045 的「Speculation PR 6b」块记录决策：speculation 保留自有工具步与自有投机循环；仅其模型轮运行在共享 loop 上（PR 6a，#17029）。本切片不改代码、不引入开关。
- **日期**：2026-11-15。行号引用已在 `main` `b098616f2fb5` 上核实。
- **行为来源**：`packages/core/src/followup/speculation.ts`（849 行）。
- **相关**：[统一代理循环](2026-10-23-unified-agent-loop.zh-CN.md)（#15327）；[Event-bus 代理循环](2026-11-11-event-bus-agent-loop.zh-CN.md)；[Speculation 引擎设计](prompt-suggestion/speculation-design.md)（下文复述的工具门、路径重写与 boundary 处理）；跟踪 issue #17045（遗留项由 follow-up #17284 承载）；Hosted Harness 评估（[2026-11-14](2026-11-14-hosted-harness-loop-evaluation.zh-CN.md)）是 Hosted 工具步「保留自有」的同类决策。

## 问题

#17045 要求 speculation 的 PR 6b「把工具步与运行迁到共享 loop，或记录保留自有的决定」。PR 6a（#17029）已把 speculation 的模型轮迁到 `runModelRound`。本决策覆盖工具步及其外围的投机循环。

## 代码实际要求（已核实）

Speculation 在后台以只读工具与 copy-on-write overlay 写跑在用户之前，其工具步正围绕此构建。[Speculation 引擎设计](prompt-suggestion/speculation-design.md)规定了下文复述的工具门、路径重写与 boundary 处理；以下行号引用已对代码核实。

1. **直接执行，绕过调度器。** 每个调用经 `tool.build(args)` 与 `invocation.execute(signal)` 直接运行（`speculation.ts:458-519`），不走 `CoreToolScheduler`。permission-deferred 调用则 bail 回正常流（`:412-416`）。
2. **overlay 写，而非真实文件系统。** `redirect` 门把路径实参重写入 overlay（`rewritePathArgs`，`:448-456`）；overlay 仅在 accept 时拷回真实文件系统，reject 时丢弃。
3. **批中途 bail 的 boundary 门。** `evaluateToolCall` 返回 `boundary` / `redirect` / `allow`（放行）；boundary（或重写失败、或 guard 拒绝）在该调用处停止投机运行并交回正常循环（`:435-456`、`:499-511`）。交回的是**部分批次**：保留已执行的响应、剥离未执行的调用，按序保留前 N 个 `functionCall` part 以与响应对应（`:611-659`）。
4. **不做已提交记录。** Speculation 会 finalize 响应（`finalizeToolResponses`，`:607`）但从不把它们记录为已提交工具调用；其结果是投机性的，不得进入已提交工具调用历史。
5. **顺序 + 提前 bail。** 调用逐个处理、遇首个 boundary 即停。

### 共享批处理接口已经允许什么

上述执行与记录机制**并非**共享接口的结构性阻塞，部分结果也是如此。`runToolBatch` 接受调用方注入的 `executor`（`agent-loop.ts:476`），因此一个投机 executor 可以直接、顺序地运行调用；`client` 是可选的（`:467`），`client?.recordCompletedToolCall(...)`（`:673`）更新会话记账——工具调用计数、供记忆使用的最近完成工具名、以及 skills-modified 标志——省略 `client` 跳过的是该记账；已提交的工具结果写入是另一个调 `recordToolResult` 的 `record()` 闭包（`:741`、`:746`），`deferRecording`（`:490`）把它作为回调返回而不调用（`:761-765`），让表面只记录它发送的内容——避免已提交记录意味着延后这些回调，而非仅省略 `client`。另有三个接缝与 boundary/部分批次行为相关（此清单并非穷尽）：`keepCancelledResults`（`:485`）完成并返回被取消批次的结果，供保留它们的表面使用；`ToolBatchResult.responses`（`:500`）按调用返回 parts，「供丢弃部分调用结果的表面使用」，已有真实表面用它只发送一个子集（`use-llm-stream.ts:6710-6714`）；按调用的启动门 `host.beforeToolLaunch`（`:221`，在 `:632` 接线）按请求顺序拒绝某个调用并使其不执行。直接执行、顺序执行、避免已提交记录、部分结果与按调用拒绝，都能经此接口表达；它们本身并不构成保留独立工具步的理由。

## 决策

**保留 speculation 自有工具步与投机循环——因为把共享接缝组合成 speculation 交回语义的适配器，对一个后台优化来说不值得，而非共享接口无法表达这些机制。** 上述接缝可表达直接、顺序、不记录的执行与部分结果。机械差异在默认输出：批处理对它未运行的每个可执行调用都在 `parts` 里以一个 `skipped` 应答作答（`agent-loop.ts:692`），而 speculation 的交回则从 model message 本身剥离未执行的 `functionCall` parts（`speculation.ts:611-659`）。表面可通过从 `responses`（而非 `parts`）构建下一轮来调和这一点——`use-llm-stream.ts:6710-6714` 已经以这种方式丢弃一个子集——所以这种剥离是表面要写的组合，而非批处理缺乏的能力。在该组合之上，speculation 仍需它的 overlay accept/reject（accept 时 overlay 逐文件 best-effort 拷回真实文件系统；reject 时丢弃）及其外围的投机循环。对着一个已工作、已测试的工具步去组合并维护这样一个投机适配器，正是本决策为一个后台优化所拒绝承担的成本。这与 Hosted Harness 决策同形：模型轮共享，特化工具步保留。

模型轮按 PR 6a 已落地的方式留在共享 loop（`runSpeculationModelRound`，由 `isUnifiedAgentLoopEnabled('speculation')` 门控）；工具门、直接执行、overlay 写与 boundary 处理不变。

**最终状态说明。** 永久保留 speculation 自有循环与 finalizer，意味着父设计最初的最终状态目标「1 个 agent loop 实现」「1 个 `finalizeToolResponses` 调用者」并非字面可达：speculation 的调用（`speculation.ts:607`）与共享批的调用（`agent-loop.ts:715`）并存。这两个目标按共享实现加上保留自有决策所留副本计数，[统一代理循环](2026-10-23-unified-agent-loop.zh-CN.md)的最终状态表现已注明——其目标列已按这些副本计数。

**编号说明。** 跟踪 issue #17045 的「PR 6b」即本工具步决策。它取代了较早的[统一代理循环](2026-10-23-unified-agent-loop.zh-CN.md)迁移表中「6b」的编号含义（该表原指 speculation 的默认开启与删除步骤）；该表现已链接本决策，并把默认开启/删除保留为独立条目。表中的「6c」是本文对这些默认开启/删除步骤的自有标签；在 #17045 中它们是 6a/6b 之后的无编号「默认开启」与「删除旧路径」checkbox，故「6c」没有单独的 tracker 条目。tracker 的「内核默认开启（如果 PR 6b 把它的运行放到了 `runAgentLoop` 上）」框在本决策下是 moot（speculation 保留自有运行，内核从不运行其轮次）；该框以及 11-18 日期行「PR 6b 合入，连同 speculation 的集成场景」——本记录的单元 parity 门禁决定取代了它——都欠 follow-up #17284 的一次调和（#17284 收集 #17045 的遗留项）。这些项现已列入 #17284 的 speculation 章节，6c 门控与其余调和项以清单条目承载，而非只留在 prose。默认开启与遗留删除仍是有待 #17284 承载的门控步骤，不属于本决策。

## 集成门禁决策

今天没有集成测试运行 speculation。**记录决策：speculation 的单元 parity 套件即其门禁。** 该套件已对比共享轮 off/on（`speculation.test.ts` 的「speculation model round on the shared agent loop」与「speculation shared-round event semantics」），含一个分支标记钉住共享轮仅在开关开启时运行。确定性的端到端投机轮不是可行的集成门禁：speculation 是后台、依赖时序的优化，其 accept/boundary 结果取决于运行中途到达的用户输入。把关共享轮迁移的是单元 parity 套件，而非集成场景。off/on 对比覆盖的是共享模型轮。boundary 交回是 speculation 自有且不变的工具步：现有 boundary 测试在 raw-chunk 臂上覆盖它的零执行 bail，而部分批次交回（第 3 项）——包括它与共享轮 parts 的组合——现已在两臂都有测试（#17399），多调用 parity 场景也钉住了绝对执行计数。该部分批次覆盖已补齐（#17399）；它是预存缺口，而非本决策引入的。

本决定把关的是共享轮迁移（PR 6a），而非 PR 6c 的默认翻转。父设计的集成条目（「该运行在其准备默认开启时加入」）与其默认变更判据——五步模型的 step 2，其完整条件清单见[统一代理循环](2026-10-23-unified-agent-loop.zh-CN.md)，此处不复述——对 6c 仍然有效。由于确定性端到端投机轮因上述时序原因不可行，6c 作者必须调和这一要求：点名一个满足该规则的 nightly 集成信号，或在 follow-up #17284 记录「单元 parity 套件对默认翻转亦足够」。本记录把这个问题留给 6c，而不预先替代它。

## 范围

- 在内：本决策记录（工具步保留自有；单元 parity 套件为门禁）。
- 在外：任何代码改动；speculation 的默认翻转与遗留删除仍是有待 #17284 承载的门控步骤。
