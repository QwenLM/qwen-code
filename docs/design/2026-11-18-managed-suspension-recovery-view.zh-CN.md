# Managed 挂起恢复视图

[English](2026-11-18-managed-suspension-recovery-view.md) | [简体中文](2026-11-18-managed-suspension-recovery-view.zh-CN.md)

状态：[无状态 Hosted Harness 设计](2026-11-16-managed-stateless-harness.zh-CN.md)第一阶段的拟议补篇。日期：2026-11-18。基线：`origin/main` `ea860cf139`。本补篇规定父设计要求的恢复/状态视图契约（"恢复/状态响应不能因为缓存条目缺失就报告成功，也不能把缺失直接当成需要运维处理的失败"）及其背后的持久状态证明。不新增回执、不改 schema、不新增 Harness 动词。

## 1. 问题

`SessionRecoveryService.inspect()` 从两个来源推导 Session 的恢复视图：持久 head 的 `recovery_status`，以及经 Harness connector 读取的活证据（`inspectRecovery`）。connector 在不持有缓存 attachment 时回答 `null`。干净挂起的 Session 在任何 Harness 上都没有 resident：写者已 seal、activation 已释放，但控制面可能仍持有过期缓存条目，或什么都没有。今天，缓存缺失会落到 `operator_required` / `awaiting_evidence` 加 `recovery_evidence_unavailable`——把健康的挂起 Session 当成需要运维的失败；反过来，过期缓存又可能为一个无人持有的 Session 报告活证据。两个方向都不可接受：视图必须跟随持久 writer/activation 状态，而非缓存的有无。

## 2. 持久事实及其顺序

`ma_session_head` 行（kind `MANAGED_SESSION`）已携带证明所需的一切：

- `state`——journal 生命周期：`ACTIVE` 或 `SEALED`。
- `writer_generation`、`writer_id`、`writer_lease_until`——fencing 写者及其租约。
- `activation_phase`、`activation_id`、`activation_expires_at`——投影的 activation。
- `activation_head_revision` 对比 `journal_revision`——投影时效。提交路径在与提交同一事务内更新 activation 投影，并拒绝把偏斜的投影认证为当前；不含 activation 变更的提交会让 `activation_head_revision` 落后于 `journal_revision`，直到一个携带 activation 的提交追平。
- `recovery_status`、`recovery_detail_code`——恢复阻塞（如有）。

挂起 teardown（父设计「挂起流程」）按固定顺序执行：关 wake 调度器、非终态 Hook/MCP close、Runtime 租约释放与 cleanup debt 对账、publisher close，然后才是停续约、释放 activation、seal。seal 是最后一步。因此，一个 activation 投影当前且为 `released` 的 `SEALED` head 证明此前每个资源步骤都已完成：在它们之前任何一步崩溃都会让 head 停留在 `ACTIVE`。

## 3. 视图契约

`inspect()` 保留既有分支（Session 非 active；已绑定 Session 缺 head；recovery 状态非 READY；原始初始 Session；无恢复意图的活跃 Turn）。在落到活 Harness 证据之前，按以下顺序评估持久挂起状态：

1. **干净挂起 → `ready`。** Session `ACTIVE`、head recovery `READY`、head `state = SEALED`、`activation_phase = released`、且 `activation_head_revision = journal_revision`（投影当前）、无活跃 Turn。视图为 `ready` 且 `nextTurnAllowed = true`：下一次 load 获取写者 generation + 1，对已 seal 写者 fencing，并重新安装 owners。不查询 Harness 证据，缓存缺失无关紧要。
2. **已 seal、投影滞后 → `awaiting_evidence`。** `state = SEALED` 但 `activation_head_revision < journal_revision`：释放可能尚未投影。视图等待投影而非猜测；这不是运维失败。（实际上释放提交同步投影；此分支覆盖与并发提交竞争的读取，以及任何未来的异步投影。）
3. **已 seal、activation 未释放、投影当前 → `operator_required`，原因 `teardown_sequence_violation`。** 每条 seal 路径都先释放 activation（挂起 teardown；终态 close 整体退休 Session）。当前投影显示 `SEALED` 而 activation 非 released，是任何健康路径都不会产生的异常；它指名运维恢复，而非泛化的 evidence-unavailable 原因。
4. **其余**沿用既有 writer-loss 与活证据分支：`ACTIVE` head 加过期租约且无活跃写者是既有恢复情形；活 attachment 的证据仍驱动 recovering/cleanup 视图。

缓存缺失本身绝不决定任何方向的结论。过期缓存条目不能让已 seal 的 Session 报告活证据：分支 1–3 在调用 `inspectRecovery` 之前评估，`SEALED` head 绝不进入活证据分支。

## 4. 与 Harness 闸门的交互

Harness 挂起闸门（`hosted_session_closing` / `hosted_session_teardown_blocked`）是独立机制，有自己的对账：被阻塞的闸门重试同一次 seal，而实际已提交的 seal 以幂等回答清除闸门。恢复视图独立于闸门报告持久真相：seal 已提交的 Session 在此处为 `ready`，即使某个 Harness 闸门仍在对账；控制面的 load 重试在对账完成前遇到闸门的暂时性拒绝。父设计待解决问题 8（卡死 teardown 的有界自动恢复）仍是挂起机制的启用门槛；本补篇既不解决也不依赖它。

## 5. 实现形态

- 扩展 `SessionRecoveryRepository.HeadRecovery`：journal 状态、activation phase、两个 revision；相应扩展 JDBC select。无 schema 变更。
- 在 `inspect()` 的活证据回退之前插入分支 1–3。
- 测试：每个分支一个单元用例（H2），含投影滞后分支（在释放之后用一个不含 activation 变更的提交构造）；干净挂起与滞后分支的真实 MySQL IT；一个回归用例证明过期缓存不能覆盖已 seal 的 head。

## 6. 验收

- 干净挂起的 Session 在无 Harness resident、无缓存条目时报告 `ready` / `nextTurnAllowed`。
- 对已 seal、已释放、投影当前的 head，缓存缺失绝不产生 `operator_required`。
- 偏斜投影产生 `awaiting_evidence`，而非 `ready` 或 `operator_required`。
- 异常分支指名 `teardown_sequence_violation`。
- 既有恢复视图（writer loss、活跃 Turn、cleanup pending、初始 Session）不变。
