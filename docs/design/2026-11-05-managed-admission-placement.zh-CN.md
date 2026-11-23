# 不经租户 placement 的工具执行准入

[English](2026-11-05-managed-admission-placement.md) | [简体中文](2026-11-05-managed-admission-placement.zh-CN.md)

状态：已实现。本文是 [2026-11-05-managed-dispatch-tenant-guards](2026-11-05-managed-dispatch-tenant-guards.zh-CN.md) 的 (b) 部分。

## 问题

(a) 之后，普通 session 类 binding 的派发不再获取租户 guard，准入也不再获取 publication guard。但 `JdbcRuntimeBindingRepository.admitExecution` 仍然无条件地先获取租户 `runtime_placement`。因此租户内每次工具调用仍要在 placement 行上排一次队，排在 binding 状态转换、provisioning、retention、维护、回收器和 writer 获取之后。

## placement 为准入排序了什么

准入用普通读读取几个 fence。placement 让每次读取都和该 fence 的写入方互斥：

| Fence                                 | 写入方及其锁                                                                                | 准入的做法                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------- |
| harness drain（`DRAINING`）           | `requestHarnessDrain`：只有 placement                                                       | 普通读 `ma_session_head` 行 |
| 生命周期开始（`LIFECYCLE_ONLY`）      | `beginLifecycle` → `beginHarnessLifecycle`：Session root（`requireLegacySessionForUpdate`） | 同上                        |
| 生命周期 effects（`DRAINING`）        | `WorkspaceLifecycleStore.saveLocked`：placement、publication guard、Session root            | 同上                        |
| storage fence（`fence_operation_id`） | `requestStorageFence`（placement）、工作区迁移（迁移 authority）                            | 普通读 `ma_storage`         |

- **生命周期 phase 已经持有 Session root。** (a) 之后，普通 binding 的准入在提交前一直持有这个 root，所以不需要 placement 也和它们互斥。
- **storage fence 有兜底。** 迁移的 `assertRetired` 要求该存储的所有 binding 都已 `RELEASED`，且没有未结束的 execution。binding 离开 `READY` 要拿它的行锁，而准入持有这把锁，所以与新 fence 并发准入的 execution 会让迁移以 `migration_work_unsettled` 停下，不会漏过。
- **缺口在 harness drain fence。** `requestHarnessDrain` 原来不获取准入会获取的任何行。

## 存储行

对带 storage id 的 binding，准入（`requireStorageAdmission` → `requirePhysicalStorageAdmission` → `localStorageOwnerKey`）在 binding 之后对 `ma_storage` 的 alias 行加 `FOR UPDATE`；`LOCAL` 存储还会锁 `ma_storage_owner` 行。绑定了工作区的 Session 总是带 storage id。

不经 placement 的准入（root → binding → alias → owner → Runtime Session → execution）要形成环，需要有某个事务：

- 持有 alias 或 owner 行，再等待 Session root、binding、Runtime Session 或 execution；或者
- 没有先锁 binding 就持有 Runtime Session 或 execution，再等待 alias 或 owner 行。

先锁同一条 binding 的事务会在 binding 上与准入串行，之后锁什么都无关。对 `LOCAL` alias 和 owner 加锁者的审计：

| 事务                                                  | 顺序                                                       | 结论                    |
| ----------------------------------------------------- | ---------------------------------------------------------- | ----------------------- |
| `createSession`、带 placement 的准入                  | binding → alias → owner → Runtime Session                  | 顺序相同                |
| `WorkspaceExecutionStore.admit`                       | binding（共享）→ Runtime Session → owner                   | 在 binding 上与准入串行 |
| `WorkspaceExecutionStore` 的释放路径                  | binding → Runtime Session → owner                          | 在 binding 上与准入串行 |
| `WorkspaceFileStore` 的 scope                         | root → alias                                               | 顺序相同                |
| `LocalStorageOwners.lockCovered`                      | 先锁 alias，再用独立连接不加锁地读 authority               | alias 之后不锁 binding  |
| worktree、子工作区 claim，维护恢复，上传，迁移，fence | 锁 alias 或 owner 之后不再锁 binding、Session 或 execution | 不成环                  |
| `completeStoppedSessionRelease`                       | alias → owner → binding → Runtime Session                  | **相反**                |

`LocalStorageOwners.lockCovered` 的注释已经写明了这个约定：准入在 alias 上等待，任何路径都不反转 binding 锁。`completeStoppedSessionRelease` 是唯一的例外，靠 placement 保证安全。它现在在 placement 之后、存储行之前先锁 binding。它持有 placement，所以这个顺序变化不影响与其他 placement 持有者的关系。

`SSH_LOCAL`、`CSI` 和 `EXTERNAL` 的加锁者没有审计，所以快速路径只覆盖没有存储，或 alias 不存在、或 alias 为 `LOCAL` 的 binding。alias 的 kind 不会原地改变。

## 设计

1. **drain 获取 Session root。** `requestHarnessDrain` 在 placement 之后、写 head 行之前锁 Session root（`ExecutionAdmissionPlacement.lockDrainRoot`）。placement → root 是所有 placement 持有者已经在用的顺序。调用方（`ManagedRuntimeCoordinator.requestWorkspaceClose`，经由 `SessionLifecycleCoordinator`）在独立事务中调用它，外层没有数据库事务。
2. **不经 placement 的准入。** 在事务开始前、紧挨现有的 `findById`，`ExecutionAdmissionPlacement.free` 用独立连接上的普通读做判断，要求同时满足：
   - binding 不属于 CSI files profile，也不是常驻工作区；
   - `isolationClass = session`，且不共享 Runtime Session；
   - 没有 lifecycle authority（这种检查已经对 head 行加共享锁）；
   - isolation key 对应的 Session root 存在；
   - 没有存储，或 alias 不存在，或 alias 为 `LOCAL`。

   否则准入照旧先获取 placement。

3. **root 是第一条语句。** 在 REPEATABLE READ 下，事务的第一次普通读会定下快照。`lockExecutionControl` 一开始就普通读 binding，所以快速路径上由 `ExecutionAdmissionPlacement.lockEntry` 最先锁 Session root。之后所有普通读（包括 head 行）都能看到 root 锁授予之前的所有提交。预读之后 root 被删除的，以 `runtime_admission_closed` 拒绝。

### 为什么这样就够

- **drain 先提交。** 它一直持有 root 到提交。准入的 root 锁在此之后才授予，它读 head 时看到 `DRAINING`，于是拒绝。
- **准入先提交。** drain 等待 root，直到准入提交。于是 execution 在 `DRAINING` 之前已经持久化，与改动前在 fence 之前刚准入的 execution 完全一样。之后的 drain 步骤会处理它，`verifyHarnessStopped` 仍会锁 binding、检查 execution。
- **生命周期 phase** 由同一个 root 排序。

### 改动后的顺序

| 路径                            | 顺序                                                                       |
| ------------------------------- | -------------------------------------------------------------------------- |
| 准入（快速路径）                | root → binding →（alias → owner）→ Runtime Session → execution             |
| 准入（其他）                    | placement → root → binding →（alias → owner）→ Runtime Session → execution |
| 派发（非常驻工作区）            | root → binding → Runtime Session → execution                               |
| `requestHarnessDrain`           | placement → root → head                                                    |
| `completeStoppedSessionRelease` | placement → binding → alias → owner → head → Runtime Session               |
| `verifyHarnessStopped`          | placement → head → binding → Runtime Session（在生命周期的 root 之后）     |
| Runtime retention               | placement → slot → binding → execution → Runtime Session                   |

## 验证

- `ExecutionControlTenantGuardsTest`（H2）和 `ExecutionControlTenantGuardsMySqlIT`：
  - 另一连接同时持有 placement 和 publication guard 时，准入仍能完成；
  - 没有 Session root 时，准入仍会等待 placement；
  - 另一事务持有 Session root（与准入相同）时，`requestHarnessDrain` 会等待；
  - drain 提交之后，在 placement 被持有的情况下，准入立即以 `runtime_admission_closed` 拒绝，说明它走的是快速路径。
- `ExecutionControlTenantGuardsMySqlIT.admissionBesideDrainAndBindingControlOfTheSameSessionDoesNotDeadlock`：40 次准入与同一 binding 的 binding 控制、该 Session 的 drain 并发。没有 InnoDB 死锁，并且第一次被拒绝之后的准入全部被拒绝。
- 现有的 drain、生命周期、迁移、CSI、常驻工作区、Runtime broker 和锁契约测试。

## 风险

- **在锁 root 之前做普通读**，会在 REPEATABLE READ 下让原来的竞态重新出现。`lockEntry` 是第一条语句，注释中写明了原因。
- **预读之后才创建的 root** 会让这次准入走带 guard 的路径，只损失原有的延迟。
- **drain 现在要等待 Session root**，排在该 Session 的 journal 提交和生命周期步骤之后。这些操作都很短。
- **未审计的存储类型**仍然获取 placement。要把快速路径扩展到这些类型，需要对它们的 alias 和 owner 加锁者做同样的审计。
