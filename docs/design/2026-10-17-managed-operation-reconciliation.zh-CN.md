# Managed operation 对账（Stage D7-2）

[English](2026-10-17-managed-operation-reconciliation.md) | [简体中文](2026-10-17-managed-operation-reconciliation.zh-CN.md)

状态：第一阶段已在 #14443 合入（契约 `1.59.0`），第二阶段（SSH Workspace 注册）已在 #14456 合入（契约 `1.60.0`），第三阶段（Session 标题）已在 #14475 合入。各阶段都不改 schema。决定 9 已在 #14669 合入、决定 10 已在 #14681 合入；`CANCELLING` 车道的取消在本次改动中实现。跨 Harness kill 的故障门禁仍留在 #14166。

这是 [#14122](https://github.com/QwenLM/qwen-code/issues/14122)（[#12380](https://github.com/QwenLM/qwen-code/issues/12380) Stage D 的 D7 总 issue）的 **D7-2** 切片，由 [#14166](https://github.com/QwenLM/qwen-code/issues/14166) 跟踪。#12380 规定，Stage D 只有同时具备持久命令投递（D7-1，[#14168](https://github.com/QwenLM/qwen-code/issues/14168)）和原命令对账（本切片），才能暴露 `java_durable`。D7-3（[#14167](https://github.com/QwenLM/qwen-code/issues/14167)，可选开启的 profile）要等这两者都完成。本切片涉及的每一处代码，都在 #14166 的设计说明里做了分类。

## 问题

`recovery_blocked` 本意是"准入未知：重新执行之前先对账"。在 `main` 的 `7d6dcc8c95` 上，它表达三种不同的意思，分别由三处代码决定：

| 种类                                         | 写入方                       | 含义                           | 之后                                                |
| -------------------------------------------- | ---------------------------- | ------------------------------ | --------------------------------------------------- |
| `TASK_CANCEL`                                | `TaskCancelCoordinator.park` | 准入未知                       | `reconcileParked` 读任务记录，从不重发              |
| `CLOSE`、`DELETE`（理论上还有 `CWD_CHANGE`） | `blockLifecycleOperation`    | 对前置条件的公开等待；准入已知 | 重新认领、重新驱动，靠按 key 存的副作用回执防止重复 |
| `WORKSPACE_CREATE`                           | `SshWorkspaceStore.fail`     | 任何不可重试的失败             | 无人处理；永久停留，并一直占着目录预留              |

由此带来两个缺陷：

- **`claimOperation` 对所有 Session 种类都接受 `RECOVERY_BLOCKED`**，`TASK_CANCEL` 也不例外。一个在第一次认领时就挂起的 cancel（`runtime_session_not_found`），之所以没被重发，只是因为扫描从不交出它。认领预算的守卫（`claimGeneration > ATTEMPT_BUDGET`）覆盖不到这种情况。
- **Turn 已经发出提交、但没有任何 Harness 应答就失败时，D7-1 把它的输入记成 `failed`。** `HarnessCoordinator` 自己的注释写明，event epoch 为空并不能证明没有准入（R10-4）：Harness 可能已经接受了 prompt，只是回复丢了。这是准入未知，却被记成了"未被接受"。

## 目标

- 对准入未知的 `recovery_blocked` operation，由一条规则决定下一步，并且只读取该 operation 自己按 key 存储的证据。
- 任何认领都不会拿到这样的 operation，也不会再次发送它。
- `submit_input` 适用同一条规则，证据来自 Session journal。
- `recovery_blocked` 的其他含义都起了名字，并写明是不同的概念。

## 非目标（后续阶段）

- ~~`WORKSPACE_CREATE`~~：见下文第二阶段。
- ~~`RENAME` 的 `UNKNOWN` 状态及其读取器（Harness 的标题 revision）~~：见下文第三阶段。
- ~~Turn 层的恢复读取与挂起~~：见下文决定 9 和 10。围绕 v2 执行 kill Harness 的故障门禁仍留在 #14166。
- 为生命周期等待改名公开的 `recovery_blocked` token。这属于契约变更，放在本来就要暴露投递状态的 D7-3 更合适。
- 删除只读不写的残留状态（`ma_turn.status = 'RECOVERY_BLOCKED'`、Session 种类的 `UNKNOWN`），以及把手写的 `INSERT INTO ma_operation` 语句收成一处。

## 决定

### 1. 含义由种类决定

`ManagedAgentStore` 定义了两个集合：

- `ACCEPTANCE_UNKNOWN_KINDS` = `TASK_CANCEL`、`SUBMIT_INPUT`，以及第三阶段起的 `RENAME`。对它们来说，`RECOVERY_BLOCKED` 表示命令的准入未知。
- `LIFECYCLE_WAIT_KINDS` = `CLOSE`、`ARCHIVE`、`DELETE`、`CWD_CHANGE`。对它们来说，这是一个准入已知的 operation 的公开等待，由生命周期 coordinator 重新驱动。

两者对外的状态都还是 `recovery_blocked`，契约里写明了每种 kind 对应哪种含义。

### 2. 认领不会拿到准入未知的行

`claimOperation` 照旧接受 `PENDING` 和 `RUNNING` 行，`RECOVERY_BLOCKED` 行只在属于生命周期等待种类时才接受。挂起的 task cancel 到期后也不再能被认领，无论它多早挂起。

### 3. 一个对账器，每种 kind 一个证据源

```java
public interface AcceptanceEvidence {
    OperationKind kind();
    AcceptanceVerdict read(OperationRecord operation); // COMMITTED、NOT_COMMITTED（附原因码）或 UNKNOWN
}
```

`OperationReconciler` 取代了 `TaskCancelCoordinator` 自己的挂起扫描。它每秒读取准入未知种类中到期的挂起行（`findParkedOperations`），询问该 kind 的证据，然后通过 `settleParkedOperation` 结算：

- **已提交**：记为完成，`harness_confirmed`、`confirmed`，并生成回执。
- **未提交**：记为失败，`java_durable`、`blocked`，写入被证明的失败码，并把 `available_at` 移到所有扫描之后。
- **未知**：重新挂起，等待 `RECHECK`（5 分钟）。

结算只作用于仍处在挂起状态且未被认领的行（`state = 'RECOVERY_BLOCKED' AND delivery_state = 'BLOCKED' AND claim_owner IS NULL`），所以对账永远不会改写已经记录的结果。证据读不出来时，该行挂起一整个复查周期，不会一直卡在页首。扫描以 kind 和 state 开头，只读挂起行，不会扫到某个 kind 已结算的历史。

`TaskCancelCoordinator` 是 `TASK_CANCEL` 的证据源。它读取任务已提交记录的 `verdict` 没有任何改动，只是扫描挪了位置。

### 4. 提交没有得到应答时，Turn 输入改为挂起

当 Turn 失败时 `submission_attempted` 已置位、但没有 event epoch，`settleTurnCommands` 现在把输入挂起：`recovery_blocked`、`java_durable`、`blocked`、`submit_input_unconfirmed`，并且立即到期。如果 Turn 失败前从未尝试提交，输入仍以 Turn 的错误码失败，因为这时"未准入"已被证明。已取消的 Turn 不变：Java 只在提交标记清空时才会在准入前取消 Turn，而 Harness 发起的取消一定带有 epoch。

### 5. Session journal 是输入的证据

Harness 接受一个 prompt 时，会往托管 Session journal 提交 `submitInput`，`commandId = promptId`，`contentDigest` 为 payload digest。Java 把这次提交存进 `ma_session_journal_tx`，按 `commandKeyHash("submitInput", promptId)` 做 key。`turnInputAcceptance` 用一条语句同时读取 journal 行和 head，然后判断：

- Turn 上有 event epoch，或者 journal 里有该 prompt 的一行、且内容 digest 与 Turn 的 payload digest 一致：**已提交**；
- 没有这一行，并且 `MANAGED_SESSION` head 处于 `DELETING` 或 `DELETED`、尚未开始压缩：**未提交**，失败码取 Turn 的错误码；
- 其他情况：**未知**。

只要还有 writer 可能提交，缺少这一行就证明不了什么。`ACTIVE` 或 `SEALED` 的 head 还能接受 writer；而且托管提交的处理逻辑要在若干次 await 之后才读取 Session 的 authority，所以即使是之后的 writer 代际，也可能提交一个更早到达的请求。处于 `DELETING` 或 `DELETED` 的 head 会拒绝所有 writer，而删除之前完成的提交一定能同时被读到。这两个事实特意放在一条语句里读：一条语句在任何隔离级别下都只有一个读视图；如果拆成两条语句，在 READ COMMITTED 下，准入和删除可能在两条语句之间先后提交，结果读成"journal 已完整却没有这次准入"，把一条已准入的输入永久记为失败。一旦开始压缩，journal 可能已经丢掉这一行，缺失就又证明不了什么。digest 与 Turn 不一致的行不是这条输入的准入，只记日志、保持未知。

如果 Session 没有托管 journal，或者 journal 先被压缩了，这条输入就一直挂起。它不构成任何屏障：Turn 命令不是 Session operation。

### 6. 屏障保持差异

`hasOpenOperation` 不把挂起的 task cancel 算作打开状态，所以它不会挡住任何生命周期操作（H4f）。`WorkspaceMigrationStore.requireIdle` 和 `WorkspaceRecoveryStore` 的源检查仍然把它算进去。这个差异是有意的：迁移要搬走的存储，可能还在被这个 cancel 的任务使用。

### 7. 第二阶段：SSH Workspace 注册按节点对账

`SshWorkspaceService.register` 的步骤依次是：认领、探测、`reserve`、在节点上执行 `register-storage`、最终探测、`complete`。其中只有 `reserve` 和 `register-storage` 有副作用。`reserve` 写入存储别名和物理目录的所有权（`FENCE_ONLY`、`UNVERIFIED`），并把这次注册记进 `result_json`。`register-storage` 在节点上写 marker。

- **没有预留就意味着从未发出。** `register-storage` 只在 `reserve` 提交之后才执行，所以没有 `result_json` 的注册从未到达节点。它不可重试的拒绝现在是终态 `failed`（`ssh_runtime_version_mismatch`、`storage_already_registered`、`runtime_node_forbidden` 等），也没有需要释放的东西。
- **已预留就意味着准入未知。** 已预留的注册以 `recovery_blocked`（`java_durable`、`blocked`）挂起，并保留失败码。它在上一次尝试结束一个延迟（`PARK_DELAY_MILLIS`，5 分钟）之后才到期。这样，调用方放弃时节点上仍在执行的 `register-storage`，在读节点之前已经结束。
- **证据就是节点本身。** `SshWorkspaceService` 是 `WORKSPACE_CREATE` 的证据源，它对预留的根目录做一次只读探测：
  - **已提交：** 预留的身份带有本次注册的 marker。`completeParked` 按原注册流程补完：存储登记、所有权就绪，并创建 Workspace 及其所有者权限。
  - **未提交：** 预留的身份没有 marker，或者该路径已换成另一个目录。`releaseParked` 把它记为失败，并删除别名和所有权，前提是这两行仍是本次注册未完成的预留。
  - **证明不了什么：** 节点读不到、节点不再允许该 actor，或者目录里是另一次注册的 marker。这些情况都重新挂起。
- **不属于任何 Session。** 注册是租户级的，Session 范围的扫描读不到它。证据源自己列出挂起行，结算也带有自己的副作用。为此，对账器改为按存储中的种类名工作，证据源可以覆盖 `settle` 和 `parked`。
- **本次改动之前挂起的记录**同样这样对账，没有预留的会立即失败，不做探测。

如果释放之后，一个残留的 `register-storage` 才写下 marker，这个 marker 会留在一个没有所有者的目录上。之后任何对该目录的注册都会看到一个外来 marker 而被拒绝。所以失败方向是安全的：一个目录永远不会有两个注册所有者。

### 8. 第三阶段：Session 标题按 Session journal 对账

标题投递（kind 为 `RENAME`，见[改名投递](2026-10-08-managed-session-rename-delivery.zh-CN.md)）先认领自己的行，标记为 `SUBMITTED`，再带着 revision 发送标题。在 `SUBMITTED` 之前失败，说明标题从未发出，这一行照旧重试。在它之后失败，或者认领在 `SUBMITTED` 期间过期，准入就是未知的。自 #14069 起，这样的行挂成 `UNKNOWN`：不再发送，它的 key 返回 `409 operation_outcome_unknown`，而且没有任何东西会去结算它。

- **只有一种挂起状态。** 现在它挂成 `RECOVERY_BLOCKED`（`java_durable`、`blocked`、`session_title_unconfirmed`），立即到期，`RENAME` 也加入了 `ACCEPTANCE_UNKNOWN_KINDS`。每秒执行的投递扫描会用同样的方式转换遗留的 `UNKNOWN` 行。这个转换在运行时完成，而不是做成迁移：`ManagedSchema` 根据 DDL 推断 catalog 的版本，只改数据的版本永远无法被识别，没有经过 Flyway 初始化的 catalog 会直接跳过它。行处于挂起状态时，它的 key 仍返回 `409 operation_outcome_unknown`。
- **认领保留。** 这一行保留认领者和认领代际，所以租约过期后才到达的那次投递的应答仍能把它记为完成，和 `UNKNOWN` 时一样。
- **回执退役。** 挂起时，标题命令的回执从 `PENDING` 改为 `FAILED`，与已放弃投递的回执一致。过去因认领过期而挂起的行，回执一直保持 `PENDING`，这个回执会让该 Session 之后的每一次改名和生命周期变更都永久返回 `409 session_operation_active`。迟到的应答和对账器都能把已退役的回执记为完成。
- **journal 就是证据。** Hosted Harness 把带 revision 的标题提交到 Session journal，operation 为 `renameSession`，`commandId = hosted-title:<revision>`，`contentDigest` 为标题的 SHA-256。`renameAcceptance` 用与 Turn 输入相同的一条语句读取这一行和 head（`journalEvidence`，见决定 5）：digest 一致为**已提交**；head 处于 `DELETING` 或 `DELETED`、尚未压缩且没有这一行时为**未提交**（`session_title_undelivered`）；其他情况，包括 digest 不一致，都是**未知**。
- **标题自己结算。** `RenameEvidence` 用 `settleParkedRename` 覆盖 `settle`，在租户锁和 Session 锁下执行。已提交时，把回执和这一行记为完成（`harness_confirmed`），并通过一个 `session.updated` 事件展示标题，无论 Session 此后进入了什么状态；只有 `DELETING` 和 `DELETED` 例外，因为已经没有可展示的地方。未提交时，这一行记为失败，`available_at` 移到所有扫描之后；这个 key 之后可以用新的 revision 重试，和任何失败的标题 key 一样；之后的替换不会改写这个结果。未知时重新挂起，等待下一次复查。
- **屏障。** 挂起的标题不再算作待投递，所以关闭、归档、删除、cwd 和审批变更都可以继续，与挂起的 task cancel 或输入一样。改名投递的设计原本要求这些变更等投递完成，因为 Harness 已经接受的标题否则可能一直不出现在公开 Session 上。现在挂起的标题改由 journal 补到公开 Session；而关闭 journal 的那次删除，正是对账器证明"未提交"的前提。之后的改名仍会替换挂起的标题。Workspace 迁移仍然等待挂起的标题，但不再统计已被替换或已失败的标题：过去它统计所有不是 `COMPLETED` 的行，一个被替换的标题就会永久占住它的存储。

### 9. Turn 层恢复读取 Broker 的证据

停在 `await_runtime` 的 Turn，欠着已死 Harness 代际派发出去的那些 Runtime 执行。两个接管加载现在都向 Broker 询问原命令的证据，而不是读一个没人刷新的状态位；规则与决定 3 相同，只是作用在 Runtime 执行而不是 operation 行上。

- **取消加载**对每个挂起的执行带 `?reconcile=true` 读取。已结算的答案变成 `known` 并带上观测到的状态。Runtime 仍无法证明的答案保持 `unknown`；租约不可用会让 binding 被作废，记录在 LOST 排空拿到丢失证据、把它围成 `abandoned` 之前保持未知，报告则把围栏后的结果保留为 known/`abandoned`。之后仍走协调器现有的"按 abandoned 取消"与未知路径，没有改动。
- **继续加载**在读到记录仍为 `UNKNOWN` 时只问一次：后续读取带 `?reconcile=true`。已结算的答案照旧按自己的 execution id 记入 journal；终态围栏报为 known/`abandoned`；仍无法证明的结果报 `unknown`。它不会为这个缺口去轮询 `waitForUnknown`，也绝不会再次派发该命令。
- **什么不算答案。** 传输或协议故障仍让加载可重试地失败。Broker 自己表示"无法证明"的答案——记录仍为 UNKNOWN、`runtime_execution_evidence_unavailable`、`runtime_reconciliation_required`、`runtime_execution_reconcile_failed`，以及确定的 not-found——一律变成 `unknown`，既不当成瞬时故障，也不产生第二次副作用。
- **挂起与复查。** 见下文决定 10：证据仍未知的 Turn 会被挂起，并按对账器周期重新驱动取消加载。决定 9 只让读取去问证据，使协调器看到真实结论。

### 10. 证据仍未知的 Turn 挂起并复查

未知门禁过去用 budget-exempt 标志调用 `transientFailure`，于是 Workspace 绑定的 Turn 在证据仍未知时，每个 backoff 都重试一次取消加载。现在它挂在 `hosted_runtime_recovery_blocked` 上：

- **挂起。** Turn 保持活动状态，输入继续 unsettled，永远不会写成 `FAILED`。挂起释放 dispatch lease，并把 `retry_after` 设为 `OperationReconciler.RECHECK`（5 分钟）。用户取消把 Turn 置为 `CANCELLING` 时会清空这个 `retry_after`，所以取消会立即被驱动，而不是排在复查窗口之后。
- **扫描。** `findDispatchable` 对非 `CANCELLING` 的 Turn 排除这个码；取消仍会扫到它，`CANCELLING` 车道保留现有的重试路径（退避有上限；尝试次数不受预算限制）；因未知结果而待处理的取消永远不会被写成 `FAILED`，取消路由仍可能把它结算为 `CANCELLED`。
- **复查。** 现有的一秒扫描同时读取到期的挂起 Turn。每次复查认领 Turn，先通过连接器丢弃缓存的 takeover 快照，再重新驱动取消加载——绝不驱动继续加载，因为 Turn 正是因为继续无法证明安全才挂起的。已就绪：现有取消路由把观测到的结果记入 journal，并把 Turn 标为 `managed_runtime_recovery_blocked`。终态围栏走现有的 cancel-over-abandoned 路径。仍未知：再次挂起。复查抛错时也重新挂起，不在同一行上空转。
- **快照。** `discardManagedRecovery` 丢弃缓存的 attachment 与 pending-recovery 标记，下一次加载会重新向 Broker 询问，而不是拿挂起时的报告作答。

## 验证

- `OperationReconcilerTest`：挂起的 cancel 只按任务记录结算（先未知，后已提交）；任务未收到停止就结束的 cancel 以 `task_already_settled` 失败；证据读不出来时挂起一整个复查周期；挂起的输入只按 store 返回的 journal 结论结算；已不在挂起状态的行不被处理；一种 kind 只能有一个证据源。所有用例都不发送、不认领，也不调用 Harness。
- `ManagedTaskCancelOperationTest.aParkedCancelHoldsNoLifecycleHostage`：到期的挂起 cancel 仍不能被认领；通用结算可以把它重新挂起、记为完成，并拒绝改写已有结果。
- `ManagedTurnCommandOperationTest`：提交未获应答的输入以 `submit_input_unconfirmed` 挂起。没有 journal、head 为 `ACTIVE`、head 为 `SEALED` 时，结论都是未知；journal 出现匹配的准入后变为已提交，结算为完成并带回执。head 为 `DELETING` 且没有准入时，证明未提交，失败码取 Turn 的错误码；digest 不一致不能证明任何事；压缩开始后也不能证明任何事。
- `WorkspaceMigrationStoreTest.refusesAStorageWithAParkedTaskCancelUntilItSettles`：挂起的 task cancel 会挡住存储迁移，结算之后放行。
- `TaskCancelCoordinatorTest` 保留了投递相关的用例；原来两个挂起用例移到了 `OperationReconcilerTest`。
- 第二阶段：`SshWorkspaceStoreTest` 覆盖未预留的注册直接失败、已预留的注册挂起一个延迟、`completeParked` 只补完一次、`releaseParked` 记为失败并把目录让给其他注册，以及释放不会动另一次注册已完成的所有权。`SshWorkspaceServiceTest` 覆盖各个结论：marker 已落地、没有 marker、路径换成了另一个目录、另一次注册的 marker、actor 已无权限、节点读不到，以及未预留的旧记录不经探测即失败。所有用例都只做探测。`OperationReconcilerTest.aKindOutsideAnySessionScansAndSettlesThroughItsSource` 覆盖证据源自己的扫描与结算。
- 第三阶段：`ManagedRenameReconciliationTest`（H2，以及 InnoDB 上的 `ManagedRenameReconciliationMySqlIT`）覆盖：提交时抛错的投递带着认领和已退役的回执挂起，不再被认领或投递，也不挡住关闭；因崩溃挂起的标题在扫描把它挂起之前挡住后续改名，之后被替换；遗留的 `UNKNOWN` 行被转换；没有 journal、head 为 `ACTIVE`、另一个标题的 digest 时结论为未知，之后变为已提交，回执、这一行和标题都记为完成并只产生一个事件，key 重放结果；已提交的标题在已关闭的 Session 上展示，在删除中的 Session 上不展示；head 为 `DELETING` 时证明未提交，压缩开始后证明不了任何事，失败的 key 用新 revision 重试且不会被标为已替换；未知结论重新挂起并多计一次尝试；认领自己的迟到应答能完成挂起的标题；未提交之前的失败仍然重试并保持生命周期屏障；请求里缺少标题的行永远不会被判为已提交，但完整的 journal 仍能让它失败；通过 store 的 `@Transactional` 代理注入语句故障，挂起与回执退役、已提交结算与标题、事件和回执都整体回滚。`OperationReconcilerTest.aParkedTitleSettlesThroughItsOwnSettle` 覆盖标题经由自己的结算、从不走通用结算。`ManagedSessionLifecycleTest` 现在会在标题挂起时关闭 Session，且不重发标题。`WorkspaceMigrationStoreTest` 统计挂起和遗留的标题，不再统计已完成、已替换或已失败的标题。
- Turn 层读取：`hosted-workspace-broker.test.ts` 固定了恢复读取上的 reconcile 查询、每个未知记录恰好一次 reconcile 尝试、一次性决策（已结算才返回，仍在执行或仍未知都不轮询），以及终态围栏。`hosted-runtime-recovery.test.ts` 覆盖被动加载逐执行对账、证据读不出来时报未知，以及继续加载把已结算结果记入 journal、或报未知/abandoned 且不写 journal。
- Turn 取消：`HarnessCoordinatorTest.workspaceRecoveryFailureUsesTheMatchingCancellationAuthority` 让待处理取消保留现有重试路径（退避有上限、预算豁免），且不会把 unknown-outcome 情况写成 `FAILED`；`managed_runtime_recovery_incomplete` 仍走终止路径。
- Turn 挂起：`HarnessCoordinatorTest` 覆盖用挂起替代 budget-exempt 重试、复查丢弃快照并重新询问、仍未知时再次挂起，以及取消就绪后的终止。

## 验收（来自 #14166）

- 准入未知的 operation 不会产生第二次副作用：认领拿不到它（决定 2），对账器也从不发送（决定 3）。
- 对账读取的是原命令身份：按 operation 的 task 读任务记录，按 Turn 的 prompt 读 journal 行并核对 payload digest，按标题的 revision 读 journal 行并核对标题（决定 3、5 和 8）。
- 对准入未知的种类，`recovery_blocked` 的下一步由一条规则决定；生命周期等待被命名为另一个概念（决定 1）。binding、Session head 和扩展 run 的词表，已在 #14166 上说明是不同的概念。
- Turn 层接管读取原命令的 Broker 记录（决定 9）：两个加载都会对账，已结算的答案被观测，仍无法证明的结果报为未知，而不是当作瞬时故障失败或再次派发。
- 结果仍未知的 Turn 会挂起，并按对账器周期复查，而不是继续 budget-exempt 重试或再次派发（决定 10）。
- `CANCELLING` Turn 上因未知 Runtime 结果而待处理的取消不会被写成 `FAILED`；取消车道重试，取消路由仍可能结算为 `CANCELLED`（决定 10）。`managed_runtime_recovery_incomplete` 仍走终止路径。
