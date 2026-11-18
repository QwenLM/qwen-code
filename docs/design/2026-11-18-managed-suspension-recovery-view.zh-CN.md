# Managed 挂起恢复视图

[English](2026-11-18-managed-suspension-recovery-view.md) | [简体中文](2026-11-18-managed-suspension-recovery-view.zh-CN.md)

状态：[无状态 Hosted Harness 设计](2026-11-16-managed-stateless-harness.zh-CN.md)第一阶段的补篇，已在第一阶段 PR（#17690）中实现。日期：2026-11-18。本补篇规定父设计要求的恢复/状态视图契约（"恢复/状态响应不能因为缓存条目缺失就报告成功，也不能把缺失直接当成需要运维处理的失败"）及其背后的持久状态证明。不新增回执、不改 schema、不新增 Harness 动词。

## 1. 问题

`SessionRecoveryService.inspect()` 从两个来源推导 Session 的恢复视图：持久 head 的 `recovery_status`，以及经 Harness connector 读取的活证据（`inspectRecovery`）。connector 在不持有缓存 attachment 时回答 `null`。干净挂起的 Session 在任何 Harness 上都没有 resident：写者已 seal、activation 已释放，但控制面可能仍持有过期缓存条目，或什么都没有。缓存缺失于是落到 `operator_required` / `awaiting_evidence` 加 `recovery_evidence_unavailable`——把健康的挂起 Session 当成需要运维的失败；反过来，过期缓存又可能为一个无人持有的 Session 报告活证据。两个方向都不可接受：视图必须跟随持久状态，而非缓存的有无。

这不只影响运维恢复接口。`ManagedAgentService.getPublicSession` 与 `getWebShellSession` 会把同一视图投影到**每一次**普通 Session 读取上，所以这里判错一个分支，就会在公开 API 和 Web Shell 里给每个已挂起 Session 贴错标签。

## 2. 持久事实，以及为什么"已 seal"还不够

`ma_session_head` 行（kind `MANAGED_SESSION`）携带：

- `state`——journal 生命周期：`ACTIVE` 或 `SEALED`。
- `writer_generation`、`writer_id`、`writer_lease_until`——围栏写者及其租约。
- `activation_phase`、`activation_id`、`activation_expires_at`——已投影的 activation。
- `activation_head_revision` 与 `journal_revision`——投影是否齐平。`JournalCommit` 在该事务带 activation 变更**或它本来就已齐平**时把它推进到新修订，并绝不把偏斜的投影认作齐平。因此已齐平的投影会跨普通提交保持齐平；只有本来就落后的投影才会一直落后，直到某次带 activation 的提交追上。
- `is_wake_pending`、`wake_head_revision`——wake 投影。wake 扫描只有在独立重放已提交前缀、证明该修订上没有任何待处理 wake 输入之后，才清除该提示。
- `recovery_status`、`recovery_detail_code`——恢复阻塞（若有）。

挂起 teardown 按固定顺序执行且最后才 seal，因此在任何资源步骤之前崩溃都会让 head 停在 `ACTIVE`。**但逆命题不成立。** 被拒绝的 load 同样会关掉它刚获取的写者：`open()` 的接管拒绝、输入未结算、workspace 不可写、extension 恢复与 quiescing 各分支都会调用 `managed.close()`，释放 activation 并 seal。它们留下的 head 与完成挂起时完全相同——`SEALED` + `released` + 投影齐平——而 journal 仍欠着工作。裸 `writers:seal` 也能留下"已 seal 但 activation 未释放"的 head。

所以"已 seal"是必要条件而非充分条件。判 `ready` 需要"什么都不欠"的正面证明，且只用已有投影：

- **没有未结算 Turn**：该 Session 在 `ma_turn` 中没有 `ACCEPTED`、`RUNNING`、`CANCELLING` 的行。
- **没有活的 Runtime 执行**：`ma_session_record` 中没有 `runtime_state` 非空的 DOMAIN 行。该列仅在某个已投影 run 的执行仍存活时非空（`unbound`、`provisioning`、`ready`、`draining`、`lost`），因此无需读记录体就能指出未结算的 MCP、Hook、extension、子任务与 Monitor 工作。
- **没有欠下的清理**：`HOSTED_CLEANUP` 的 `ma_resource_ref` 背后没有 `REFERENCED` 的 `ma_resource`——与清理债务扫描器同一判据。
- **该修订上的 wake 证明**：`is_wake_pending = 0` 且 `wake_head_revision = journal_revision`。

## 3. 视图契约

`inspect()` 保留既有分支（Session 非 active；已绑定 Session 缺 head；recovery 状态非 READY；原始初始 Session；无恢复意图的活跃 Turn）。在落到 Harness 活证据之前，它先评估持久挂起状态：

1. **干净挂起 → `ready`。** Session `ACTIVE`、head recovery `READY`、`state = SEALED`、`activation_phase = released`、投影齐平、无活跃 Turn、具备上述 wake 证明、且无未结算工作。视图为 `ready` 且 `nextTurnAllowed = true`：下一次 load 获取 writer generation + 1，被已 seal 的写者围栏保护，并重新安装 owner。不查 Harness 证据，缓存有无无关。
2. **已 seal 但投影滞后 → `awaiting_evidence`。** `activation_head_revision < journal_revision`：释放可能尚未投影。视图选择等待而非猜测，这不是运维失败。
3. **其余情况一律下落**到既有的写者丢失与活证据分支。无法证明自己什么都不欠的已 seal head，保持这些分支本来就给出的保守答案；既不会被改写成健康挂起，也不会被赋予新的异常码——裸 `writers:seal` 与被拒绝的 load 都能合法地留下这些形态。

缓存缺失本身在两个方向上都不决定结果；过期缓存也无法让一个已证明干净的已 seal Session 报告活证据：分支 1–2 在调用 `inspectRecovery` 之前评估。

**证明的适用范围。** wake 扫描覆盖符合条件、journal 未压缩的活跃 public Session。落在该范围之外的已挂起 Session——子 Session，或 journal 已压缩的 Session——永远拿不到 wake 证明，因此保持既有的保守视图而非 `ready`。另有两处残留是刻意为之：某个已投影 run 未终结但既无 Runtime 执行也无清理债务（例如中途停下的 extension bootstrap），不被上述判据指出；wake 证明在挂起之后一次扫描才到达，该窗口内的读取是保守的。所有残留情形下，load 本身仍会拒绝并重新建立 resident 视图，不会丢失工作也不会重复执行。扩大证明范围属于后续工作，不是删掉某条判据的理由。

## 4. 与 Harness 闸门的关系

Harness 挂起闸门（`hosted_session_closing` / `hosted_session_teardown_blocked`）是另一套机制，有自己的对账过程。恢复视图独立于它报告持久事实：seal 已提交且义务已证明清空的 Session，即使某个 Harness 闸门仍在对账，在这里也是 `ready`；控制面的 load 重试在对账完成前会撞上闸门拒绝。闸门自身的上界见[有界恢复补篇](2026-11-18-managed-suspension-bounded-recovery.zh-CN.md)。

## 5. 实现形态

- 扩展 `SessionRecoveryRepository.HeadRecovery`，加入 journal 状态、activation phase、两个修订号与两个 wake 列；相应扩展 JDBC select。不改 schema。
- 新增 `SessionRecoveryRepository.hasUnsettledWork`，用一条语句覆盖上述三个义务投影。
- 把分支 1–2 插入 `inspect()`，位于活证据兜底之前。
- 测试：每个分支与每条判据各一个 H2 用例，包含"已结算记录与已确认债务不会过度拦截"的用例，以及"过期缓存无法覆盖已证明干净的已 seal head"的回归用例。干净挂起与滞后分支的真实 MySQL IT 仍是启用前的欠项。

## 6. 验收

- 干净挂起的 Session 在没有 Harness resident、没有缓存条目时报告 `ready` / `nextTurnAllowed`。
- 仍欠 Turn、活 Runtime 执行或清理债务的已 seal head 绝不判 `ready`。
- 缺少 wake 证明、或 wake 证明只覆盖更旧修订的已 seal head 绝不判 `ready`。
- activation 投影偏斜时给出 `awaiting_evidence`，既不是 `ready` 也不是 `operator_required`。
- 已结算记录与已确认债务不阻挡该证明。
- 既有恢复视图（写者丢失、活跃 Turn、清理待办、初始 Session）保持不变。
