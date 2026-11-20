# 基于持久原生终态的 Managed 恢复

[English](2026-11-19-managed-recovery-native-terminal.md) | [简体中文](2026-11-19-managed-recovery-native-terminal.zh-CN.md)

状态：提案。#17538 与 #17543 已在同一 PR 中实现；#17542 在此分析，留给后续处理。日期：2026-11-19。本文把[挂起恢复视图](2026-11-18-managed-suspension-recovery-view.zh-CN.md)从已 seal 的 head 推广到活跃 head。不改 schema、不新增 Harness 动词；OpenAPI 仅改描述（§4 的 recheck 错误码）。

## 1. 问题

`SessionRecoveryService` 决定 Session 能否接受下一个 Turn。在 sealed-head 证明之外，它判断最新 Turn 的输入时，唯一读取的证据是经 `HarnessConnector.inspectRecovery` 拿到的 Harness 活证据。这份证据只存在于一个控制面副本上：Hosted Harness 的 `GET /session/:id/status` 只回应加载该 Session 的 client（`X-Qwen-Client-Id` 必须等于 `session.clientId`）。其他副本都没有 attachment，connector 返回 `null`。三个已报告的故障同出于此：

- **#17538：读路径在副本间翻转。** 在没有 attachment 的副本上，`null` 证据会让终态 Turn 落入 `operator_required` / `recovery_evidence_unavailable` / `nextTurnAllowed=false`。轮询负载均衡下，大多数读取都会落在这样的副本上。`ManagedAgentService.getPublicSession` 与 `getWebShellSession` 把同一视图投影到每一次 Session 读取上，于是发送闸门逐请求翻转。Web Shell 的缓解（#17557）要求同一 Turn 连续两次缺失才接受，4 副本下一个已完成的 Turn 仍有约 9/16 的读取被锁住。
- **#17543：recheck 无法从持久状态结清。** `recheck` 会重读同一视图。对冷的终态 Turn，它接着调用 `recheckRecoveryCleanup`，这需要一个能打开该 Session 的 Harness。没有这样的 Harness 时，调用要么抛出无错误码的失败，要么返回 `409 recovery_recheck_unavailable`。即使持久状态已表明 Harness 结清了该 Turn，这个回答也永远不变。
- **#17542：被外部终止的 runtime 永远无法结清其 Turn。** Workspace Turn 的 `fail()` 要先拿到 Harness 对输入已结清的证明（`inputSettlementConfirmed`），或一次已对账的取消。runtime 消失后，这个证明永远拿不到。结果形成循环：`recoverParkedRuntime` 调用 `fail`，取消一直未对账，`parkRuntimeRecovery` 把 Turn 再次挂起，下一次 recheck 又从头开始。

## 2. 已能证明结清的持久事实

Harness 只从 journal 投影公开终态事件。`turn_complete` 与 `turn_error` 只作为已提交 `turn.settled` 事件的投影存在（`hosted-harness-session.ts`）。控制面在同一事务里通过 `completeHarnessTurn` 与 `appendEvents` 写入它们，source key 为 `bootId:eventEpoch:sourceId`。

控制面自己写的终态事件不带 source key：`settleFailedTurn` 与 `failWorktreeInitialTurns` 写的 SQL `turn.failed`，以及 `cancelUnadmittedTurn` 写的 SQL `turn.cancelled`。只有 Turn 终态事件会置 `is_terminal = 1`。

因此：

> 当且仅当 `ma_public_event` 中存在该 Turn 的 `SESSION` 流记录，且 `is_terminal = 1`、`source_key` 非空时，这个 Turn 拥有**持久原生终态**。此时 Harness journal 中一定有该 Turn 的 prompt 对应的 `turn.settled`。

这正是 recheck 契约在任何清理之前就要求的"持久原生终态"。历史 SQL 失败不算，契约也禁止把它当作原生结清。这个事实经 `idx_ma_event_turn` 在每个副本上都可读，不需要任何 Harness 可达。

## 3. 视图契约变更（#17538）

`inspect()` 保留所有现有分支及其顺序。在读取活证据之后新增一个分支，**仅在本副本没有活证据**（`evidence == null`）**且不持有缓存的 recovery attachment 时**生效：

- 本副本不持有缓存的 recovery attachment（`cachedRecoveryAttachment == null`，纯进程内缓存读取）。owner 副本上抛异常或回应别的 prompt 的状态读取是"读不到证据"，不是"没有证据"，仍走保守分支；
- 最新 Turn 不处于活跃状态；
- head 为 `ACTIVE`，即活的 journal；已 seal 的 head 保留挂起证明及其已记录的残余；
- 该 Turn 拥有持久原生终态（§2）；
- `hasUnsettledWork` 为假：没有活跃 Turn、没有存活的 Runtime execution、没有 `REFERENCED` 的 `HOSTED_CLEANUP` 债务。

满足时视图为 `ready`、`nextTurnAllowed = true`，不提供 recheck 或 cancel。前面的分支已经处理了非活跃 Session、已绑定 Session 缺失 head、以及 head 的恢复阻断不为 `READY` 的情况，所以持久的 Harness 阻断仍然优先。

设计决策：

- **兜底而非覆盖。** owner 副本仍报告它的活证据，例如 Turn 刚结束时的 `cleanup_pending` / `file_history_pending`。被替换的只是"没有证据"，而持久状态如今恰好证明了这种缺失过去所拦下的那件事。若覆盖活证据，就会把真实的 Turn 后义务藏起来，而唯一能看到这些义务的正是 owner 副本。
- **只认原生终态。** 最新 Turn 只能证明它自己的 prompt 已结清。正常路径下，更早的输入也被覆盖：Harness 同一时刻只运行一个 Turn（`hosted_turn_active`），而加载时若发现更早的未结清输入，会在 `open()` 中拒绝。因此在更早输入仍待结清时，不会出现更新的原生终态（未被证明的剩余情况见 §9）。从未提交的 SQL 失败（`is_submission_attempted = false`）**不**算证明：它对更早 Turn 毫无说明，而那个 Turn 的输入可能仍未在 journal 中结清。
- **只针对活跃 head。** 未通过挂起证明的已 seal head（例如缺少 wake 证明）保持保守回答：那里迟到的 wake 输入没有 owner 来处理。

## 4. Recheck 变更（#17543）

- `recheck` 通过同一视图确定目标。拥有持久原生终态且没有未完成义务的 Turn 因此是 `ready`，`recheck` 在联系任何 Harness 之前就直接返回它。这回应了 issue 的主要期望：持久状态证明 Turn 已终态时，recheck 从持久状态结清。
- 没有任何 Hosted Harness 能服务的冷清理 recheck，现在以 `503 recovery_runtime_unavailable` 失败。这覆盖 `recheckRecoveryCleanup` 除下述类型化终止拒绝之外所有非 `ManagedAgentException` 的失败，这类失败过去以无错误码的错误出现。有错误码的拒绝原样透传，包括 pool 的 `503 harness_pool_unavailable`。`409 recovery_recheck_unavailable` 保持契约含义：recheck 已运行，但工作不符合条件。
- 类型化的终止拒绝（`HostedHarnessRecoveryDeclinedException`）映射为 `409 hosted_turn_recovery_declined`，并保留原拒绝作为 cause。拒绝是终局的——重试永远改变不了它——因此不能披上上面那个可重试的 `503`。public 与 WebShell 两处 recheck 描述都写明这两个错误码；这就是那次仅改描述的 OpenAPI 变更，版本 1.123.0。
- 清理债务的 recheck 仍依赖 Harness，issue 允许这一点。

## 5. #17542 的分析与后续

§1 中的循环确实存在，但控制面不能简单地写 `FAILED` 来打破它：journal 中的输入会保持未结清，下一次 Harness 加载会在 unsettled-input 分支拒绝该 Session。结清必须落到 journal，这需要一个 Harness 写者。

阻挡 Harness 的是取消就绪判定。`HarnessRuntimeRecovery.isCancellationReady` 会拒绝 Runtime execution 结果为 `unknown` 的 `results_ready` 挂起。runtime 被外部终止后，只有当 Runtime Broker 把已终止的 generation 视为"其 execution 已停止"的权威证据时，这个结果才可能变为已知。

Broker 已有 `LOST` generation 与有界的 drain 轮次（`RuntimeBindingProvisioning`、`RuntimeDrainCoordinator`）。后续工作必须先在真实环境复现，找到是哪一层让结果停留在 `unknown`，再在以下方案中择一提出：

1. 已 drain 的 `LOST` 或 `RELEASED` generation 把其 execution 报告为已停止，让现有取消路径在 journal 中结清该 Turn；或
2. 一个专用的终止原因，经 Harness recovery 传递，使该 Turn 只被结清一次。

两种方案都必须保留防重复执行的保护：旧 generation 仍可能运行时绝不结清。journal 结清后，§3 会让 Session 在每个副本上都是 `ready`。

## 6. 实现形态

- `SessionRecoveryRepository.hasNativeTerminal(tenantId, sessionId, turnId)`，在 `JdbcSessionRecoveryRepository` 中实现为一条针对 `ma_public_event` 的 `EXISTS`。
- `SessionRecoveryService.inspect()`：§3 的兜底分支，以缓存 attachment 读取为闸门。
- `SessionRecoveryService.recheck()`：两处清理调用都经过 `recheckCleanup`，后者实施 §4 的 `503` 映射、把类型化终止拒绝映射为 `409 hosted_turn_recovery_declined`，并记录原始失败，因为 API 映射 `ManagedAgentException` 时不会记录其 cause。
- 开销：在没有活证据的副本上，最新 Turn 不活跃且处于活跃 head 的 Session 读取，现在会额外执行那条带索引的 `EXISTS`；它成立时，还会执行现有的 `hasUnsettledWork` 语句。

## 7. 验证

`SessionRecoveryServiceTest` 中的 H2 单元用例：

- 拥有原生终态的 `COMPLETED`、`CANCELLED` 以及 Harness `FAILED` Turn，在没有 attachment 时为 `ready`，且摘要投影与恢复读取一致；
- SQL 写入的终态（source key 为 null）保持 `operator_required`；
- 拥有原生终态、但存在活跃 Turn、存活的 Runtime execution 或清理债务时，不为 `ready`；
- owner 的活证据（`cleanup_pending`）仍优先于原生终态；
- 缺少 wake 证明的已 seal head，即使有原生终态也保持非 ready；
- 对原生终态 recheck 时返回 `ready`，且不调用 `recheckRecoveryCleanup`；
- Harness 不可达时返回 `503 recovery_runtime_unavailable`，有错误码的 pool 拒绝原样透传；
- 带 source key 但非终态的行（`is_terminal = 0`），以及属于别的 Turn 的原生终态，都不能结清最新 Turn；
- owner 副本的状态读取抛异常或回应别的 prompt 时，即使存在原生终态也保持非 ready：缓存 attachment 否决该分支；
- 清理 recheck 遇到类型化终止拒绝时返回 `409 hosted_turn_recovery_declined`，而不是可重试的 `503`。

尚欠：在真实 MySQL 上确认 `ma_public_event` 查询走 `idx_ma_event_turn` 的执行计划，以及在双副本环境中证明读取稳定。`EXISTS` 按 `sequence_id` 升序扫过该 Turn 的行，而终态位于结清批次末尾；已达成一致的最小改写是 `ORDER BY sequence_id DESC LIMIT 1`（同一索引反向扫描；负例仍走全量），由该计划检查决定采纳或量化后再定。

## 8. 验收标准

- 在活跃 head 上，Harness 已结清的 Turn 在没有未完成持久义务时，从每个副本读取都报告 `ready` / `nextTurnAllowed = true`。摘要与恢复接口一致。
- SQL 写入的终态从不被当作原生结清。
- owner 副本的活证据以及所有 sealed-head 分支保持不变。
- owner 副本的状态读取失败从不授予 readiness，即使存在原生终态。
- 对持久已结清 Turn 的 recheck 不加载 Session 即返回 `ready`；Harness 不可达时返回带错误码的 `503`，类型化终止拒绝返回带错误码的 `409`。

## 9. 残余问题

- 仍欠持久义务的活跃 head（例如 Turn 结束后仍在运行的后台 Runtime execution），在非 owner 副本上保持原有的保守视图。要补上这一缺口，需要把 owner 对这类工作的判定持久化。
- 没有独立 `ma_turn` 行、只存在于 journal 中的待处理输入，对持久分支不可见。若 Harness 需要先处理它，下一次提交会走 Harness 的正常准入，与 owner 早一刻回答 `ready` 的情形完全相同。
- 该分支不重放 journal，因此"更新的原生终态之后不会残留更早的待结清输入"这一判断依赖 §3 所述的 Harness 准入与加载保护，而非对 journal 的证明。若这一假设不成立，非 owner 副本会回答 `ready` 而 owner 回答 `inputs_unsettled`。该视图只控制能否发送，本身从不准入任何工作：下一次提交仍要经过 coordinator 与 Harness 自身的准入保护。
- 有些非 ready 判定在 owner Harness 内部计算，持久分支一个都不读取：Turn 结束后的 file-history 工作（`cleanup_pending` / `file_history_pending`）、待处理的 file-history 撤销、未就绪的 continuation、扩展恢复，以及已停止的写入。这些状态成立期间，owner 会根据 live evidence 报告它们，而非 owner 副本会回答 `ready`。与上一条相同，该视图只控制能否发送：下一次提交仍要经过 coordinator 与 Harness 自身的准入。
- 冷副本对持久已结清 Turn 的 recheck 直接返回 `ready`，不再尝试清理（§4）。改动前，同一个 POST 可以把 cleanup-only 加载路由到 placement owner，推进 owner-only 的清理债务；这个驱动能力被有意放弃，因为尝试它会打破本设计赖以成立的"不加载 Session"保证。清理仍有其他驱动者：owner 自身的恢复仍读取它的活证据（该分支在那里永不生效），而 `REFERENCED` 的 `HOSTED_CLEANUP` 债务是持久的，每个副本的 `hasUnsettledWork` 都能看到。作为上一条 owner-only 残余在 recheck 侧的对应物，接受这一取舍。
- #17542 仍未解决（§5）。
