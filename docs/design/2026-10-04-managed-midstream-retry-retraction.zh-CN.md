# 托管中途模型重试的带内撤回

[English](2026-10-04-managed-midstream-retry-retraction.md) | [简体中文](2026-10-04-managed-midstream-retry-retraction.zh-CN.md)

状态：已提议。修复 #13319（父级 #12380 / Stage G #12952），是
[2026-09-30-hosted-turn-failover-e2e](2026-09-30-hosted-turn-failover-e2e.zh-CN.md)
中 G1 故障转移工作的带内姊妹篇。

## 问题与范围

在第一个已发布 chunk 之后落地的模型重试，会把被撤回尝试的孤立前缀拼接进
managed-agent Turn 的公开 transcript。在打包栈上可确定性复现（fake OpenAI
网关 + MySQL + managed-agent-server jar + `dist/cli.js` Hosted Harness）：
网关在第一个已发布 chunk 之后断开模型流，CLI 重试，重试成功，Turn 完成——
但被撤回尝试的前缀与重试全文直接拼接，例如
`MIDSTREAM_PARTIALMIDSTREAM_RECOVERED_AFTER_RETRY` 成为一条可见回答。

根因链：

1. `packages/core/src/core/llm-chat.ts` —— 回答文本一经交付，传输重试循环即
   进入 continuation 臂（#7832）：保留已交付文本，通过两个合成 turn 请求模型
   从其处续写，并 yield 带 `isContinuation: true` 的 `RETRY`。
2. `packages/cli/src/serve/hosted-harness-model.ts` —— 带
   `isContinuation: true` 的 `Retry` 事件被有意保留文本缓冲区，并继续在同一
   message id 下发布 delta。只有发布之后的非 continuation
   `Retry`/`ModelFallback` 才会抛出
   `Hosted Harness cannot retract a published model attempt.`
3. `packages/cli/src/serve/hosted-text-deltas.ts` —— 每个 chunk 都以只可追加
   的 activation 域 `message.delta` journal 事件落账；没有撤回 API。
4. `HarnessEventProjector.java` —— `agent_message_chunk` 纯追加地投影为
   `item.output_text.delta`。`stream.reconciled` 撤回机制
   （`ManagedAgentStore.retractContinuationOutput`）只覆盖 Harness 崩溃恢复
   路径，按死亡拥有者的 `harnessBootId:eventEpoch:` 源前缀键控；带内重试与
   存活进程共享同一 boot 与 epoch，没有任何东西能撤回其前缀。

continuation 契约——provider 从其看到的部分输出处续写——对行为良好的
provider 成立，且小规模重放重叠在尝试折叠进历史时已被剥离。但当瞬时容量事件
把重试路由到以全新完整回答响应的后端时，harness 无法区分「完美续写」与
「重启」：两者都会追加。重复随之落入公开 feed、已提交消息以及模型自身的历史。

## 现状

- G1 设计把更严重的形态记录为已知 follow-up：第一个流式 chunk 之后的非
  continuation 重试或回退会让 Turn 终态失败，而将该结算归类为可重试被推迟。
- 打包栈现实中 continuation 臂对 Turn 更温和、对用户更糟：Turn 完成了，但
  transcript 静默携带重复前缀。
- `llm-chat.ts` 中的回退链以 `!streamYieldedAnyChunk` 为门，因此已发布内容
  之后的 `ModelFallback` 事件目前无法从主路径触发；Harness 侧对应的抛出属于
  纵深防御。
- `stream.reconciled` 已是公开契约的一部分：OpenAPI 描述与 Web Shell 投影器
  都已处理它——客户端重新加载 items 并在 snapshot 之后继续。无需公开 API
  变更。

## 目标与非目标

目标：

- 已发布文本的中途切断之后，Turn 完成且公开 transcript 只显示恢复文本
  （`clean-retry-recovery`：`turn.completed` 且可见文本精确相等）。
- 行为对两种 provider 行为都正确：全新完整回答（重启）与续写尾部——因为
  一旦输出已发布，重试根本不再请求续写。
- `Retry`（continuation 与全新重启两臂，包括没有内容门的限流臂）与
  `ModelFallback` 事件都被覆盖。
- 崩溃恢复、接管与交互式 CLI 路径保持现有行为。

非目标：

- Turn 级可重试结算（G1 follow-up 的另一种形态）。本设计下被重试的中途
  切断从不结算 Turn，因此不引入新的协调器结算分类。
- 改变交互式 CLI 的 continuation 行为：continuation 臂仍是能保留文本缓冲区
  的消费者的默认行为。
- 撤回当前在途 assistant 消息的文本/推理 delta 之外的任何内容（工具 Turn
  中已提交的早期轮次保持不变）。

## 提议方案

发布后的重试变为全新 replay 加上对已发布前缀的带内撤回，横跨四层。

### 1. Core：可选的交付后 replay（`llm-chat.ts`）

`LlmChatSendOptions` 新增 `retractDeliveredOutputOnRetry?: boolean`。设置时：

- continuation 臂整体跳过：在全新重试时撤回已交付输出的消费者用不上
  续写语义，而把重启拼接到已发布前缀上正是本次要修复的故障。
- replay 臂接纳已交付内容的切断：设置该标志时绕过
  `!streamYieldedContentChunk && transportContinuationText.trim().length === 0`
  这道门。replay 弹出待定的部分 assistant turn 并重发原始请求，模型因而返回
  完整全新回答，调用方撤回其已发布内容。

该标志沿 `SendMessageOptions`（client.ts）→ `Turn` 构造函数 → `Turn.run` →
`chat.sendMessageStream` 传递。只有 Hosted Harness 设置它；交互式消费者不变。

### 2. Harness：撤回已发布前缀（`hosted-text-deltas.ts`、`hosted-harness-model.ts`）

`HostedTextDeltaStream` 记录当前消息首个已提交 delta 的 journal 序号，并新增
`retract()`：

- 落账一个 activation 域 `message.retracted` 事件（
  `managed-session-records.ts` 中的新 kind：载荷
  `{messageId, turnId, fromSequence}`，actor 类 `harness`），command id 为
  `assistant-retract:<turnId>:<messageId>`。
- 重置该流（新 message id、序号、首序号），使 replay 在全新身份下发布。

`hosted-harness-model.ts`：发布之后到达的 `!isContinuation` 的 `Retry` 或
`ModelFallback` 现在执行撤回并重置文本缓冲区，而不再抛出
`Hosted Harness cannot retract a published model attempt.`。带
`isContinuation: true` 的 `Retry` 保持现有追加行为（Harness 发送已不再产生
它，但该臂对任何未来调用方仍然正确）。

### 3. Harness 流：承载撤回（`hosted-harness-session.ts`）

`eventEnvelope` 把 `message.retracted` 映射为新的 SSE 事件
`type: 'message_retracted'`，携带 `promptId`（使协调器的按 Turn 过滤接受
它）、`turnId`、`messageId` 与 `fromSequence`。SSE `id` 仍为 journal 序号，
因此该事件在它撤回的每一条 delta 之后占据明确定义的位置。

### 4. Server：带内撤回（`HarnessCoordinator.java`、`ManagedAgentStore.java`）

`HarnessCoordinator.consumeStream` 新增 `message_retracted` 分支：先冲刷待处理
的文本 delta 批次（范围必须覆盖已从流中读出的 delta），再调用 store。

`ManagedAgentStore.retractHarnessTurnOutput(tenant, session, turn, owner,
eventEpoch, fromSourceId, retractionSourceId)` 在单个事务中运行，镜像
`retractContinuationOutput` 的纪律，boot 前缀在事务内从会话当前的
`harnessBootId` 派生：

- 校验 dispatch 租约，且 `eventEpoch` 仍等于该 Turn 的 `harnessEventEpoch`
  （进行中发生恢复准入则失败）。
- 幂等键
  `reconcile:inband:<bootId>:<eventEpoch>:<turnId>:<fromSourceId>`——重投递的
  撤回（崩溃恢复重放会在新 epoch 下重发未消费的 journal 事件，键不同，且
  被撤回的 delta 已被重新发布、必须再次撤回）是安全的。
- 对该 Turn 的 `item.output_text.delta` / `item.reasoning.delta` 事件中源键
  位于存活 `bootId:eventEpoch:` 命名空间且数字源 id `>= fromSourceId` 者，
  置空 `text` 并丢弃 `item_id`/`content_part_id`——恰为当前在途消息的已发布
  输出；已提交的早期轮次携带更小的源 id，保持不变。
- 从首个被撤回序号起重分配 item 身份，删除派生的 item/part/snapshot 投影，
  重置消息投影消费者进度，并追加公开的 `stream.reconciled` 事件使客户端重新
  加载——与崩溃恢复已产生的公开形态相同。
- 在同一事务内把 Harness 游标推进过撤回事件，崩溃无法重复应用它。

## 设计决定与理由

- **发布之后用全新 replay 而非 continuation。** 续写尾部只在 provider 遵守
  续写指令时正确；重启与完美续写对消费者不可区分。重放原始请求在任何
  provider 行为下都得到完整回答，撤回则移除孤立前缀。continuation 臂保留给
  从不发布的消费者（交互式 UI）。
- **带内撤回，而非协调器 Turn 重试。** 协调器重试 Turn 需要一条新的无工具
  parked Turn 恢复路径（今天的 continue 路由要求 `results_ready` 工具
  checkpoint），并且会让 Harness journal 呈现已结算错误而 store 中 Turn 仍在
  运行——这正是恢复机制所要避免的跨系统不一致。带内 Turn 从不结算，公开
  更正复用经过验证的 `stream.reconciled` 契约。
- **范围按 journal 序号键控，而非 message id。** 公开 delta 事件不携带
  Harness 的 message id，而把该 id 铸入公开形态会改变 API。SSE 源 id 本就是
  journal 序号；`fromSequence` 恰好选中当前消息的 delta，因为一条消息的
  delta 是连续的，且重试只发生在消息中途。
- **`ModelFallback` 对称覆盖。** 该链目前无法在发布之后触发，但 Harness 的
  处理不再假设这一点：发布后的回退执行撤回并重置，而不再让 Turn 失败。
- **Journal 兼容性遵循 G1 策略。** 含有 `message.retracted` 事件的 journal
  无法被旧版本 Harness 打开（`managed_session_open_failed`），与
  `message.delta` 相同：先升级舰队再启用 Hosted Workspace turn，或者对回滚
  设卡。

## 约束与风险

- replay 预算（`STREAM_RETRY_CONFIG.maxRetries`）现在也约束发布后的切断；
  预算耗尽时 Turn 以原始错误结束，与此前不可续写切断的行为相同。
- replay 是完整重问：对接近结尾处被切断的长生成，这会额外花费一份完整回答
  的 token 与时延。在托管路径上，持久公开 transcript 的正确性优先于
  continuation 优化。
- Harness 崩溃之后，在重放恢复流重新发布的 delta 与重投递的撤回事件之间，
  孤立前缀可能在新 epoch 下短暂重现；随后的 `stream.reconciled` 会纠正它，
  与崩溃恢复的现状一致。
- 撤回就地置空事件，因此对已消费序号的迟到的轮询会观察到空文本——这正是
  文档化的 `stream.reconciled` 契约。

## 验证计划

- Core 单元测试：设置该标志时，已交付内容后的可续写切断 yield 普通
  `RETRY`（无 `isContinuation`）并重发原始请求；不设置时行为不变。
- CLI 单元测试：`HostedTextDeltaStream.retract` 落账事件并重置身份；
  `hosted-harness-model` 在发布后的 `Retry`/`ModelFallback` 上撤回 + 重置且
  不再抛出；envelope 把 `message.retracted` 映射为 `message_retracted`。
- Java 单元/集成测试：store 方法恰好置空源 id 范围、重建投影、发布
  `stream.reconciled`、幂等，并拒绝过期 epoch；协调器分支在撤回前先冲刷
  已批次的 delta。
- 打包栈 E2E（issue 场景：fake 网关在第一个已发布 chunk 后断开，随后回答
  完整恢复文本）：期望 `turn.completed`、两次模型请求且重放的请求体一致、
  可见文本与恢复文本精确相等。

## 验收标准

- 该 E2E 场景分类为 `clean-retry-recovery`（`turn.completed` + 可见文本精确
  相等），而不是 `completed-with-unretracted-prefix` 或 `terminal-error`。
- 持久公开事件表、已提交消息与模型历史中都不出现拼接前缀。
- 现有门禁保持绿色：`scripts/run-managed-agent-server-e2e.ts` 的
  `--session-failover`、`--inflight-failover`、`--continuation-failover` 与
  real-model 检查。

## 未决问题

- #13319 引用的 `--midstream-retry` runner 模式未发布到仓库；其 known-gap
  期望（两种坏形态通过、干净恢复失败）需要由其所有者在本修复落地后翻转。
