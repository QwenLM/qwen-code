# Workspace 执行占用不再使用租户锁

[English](2026-11-03-managed-workspace-membership-cas.md) | [简体中文](2026-11-03-managed-workspace-membership-cas.zh-CN.md)

## 状态与范围

状态：Implemented。针对性的 H2 用例和现有 MySQL 恢复、盘点用例已通过。
下面专门的 MySQL 并发用例补充这些证据，执行结果记录在 PR 验证报告中。
完整验收仍等待所需 CI 门禁通过。

本变更替换普通 Workspace 执行占用的串行化方式。现在 LOCAL 或 SSH_LOCAL
目录上的每一次工具调用准入、释放和文件 rewind 都要先拿租户级 placement
guard，再锁住物理目录行，然后用 `FOR UPDATE` 扫描该目录的成员行。变更之后，
同样的操作先在锁外做预检查，再对目录行做一次短的条件更新；目录的占用情况由
目录行上的汇总字段表达。目录行仍然是这个目录所有写入者都会碰到的唯一点；
租户 guard 不再参与这个领域。

成员模型本身不变，仍以
[并发 Managed Workspace 会话](2026-10-21-managed-workspace-concurrency.zh-CN.md)
为准：以 Runtime Session 为单位的成员身份、共享的普通执行、独占的 rewind，
以及要求零成员的物理步骤。本变更只改变这些规则的实现方式。要改的原因是当前
的实现把互不相关的工作耦合在了一起：租户 guard 正是
[租户 guard 的有界耦合](2026-10-11-managed-tenant-guard-wedge.zh-CN.md)
所指出的机制，而成员扫描在一个非唯一索引上加间隙锁，使得聚簇索引的形状一旦
变化，不同租户的插入就会挤在同一条物理记录上等锁。

## 问题与现状

`claim` 在每次工具调用前执行，入口是 `WorkspaceRuntimeTransport.acquire`。
对 LOCAL 和 SSH_LOCAL 存储，`WorkspaceExecutionStore.claim` 的事务按顺序做：

1. 通过 `WorkspaceStorageKindGuard.lockDomain` 拿租户 placement guard，语句
   不设超时，等待只受 `innodb_lock_wait_timeout` 限制。
2. 在 `storageKey` 里先对存储别名行 `FOR UPDATE`，再对物理
   `ma_storage_owner` 行 `FOR UPDATE`。
3. 对 Runtime binding 行和 Runtime Session 行 `FOR UPDATE`。
4. 对目录行做一次 `INSERT ... ON DUPLICATE KEY UPDATE`，而前一步已经证明这行
   存在；随后对同一行再做一次 `FOR UPDATE`。
5. 在持有上述全部锁的情况下做挂载校验，包括文件系统身份检查
   （`storageGuard.verifyLocked`）。
6. 成员扫描
   `SELECT ... FROM ma_runtime_session WHERE execution_storage_key = ? FOR UPDATE`。
   这个谓词使用非唯一索引 `idx_ma_runtime_execution_storage`，扫描会加间隙锁。
7. 在 Java 里判断（`holder_key` 与 `maintenance_id` 为空、没有其他成员处于
   独占），然后执行成员 `UPDATE`。

`release`、`beginRewind`、`endRewind`、`holdForMaintenance` 和 `releaseLost`
各自重复租户 guard 和目录锁，其中检查占用情况的两条还重复扫描。

这个形态有三个问题：

- 租户 guard 是每个租户一行。该租户每个目录的每次工具调用都要在这一行上排
  队，一个持有时间长的事务会拖住与它无关的轮次。租户 guard 设计已经禁止它
  覆盖的路径出现这种耦合；成员相关的路径当时被留下来继续持有这把锁。
- 成员扫描的间隙锁让结果依赖索引的物理布局。换成自增主键后，所有插入都落在
  索引末端的同一条记录上，不同租户的插入于是等同一把锁。这个失败已在真实
  MySQL 8.4 上针对自增主键的基线复现。
- 成败结论是在 Java 里根据事务早先读到的行算出来的。一条放在锁等待之前的普通
  读会把 REPEATABLE READ 的快照建立得太早，重试因此基于自己看不见的状态做
  出动作。租户 guard 变更里发现并修复过两处这样的缺陷；每次的修法都是挪动读
  语句的位置，而这种错误从代码里看不出来。

## 目标

- G1：一个目录上的执行准入、释放和 rewind 从不等待租户 placement guard，也
  不在 `idx_ma_runtime_execution_storage` 上通过成员扫描获取间隙锁或 next-key
  范围锁。更新成员身份仍会获取写入所需的索引记录锁。
- G2：两个目录，无论属于同一租户还是两个租户，都可以互不阻塞地准入执行、检查
  占用。
- G3：占用规则的结果保持不变：共享的普通成员、独占的 rewind、维护和上传的
  互斥、要求零成员的物理步骤、精确释放、只清理一个 binding 加 generation 的
  丢失 worker 清理，以及 retention 保留仍有成员的 binding。
- G4：每个决定成败的条件要么写在 `UPDATE ... WHERE` 的谓词里，要么读自本事务
  已经用点锁锁住的行的当前锁定读。快照读不决定任何结论。
- G5：一个事务持有的锁遵循一份明确的顺序，本领域内没有事务以别的顺序获取
  其中的两把。

## 非目标

- CSI 预留、CSI 退役，以及 resident 档位的准入。`claim` 和 `release` 的
  resident 分支保持现状，包括它的租户 guard。
- 其他领域持有的租户 guard：Runtime placement、publication、迁移 fence 的
  安装、lifecycle 准入，以及 retention 清扫。
- 替换共享基线的主键。本设计以当前基线为前提，即
  `ma_storage_owner.id` 是自增主键，`storage_key` 保留为唯一业务键。
- 对外路由、Harness 协议，以及 WebShell。

## 设计

### D1. 目录行上的占用汇总

给 `ma_storage_owner` 增加两列：

- `member_count BIGINT UNSIGNED NOT NULL DEFAULT 0`，等于 `execution_storage_key` 与该行
  `storage_key` 相同的 `ma_runtime_session` 行数。
- `exclusive_member_key CHAR(64)`，仅当有一个成员持有独占 rewind 时非空。取值
  是 binding id、runtime generation 和 runtime session id 的 SHA-256，与运维
  恢复已有的 holder key 使用同一种构造。

并增加两条 `CHECK` 约束：

- `member_count >= 0`。
- `exclusive_member_key` 为空，或者 `member_count >= 1`。

第三条约束没有加：它本来要禁止有成员时再出现 holder。`holder_key` 同时也是
release 和 `isHeld` 用来拒绝"成员还在、目录上却出现了 holder"的信号，恢复测试
会构造这种组合。生产写路径在设置 `holder_key` 或 `maintenance_id` 之前仍然要求
`member_count = 0`。

成员行保留。`execution_storage_key` 和 `is_execution_exclusive` 仍然是所有
"问题针对一个 binding 或一个 Session 而不是针对目录"的消费方的事实来源：
retention、丢失 worker 清理、运维恢复、停止后的 Session 释放、worktree 清理，
以及 CSI 盘点。汇总字段只回答目录级的问题，并且只有 D4 列出的写路径可以修改
它。

### D2. 每次调用的成员操作不再拿租户 guard

`claim`、`release`（含 mount handback）、`beginRewind` 和 `endRewind` 在
LOCAL 与 SSH_LOCAL 路径上不再调用 `WorkspaceStorageKindGuard.lockDomain`。

不是每次调用都发生的操作，在其他领域要求时可以继续持有 guard：物理注册、
fence、restore、迁移、维护、丢失 worker 清理、运维恢复，以及 retention。
它们在成员问题上的正确性不得依赖这把锁。这些操作本来就会锁目录行，而汇总字段
使目录行本身就足够回答占用问题。

### D3. 准入变成预检查加一次短的条件更新

`claim` 分成两段。

在任何事务之外，它读取 binding、session、别名和目录行，并执行现在已有的挂载
校验。这段读只用于快速失败和取得 `mount_revision`，不决定成败。

随后它开启一个只有三条语句的事务并立即提交：

```sql
UPDATE ma_storage_owner
   SET member_count = member_count + 1
 WHERE storage_key = ?
   AND mount_state = 'READY'
   AND mount_revision = ?
   AND holder_key IS NULL
   AND maintenance_id IS NULL
   AND exclusive_member_key IS NULL;

SELECT binding_state, runtime_generation, is_drain_requested
  FROM ma_runtime_binding
 WHERE binding_id = ?
   FOR SHARE;

UPDATE ma_runtime_session
   SET execution_storage_key = ?
 WHERE binding_id = ?
   AND runtime_generation = ?
   AND runtime_session_id = ?
   AND harness_session_id = ?
   AND session_state IN ('ACQUIRING', 'READY')
   AND execution_storage_key IS NULL;
```

`mount_revision` 取预检查读到的值。第一条语句影响行数为 0 时返回
`workspace_busy`；第三条为 0 时返回 `unavailable`。binding 行如果已经不再是
同一 generation 下的 `READY`，或者 `is_drain_requested` 已置位，事务回滚并返回
`unavailable`。

这条 `FOR SHARE` 读锁住单个 binding 行，更新语句同时锁住目录和 session 记录。
它的作用是：一个先于本事务提交的、把 binding 转为 `DRAINING` 或
`LOST` 的变更，不能再被一个新成员跟在后面。它不是目录锁，也不是租户锁。H2
没有共享锁语法，所以 H2 测试对这一行使用 `FOR UPDATE`。MySQL 和 MariaDB 使用
`FOR SHARE`。

事务持有锁的时间只有这几条语句的执行时间。文件系统检查发生在事务开启之前。

### D4. 每条成员写入都在同一事务里维护汇总

| 路径                                              | 成员行                                              | 同一事务里的目录行                                                                |
| ------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------- |
| `WorkspaceExecutionStore.claim`                   | 为一个 session 设置 `execution_storage_key`         | 在 D3 的谓词下 `member_count + 1`                                                 |
| `WorkspaceExecutionStore.release`                 | 清除一个 session 的 key 和 `is_execution_exclusive` | `member_count - N`；当 `exclusive_member_key` 等于该成员且 `N > 0` 时一并清除     |
| `WorkspaceExecutionStore.releaseLost`             | 清除一个 binding 加 generation 的全部成员           | 对这些行所在的那一个物理 key 做 `member_count - N`                                |
| `JdbcRuntimeBindingRepository.clearStoppedMember` | 清除一个 session 的 key 和独占标志                  | `member_count - 1`；当 `exclusive_member_key` 等于该成员时一并清除                |
| `WorkspaceExecutionStore.beginRewind`             | 设置 `is_execution_exclusive`                       | 在 `member_count = 1`、挂载为 `READY` 且该列为 null 时设置 `exclusive_member_key` |
| `WorkspaceExecutionStore.endRewind`               | 清除 `is_execution_exclusive`                       | 在 `exclusive_member_key` 等于该成员时清除它                                      |
| `JdbcRuntimeRetention` 的 session 删除            | 删除 `RELEASED` 或 `FAILED` 的 session 行           | 不涉及；谓词增加 `execution_storage_key IS NULL`，因此成员行不会被删除            |

`N` 是同一事务里成员行语句的影响行数，目录行语句减去的正好是 `N`。目录行语句
影响行数为 0 时回滚事务。没有任何逻辑会就地修补不一致：计数与成员行不符是
缺陷，由 `CHECK` 约束拒绝这次写入，而不是事后修正。

retention 删除 session 行时不经过成员写路径，所以它的删除谓词必须排除仍然持有
成员身份的行。删掉一行成员却不减计数，会让汇总偏大。

### D5. 目录级问题改读汇总

这些路径现在通过扫描成员行来判断目录是空闲还是占用。它们改为从自己已经锁住的
目录行上读取 `member_count` 和 `exclusive_member_key`：

- `WorkspaceExecutionStore.holdForMaintenance`，在取得 `holder_key` 和
  `maintenance_id` 之前要求 `member_count = 0`。
- `WorkspaceFileUploadStore.admit`，在它短暂占用 `holder_key` 之前要求
  `member_count = 0`。
- `WorkspaceStorageGuard` 的注册、`fence`、`restoreOriginal`、`requireFenced`，
  以及 `inspect` 里表达占用的那一部分。

`hasExecutionMembers` 被删除。需要某个具体成员身份的路径不属于目录级问题，
继续读取成员行：`ManagedRuntimeRetentionGuard.bindingReferenced`、
`JdbcRuntimeBindingRepository.hasExecutionMembership`、
`WorkspaceOperatorRecoveryStore.holder`、`SessionWorktreeStore.cleanupBlocker`，
以及 CSI 盘点和 checkpoint 的读取。

### D6. 谓词必须承载的内容

本变更涉及的每条路径都遵循三条规则。

一个条件只有出现在 `UPDATE ... WHERE` 里，或者通过当前锁定读读取本事务已经
用点锁锁住的行，才可以决定结果。预检查的读只用于快速失败和绑定参数。
这消除了这样一类缺陷：
一条放在锁等待之前的普通读把事务的快照建立得太早。

具体而言，`WorkspaceStorageGuard` 在注册、fence、恢复和已 fenced 的权限检查中，
通过 `FOR UPDATE` 读取成员数。MySQL fence 竞争用例复现了普通读在获取目录锁后
仍然读取到旧的零计数：获取锁不会刷新之前已经建立的 REPEATABLE READ 快照。
诊断 inspection 保留非锁定读。

影响行数只对确实修改了存储值的语句做判断。MySQL 和 MariaDB 的 Connector/J
默认返回匹配行数而不是变更行数，H2 同样如此，所以一条把列写回原值的更新无法
与一条什么都没匹配到的更新区分开。

冗余语句删除。`claim` 去掉对目录行的 `INSERT ... ON DUPLICATE KEY UPDATE` 以及
紧随其后的第二次 `FOR UPDATE`，`holdForMaintenance` 去掉同样的一对。两者在
到达这些语句之前都已经要求这行存在。

### D7. 统一的加锁顺序

一个事务如果要锁住下面几类中的多个，必须按这个顺序获取。目录和 binding 锁
使用唯一键点查；被移除的占用扫描不得获取成员索引范围锁。Session 写入仍可能
锁住其他二级索引范围，这不在此处较窄的保证内：

1. 租户 placement guard，仅限 D2 仍然允许的位置。
2. `ma_storage` 里的别名行，按 `alias_key` 升序。
3. `ma_storage_owner` 里的目录行。
4. `ma_operation` 与 `ma_operation_work` 里的 operation 行和 work 行。
5. `ma_runtime_binding` 里的 binding 行。
6. `ma_runtime_session` 里的 session 行。

`claim` 取第 3 类再取第 5 类。与它共享锁、而当前顺序相反的事务有：

- `WorkspaceOperatorRecoveryStore.prepare` 先锁 binding 行，再在 `holder` 里锁
  目录行，并且最先锁租户 guard。一旦 `claim` 不再拿 guard，两者就形成现在由
  guard 拆开的锁环。`prepare` 改为先锁目录行，再锁 binding 行。
- `WorkspaceExecutionStore.releaseMaintenance` 经
  `WorkspaceMaintenanceRecovery.recordReturned` 先锁维护 work 行，再更新目录
  行；而 `holdForMaintenance` 先锁目录行，再经 `recordStart` 写 work 行。
  `releaseMaintenance` 改为先锁目录行，然后在该锁下重新检查已返回的 work。
- `JdbcRuntimeBindingRepository.admitExecution` 先锁 binding 行，再在
  `requirePhysicalStorageAdmission` 里锁目录行。执行准入改为先锁目录行，再锁
  binding 行。它只需要目录的 `mount_state`，因此目录锁是点锁，前面不必先锁
  别名行。`admitSession` 不锁目录行，它先 binding 后 session 的顺序已经符合。

本领域其余的多行事务已经符合这个顺序：`fence` 和 `restoreOriginal` 先锁
guard，再经 `LocalStorageOwners.lockCovered` 锁别名行，然后锁目录行；注册和
迁移来源的读取同样如此；`releaseLost` 先锁 guard 和目录行，再锁 binding 行。

## 为什么不采用另外的做法

曾经考虑连目录行一起去掉，只保留租户锁的移除。要保留的规则比较的是分别写入的
行：一个 Session 的成员行、另一个 Session 的成员行，以及目录的维护字段。如果
没有任何一行是每个写入者都会碰到的，竞争的双方读到的都是对方还没改过的状态，
两次写入就都成功了。唯一索引只能把独占者限制为一个，表达不了"存在共享占用时
不能独占"。引入外部锁，或者把一个目录的写入都路由到同一个进程，只是把这个
共同点移出数据库，还要额外做选主、fencing 和故障切换。条件更新保留了这个
共同点，并且只在语句执行期间持有它，而不是在整个检查期间持有它。

## 风险

- **汇总与成员行偏离。** 每条成员写入都在 D4 的表里，减计数使用它前一条写入的
  影响行数，retention 不能删除成员行，`CHECK` 约束拒绝自相矛盾的汇总。减计数
  在语句里也有保护：更新带 `WHERE member_count >= N`，所以一个盖不住刚清除的
  成员行的计数会什么都匹配不到，事务因此回滚，而不依赖引擎如何处理无符号下溢。
  新增测试在每个场景结束后断言两者相等。偏离仍然以失败关闭而不是就地修补，
  所以一条被遗漏的写路径会表现为回滚，而不是缓慢的偏差。
- **去掉 guard 会暴露它原来掩盖的锁环。** 已知的逆序就是 D7 里的三处，而顺序
  可以通过逐个列事务的加锁点来检查。新增的死锁测试驱动其中唯一一对同时共享
  目录行和 binding 行的事务。
- **预检查通过后、更新前目录发生了变化。** 条件更新带上 `mount_state` 和
  `mount_revision`，每一个必须使准入失效的状态转换都会写其中之一。下面的失效
  清单记录了每个转换写哪一列。一个两者都不写的转换会让准入基于过期的检查成功，
  所以任何新增的目录状态都必须更新这行。
- **基线本身也在被改造。** 列类型和索引名以合入时的基线为准。汇总字段和它们的
  约束在同一次变更里加到那份基线上；它们不是采纳自增主键的理由。

## 失效清单

每一个必须让正在进行的 `claim` 失败的状态转换，以及让条件更新失败的那次目录
写入。这些转换现在就都会更新 `ma_storage_owner`。

| 转换           | 写入者                                                             | 目录行的变化                                           |
| -------------- | ------------------------------------------------------------------ | ------------------------------------------------------ |
| Fence          | `WorkspaceStorageGuard.fence`                                      | `mount_state = 'FENCED'`                               |
| Restore        | `WorkspaceStorageGuard.restoreOriginal`                            | `mount_state = 'READY'`，`mount_revision` 递增         |
| 注册完成       | `WorkspaceStorageGuard` 的注册、`SshWorkspaceStore.publish`        | `mount_state = 'READY'`，`mount_revision` 被设置或递增 |
| 维护占用与释放 | `holdForMaintenance`、`releaseMaintenance`、`reconcileAfterReboot` | `holder_key` 与 `maintenance_id` 被设置或清除          |
| 上传占用       | `WorkspaceFileUploadStore.admit` 与 `finish`                       | `holder_key` 被设置或清除                              |
| 独占 rewind    | `beginRewind`、`endRewind`                                         | `exclusive_member_key` 被设置或清除                    |
| 别名被删除     | `SshWorkspaceStore.releaseParked`                                  | 删除 `SSH_LOCAL` 的 owner 行                           |

有两个转换不修改目录行，也不需要修改。迁移把 `fence_operation_id` 写在
`ma_storage` 里租户的 fence 行上，而 `claim` 和 `holdForMaintenance` 都已经在
条件更新之前调用 `WorkspaceMigrationAdmission.requireOpen`。`requireOpen` 在
事务内执行时会锁住这行 fence，所以一个先提交的 fence 可见，一个尚未提交的
fence 会阻塞在这行上。别名改指向在持有别名行时更新别名行的 `physical_key`；
准入通过在同一把目录锁之下读取别名行来解析物理 key，因此能看到已提交的目标。

## 加锁顺序清单

同时在租户 guard、别名行、目录行、operation 或 work 行、binding 行、session 行
中至少两类上加点锁的事务。"调整"给出 D7 要求的重排；其余事务已经符合顺序。

| 事务                                             | 当前顺序                                   | 调整                       |
| ------------------------------------------------ | ------------------------------------------ | -------------------------- |
| `claim`、`beginRewind`                           | guard、别名、目录、binding、session        | 去掉 guard                 |
| `release`                                        | guard、别名、目录、binding                 | 去掉 guard                 |
| `holdForMaintenance`                             | guard、别名、目录、operation，然后 work 行 | 无                         |
| `releaseMaintenance`                             | guard、work 行、目录                       | 目录行先于 work 行         |
| `releaseLost`                                    | guard、目录、binding、session              | 无                         |
| `clearStoppedMember`                             | guard、别名、目录、binding、session        | 无                         |
| `admitExecution`                                 | guard、binding、别名、目录                 | 目录行先于 binding         |
| `compareAndSet`、`recoverLost`                   | binding control、guard、slot、binding      | 无                         |
| `WorkspaceOperatorRecoveryStore.prepare`         | guard、binding、目录、session              | 目录行先于 binding         |
| `WorkspaceStorageGuard.fence`、`restoreOriginal` | guard、别名们、目录，然后成员扫描          | 成员扫描改为读汇总         |
| `WorkspaceFileUploadStore.admit`                 | guard、operation、目录，然后成员扫描       | 成员扫描改为读汇总         |
| `WorkspaceMigrationStore` 的 fence 安装          | guard、别名 fence 行                       | 无                         |
| `JdbcRuntimeRetention` 清扫                      | guard、slot、binding、execution、session   | 无；session 删除排除成员行 |

## 验证

### 必须保持通过的现有覆盖

- `WorkspaceRecoveryContract`，在 H2 上经 `WorkspaceRecoveryTest` 运行，在
  MySQL 上经
  `ManagedAgentMySqlIT#originalWorkspaceHoldersRecoverWithoutCurrentAuthority`
  运行：共享成员、rewind、维护互斥、丢失清理和运维准备。
- `WorkspaceRuntimeTest`：两个连接并发准入、精确释放、mount handback，以及
  竞争下的 rewind。`heldTenantGuardDoesNotBlockMembershipChanges` 在持有租户
  placement guard 的情况下完成 claim、rewind 和 release，并检查
  `member_count`。
- `JdbcPhysicalStorageReleaseTest`，在 MySQL 上经 `JdbcRuntimeBrokerMySqlIT`
  运行：按别名精确释放。`verifyCleanupOrdering` 断言清理等待目录行、并且等待
  期间 session 行仍可加锁；它按 D7 的顺序改写。
- `ManagedRuntimeRetentionGuardTest` 及其 MySQL 子类、retention 竞争测试、
  `WorkspaceStorageGuardTest`、`WorkspaceFileUploadStoreTest` 及其 MySQL
  子类，以及 `HostedWorkspaceConcurrencyIT`。

### Schema 契约

新增的列和约束写入共享的 V1 基线，按本模块的 schema 政策原地修改。
`ManagedSchemaProjection.STORAGE_OWNER` 加入这两列。比较整行
`ma_storage_owner` 的 CSI 盘点断言，即 `WorkspaceCsiApplicationInventoryTest`
及其 MySQL 子类，按新的行形状重新生成。`ManagedSchemaTest` 的漂移检查覆盖新
约束，不需要额外修改。

### 新增的 MySQL 覆盖

`WorkspaceExecutionMembershipMySqlIT` 针对可丢弃的 MySQL 8.4 运行。
并发用例在事务仍然打开、阻塞者尚未释放时，观察
`performance_schema.data_locks` 或锁等待图：

- 一个外部事务在整个运行期间持有该租户的 placement guard。该租户目录上的
  `claim`、重入 `claim`、rewind 开始和结束、释放和重复释放都能完成。
- 两个连接分别在两个不同目录上准入执行，覆盖同租户和不同租户。双方互不等待，
  都能到达提交前的暂停点。活动快照必须包含目录记录锁；
  `idx_ma_runtime_execution_storage` 上的锁只能是记录锁（`REC_NOT_GAP`），
  不允许成员扫描的范围锁。
- `WorkspaceOperatorRecoveryStore.prepare` 在已持有目录行锁的情况下，等待外部
  事务故意持有的 binding 行锁。重入 `claim` 随后排在它后面。释放阻塞者后，
  运维准备完成，claim 被拒绝，服务器死锁计数不增加。
- 尚未提交的成员身份阻塞 fence 和维护，两者在成员提交后拒绝执行。释放成员后，
  每个物理操作都能成功，作为正向对照。尚未提交的独占 rewind 同样先阻塞、
  再拒绝另一个成员；rewind 结束后，该成员准入成功。
- 每个场景结束后，`member_count` 等于携带该 `execution_storage_key` 的
  session 行数，`exclusive_member_key` 要么与唯一的独占成员一致，要么为 null。

H2 不产生 InnoDB 的间隙锁，也不做死锁检测，因此不能作为锁行为的证据。挑选出的
MySQL 用例在本模块的验证预算内本地运行；完整的 MySQL 矩阵仍由 CI 负责。

## 验收标准

1. 任何每次调用的成员路径都不再获取租户 placement guard，一把被持有的 guard
   不会拖延 `claim`、`release` 或 rewind。
2. 不同目录的准入和占用检查互不阻塞，占用检查不获取成员索引间隙锁或 next-key
   范围锁。成员写入可以持有索引记录锁。
3. G3 列出的占用结果在现有测试套件上保持不变。
4. 每个被测场景结束后，`member_count` 和 `exclusive_member_key` 与成员行一致；
   会破坏 `CHECK` 约束的写入被回滚。
5. 加锁顺序清单里的事务按 D7 的顺序获取锁，并发的 `claim` 与运维准备用例不
   报告死锁。

## 未决问题

无。
