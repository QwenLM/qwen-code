# 不经租户 guard 的工具执行控制

[English](2026-11-05-managed-dispatch-tenant-guards.md) | [简体中文](2026-11-05-managed-dispatch-tenant-guards.zh-CN.md)

状态：(a) 和 (b) 均已实现。(b) 的设计见 [2026-11-05-managed-admission-placement](2026-11-05-managed-admission-placement.zh-CN.md)。

## 问题

每次工具调用都先准入一条 execution（`JdbcRuntimeBindingRepository.admitExecution`），再授权派发（`authorizeDispatch`）。两者都会调用 `JdbcCsiActivationAdmission.lockForExecution`，进而调用 `JdbcCsiFilesRetirementGuard.lockBindingControl`。

对 `session` 类 binding（默认配置 `isolationClass = session`），`lockBindingControl` 依次获取：

1. 租户 `runtime_placement`；
2. 租户 `output_publication`；
3. 该 Session 的所有 slot 和 binding 行；
4. Session root。

对普通（非 CSI）Session，`lockManagedSession` 最后返回 `null`：Session 没有被固定，也不存在 CSI files profile 的 slot 或 binding。整个过程只为证明"这个 binding 不是 CSI"，却让租户内每次工具调用都在两个租户级行上排队，排在 binding 状态转换、provisioning、retention、维护、回收器和 writer 获取之后。此外，`admitExecution` 在这一切之前还会无条件获取 placement。

## 现有的加锁顺序

placement 持有者以两种相反的顺序锁 binding 行和 Session root：

- **先 binding 后 root：** `lockManagedSession` 和 `requireProvisionPin` 先锁 slot 和 binding 行，再由 `readPin` 锁 root。
- **先 root 后 binding：** 生命周期校验（`verifyHarnessResources`）、hosted cleanup commit（`HostedCleanupReferences`）和运维恢复。

它们都先获取 placement，所以彼此不会相遇。要去掉 placement，就必须让剩下的所有持有者对 root 和 binding 采用同一种顺序。

## (a) 在 Session root 下完成执行控制

1. **统一为一种顺序：先 root，后 slot 和 binding 行。** `lockManagedSession` 和 `requireProvisionPin` 先调用 `readPin` 锁 Session root，再调用 `readRuntimeRows`。这样，所有 placement 持有者都先锁 Session root，再锁该 Session 的 slot 和 binding 行；它们在 root 之前获取的 guard 不变。
2. **不经 guard 的执行控制。** `lockExecutionControl` 供 `lockForExecution` 使用，也就是准入和派发。对 CSI files profile 之外的 binding，它只锁 Session root（`readPin`）。以下情况拒绝：Session 被固定到该 profile；pin 指定了 request key；仍存在 profile 的 slot 或 binding（`hasCsiRuntimeMarker`，普通读）。这些与 `lockManagedSession` 对此类 binding 的拒绝条件一致。profile binding 仍走完整的加锁路径。

   这条路径还要求 Session root 已经存在。对不存在的 root 做加锁读只会拿到间隙锁，而间隙锁彼此不互斥，所以派发与 binding 控制之间不会被排序。接下来两者查找 binding 时，会以相反的顺序锁 binding 的唯一索引和主键，从而死锁。MySQL 压力测试复现了这一点。root 不存在时（托管 Session 不应出现这种情况），执行控制保持带 guard 的路径。如果 root 在存在性检查与加锁之间被删除，则拒绝。

3. **为什么只锁 root 就够。**
   - pin 列在 Session root 上，修改 pin 必须等待这把锁。
   - profile 的 slot 或 binding 只能由 `requireProvisionPin` 创建，而它要求 pin 已经提交，所以在 root 显示未固定时不会新出现。
   - binding 本身的状态随后仍在 `authorizeDispatch` 和 `admitExecution` 中、在该行的行锁下检查，与原来相同。

改动后的顺序：

| 路径                                                   | 顺序                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| 派发（非常驻工作区）                                   | root → binding → runtime Session → execution                                   |
| 准入                                                   | placement →（共享 runtime Session 时的存储）→ root → binding → runtime Session |
| binding 控制（`compareAndSet`、claim、renew、release） | placement → publication guard → root → slot、binding                           |

没有任何路径在不持有 guard 的情况下先锁 slot/binding、再锁 Session root。只锁 slot 和 binding、不锁 root 的路径（普通请求的 `findOrCreate`、`recoverLost`、Runtime retention）从不等待 root。binding 控制和 `requireProvisionPin` 仍持有两把 guard，除顺序外行为不变。

## (b) 准入中的 placement

`admitExecution` 仍然先获取 placement。它让准入与 harness drain fence 互斥：`requestHarnessDrain` 在 placement 下插入 drain 行，准入（`requireHarnessAdmission`）则不加锁地读取这一行。要去掉 placement，需要一个行级握手。head 行同时承载 journal writer 的状态，所以 (b) 改为让 drain 获取准入本来就持有的 Session root，见 [2026-11-05-managed-admission-placement](2026-11-05-managed-admission-placement.zh-CN.md)。

## 验证

- `ExecutionControlTenantGuardsTest` 在 H2 上运行，也通过 `ExecutionControlTenantGuardsMySqlIT` 在 MySQL 上运行。针对 session 类 binding：
  - 另一连接同时持有 placement 和 publication guard 时，派发仍能完成；
  - 另一连接持有 publication guard 时，准入仍能完成。
- `ExecutionControlTenantGuardsMySqlIT.dispatchBesideBindingControlOfTheSameSessionDoesNotDeadlock`：在有和没有 Session root 两种情况下，派发与同一 session 类 binding 的 claim、renew、release 并发执行，都没有 InnoDB 死锁。加入 root 存在性检查之前，没有 root 的情况会死锁。
- `ExecutionControlTenantGuardsTest.withoutASessionRootDispatchKeepsTheGuardedPath`：没有 root 时，派发仍会等待被持有的 placement guard。
- 现有的 CSI、常驻工作区、Runtime broker、retention、binding 控制和锁契约测试继续通过，包括 CSI 的 MySQL 测试。

## 风险

- 如果还有路径在不持有 guard 的情况下，先锁 session 类 slot 或 binding、再锁该 Session 的 root，它会与派发死锁。上表就是清单。在调用 `lockManagedSession` 之前就锁行的 CSI 路径（`findOrCreate` 中的 `lockBinding`、`lockRuntimeSession`）都持有 placement，且只涉及 profile binding；对这类 Session 的普通派发会在读取 root 之后立即被拒绝。
- 残留的 profile slot 或 binding 用普通读检测，而不是加锁读。它们在并发情况下只会消失、不会新出现，所以漏看只会造成一次本不必要的拒绝，不会放行 CSI Session。
