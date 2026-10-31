# Hosted B2 —— 两次替换下的 attempt/stream 身份与 live SSE 视图

[English](2026-10-31-hosted-b2-stream-identities.md) | [简体中文](2026-10-31-hosted-b2-stream-identities.zh-CN.md)

状态：提议中，2026-10-31。属于 [#14481][issue]（G3 Step 3 恢复矩阵验收，跟踪
#12380）。扩展 [G3 Step 3 恢复](2026-10-09-hosted-g3-step3-recovery.zh-CN.md) 所述
`hosted-failover-e2e` 打包支路。本切片补全矩阵行 **B2（「streamed prefix and two
replacements」）**：现有 model-round 臂已打包重发、撤回顺序与准入观察，但缺**新
attempt/stream 身份**与 **live SSE 视图**——runner 自己的 reload helper 注释明言
「the live SSE view is not read」。

## 问题

矩阵行 B2 写道：_「新 attempt/stream 身份；新 delta 前的持久撤回；live 视图、reload
与 replay 只暴露存活答案与一个终态。」_ model-round 臂在第一个模型轮内连续崩溃两个
owner（各在发布被扣住的前缀之后），断言存活答案、一个终态、撤回先于新 delta、
deep-equal 已保存请求重发、不同 boot id 与递进 writer head。缺三项观察：

1. **Attempt 身份。** 没有断言每次替换开启*新*模型 attempt。复用死代
   `attemptId` 的恢复会通过。
2. **Stream 身份。** 没有断言每代公共 delta 携带*新* item/part 身份，也没有断言被撤回
   的前缀按公共 API 契约被清空（空文本、无 `item_id`/`content_part_id`）。继续以原身份
   提供死代前缀的 live 视图会通过。
3. **Live SSE 视图。** 现有断言全部读 REST reload 视图（`publicTranscript`）。连接的
   浏览器实际观看的 live SSE 流——跨崩溃的视图——从未被观察，因此 live 投递孤儿前缀、
   丢失撤回公告或重复投影终态的控制面会通过。

## 现状（在 `main` 的 `bc8ad53f95` 上实证）

- **编排已存在。** `--model-round-failover --harness-only` 在一个无工具 Turn 上跑三代
  Harness：fake 模型每代回一个被扣住的前缀（`modelRoundPartials` = PARTIAL_ONE /
  PARTIAL_TWO，逐代 `holdUntil`），runner 在 hold 处崩溃每个 owner、scrash 其磁盘，
  `advanceModelRound()` 仅在 owner 死后释放 hold，使重发落在下一代。第三代以
  `modelRoundResponse` 完成。不涉及 serve 钩子。
- **现有断言**（model-round 审计）：一个 `turn.completed` 终态；存活文本等于
  `modelRoundResponse`；两次转换的 `retractedBeforeNewDeltas`（经
  `reconciledBetween`）；`terminalRows()=1`；流式轮请求 = partials+1 且全部
  deep-equal；零工具执行；一个 Turn；一条准入 journal 事务与一个准入资源（B1）；三个
  不同 boot id；writer generation / journal revision / committed sequence 严格递进。
- **Attempt 身份。** `beginMainAttempt` 生成
  `attemptId = ${turnId}:main:${randomUUID()}`（`managed-hook-activation.ts`），
  记入每个 `model.attempt` 事件（started / output_committed / abandoned）及其
  route/usage ref。runner 已有 journal HEX 解析模式（`b3RoundAndBudget`）。
- **Stream 身份。** CLI 把每个 attempt 预分配的 messageId 绑入
  `HostedTextDeltaStream.bindMessageId`（`hosted-text-deltas.ts`）；delta 在其下发布，
  `retractOriginal(messageId, …)` 清空死 attempt 的 delta 并记 `message.retracted`。
  Spring 投影的公共事件带顶层 `item_id` / `content_part_id`（可空）。身份模型
  （`EventIdentity`，projection v1，真机实证）：`item_id` 是该 Turn 唯一的 assistant
  item（`item_<turnId>_assistant`），跨修复稳定；文本 delta **仅当前一个 delta 保有
  身份时才延续其 content Part**，否则开新 Part（`part_<turnId>_output_text_<sequence>`）。
  撤回清空死 delta 的文本与身份，因此下一代首个 delta 无法延续、必须开新 Part——
  逐代不同的 Part 正是「每次替换都打断了延续」的见证。公共 API 契约：
  `stream.reconciled` 事件意味着该 Turn 较早的 delta「现在文本为空、没有 item_id 或
  content_part_id，且后续 delta 可命名其他 Part」
  （`managed-agent-public-api.openapi.json` PublicEvent schema）。
- **Live SSE。** `GET /v1/agents/sessions/{id}/events` 在 `stream=true` 或
  `Accept: text/event-stream` 时提供 SSE（`PublicAgentController.events`）；
  `Last-Event-ID` 优先于 `after`；低于 `replay_floor_sequence` 的游标得到 409
  `cursor_expired`（JSON）或一个 `agent.session.resync_required` SSE 帧后关闭。流由
  控制面提供，因此跨 Harness 崩溃存活——这正是 live 视图断言所需。

## 目标与范围

**范围内。** 扩展现有 model-round 臂（harness-only 变体）：

1. **Attempt 身份**：三个流式 attempt 携带三个不同 `attemptId`，每代一个新 attempt
   （journal `model.attempt`）。
2. **Stream 身份**：两个死前缀（live 捕获）与存活答案（reload）携带逐代不同的
   content Part——延续在每次撤回处被打断——而三者共享该 Turn 唯一的 assistant
   `item_id`；每次撤回后死前缀的 delta 在 reload 与 replay 视图中文本为空、
   `item_id`/`content_part_id` 为 null。
3. **Live SSE 视图**：runner SSE 客户端在第一个前缀之前连接并跨两次崩溃保持连接；
   live 观察 PARTIAL_ONE、撤回公告、新身份下的 PARTIAL_TWO、第二次撤回、存活答案与
   恰好一个终态。公共 `stream.reconciled` 帧不携带 payload——契约是客户端看到它就
   reload（store 已原地清空被撤回的 delta）——因此 live 收敛视图是**最后一次撤回之后
   的 delta**，而原始捕获中撤回前的帧提供死代的身份。live 收敛视图等于 REST reload
   与 `Last-Event-ID: 0` replay。逐阶段活性守卫使每项观察非空过（帧必须真的到达）。
4. 现有撤回顺序、parity、准入、boot、head 断言保留。

**范围外。** 投影重建游标语义（`cursor_expired` / `resync_required` floor 处理）——
另有夹具的独立 concern；新断言的冻结控制面变体（Q2 臂保持现范围）；两侧 owner 重启；
真实 provider 验收。

**无生产行为改动。** 全部新增为 runner 断言与一个 SSE 客户端 helper；无新 serve
钩子，无 CLI/Java 源码改动。

## 方案

### 身份读法

- `b2ModelAttempts(port, sessionFilter, promptId)` 返回原 prompt 的
  `{attemptId, state, sequence}` 行（最旧优先）；审计要求 `partials + 1` 个不同
  attempt id。它复用 `readJournalManagedEvents`——唯一的共享 journal HEX 解码
  （HEX + 解码，绝不 `--batch` 文本），`finishedBeforeCommitWindow`、
  `siblingFinalPlan`、`b3RoundAndBudget` 同样复用。
- `PublicEvent` 带可选 `turn_id` / `item_id` / `content_part_id`（已在 wire 上）。
  `b2DeltaIdentity(events, text)` 经共享 `textDeltas` 选择器（与 `deltaSequences`
  同一选择器，去掉其空匹配 throw）把携带某前缀的文本 delta 分组为
  `{itemIds, partIds, sequences}`。

### Live SSE 客户端

`readPublicSse(storeUrl, sessionId, { tenantId, after, lastEventId, until, timeoutMs,
drainMs })` 驱动共享 `SseObserver`
（`integration-tests/helpers/hosted-sse-observer.ts`）——仓库收拢的 SSE 解析循环，
断言 content-type、`id === payload.sequence`、`event === payload.type`——而非私有
解析循环。`until` 是**推进**信号而非出口：首次成立后再有界地读一个 drain 窗口
（`drainMs`，默认 2s），使重复投影的终态仍被观察；随后捕获以全部帧加最后 id
resolve。臂在第一个前缀之前开一条 live 连接（after=0），跨两次崩溃保持；终态后用
`Last-Event-ID: 0` 的第二条连接作 replay 见证。捕获 promise 在创建处标记已处理
（`.catch(() => undefined)`)，使早期臂失败时 teardown 的 abort 不会变成 unhandled
rejection；审计的 await 仍看到真实拒绝，abort/预算错误被重包装为 `B2 live SSE …`。
行为化测试覆盖 drain（窗口内两个终态）、abort 语义、共享 observer 的分帧/wire 断言。

### 视图审计

`assertB2StreamViews({ live, reload, replay, partials, answer, firstPrefixSequence,
secondPrefixSequence, originalTurnId })` 是顶层 helper，使行为化测试执行每个子句：
收敛 live 文本（最后一条无 payload 的 `stream.reconciled` 之后的 delta）、live 与
replay 中原 Turn 恰好一个终态、撤回顺序、唯一共享 assistant item 加逐代互不相同的
content Part（每组必须真的携带 item）、reload 与 replay 中被清空的前缀 delta、
replay 身份与 reload 答案的 item 和 Part 都一致。model-round 臂无 gate 模式，其证据
经共享 `writeEvidenceFile` 写入显式命名的 `model-round-<epoch>` 目录（或
`G3_VERIFY_REPORT_DIR`），绝不借用 `packaged-undefined-<epoch>` 目录。

### 断言位置

全部新检查位于现有 model-round 审计块、现有断言之后，gated 在
`modelRoundFailover && harnessOnly`，冻结控制面变体不变。错误信息 B2 专属
（`B2 attempt identities …`、`B2 stream identities …`、`B2 live SSE …`），使回归
点名缺失的观察而非通用审计串。

## 设计决定与理由

- **扩展 model-round 臂而非新臂**——两次替换的流式前缀编排已存在且经 CI 证明；B2 的
  缺口纯为观察性。无新 CI step、无上限变化。
- **Live 视图归控制面所有**——SSE 连接跨两次 Harness 崩溃存活是被测属性，不是麻烦；
  客户端不得逐代重连（那会悄悄变成 reload 轮询）。
- **身份来自 wire 与 journal，而非夹具**——attempt id 来自 `model.attempt` journal
  事件；stream id 来自公共事件的 `item_id`/`content_part_id`。夹具只提供前缀文本。
- **逐阶段活性守卫**——每项 live 观察断言帧真的到达（前缀 delta、撤回、新身份
  delta、终态）；静默读不到任何东西的 SSE 客户端会变红而非空过。

## 约束与风险

- **SSE 解析健壮性。** 帧边界跨 TCP chunk 分裂；解析器是具名 helper，配注入 chunking
  的行为化测试，真机运行是集成见证。
- **共享臂回归。** 冻结控制面变体与其他所有臂的行为必须逐字节不变；新检查 gated，
  契约套件钉住 gate。
- **撤回是原地的。** reload/replay 身份检查事后读被清空的 delta（契约的承诺）；live
  客户端另外看到撤回公告帧。两者都断言；任一单独都不充分。

## 验证计划

- **.75 真机**：model-round harness-only 臂带新断言绿——三个不同 attempt id；三个
  不同 stream 身份；被撤回前缀清空；live SSE 观察两个前缀、两次撤回与一个终态；
  live == reload == replay。
- **实测变异红**：M1 `attemptId` 确定性→attempt 身份红（置于共享审计之前：复用 id
  碰撞 journal command id、去重后续代 attempt，身份检查是根因诊断）；M2
  `retractOriginal` 提前 return→红于共享审计的 `retractedBeforeNewDeltas`——即 B2
  撤回顺序观察——live SSE、Part 延续、清空、replay 检查由同一撤回机制在不同视图的
  观察共同见证（仅破坏 live 流的变异在 Java SSE 投影，超出本切片 CLI-only 范围）；
  M3 `messageId` 钉死常量→红于**上游屏障**（gen2 的流式发布始终未就绪）：跨代
  messageId 碰撞在撤回幂等守卫显现之前就破坏了流式发布——记录为上游守卫观察，而非
  B2 专属见证。各用后还原。Part 延续、清空、replay 检查由 M2（其机制就是撤回）加
  head 绿的正向证据共同见证。
- 契约套件 + 行为化测试（SSE 解析器、身份读法）绿；`npm run build && npm run
typecheck && npm run bundle`。

## 验收标准

- 打包 model-round 臂断言新 attempt/stream 身份、被撤回前缀清空、live SSE 视图收敛到
  存活答案与一个终态，且等于 reload 与 replay。
- 每个新信号有一次实测命名变异红（M1–M3）；live 客户端逐阶段非空过守卫。
- 双语设计文档对齐；CI 绿；无生产行为改动。

## 开放问题

- 冻结控制面变体是否后续继承身份断言（延后；Q2 的范围是过期 claim 围栏）。
- 投影重建游标/resync 语义作为独立切片（此处范围外）。

[issue]: https://github.com/QwenLM/qwen-code/issues/14481
