# 去掉发布车道上的租户级 guard

[English](2026-11-04-managed-publication-tenant-guards.md) | [简体中文](2026-11-04-managed-publication-tenant-guards.zh-CN.md)

状态：C1 已实现；C2、C3 为方案。

## 问题与现状

工具输出发布（reserve、上传、校验、finish、准入、回执、续期、隔离）的每次调用仍会获取两个
租户级的行：

- **Placement**（`runtime_placement`），最先获取，经由 `lockPublicationPlacement` /
  `lockStagedPlacement`、发布写入方（`lockPublicationWriter`）和 CSI continuation。
- **Publication**（`output_publication`），随后获取，经由 `ToolPublicationStore`、
  `ToolPublicationDataStore`、`ToolPublicationAdmissionStore` 和 `ManagedToolResultStore`
  中的 `ToolPublicationRetentionStore.lockTenant`。

因此一个租户内所有发布输出的 Session，其发布步骤只能逐个执行，还要排在 Runtime placement、
存储工作、迁移、retention 和回收之后。journal commit、Turn 准入和 Session 命令都已不再获取
这两个行。

## 每个 guard 保护什么

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
- 该车道先锁 Session root 和 head，再锁 publication 行，与回收的顺序一致；锁 root 之后不再
  获取 publication guard，因此不会与 retention（publication guard、root、head）形成环路。
- CSI 发布保留该 guard，这是其退役与 continuation 路径的预期。

考虑过但未采用：独立的 `publication_quota` guard，或计数行加条件更新。两者都会为了精确上限
继续按租户串行每一次预留，而保护性上限并不需要；计数行还需要在每次 held 字节缩小时更新。

### C2. 其他普通发布车道

把 C1 的做法用到普通的上传、校验、finish、准入和回执车道，以及工具结果投影 worker 和快照
写入方：跳过 publication guard，保持 root、head、publication 行的顺序，不调整任何车道的顺序。
工作量在于 C1 也需要的审计：锁 root 之后，车道中不能再获取 publication guard（C1 的证据读租约
就经由 `ToolPublicationRetentionStore.read` 获取过）。这类调用要么改用 Session 已锁定的变体，
要么该车道保留 guard。CSI 车道保留。

### C3. 用原始 Runtime binding 取代 placement

在普通（非 CSI）发布车道中，用对原始 binding 行（`ma_runtime_binding`）的共享锁取代
placement guard，获取位置与目前的 placement 相同。retention 清扫在检查引用之前以
`FOR UPDATE` 锁定该行，因此要么车道等待清扫，随后发现 binding 已不存在而拒绝；要么清扫等待
车道，随后看到它的引用。CSI 固定的 Session 保留 placement；CSI 退役与应用路径不在范围内。

这正是[锁范围设计](2026-11-04-managed-lock-scope.zh-CN.md)为 hosted cleanup 引用留下的
binding 握手；同一握手之后也可用于这些引用。

## 待定问题

1. C2 锁 root 之后的审计要覆盖回执车道在同一事务中的 journal commit 与资源安装；
   `ToolPublicationLockOrderMySqlIT` 就是发现 C1 那处问题的检查。
2. C3 需要确定 binding 在全局顺序中的位置：清扫在 placement 下先锁 slot 再锁 binding；
   车道会在 Session root 之后锁 binding。清扫锁定 binding 之后不再锁 Session 行，预计不会
   形成环路，但审计必须覆盖车道和清扫对 `ma_tool_execution` 的加锁。
3. `ManagedToolResultStore.claim` 和 `admitsLegacyProjection`（工具结果投影的 worker
   车道）是按 C2 处理，还是保留 guard。

## 风险

- 去掉租户串行会暴露原本被掩盖的缺失键间隙锁、顺序环路和过期快照；每一步的测试都需要独立
  的 MySQL 连接，不能只用 H2。
- 不同 Session 的并发预留可能让租户字节上限和活跃捕获数上限短暂被超出（C1）。

## 验证与验收

每一步：在基线上复现目标等待，再证明移除的 guard 被持有时车道仍能完成；在 MySQL 上并发
运行同一租户不同 Session 的发布，不出现死锁；在并发车道下运行回收、retention 清扫和配额
耗尽；通过发布、retention、回收与锁契约测试，包括 CI 中的 MySQL profile。
