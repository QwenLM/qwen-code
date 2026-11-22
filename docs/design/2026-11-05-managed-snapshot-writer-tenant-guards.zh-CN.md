# 不经租户 guard 的 native journal 快照

[English](2026-11-05-managed-snapshot-writer-tenant-guards.md) | [简体中文](2026-11-05-managed-snapshot-writer-tenant-guards.zh-CN.md)

状态：已实现。

## 问题

发布 native journal 快照（`ManagedNativeJournalSnapshots.publish`）的过程中，会三次锁快照写入方（`JournalWriterLifecycle.lockSnapshotWriter`），每次都通过六参数的 `lockPublicationWriter` 依次获取租户的 `runtime_placement` 行和 `output_publication` 行。因此，同一租户下每个 Session 的每次快照，都要排在所有 placement 持有者（binding 状态转换、provisioning、Runtime retention、工作树维护、生命周期）和所有 publication guard 持有者（回收器、writer 获取、生命周期、CSI）之后。普通 journal commit 和工具发布已经不获取这两行（[journal commit](2026-11-03-managed-journal-commit-tenant-guard.zh-CN.md)、[publication guard](2026-11-04-managed-publication-tenant-guards.zh-CN.md)、[placement](2026-11-04-managed-publication-placement.zh-CN.md)）。

## 现有的事务结构

`publish` 依次运行三个 READ COMMITTED 事务：

1. **Basis**：锁写入方并登记读租约，然后提交。
2. **Build**：upsert 快照的 manifest 行（`claim`），逐页读取 journal，每页存一个 page 资源和对应的 `NATIVE_SNAPSHOT` 引用。之后再锁一次写入方，检查 head 没有变化，复制 journal 引用，提交前再锁一次写入方。
3. **Close**：释放读租约。

Build 中读取 journal 的操作运行在独立的 `REQUIRES_NEW` 事务里，每次都会在 Session root 和 head 上登记读租约。因此 Build 不能在读页之前锁 root 和 head，否则它自己的内层读取会一直等它。所以 Build 第一次到达 root 时，只持有本快照新建的行。Build 期间发生的 journal commit 不会被阻塞：它会改变 head，Build 随后以 `managed_session_head_conflict` 失败（见 `ManagedNativeJournalSnapshotsMySqlIT`）。

## 为什么不需要租户 guard

- **不会引入新的死锁环。** Build 到达 root 时，只持有它自己创建的行：manifest、page 资源和 `NATIVE_SNAPSHOT` 引用。假设某个事务持有这个 root 或 head，再去等这些行。今天 Build 在等 placement，而每个 guard 持有者都在 root 之前获取 guard，所以这个事务今天已经与 Build 成环。不拿 guard 的事务，则在 root 上形成同一个环。去掉 guard 只改变 Build 在哪把锁上等待，不改变是否存在环。
- **回收器不会等待这些行。** 存活 Session 的回收器（`ManagedProjectionResourceCollector`）和已退役 Session 的回收器（`SessionResourceCollectionCollector`）都先用普通读取找候选，因此只能看到已提交的行；之后在 root 和 head 之后按主键锁定或更新这些行。Build 未提交的行永远不会成为候选。
- **写入方的检查都在行锁下完成。** 凭据、harness placement（Session root）、legacy 与 CSI 固定（root）、生命周期 phase 与 writer 代际（head）、退役（root）、恢复状态（head），都在 root/head 锁下或通过已提交读来检查。物理存储检查使用普通写入方的非加锁读取（[存储共享](2026-11-05-managed-publication-storage-sharing.zh-CN.md)）。
- **被复制的资源不会被回收。** Basis 的读租约保护它们不被回收，Build 在复制引用之前会调用 `checkReadView`。
- **CSI 不变。** 已被 CSI 固定的 Session 会在 `lockCsiContinuation` 中、root 之后获取两把 guard，与它的 journal commit 相同。

## 改动

`lockSnapshotWriter` 不再自己获取 placement，改为调用 `lockPublicationWriter(..., placement = false, publicationGuard = false)`。没有 schema、API、配置或事务边界的变化。

## 验证

- `ManagedNativeJournalSnapshotsTest.publishesWhileBothTenantGuardsAreHeld`，在 H2 上运行，也通过 `ManagedNativeJournalSnapshotsMySqlIT` 在 MySQL 上运行：另一连接同时持有 placement 和 publication guard 时，快照在上限内发布完成，并且可以重放。
- 现有的快照、快照退役、journal 锁契约、锁顺序和 store 拆分测试继续通过。

## 风险

如果某个事务持有 Session root 或 head，再去等快照自己的行，它仍会与 Build 死锁。这个环今天就存在，本改动既不增加也不消除它。目前没有找到这样的事务：回收器只选择已提交的候选，journal commit 写入的引用属于 `JOURNAL`，而不是 `NATIVE_SNAPSHOT`。
