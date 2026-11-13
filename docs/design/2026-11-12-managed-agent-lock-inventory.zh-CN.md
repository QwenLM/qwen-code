# Managed Agent 锁清单：lifecycle claim 镜像与租户 guard

[English](2026-11-12-managed-agent-lock-inventory.md) | [简体中文](2026-11-12-managed-agent-lock-inventory.zh-CN.md)

## 状态与范围

- 状态：调查记录与提案。本文不改动任何代码；下面每一项后续工作都需要各自的改动、基线复现和 MySQL 证据。
- 日期：2026-11-12；2026-11-13 合并 `main` 后修订。源码基线：`main` 的 `6fb21a87f3`。
- 范围：`packages/managed-agent-server`，主要是 `persistence` 模块。本文回答对模块锁设计评审时留下的两个问题：
  1. `ma_session_head` 上的 lifecycle claim 副本（"claim 镜像"）是否仍有必要？
  2. 哪些 `ma_tenant_guard` 获取仍在保护租户级不变量，哪些只是在串行化行锁本已排好序的工作？
- 相关工作：锁简化系列（[锁简化](2026-11-02-managed-agent-lock-simplification.zh-CN.md)、[锁范围](2026-11-04-managed-lock-scope.zh-CN.md)、[剩余锁优化](2026-11-05-managed-remaining-lock-optimization.zh-CN.md)），以及从 [tenant guard wedge](2026-10-11-managed-tenant-guard-wedge.zh-CN.md) 到 [binding control 租户 guard](2026-11-06-managed-binding-control-tenant-guards.zh-CN.md) 的租户 guard 系列。同一次评审还产出了 #17069 中的 gap lock 修复，以及 #17072 中对 binding control 读取的精简，两者均已合并。[rename 单一权威改造](2026-11-12-managed-rename-single-authority.zh-CN.md)在 #17074 中去掉了 rename 的租户 guard。

## 问题

模块目前叠加了行锁、带代际号的租约，以及两种租户级 guard 行。之前的设计已经逐条路径地去掉了许多 guard 获取，但没有一份统一清单说明还剩哪些、各自为什么存在。评审中具体有两个疑问：

- lifecycle claim 状态存了两份，一份在 `ma_operation` 行上，一份在 Session head 上；每次 claim、续租和结算都要在同一个事务里两边一起写。
- 仍有约一百行 guard 调用（基线上为 106 行，含包装方法体），存在三种不同的等待上限策略，还有一个方法名（`WorkspaceMigrationAdmission.lockTenant`）掩盖了它实际锁的是哪一行 guard。

## 第一部分：lifecycle claim 镜像

### 现状

权威的 claim 存在 `ma_operation` 上（`claim_owner`、`claim_generation`、`claim_until`）。head 行 `ma_session_head` 带有 `phase`、`operation_id`，并在 `claim_generation` 和 `claim_lease_until` 中保存 claim 的副本。这份副本只为 lifecycle 协议 1 和 2 维护（`WorkspaceToolProfiles.lifecycleProtocol(int)`）。

| 写入方                                                                                      | 对 head 副本的影响                                      | 加锁顺序                                                      |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------- |
| `AgentLifecycleOperations.claimOperation`、`renewLifecycleOperation` → `syncLifecycleClaim` | 读取刚刚更新过的 operation 行，然后写入代际号和租约     | Session root（`lockOperationSession`）→ `ma_operation` → head |
| `blockLifecycleOperation`、`retryOperation`                                                 | 只清空租约；该 operation 仍对准入保持关闭               | Session root → `ma_operation` → head                          |
| `failOperation`                                                                             | 清空 `operation_id` 和租约；phase 保持 `LIFECYCLE_ONLY` | Session root → `ma_operation` → head                          |
| `JdbcWorkspaceLifecycleStore.saveEffects`                                                   | 设为 `DRAINING`；只有协议 2 保留租约                    | placement 与 publication guard → `ma_operation` → head        |
| `JdbcRuntimeBindingRepository.requestHarnessDrain`                                          | upsert 为 `DRAINING` 并清空租约                         | placement → drain root → head                                 |

| 读取方                                                                                                                                                                                                                                                                                     | claim 的来源                                                                                                                        | 锁                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 带 lifecycle authority 的 broker 准入：`RuntimeAdmissionFences.requireHarnessAdmission`，调用方包括 `completeStoppedSessionRelease`、`admitSession`、带 drain receipt 的 `compareAndSet`，以及 `requireHarnessAdmission` / `requireHarnessCleanup` / `requireHookAdmission` 这几个包装方法 | head 副本：phase、`operation_id`、`claim_generation`，以及与数据库时间比较的 `claim_lease_until`                                    | head `FOR SHARE`（H2 上为 `FOR UPDATE`），在调用方锁住自己的 binding 行之后；部分路径之前还锁了 storage 行或 placement |
| managed-agent 一侧的 lifecycle 写入方：`JdbcWorkspaceLifecycleStore.requireClaim`，被 `JournalFencing.checkLifecycleWriter` 和 lifecycle effects 使用                                                                                                                                      | 直接读 `ma_operation`，并与 `ma_session`、head 连接查询                                                                             | 一条覆盖 operation、Session 和 head 的 `FOR UPDATE` 语句                                                               |
| `JdbcRuntimeBindingRepository.requestHarnessDrain`                                                                                                                                                                                                                                         | upsert 的 `ON DUPLICATE KEY UPDATE` 在 `gmt_modified` 的 CASE 中读取 `phase` 和 `claim_lease_until`，同时设为 `DRAINING` 并清空租约 | placement → drain root → head；不锁 `ma_operation`                                                                     |

因此 broker 的准入检查是唯一为做出准入决定而校验这份副本的读取方。drain 的 upsert 也会在 `gmt_modified` 的 CASE 中读取 `claim_lease_until`；managed-agent 一侧已经直接对照 `ma_operation` 校验 claim。

### 分析

这份副本让 broker 在一行上做一次当前读，就能同时拿到 phase、operation 身份和 claim；而这一行它本来就要为了 phase 加锁。

替代方案是让 broker 先对 authority 对应的 `ma_operation` 行加共享锁（代际号、租约和 delivery state），再对 head 加共享锁（phase 和 `operation_id`）。是否安全取决于加锁顺序：

- 所有会锁 `ma_operation` 的写入方都先锁它、再锁 head。`requestHarnessDrain` 是唯一从不拿 operation 行的 head 写入方（placement → drain root → head），因此它构不成 operation↔head 的环。broker 必须采用同样的先 operation 后 head 顺序。先读 head、后读 operation，会和一个持有 operation 行、正在等 head 的 claim、续租或失败操作形成环。
- 按先 operation 后 head 的顺序：持有 operation 行的写入方会让 broker 在碰 head 之前就开始等待；持有 operation 共享锁的 broker 会让写入方在碰 head 之前就开始等待。双方都不会在等第一行时已经持有第二行。
- 先排他持有 head、再去锁 binding 行的事务，今天就已经与 broker 冲突，因为 broker 是在 binding 行之后对 head 加共享锁的。替代方案只是把 operation 行加在同一个位置，不会引入经过 binding 的新环。这个结论来自阅读源码，必须用 MySQL 竞态测试确认。

这份副本目前的代价：

- 协议 1 或 2 的 lifecycle operation 每次 claim 和续租都要在 `ma_operation` 上多一次 `SELECT`、在 head 上多一次 `UPDATE`；block、retry 和 failure 时也要更新 head。
- 分布在 managed-agent 与 Runtime Broker 两个 persistence 包中的七处写入点必须让两份数据保持一致。任何一处漏更新，都会让 broker 依据过期的租约放行或拒绝。
- 对于 managed Session，head 行同时也是 journal head，所以每次续租都会对 journal commit 也要加锁的那一行加排他锁。

单次调用的代价很小，因为续租是周期性的，head 更新也很短。

### 结论

从加锁顺序看，这份副本不是必需的，可以删除。暂时保留。只有出现具体的触发条件时才删除，比如测到续租在 head 上造成争用，或者发现某个缺陷是由副本不一致引起的；并且要同时满足[后续工作](#后续工作)中列出的前提。

## 第二部分：租户 guard 清单

### guard 行与入口

`ma_tenant_guard` 每个 `(tenant_key, guard_domain)` 一行，获取方式是先 `INSERT … ON DUPLICATE KEY UPDATE`，再 `SELECT … FOR UPDATE`。共有两个 domain：

- `runtime_placement`（placement）。原语是 `JdbcRuntimeBindingRepository.lockPlacementDomain`，包装方法有 `JdbcWorkspaceLifecycleStore.lockPlacement`、`JournalFencing.lockPlacementBounded`、`WorkspaceMigrationAdmission.lockTenant` 和 `WorkspaceStorageKindGuard.lockDomain`。`lockTenant` 这个名字里写的是 "tenant"，实际锁的却是 placement 行。运维存储注册也使用这个 domain，用一个哨兵键（`external-storage-registration/1`）作为有意设置的跨租户锁；`LocalStorageOwners` 则按主机哨兵键（`local-storage-host/<hostId>`）加锁。
- `output_publication`（publication）。原语是 `ToolPublicationRetentionStore.lockTenant`，`ToolPublicationStore` 和 `ToolPublicationAdmissionStore` 里各有带上限的本地包装方法。CSI retention root（`JdbcCsiFilesRetirementGuard.lockRetentionRoot` 和 `initializeRetentionRoot`）锁的也是同一行。

在基线上，下面的重新生成命令在生产代码中匹配到 121 行：15 行方法声明和 106 行调用。调用行中包含包装方法体和重载转发，因此下表按入口操作分组，而不是按原始行数。`WorkspaceStorageKindGuard.lockDomain` 一族（23 个调用点，分布在九个 storage 与 worktree store 中）并入 G4。

### 清单

| 分组                                               | 入口操作                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | guard                                               | guard 保护什么                                                                                                                                                                                             | 分类                                                               |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| G1 Runtime placement 与 binding 生命周期（broker） | `findOrCreate`、`admitSession`、`recoverLost`、`compareAndSet`、`requestHarnessDrain`、`requestStorageFence`、`verifyHarnessStopped`、`completeStoppedSessionRelease`、`createSessionTombstone`、`lockActiveForRetirement`、`JdbcRuntimeRetention.visit`、`ExecutionAdmissionPlacement.lockEntry`（没有 Session root 时）、`WorkspaceOperatorRecoveryStore.prepare`                                                                                                                                                                                                                                          | placement                                           | placement 会扫描该租户所有 binding 和 slot 上的恢复障碍。retention 在 placement 下以 READ COMMITTED 读取引用。准入和 drain 与 binding 状态迁移排序。                                                       | 保留：租户级不变量                                                 |
| G2 Resident Workspace 条件分支                     | `JdbcRuntimeBindingRepository.claimOperation` 和 `authorizeDispatch`（仅 resident profile）、`ResidentWorkspaceRetirementStore.authorize` 和 `lockedPlan`                                                                                                                                                                                                                                                                                                                                                                                                                                                    | placement；retirement 还会拿 publication            | Harness 准入行和 resident retirement，只有 Resident Workspace 会读                                                                                                                                         | 保留：已收窄到需要它的 profile                                     |
| G3 lifecycle 协议与 writer 所有权                  | `AgentLifecycleOperations.beginLifecycle` 和 `completeOperation`、`JdbcWorkspaceLifecycleStore.lock`、`JdbcHarnessPlacementStore.lockEligible`、`JournalLifecycleAuthorization.authorizeLifecycle`、`JournalFencing.checkLifecycleWriter`（仅在带 lifecycle authority 时）、`JournalWriterLifecycle.acquireWriter` 和 `releaseOwnership`                                                                                                                                                                                                                                                                     | 先 placement 后 publication                         | lifecycle 的 begin、settle、takeover 和 quiesce 先拿 guard，再拿 Session，再拿 head（journal commit 设计中的角色 R1）。writer 所有权变更与它们以及 retirement 保持排序。                                   | 保留：排序约定                                                     |
| G4 针对 fence 的准入，以及租户范围的创建           | `AgentLifecycleOperations.beginOperation`、`unarchiveWorkspaceSession`、`beginChildClose`；`AgentSessionAdmissions.insertWorkspaceSessionCommand`（可能解析为 Resident Workspace 的选择）、`insertInternalTeamLeadSessionCommand`、`insertChildSession`；`WorkspaceMigrationStore.lockAuthority`；`WorkspaceStorageKindGuard.lockDomain`（`WorkspaceStorageGuard`、`JdbcSessionWorktreeStore`、`JdbcWorkspaceExecutionStore`、`JdbcSshWorkspaceStore`、`JdbcChildWorkspaceStore`、`ExternalStorageRegistrationStore`、`WorkspaceMaintenanceRecovery`、`WorkspaceCsiReservationStore`、`LocalStorageOwners`） | placement（migration authority 还会拿 publication） | fence 安装与准入在任何 Session 锁之前共用这把锁。可能解析为 Resident Workspace 的选择保留租户 guard；默认选择保留租户扫描，以便与默认切换保持排序。storage-kind 迁移经由 `lockDomain` 拿同一行 placement。 | 大部分保留。下面列出一个候选项、一个审查缺口和一个已解决的候选项。 |
| G5 条件性的每轮 placement                          | `JournalCommit.commit`（仅针对带 hosted-cleanup 引用的记录）、`ToolPublicationPlacement.lockEntry` 和 `JournalWriterLifecycle.lockPublicationWriter`（仅当原始 binding 不是 placement-free 时；否则该 lane 改拿 Session root）                                                                                                                                                                                                                                                                                                                                                                               | placement                                           | hosted cleanup 引用对 Runtime retention 保持可见。拿了 placement 的 lane 在 root 之前保持 placement；拿了 root 的 lane 之后绝不再拿 placement。                                                            | 保留：已收窄                                                       |
| G6 publication 回收与保留的顺序                    | `SessionResourceCollectionCollector.claim` 和 `page`、`ManagedProjectionResourceCollector.collect`、`ToolPublicationRetentionStore.lockSessionHead`（被要求拿 guard 时）                                                                                                                                                                                                                                                                                                                                                                                                                                     | publication                                         | 回收先拿 guard，再拿 Session root 和 head，再拿 publication 和 operation 行                                                                                                                                | 保留：排序约定                                                     |
| G7 CSI 原始资源与带 lifecycle authority 的回执     | `ToolPublicationStore.require`（CSI 原始资源和 CSI 结算）与 `applyLocked`、`ToolPublicationAdmissionStore.require`（CSI 或 lifecycle authority）、`JournalWriterLifecycle.lockPublicationWriter`（CSI 的 publication guard）                                                                                                                                                                                                                                                                                                                                                                                 | publication                                         | CSI 的 retirement 和 continuation 要求在 root 之前拿 guard。普通 producer 已不再拿它（[publication 租户 guard](2026-11-04-managed-publication-tenant-guards.zh-CN.md)，C2）。                              | 保留：已收窄                                                       |
| G8 私有 CSI files profile                          | `JdbcCsiFilesRetirementGuard.requireProvisionPin`、`lockBindingControl` / `lockExecutionControl`（profile binding，或非 execution / 缺 root 的路径）、`lockManagedSession`；`WorkspaceCsiRuntimeAccess.resolve`、`admission`、`readNative`；`WorkspaceCsiSessionCommands.create`；`JournalFencing` 中的 CSI continuation lane                                                                                                                                                                                                                                                                                | 两种 guard 加 retention root                        | 被 pin 的原始 binding、它的 retention root，以及单 Session 准入                                                                                                                                            | 只要该 profile 存在就保留                                          |

租户字节配额是 publication guard 的另一个历史用途。它已不再需要 guard：publication 租户 guard 设计中的 C1 已经实现。

### 候选项与缺口

1. **rename 的 gap 隐患（已在 #17074 中解决）**。原先 `AgentSessionCommands.beginSessionRename` 拿 guard 的原因是"空的 operation 区间即使跨 Session 范围也可能共用一个 InnoDB gap"——这是在掩盖一个 gap lock 隐患（journal commit 设计中的角色 R3），而不是在保护租户不变量。[rename 单一权威改造](2026-11-12-managed-rename-single-authority.zh-CN.md)把它替换为 `settleRenameSync`，后者不再拿租户 guard：回放探测不加锁，复用同一 key 的竞争 Session 会在 receipt 的唯一键上失败。本条目保留作为该隐患及其解决方式的记录。
2. **`insertWorkspaceSessionCommand` 中的默认 Workspace 选择**。租户扫描让创建与默认切换保持排序。只有配合一个只锁单个租户级指针行的默认切换协议，才能收窄它。在默认切换因其他原因改动之前，先不动。
3. **审查缺口：`beginOperation`、`unarchiveWorkspaceSession` 和 `beginChildClose`**。它们通过 `WorkspaceMigrationAdmission.lockTenant` 拿 placement guard，但源码没有说明它们是依赖这把锁做 fence 准入，还是只用于 lifecycle 排序。在把它们归为保留或候选之前，应按 [Session 命令审查](2026-11-03-managed-session-commands-tenant-guard.zh-CN.md)的标准逐一判断。

### 等待上限与命名

对同样的行，同时存在三种等待策略：

- 不设上限：使用 InnoDB 的默认等待，例如 `lockPlacementDomain(connection, tenant)`。
- 具名的五秒上限 `JournalFencing.GUARD_ACQUIRE_TIMEOUT_SECONDS`，由 `lockBounded` 包装，超时以 `tenant_guard_contended` 失败。
- 字面值十秒上限，直接写在 CSI、retention、resident 和存储注册路径上。

选用哪种取决于各条路径的历史，而不是某条明确的规则。方法名 `WorkspaceMigrationAdmission.lockTenant` 进一步加剧了混淆，因为 publication 那边的包装方法锁的是另一行，却也叫 `lockTenant`。

## 设计决策与理由

- **只记录，不删除。** 剩下的获取点大多对应某个早先设计已经接受的约定。删除其中任何一个都是协议变更，需要各自的复现和竞态测试。本文只负责把全貌固定下来。
- **按入口操作分类，而不是按调用行。** 同一个 guard 会经由多个包装方法获取，一个操作也可能同时拿两种 guard。按行计数会把包装方法的方法体和真正的入口混在一起。
- **暂时保留 claim 镜像。** 它是冗余的，但删除它要改动两个 persistence 包中的七处写入点以及 broker 一侧的读取方，收益很小。删除它的主要理由是消除双写不变量，这值得单独作为一个改动。

## 约束

- 已准入的操作和恢复决策保持在 SQL 中持久化。过期的所有者绝不能提交持久状态，也不能释放更新的所有者的资源。
- 每类资源的加锁顺序固定：guard 在 Session root 之前，root 在 head 之前，binding control 遵循 binding control 设计中的定义。如果其他路径以相反顺序锁同样的资源，后续工作就不能在这条路径上于 root 之后再拿 guard。
- 在首个正式版本发布之前，schema 改动直接修改 V1 基线。

## 风险

- 分类依据的是对基线源码的阅读。没有测试覆盖的分支可能以注释没有写明的方式依赖某个 guard。每项后续工作在删除任何东西之前，都必须先用独立连接在 MySQL 上复现它所依据的假设。
- 代码一挪动，清单就会过时。下面给出的重新生成命令让它保持可核对。

## 后续工作

按从易到难排列，每一项都是独立的改动。

1. **命名与等待上限（不改变行为）。** 重命名 `WorkspaceMigrationAdmission.lockTenant`，让名字表明它拿的是 placement；把字面值十秒上限换成具名常量。不改动任何锁。
2. **rename 的 gap 隐患——已完成（#17074）。** `settleRenameSync` 结算 rename 时不再拿租户 guard，回放探测也不加锁；基于唯一键的插入仲裁已取代对缺失区间的加锁读。无需进一步工作；见候选项 #1 与 [rename 单一权威设计](2026-11-12-managed-rename-single-authority.zh-CN.md)。
3. **G4 审查缺口。** 按 Session 命令审查的标准，为 `beginOperation`、`unarchiveWorkspaceSession` 和 `beginChildClose` 分类。
4. **删除 claim 镜像（有条件）。** 仅在第一部分所述的触发条件出现之后进行。broker 准入先以 `FOR SHARE` 读 operation 行，再读 head；这修订了[锁范围](2026-11-04-managed-lock-scope.zh-CN.md)中"带 lifecycle authority 的 broker 准入必须读取并共享锁定当前 head claim"的要求。在 V1 基线中从 head 去掉 `claim_generation` 和 `claim_lease_until`，同时也要从 `ManagedSchemaProjection.SESSION_HEAD` 中去掉这两列——`JdbcCsiActivationAdmission.activeNativeHead` 经由该清单 select 它们，但并不消费。删除 `syncLifecycleClaim`，以及 block、retry、fail 和 `saveEffects` 中对 head 租约的更新。drain 的 upsert 要**重写** `gmt_modified` 的 CASE，而不是只删掉 `claim_lease_until = NULL`：CASE 中读取了 `claim_lease_until IS NOT NULL`，删列而不重写 CASE 会留下无法 prepare 的语句；整个删掉 CASE 则会丢掉"仅在新行、非 DRAINING 或仍有租约时才更新 `gmt_modified`"的规则。验收：claim 与 broker 准入、终态结算与准入、drain 与续租这几组 MySQL 竞态测试，外加现有的 lifecycle 和 broker 测试套件。
5. **私有 CSI files profile。** 如果该 profile 被下线，就连同它一起去掉 G8 以及 G7 中的 CSI 分支。

## 验证与验收

本次改动只涉及文档，需要对两个语言版本做 Markdown 格式和链接检查。

评审者可以在 `packages/managed-agent-server` 下重新生成原始调用列表：

```bash
grep -rn -E '(lockPlacementDomain|lockPlacement|lockPlacementBounded|lockTenant|lockRetentionRoot|initializeRetentionRoot|lockDomain)\(' \
  persistence/src/main/java control-plane/src/main/java runtime-broker/src/main/java
```

该命令在基线上匹配 121 行：15 行方法声明和 106 行调用（见第二部分）。声明行是首参数带类型的方法签名；把输出通过下面的过滤器即可单独列出它们：

```bash
grep -E '(lockPlacementDomain|lockPlacement|lockPlacementBounded|lockTenant|lockRetentionRoot|initializeRetentionRoot|lockDomain)\((Connection|JdbcTemplate|String|JsonNode) '
```

满足以下条件时本文即可接受：

- 两个语言版本都完整，且互相链接；
- 清单中的每个分组都能对应到所述基线上的调用点；
- 每项后续工作在开始实现之前，都写明了自己的验收证据。
