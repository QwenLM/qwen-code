# 不经 placement guard 的发布车道

[English](2026-11-04-managed-publication-placement.md) | [简体中文](2026-11-04-managed-publication-placement.zh-CN.md)

状态：提案（[不经租户级 guard 的发布车道](2026-11-04-managed-publication-tenant-guards.zh-CN.md)中的 C3）。
本文取代该文档里的 C3 草案；草案中"binding 在 root 之前"的顺序不成立（见"为什么不能把 binding 锁放在一个固定位置"）。

## 问题

C1/C2 之后，普通工具发布的每一步（reserve、renew、派发、上传、校验、finish、准入、回执）仍然先获取租户的 `runtime_placement` 行（`ma_tenant_guard`），位置在 `ToolPublicationStore.lockPublicationPlacement`、`lockOriginal` 的 native 分支，以及 `JournalWriterLifecycle.lockPublicationWriter`。因此一个租户的所有发布只能逐个执行，并且排在每个 placement 持有者之后：binding 状态转换、provisioning、Runtime retention、迁移、存储 fence 和生命周期操作。journal commit、Turn 准入、Session 命令和普通派发授权都已经不再获取它。

## placement 在这些车道上保护的内容

| 车道读取的内容                                              | 另一侧的写入方                                                                                                             | 去掉 placement 后由谁保证                                                                                                                                           |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原始 binding 处于 `READY` 且未请求 drain（`requireAccess`） | binding 状态转换（`compareAndSet`、`claimOperation`、`renewOperation`、`releaseOperation`）                                | `session` 类：它们在 `lockBindingControl` 中锁 Session root。`workspace` 类：binding 行。                                                                           |
| 同上                                                        | 运维恢复（`WorkspaceOperatorRecoveryStore`）在 placement 和 binding 行下把 `READY` 的本地 binding 改为 `OPERATOR_RECOVERY` | 目前没有；C3 让它经过 `lockBindingControl`（见下文）。                                                                                                              |
| 同上                                                        | `recoverLost`、`releaseLost`、Runtime retention                                                                            | 只从 `LOST` 或已过保留期的终态 binding 开始，车道本身会拒绝这些 binding。                                                                                           |
| execution 行（`lockOriginal` 中的 `FOR UPDATE`）            | 派发、恢复、retention                                                                                                      | execution 行本身；除了在 binding 或 slot 锁之下、按先 binding 后 execution 的顺序之外，没有 execution 写入方获取 placement。                                        |
| 引用对 Runtime retention 可见                               | `JdbcRuntimeRetention.visit`（placement、slot、binding `FOR UPDATE`、READ COMMITTED 下读引用、删除）                       | reservation 需要 `READY` 的 binding；retention 需要在 binding 锁下看到超出保留窗口的终态 binding。后续车道作用于已存在的 `ma_output_capture` 行，已提交读能看到它。 |
| 生命周期 claim 与 phase（`requireOrdinaryAdmission`）       | 生命周期开始/完成                                                                                                          | head 行，与 journal commit（#16256）相同。                                                                                                                          |
| 存储 fence（`requireSessionStorageOpen`）                   | 迁移                                                                                                                       | 存储行，与 journal commit 和 Session 命令（#16329）相同。                                                                                                           |
| Harness 准入行                                              | Harness drain（`requestHarnessDrain`）                                                                                     | 只有常驻工作区会读取它们；常驻工作区保留 placement，与派发相同。                                                                                                    |

## 为什么不能把 binding 锁放在一个固定位置

有两类 placement 持有者以相反的顺序锁 binding 和 Session root：

- 先 binding 后 root：`session` 类 binding 的 `lockBindingControl` 依次获取 placement、publication guard、slot 和 binding `FOR UPDATE`（`readRuntimeRows`），然后是 root（`readPin`）。默认配置（`isolationClass = session`）下的每次 binding 状态转换都经过这里；
- 先 root 后 binding：生命周期校验（`WorkspaceLifecycleStore.lock` 之后的 `verifyHarnessResources`），以及 hosted cleanup journal commit（`HostedCleanupReferences.apply`，先 root 和 head）。

它们彼此不会相遇，因为两者都先获取 placement。一条不拿 placement 的车道，如果在 root 之前锁 binding，会与第二类死锁；如果在 root 之后锁，会与第一类死锁。

## 方案

普通原始记录指非 CSI、且不属于常驻工作区的原始记录。原始记录为普通的发布车道去掉 placement，按以下顺序执行：

1. **先锁 Session root**（`ToolPublicationRetentionStore.lockSessionRoot`），放在原来获取 placement 的位置。`lockPublicationWriter` 中后续对 root 的加锁变为重入。
2. **原始 binding**，按隔离级别区分：
   - `session` 类，且 `isolation_key` 等于发布所在的 Session：以 READ COMMITTED 读取 binding，不加锁。这类 binding 每次离开 `READY` 都持有这个 root，所以这次读取能看到所有已提交的转换，之后的转换会等待本事务结束。
   - `workspace` 类：在 root 之后对 binding 加 `FOR SHARE`。它的写入方不获取 root（`lockBindingControl` 直接返回）；先 root 后 binding 的持有者都会先锁 root。同一 binding 上不同 Session 的发布可以共享这把锁。
3. **execution `FOR UPDATE`**，然后按 C2 锁 head 和 publication 行。

以下情况保留 placement，并且仍像现在一样最先获取：CSI 原始记录；常驻工作区的原始记录；`isolation_key` 属于其他 Session 的 session 类 binding；带生命周期授权的回执（`checkLifecycleWriter` 会获取它）；journal commit 携带 hosted cleanup 的回执（`JournalCommit` 会获取它）。

运维恢复改为通过 `lockBindingControl` 锁 binding，采用 `compareAndSet` 的顺序（placement、guard、slot、binding、root）。这样，session 类 binding 每次离开 `READY` 都持有 root。

发布事务已经运行在 READ COMMITTED 下（C1）。它们在 root 之前的普通读取（`findPublicationRow`、binding 身份）只读取不可变的身份信息，与现在相同。

## 待定问题

1. 在已找到的所有流程中，session 类原始 binding 的 `isolation_key` 都等于发布所在的 Session。车道会检查这一点；不成立时保留 placement。
2. native 快照写入方（见 C2 的说明）也获取 placement，不在本文范围内。

## 风险

- 如果漏掉某个不持有 root 就让 binding 离开 `READY` 的写入方，车道可能会对一个刚刚停止的 binding 发布。上表就是写入方清单；MySQL 审计会在车道运行期间持有每个写入方的行锁来检查。
- 同一事务里先对共享 binding 加 `FOR SHARE`、再加 `FOR UPDATE`，会让两条车道死锁。车道从不写 binding；唯一可能写的回执情况（hosted cleanup）保留 placement。

## 验证与验收

- convoy 审计：另一连接持有 placement 时，每条普通车道都能在上限内完成；CSI、常驻工作区、生命周期授权和 cleanup 回执仍然快速失败。
- MySQL：在同一个 Session 上、以及在同一个共享 binding 上，让车道与 binding 状态转换（`compareAndSet` 到 `DRAINING`）、生命周期校验、运维恢复和 hosted cleanup commit 并发执行，结果都不死锁；状态转换之后的车道会拒绝该 binding。
- MySQL：Runtime retention 与并发 reservation 同时运行时，从不删除仍被引用的 execution 或 binding。
- 现有的发布、retention、生命周期、CSI 与锁契约测试继续通过，包括 CI 中的 MySQL profile。
