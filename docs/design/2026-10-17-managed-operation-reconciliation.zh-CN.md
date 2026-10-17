# Managed operation 对账（Stage D7-2）

[English](2026-10-17-managed-operation-reconciliation.md) | [简体中文](2026-10-17-managed-operation-reconciliation.zh-CN.md)

状态：第一阶段已在 #14443 合入（契约 `1.59.0`）。第二阶段（SSH Workspace 注册）在本次改动中实现（契约 `1.60.0`）。两个阶段都不改 schema。

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
- `RENAME` 的 `UNKNOWN` 状态及其读取器（Harness 的标题 revision）。
- Turn 层的未知工具结果（`managed_runtime_recovery_blocked`）：需要把 Runtime Broker 的 `reconcileExecution` 接到 Turn 上，与 #13847 一起做。
- 处于 `CANCELLING` 的 Turn 被调度器以 `managed_runtime_recovery_blocked` 判为失败时，挂在它上面的 `CANCEL`。
- 为生命周期等待改名公开的 `recovery_blocked` token。这属于契约变更，放在本来就要暴露投递状态的 D7-3 更合适。
- 删除只读不写的残留状态（`ma_turn.status = 'RECOVERY_BLOCKED'`、Session 种类的 `UNKNOWN`），以及把手写的 `INSERT INTO ma_operation` 语句收成一处。

## 决定

### 1. 含义由种类决定

`ManagedAgentStore` 定义了两个集合：

- `ACCEPTANCE_UNKNOWN_KINDS` = `TASK_CANCEL`、`SUBMIT_INPUT`。对它们来说，`RECOVERY_BLOCKED` 表示命令的准入未知。
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

## 验证

- `OperationReconcilerTest`：挂起的 cancel 只按任务记录结算（先未知，后已提交）；任务未收到停止就结束的 cancel 以 `task_already_settled` 失败；证据读不出来时挂起一整个复查周期；挂起的输入只按 store 返回的 journal 结论结算；已不在挂起状态的行不被处理；一种 kind 只能有一个证据源。所有用例都不发送、不认领，也不调用 Harness。
- `ManagedTaskCancelOperationTest.aParkedCancelHoldsNoLifecycleHostage`：到期的挂起 cancel 仍不能被认领；通用结算可以把它重新挂起、记为完成，并拒绝改写已有结果。
- `ManagedTurnCommandOperationTest`：提交未获应答的输入以 `submit_input_unconfirmed` 挂起。没有 journal、head 为 `ACTIVE`、head 为 `SEALED` 时，结论都是未知；journal 出现匹配的准入后变为已提交，结算为完成并带回执。head 为 `DELETING` 且没有准入时，证明未提交，失败码取 Turn 的错误码；digest 不一致不能证明任何事；压缩开始后也不能证明任何事。
- `WorkspaceMigrationStoreTest.refusesAStorageWithAParkedTaskCancelUntilItSettles`：挂起的 task cancel 会挡住存储迁移，结算之后放行。
- `TaskCancelCoordinatorTest` 保留了投递相关的用例；原来两个挂起用例移到了 `OperationReconcilerTest`。
- 第二阶段：`SshWorkspaceStoreTest` 覆盖未预留的注册直接失败、已预留的注册挂起一个延迟、`completeParked` 只补完一次、`releaseParked` 记为失败并把目录让给其他注册，以及释放不会动另一次注册已完成的所有权。`SshWorkspaceServiceTest` 覆盖各个结论：marker 已落地、没有 marker、路径换成了另一个目录、另一次注册的 marker、actor 已无权限、节点读不到，以及未预留的旧记录不经探测即失败。所有用例都只做探测。`OperationReconcilerTest.aKindOutsideAnySessionScansAndSettlesThroughItsSource` 覆盖证据源自己的扫描与结算。

## 验收（来自 #14166）

- 准入未知的 operation 不会产生第二次副作用：认领拿不到它（决定 2），对账器也从不发送（决定 3）。
- 对账读取的是原命令身份：按 operation 的 task 读任务记录，按 Turn 的 prompt 读 journal 行，并核对 payload digest（决定 3 和 5）。
- 对准入未知的种类，`recovery_blocked` 的下一步由一条规则决定；生命周期等待被命名为另一个概念（决定 1）。binding、Session head 和扩展 run 的词表，已在 #14166 上说明是不同的概念。
