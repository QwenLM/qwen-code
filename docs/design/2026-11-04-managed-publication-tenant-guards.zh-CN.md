# 去掉发布车道上的租户级 guard

[English](2026-11-04-managed-publication-tenant-guards.md) | [简体中文](2026-11-04-managed-publication-tenant-guards.zh-CN.md)

状态：C1、C2 已实现；C3 的设计见
[不经 placement guard 的发布车道](2026-11-04-managed-publication-placement.zh-CN.md)。

## C1/C2 之前的问题与基线状态

在 C1/C2 之前，工具输出发布（reserve、上传、校验、finish、准入、回执、续期、隔离）的每次调用
都会获取两个租户级的行：

- **Placement**（`runtime_placement`），最先获取，经由 `lockPublicationPlacement` /
  `lockStagedPlacement`、发布写入方（`lockPublicationWriter`）和 CSI continuation。
- **Publication**（`output_publication`），随后获取，经由 `ToolPublicationStore`、
  `ToolPublicationDataStore`、`ToolPublicationAdmissionStore` 和 `ManagedToolResultStore`
  中的 `ToolPublicationRetentionStore.lockTenant`。

因此一个租户内所有发布输出的 Session，其发布步骤当时只能逐个执行，还要排在 Runtime placement、
存储工作、迁移、retention 和回收之后。journal commit、Turn 准入和 Session 命令此前已不再获取
这两个行。下文的 C1/C2 从普通车道移除了 publication guard，placement 仍保留；CSI original
和带生命周期授权的回执仍保留 publication guard。

## 基线中的 guard 职责

| guard       | 保护的内容                                                                                                                                                                             | 另一侧的持有者                                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Placement   | 发布的原始 Runtime binding 保持被引用：Runtime retention 清扫只有在 `executionReferenced` 和 `bindingReferenced` 找不到该 binding 的 `ma_output_capture` 或 execution 行之后才删除它。 | `JdbcRuntimeRetention.visit`（placement、slot、binding `FOR UPDATE`，在 READ COMMITTED 下读引用）。                          |
| Publication | 1. 租户字节配额：`reserve` 先 fence 已过期的预留，汇总租户已占用字节，再插入预留。2. 发布车道与回收之间的锁顺序。                                                                      | 其他 Session 的 `reserve`；`SessionResourceCollectionCollector` 与发布回收器（租户、私有 head、publication、公共 Session）。 |

只有 `reserve` 会增加租户总量。上传、校验、finish、准入和回执只在已有预留内移动字节
（`*_used_bytes` 不会超过 `*_held_bytes`），回收只释放字节。

回收与 retention 先获取 publication guard，再锁 Session root 和 head（`lockGenericSession`），
然后锁 publication 行与操作行。普通车道依次获取 placement、publication guard，再锁 root 和
head（`lockPublicationWriter`），然后锁 publication 行：guard 之下的顺序相同。只有 CSI 车道会
在 root 之前锁 publication 行（对普通 Runtime，`lockOriginalSettledResult` 会提前返回）。

## 方案

分三步，各自一个 PR，每步都附 MySQL 锁等待证据。

### C1. 租户配额不加锁

租户字节上限（`tool-publication.tenant-bytes`）和活跃捕获数上限是保护性上限，接受有界的
超额。普通 apply 车道（`ToolPublicationStore.applyLocked`：reserve、renew、fence、未开始
释放）及其发布写入方不再获取 `output_publication`。

- 该车道运行在 READ COMMITTED 下，每次汇总都能看到之前已提交的所有预留。不同 Session 的两次
  预留可能在各自汇总与提交之间重叠，一起越过租户上限。超额最多为重叠的预留数乘以每次分配
  （捕获大小加 4,784,128 字节）；超出的是 held 字节，finish 后会缩回 used，之后的预留在
  空间释放前都会被拒绝，因此不会累积。
- Session 字节上限仍然精确：同一 Session 的预留在其 root 上串行，发布写入方在汇总之前锁定
  该 root。
- 汇总前仍会在整个租户内 fence 已过期的预留。该更新使用热路径的语句超时与
  `tenant_guard_contended` 命名失败映射，因此回收器持有的过期行不会让 placement 持有者
  一直等到数据库默认锁超时。
- 该车道先锁 Session root 和 head，再锁 publication 行，与回收的顺序一致；锁 root 之后不再
  获取 publication guard，因此不会与 retention（publication guard、root、head）形成环路。
- CSI 发布保留该 guard，这是其退役与 continuation 路径的预期。

考虑过但未采用：独立的 `publication_quota` guard，或计数行加条件更新。两者都会为了精确上限
继续按租户串行每一次预留，而保护性上限并不需要；计数行还需要在每次 held 字节缩小时更新。

### C2. 其他普通发布车道与读租约

把 C1 的做法用到普通的生产端（派发、上传、校验、finish）、准入和回执车道，以及工具结果投影
worker：跳过 publication guard，保持 root、head、publication 行的顺序，不调整任何车道的顺序。
CSI original 保留 guard；journal commit 带生命周期授权的回执也保留，因为那个 commit 自己会
获取 guard。

投影 worker 的 `claim`、`admitsLegacyProjection` 和 `complete` 都遵循相同的无 guard 顺序。
准入操作加入完成操作的同一事务；完成操作复用已经持有的 root 和 head 锁，并在不获取
publication guard 的情况下重新检查私有 Session 的拒绝条件。

读租约（`ToolPublicationRetentionStore.read`）也不再获取 guard。所有可能删除租约所保护内容的
检查（发布、Session 资源与投影回收器）都持有该 Session 的 root 和 head，退役会更新 root；在同一
root 和 head 下获取的租约本身就能与它们互斥。租约续期也跳过 guard：锁定 root 后重新检查退役
世代与过期时间，再延长租约。这同时去掉了车道在 root 之后读取证据时的 guard（C1 发现的环路），
以及 Artifact 与 journal 资源读取中的 guard。

隔离损坏的发布对象同样只锁该 Session 的 root、head 与 publication 行。隔离不会改变租户级
容量，并保留 retained-publication 状态检查，因此无论独立执行，还是加入已经持有 root 的
读取事务，都能采用同一顺序。其他 retained-publication 变更仍保留 guard 优先的入口。

审计以测试形式完成：另一连接持有 guard 时，reserve、派发、finish、准入和回执都必须能完成
（`ManagedSessionGuardConvoyIT`）；任何在 root 之后获取 guard 的车道都会在这里卡住。另一个
观测用例在 guard 被持有时，把尚未过期的读租约回拨到续期窗口，要求它在持有 root 的事务中
成功延长过期时间。
隔离观测用例要求在同样持有 guard 的情况下，完成该 Session 内的状态变更。过期预留观测用例
持有另一个 Session 的过期 capture 行，检查有界的命名失败，再释放该行并检查新预留能成功
将其 fence。
`ToolPublicationLockOrderMySqlIT` 中的完整投影观测用例在另一连接持有 guard 时，要求普通
完成操作发布结果、Artifact 和事件；claim 后被固定为私有状态的 Session 仍必须拒绝完成，
既不改变已租赁的操作，也不发布这些输出。

容量核算放在独立的持久化辅助类中，准入入口加锁归入 grant store，使两个现有发布 store
都低于各自的类大小棘轮；抽取后同步降低上限。门面清单登记了有意新增的 guard 选择 writer
重载，事务属性保持不变。

未覆盖：native journal 快照写入方，其 build 事务在锁 Session 之前先锁资源行，顺序需要单独分析。

### C3. placement

见[不经 placement guard 的发布车道](2026-11-04-managed-publication-placement.zh-CN.md)。
此处最初提出的"binding 在 root 之前"的草案不成立：placement 持有者以两种顺序锁 binding 和 Session root。

## 待定问题

1. native journal 快照写入方仍获取 guard（见 C2）。

## 风险

- 去掉租户串行会暴露原本被掩盖的缺失键间隙锁、顺序环路和过期快照；每一步的测试都需要独立
  的 MySQL 连接，不能只用 H2。
- 不同 Session 的并发预留可能让租户字节上限和活跃捕获数上限短暂被超出（C1）。

## 验证与验收

每一步：在基线上复现目标等待，再证明移除的 guard 被持有时车道仍能完成；在 MySQL 上并发
运行同一租户不同 Session 的发布，不出现死锁；在并发车道下运行回收、retention 清扫和配额
耗尽；通过发布、retention、回收与锁契约测试，包括 CI 中的 MySQL profile。
