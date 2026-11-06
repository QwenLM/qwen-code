# 不经租户 placement 的工具执行准入

[English](2026-11-05-managed-admission-placement.md) | [简体中文](2026-11-05-managed-admission-placement.zh-CN.md)

状态：方案。本文是 [2026-11-05-managed-dispatch-tenant-guards](2026-11-05-managed-dispatch-tenant-guards.zh-CN.md) 的 (b) 部分。

## 问题

(a) 之后，普通 session 类 binding 的派发不再获取租户 guard，准入也不再获取 publication guard。但 `JdbcRuntimeBindingRepository.admitExecution` 仍然无条件地先获取租户 `runtime_placement`。因此租户内每次工具调用仍要在 placement 行上排一次队，排在 binding 状态转换、provisioning、retention、维护、回收器和 writer 获取之后。

## placement 为准入排序了什么

准入用普通读读取几个 fence。placement 让每次读取都和该 fence 的写入方互斥：

| Fence                                 | 写入方及其锁                                                                                | 准入的做法                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------ |
| harness drain（`DRAINING`）           | `requestHarnessDrain`：只有 placement                                                       | 普通读 `ma_session_head` 行                |
| 生命周期开始（`LIFECYCLE_ONLY`）      | `beginLifecycle` → `beginHarnessLifecycle`：Session root（`requireLegacySessionForUpdate`） | 同上                                       |
| 生命周期 effects（`DRAINING`）        | `WorkspaceLifecycleStore.saveLocked`：placement、publication guard、Session root            | 同上                                       |
| storage fence（`fence_operation_id`） | `requestStorageFence`（placement）、工作区迁移（迁移 authority）                            | 普通读 `ma_storage`                        |
| 本地物理存储 owner                    | 存储注册、迁移和 CSI 路径                                                                   | binding 之后 `ma_storage_owner FOR UPDATE` |

准入涉及的其他行都是行锁：Session root（(a) 部分）、binding、Runtime Session 和新 execution。

- **生命周期 phase 已经持有 Session root。** (a) 之后，普通 binding 的准入在提交前一直持有这个 root，所以不需要 placement 也和它们互斥。
- **storage fence 有兜底。** 迁移的 `assertRetired` 要求该存储的所有 binding 都已 `RELEASED`，且没有未结束的 execution。binding 离开 `READY` 要拿它的行锁，而准入持有这把锁，所以与新 fence 并发准入的 execution 会让迁移以 `migration_work_unsettled` 停下，不会漏过。
- **缺口在 harness drain fence。** `requestHarnessDrain` 不获取准入会获取的任何行。`drainHarnessSession` 和 `verifyHarnessStopped` 之后确实会检查 execution，但 fence 的用意是在 drain 开始前挡住新工作。
- **本地物理存储 owner 尚未审计。** 准入在 binding 之后锁 `ma_storage_owner`，其他持有者对这两行的加锁顺序还没有确认。

## 方案

1. **drain 获取 Session root。** `requestHarnessDrain` 在 placement 之后、写 head 行之前锁 Session root（`ma_session ... FOR UPDATE`）。placement → root 是所有 placement 持有者已经在用的顺序。调用方（`ManagedRuntimeCoordinator.requestWorkspaceClose`，经由 `SessionLifecycleCoordinator`）在独立事务中调用它，外层没有数据库事务。没有 root 的 harness Session 保持现状。
2. **不经 placement 的准入。** 在事务开始前、紧挨现有的 `findById`，用独立连接做几次普通读，决定准入能否跳过 placement。要求同时满足：

   - binding 不属于 CSI files profile，也不是常驻工作区；
   - `isolationClass = session`，且不共享 Runtime Session；
   - 没有 lifecycle authority（这种检查已经对 head 行加共享锁）；
   - isolation key 对应的 Session root 存在；
   - binding 的存储没有本地物理 owner。

   否则准入照旧先获取 placement。

3. **root 之前不做一致性读。** 在 REPEATABLE READ 下，事务的第一次普通读会定下快照。现在第一次读发生在 placement 之后。快速路径上，第一条语句就是锁 root：`lockExecutionControl` 接收事务外预读得到的 root 存在性，不在事务内再读。之后所有普通读（包括 head 行）都能看到 root 锁授予之前的所有提交。

### 为什么这样就够

- **drain 先提交。** 它一直持有 root 到提交。准入的 root 锁在此之后才授予，它读 head 时看到 `DRAINING`，于是拒绝。
- **准入先提交。** drain 等待 root，直到准入提交。于是 execution 在 `DRAINING` 之前已经持久化，与今天在 fence 之前刚准入的 execution 完全一样。之后的 drain 步骤会处理它，`verifyHarnessStopped` 仍会锁 binding、检查 execution。
- **生命周期 phase** 由同一个 root 排序，见上文。

### 改动后的顺序

| 路径                   | 顺序                                                                       |
| ---------------------- | -------------------------------------------------------------------------- |
| 准入（快速路径）       | root → binding → Runtime Session → execution                               |
| 准入（其他）           | placement →（storage）→ root → binding →（storage owner）→ Runtime Session |
| 派发（非常驻工作区）   | root → binding → Runtime Session → execution                               |
| `requestHarnessDrain`  | placement → root → head                                                    |
| `verifyHarnessStopped` | placement → head → binding → Runtime Session（在生命周期的 root 之后）     |
| Runtime retention      | placement → slot → binding → execution → Runtime Session                   |

准入和 retention、派发一样，先锁 binding，再锁 Runtime Session 和 execution。它最先锁 root，而没有任何不持 guard 的路径会先锁 binding、再锁 root。

## 发现：storage alias 行

实现前的复查发现了上面审计漏掉的一把锁。对带 storage id 的 binding，准入（`requireStorageAdmission` → `requirePhysicalStorageAdmission` → `localStorageOwnerKey`）会在 binding 之后对 `ma_storage` 的 alias 行加 `FOR UPDATE`。只要存储有 alias 行就会加，不只限于 `LOCAL` 存储。绑定了工作区的 Session 总是带 storage id。

placement 持有者以两种相反的顺序锁这一行和 binding：

- **先 binding 后 alias：** `createSession` 和准入；
- **先 alias 后 binding：** `completeStoppedSessionRelease`（alias → storage owner → binding → Runtime Session）。

今天靠 placement 把它们隔开。不经 placement 的准入无论放在哪种顺序，都会和其中一条形成环，所以快速路径不能直接覆盖带存储的 binding。有两条路：

- **(b1) 只覆盖没有存储的 binding。** 快速路径额外要求没有 storage id，加锁顺序就与派发相同。改动小且安全，但覆盖不到绑定工作区的 Session。
- **(b2) 先统一存储相关的加锁顺序。** 所有 placement 持有者都先锁 binding，再锁 alias 和 storage owner 行。`completeStoppedSessionRelease` 把 binding 锁提前；其他锁 alias 的路径逐一审计：`LocalStorageOwners`、`WorkspaceFileUploadStore`、迁移、SSH、CSI。之后快速路径的顺序是 root → binding → alias → storage owner → Runtime Session。同一工作区的准入仍会在它的 alias 行上串行，与今天相同；收益在于同一租户内不同工作区之间可以并发。

## 验证计划

- `ExecutionControlTenantGuardsTest`（H2）及其 MySQL 子类：
  - 另一连接持有 placement 和 publication guard 时，快速路径的准入仍能完成；
  - 没有 root、有本地物理存储 owner、或 binding 共享 Runtime Session 时，准入仍会等待 placement。
- drain 排序，用语句钩子使其确定：
  - 准入在锁住 root 后暂停，`requestHarnessDrain` 等待，drain 随后能看到已提交的 execution；
  - drain 提交之后，准入以 `runtime_admission_closed` 拒绝。
- MySQL 压力测试：准入与同一 Session 的 `requestHarnessDrain`、binding 控制和派发并发，没有 InnoDB 死锁。
- 现有的 drain、生命周期、迁移、CSI、常驻工作区和锁契约测试。

## 风险

- **在锁 root 之前做普通读**，会在 REPEATABLE READ 下让原来的竞态重新出现。验证用的钩子固定了语句顺序，代码中也写明了原因。
- **预读之后才创建的 root** 会让这次准入走带 guard 的路径，只损失原有的延迟。
- **预读之后被删除的 root** 会被拒绝，与 (a) 相同。
- **drain 现在要等待 Session root**，排在该 Session 的 journal 提交和生命周期步骤之后。这些操作都很短，实际上本来就排在 drain 之前。
