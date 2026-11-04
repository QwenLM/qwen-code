# 去掉 journal commit 的租户 guard

[English](2026-11-03-managed-journal-commit-tenant-guard.md) | [简体中文](2026-11-03-managed-journal-commit-tenant-guard.zh-CN.md)

## 问题与现状

`JournalCommit.commit` 是 Managed Session 写入最频繁的路径，Harness 的每一批 journal
记录都经过它。它的第一条数据库语句就是获取租户 placement guard
（`WorkspaceLifecycleStore.lockPlacement`，等待上限为 `GUARD_ACQUIRE_TIMEOUT_SECONDS`），
并一直持有到 commit 事务结束。持有期间覆盖记录解析、资源写入、扩展与 action 投影以及
head 更新。因此，一个租户内所有 Session 的 journal commit 只能逐个执行，还要排在
Runtime placement、存储工作、迁移、维护和 retention 之后。负载高时，超过上限就返回
`tenant_guard_contended`。

`requirePhysicalSessionOpen` 在锁定存储的别名行和目录行之前，会再获取一次 guard
（目前是重入）。

[Turn 准入](2026-11-03-managed-turn-admission-tenant-guard.zh-CN.md)与
[Session 命令](2026-11-03-managed-session-commands-tenant-guard.zh-CN.md)两份设计，
已经从没有租户级理由的路径上去掉了 guard。代码注释说明了 commit 仍持有它的原因：生命周期
准入只与这一行串行，没有它，准入会在 commit 进行到一半时插进来。

## guard 对 commit 起什么作用

| 作用                              | 依赖方                                                                                             | 现状                                                                                           |
| --------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| R1. 与生命周期排序                | 生命周期 begin（插入 v1/v2 claim）、生命周期 settle 与校验、Harness takeover 与 quiesce            | 它们依次获取 guard、Session 行（`ma_session`）、head 行。持有 guard 的 commit 不会与它们交错。 |
| R2. 让持有 guard 的读取方保持一致 | 迁移 prepare；Runtime retention 清扫（`JdbcRuntimeRetention.visit`，READ COMMITTED）；Session 退役 | 它们在持有 guard 时读取 commit 会写入的行。                                                    |
| R3. 串行化租户内所有 commit       | 没有路径有意依赖                                                                                   | 它掩盖了 commit 路径中的两类隐患：对不存在的键做锁定读后再插入，以及跨 Session 的锁。          |

## 设计

commit 改为在**自己的 Session 行**上排队，不再使用租户行。之前说的是"会话 head 行"，
实际应选 Session 行：所有 R1 参与方都先锁 `ma_session` 再锁 head，先锁 head 会与之
形成反向顺序。

1. **先锁 Session 行。** 删除 `commit` 开头的 guard（只针对普通 commit，即
   `authority == null`）。第一条语句改为 `ToolPublicationRetentionStore.lockSessionRoot`：
   按主键 `(tenant_id, session_id)` 插入或更新，再执行 `FOR UPDATE`。commit 本来就会在
   稍后经由 `lockCsiContinuation` 调用它。主键重复时只加记录锁，不加间隙锁。随后
   `requirePlacement` 再次锁定同一行，没有额外代价。凭证检查和 `validateCommit` 都不访问
   数据库，所以事务的第一次一致性读发生在 Session 锁之后。
2. **不经 guard 的 fence 检查。** commit 调用 `requirePhysicalSessionOpen` 的一个变体：
   跳过 guard，保留对别名行和目录行的锁定读。理由与 Turn 准入相同：迁移 prepare 先锁这些
   行，再基于已提交数据检查是否空闲（#16223）。`requirePhysicalSessionOpen` 的其他调用方
   不变。
3. **对可能不存在的键的锁定读，改为探测、插入、重复时重读。** 不同 Session 的 commit
   并发执行后，对不存在的键做 `FOR UPDATE` 会加间隙锁。两个 Session 的新键落在同一间隙时，
   插入会互相死锁。涉及的键都以 Session scope key 为前缀，但两个 Session 的键之间的间隙
   是共享的。每处改为：普通读；不存在则插入；出现 `DuplicateKeyException` 时做锁定重读，
   并执行原有的身份校验。这与 #16225 处理回执的方式相同。排查从 `commit` 可达的全部
   `FOR UPDATE` 后，找到两处：

   | 位置                                                     | 行                                          | 何时不存在           |
   | -------------------------------------------------------- | ------------------------------------------- | -------------------- |
   | `JournalResourceWrites.commitResources` → `findResource` | `ma_resource (scope_key, resource_id)`      | 每个新资源           |
   | `HostedCleanupReferences.apply`                          | `ma_resource_ref` 的 `HOSTED_CLEANUP` owner | cleanup 的第一个状态 |

   其余锁定读针对的行一定存在（Session 行、head 行、被引用的资源，缺失时 commit 会失败），
   或者是有意设置的串行点。`reconcileNeverStartedVerdict` 锁定子运行记录和父 Session 的子
   血缘，使"从未启动"的 verdict 与子 Session 创建串行。commit 从不向血缘索引插入数据。
   子运行记录通常已存在，只有在它与 verdict 由同一个 commit 首次写入时才不存在；这种少见
   情况下仍会加间隙锁，若因此死锁，会像其他死锁一样回滚。
4. **不变的路径。** 带生命周期授权的 commit（`authority != null`）仍在
   `checkLifecycleWriter` 中最先获取两个 guard。CSI 固定的 Session 仍在
   `lockCsiContinuation` 中、在锁定 root 之后获取两个 guard。这是 root → guard 的顺序，
   与 renew 和 recovery 已有的顺序相同。与先取 guard 的路径之间的死锁，由 `lockBounded`
   和 `namedRootDeadlock` 映射为 `tenant_guard_contended`。

## 为什么 guard 的读取方仍然正确

| 读取方                                                   | 为什么不需要 commit 持有 guard                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 生命周期 begin                                           | 它在写入 `CLOSE`/`ARCHIVE`/`DELETE` 操作（v2 claim）之前锁定 Session 行，而 commit 从第一条语句起就持有该行。begin 要么发生在 commit 的快照之前（commit 的 `requireNoLifecycleClaim` 能看到 claim），要么发生在 commit 结束之后（`requireIdleJournal` 锁定 head，快照落后时用锁定读重扫；#13800 R2-3）。                                                             |
| 生命周期 settle 与校验（`WorkspaceLifecycleStore.lock`） | 先 guard，再对 Session 行 `FOR UPDATE`。理由同上。                                                                                                                                                                                                                                                                                                                   |
| Harness takeover 与 quiesce                              | 它们锁定 Session 行（`HarnessPlacementStore.lock`），commit 的 `requirePlacement` 也锁定该行。                                                                                                                                                                                                                                                                       |
| 迁移 prepare                                             | 别名行和目录行，加上基于已提交数据的空闲检查（#16223）。commit 在写入任何数据之前锁定这些行。空闲检查的活跃 writer 计数读的是 writer 租约，commit 不修改它。                                                                                                                                                                                                         |
| Runtime retention 清扫                                   | 它只读取 commit 写入的行（hosted cleanup 引用、`cleanup_head_revision`、`child_run` 记录、`ma_output_capture`），只删除 commit 从不读取的行（`ma_runtime_binding`、`ma_runtime_session`、`ma_tool_execution`）。因此任何交错的结果，都等同于先执行清扫、再执行 commit，而 guard 本来就允许这个顺序。`hasCsiRuntimeMarker` 会读 binding，但清扫从不删除 CSI binding。 |
| Session 退役                                             | 它在读取或删除 journal 行之前，先对 head 行 `FOR UPDATE`，而 commit 持有该行。                                                                                                                                                                                                                                                                                       |
| writer 获取、续租与释放                                  | 它们锁定 head 行，commit 的 writer 检查在自己的锁下读取该行。                                                                                                                                                                                                                                                                                                        |

## 放弃的方案

- **先锁 head 行。** 生命周期 begin、settle 和 Harness placement 都先锁 `ma_session`
  再锁 `ma_session_head`。先锁 head、后锁 Session 行（`requirePlacement`）的 commit
  会与它们死锁。
- **只对部分记录类型保留 guard。** hosted cleanup 与资源写入很常见，会有太多 commit
  保留 guard。上面"只读、只删"的论证已经让这个条件变得不必要。

## 风险

- 同一 Session 的 commit 仍在其 Session 行上逐个执行；此前它们本来就经由 head 行串行。
  同一 Session 的 Session 命令（改名、修改模型）与 commit 现在只彼此等待，不再等整个租户。
- CSI 固定 Session 的 commit 现在先锁 root、后取 guard，而不是先取 guard。与先取 guard
  的路径之间、同一 Session 内的死锁可能更频繁。它们与现在一样被命名并重试。
- commit 路径的审计是静态的。漏掉的"对不存在键的锁定读"会表现为同一租户两个 Session
  之间的 InnoDB 死锁（1213）。被选中的事务会回滚，同一命令重试时按命令键保持幂等。
  下面的 MySQL 测试专门覆盖这种情况。
- 已有问题，本次不改：清扫可能先退役某个 binding，之后 commit 才写入指向它的 hosted
  cleanup 引用，而 guard 本来就允许这个顺序。后续工作：插入引用时对 binding 行加
  `FOR SHARE` 锁，binding 已不存在时拒绝。

## 验证与验收

1. 另一事务持有租户 placement guard 时，普通 commit 仍能完成。
   `ManagedSessionGuardConvoyIT` 断言 commit 不受 guard 约束。
2. 在 Session 行上排序。排在未提交赢家之后的重复 commit，在 Session 行（而不是租户
   guard）上等待，赢家提交后重放赢家的结果。这说明加锁之后的普通查询读到的快照晚于该锁
   （`duplicateCommitReplaysOnceTheWinnerReleasesItsGuards`）。在被阻塞的 record commit
   之后发起的删除准入，在该 commit 的 Session 行上等待，并在它之后完成
   （`ManagedAgentMySqlIT.serializesDeletionBehindTheRecordCommit`）。
3. 仅 MySQL：四个 writer 在同一租户内打开 Session，并发提交 monitor chain fixture。
   每个 revision 都发布一个新资源，全部完成且不出现死锁
   （`concurrentCommitsOfOneTenantDoNotDeadlock`）。H2 不加间隙锁，所以这一项需要
   MySQL profile。hosted cleanup 引用只由现有的 hosted cleanup 测试覆盖。
4. 现有的 journal、生命周期、Harness placement、迁移、retention、CSI 与 hosted
   recovery 测试继续通过，包括 CI 中的 MySQL profile。

## 交付

一个叠加在 #16223 之上的 PR。提交 1 改造这两处不存在键的位置（第 3 步），在保留 guard
时也是安全的。提交 2 去掉 guard，并加入不经 guard 的 fence 检查变体（第 1、2 步），附带
测试 1 到 3。
