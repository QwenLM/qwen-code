# 不经 publication guard 的 Runtime binding 控制

[English](2026-11-06-managed-binding-control-tenant-guards.md) | [简体中文](2026-11-06-managed-binding-control-tenant-guards.zh-CN.md)

状态：已实现。

## 问题

Runtime binding 控制（`compareAndSet`、`claimOperation`、`renewOperation`、`releaseOperation`）调用 `JdbcCsiFilesRetirementGuard.lockBindingControl`。对 session 类 binding，它依次获取：

1. 租户 `runtime_placement`；
2. 租户 `output_publication`；
3. Session root，然后是该 Session 的 slot 和 binding 行。

每个被 claim 的 binding 都会周期性续租，所以每次续租都要在这两个租户级行上排队。

## 为什么不需要这些 guard

- **publication guard 只为 CSI profile 的 original 服务。** `lockBindingControl` 用它判断租户的 retention root 是否已初始化。只有当 Session 被固定、且这个 binding 就是它的 profile original 时，这个结果才有意义。对其他 binding，`lockManagedSession` 要么返回 null，要么因为 binding id 与 original 不同而拒绝，与 guard 的结果无关。
- **没有 publication guard 持有者依赖它来挡住 binding 控制。** 它的持有者（生命周期、writer 获取、回收器、retention、CSI publication lane 和迁移）都不读 binding 的 operation 租约。它们读 binding 的地方，要么是事务开始前的提示读，要么在 `lockOriginal` 之下。
- **租约变更不需要 placement。** claim、renew 和 release 只改 binding 的 operation owner 和租约，不让 binding 离开当前状态，也不碰 slot。与派发一样，它们只需证明 Session 没有被 CSI 固定，而这由 Session root 决定（见 [2026-11-05-managed-dispatch-tenant-guards](2026-11-05-managed-dispatch-tenant-guards.zh-CN.md) 的 (a) 部分）。

## 设计

1. **只有 profile binding 获取 publication guard。** `lockBindingControl` 只在 binding 属于 CSI files profile 时获取 `output_publication`。
2. **租约变更使用执行控制。** claim、renew 和 release 调用 `lockExecutionControl`：
   - Session root 存在时，普通 session 类 binding 只锁这个 root，然后锁自己的 binding 行；
   - 没有 root，或 binding 属于 profile 时，仍走带 guard 的路径。
3. **`compareAndSet` 保留 placement。** 它在 binding 控制之后立即获取 placement，并且可能让 binding 离开当前状态。placement 必须在 root 之前，所以它仍走带 guard 的路径，只是不再获取 publication guard。

### 改动后的顺序

| 路径                               | 顺序                                                           |
| ---------------------------------- | -------------------------------------------------------------- |
| claim、renew、release（root 存在） | root → binding                                                 |
| claim、renew、release（其他）      | placement →（publication guard，仅 profile）→ root → 行        |
| `compareAndSet`                    | placement →（publication guard，仅 profile）→ root → 行 → slot |
| 派发                               | root → binding → Runtime Session → execution                   |

租约变更与派发和所有 placement 持有者一样，先锁 root 再锁 binding。root 不存在时保留 placement，原因同 (a) 部分中的间隙锁问题。

## 验证

- `ExecutionControlTenantGuardsTest`（H2）和 `ExecutionControlTenantGuardsMySqlIT`：
  - 有 root 时，另一连接同时持有 placement 和 publication guard，claim、renew 和 release 仍能完成；
  - 没有 root 时，只持有 publication guard 不影响它们完成；持有 placement 时它们会等待；
  - 持有 publication guard 时 `compareAndSet` 仍能完成；持有 placement 时它会等待。
- `ExecutionControlTenantGuardsMySqlIT.dispatchBesideBindingControlOfTheSameSessionDoesNotDeadlock`：在有和没有 root 两种情况下，派发与同一 binding 的 claim、renew、release 并发。
- 现有的 binding 仓库、CSI retirement 和 Runtime broker 测试。

## 风险

- 如果将来某个 publication guard 持有者读取 binding 的租约，并指望 binding 控制等待，就会出现竞态。目前没有这样的路径。
- CSI profile binding 仍获取两把 guard，行为不变。
