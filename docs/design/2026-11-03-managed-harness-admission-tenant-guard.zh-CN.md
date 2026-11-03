# 去掉 Harness 准入检查的租户 guard

[English](2026-11-03-managed-harness-admission-tenant-guard.md) | [简体中文](2026-11-03-managed-harness-admission-tenant-guard.zh-CN.md)

## 问题与现状

`JdbcRuntimeBindingRepository` 提供一组独立的 Harness 检查：
`requireHarnessAdmission`（只带 scope 和带 binding 请求两个重载）、
`requireHarnessRecovery`、`requireHarnessCleanup`（两个重载）以及
`requireHookAdmission`（两个重载）。它们各自开启事务，获取租户 placement guard
（`lockPlacementDomain`，没有语句超时），再执行共用的 Harness fence 检查。

`RuntimeExecutionDispatcher.beginDispatch` 在每次未取消的工具派发前都会调用
`requireHarnessAdmission`。因此，一个租户内所有 Session 的每次工具调用都在该租户的
placement 行上排队，排在 Runtime placement、存储注册、fencing、迁移、维护、CSI 工作和
retention 之后。对于检查不覆盖的 scope，例如没有生命周期 authority 的非 Session
隔离，检查会立即返回，但 guard 已经先获取了。

共用检查只读不写。它对 resident scope 读取 `ma_session`，并读取 `ma_session_head`
中的 Harness 行：phase（`OPEN`、`DRAINING`、`LIFECYCLE_ONLY`）、operation、claim
generation 与 claim lease。Recovery 还会读取生命周期操作的协议版本。这七个方法都不写
任何行。在 placement、Session 准入和 tombstone 事务内部使用的、接收 connection 的版本
保持不变，继续沿用调用方已持有的 guard。

## 目标与范围

在不改变任何判定结果的前提下，为这七个独立的只读检查去掉租户 guard。不在范围内：
Harness drain（`requestHarnessDrain`）、生命周期 claim 写入、`authorizeDispatch`、
placement 与 Session 准入，以及其他 guard 持有者。

## 设计

每个方法保留事务，只去掉 `lockPlacementDomain`。读取在同一事务内执行，因此在 MySQL
和 MariaDB（REPEATABLE READ）上基于同一个一致快照。

由于检查不写任何行，判定结果保持不变：

- 有 guard 时，并发的转换（例如 Harness drain 或生命周期 claim）要么先提交、检查
  能看到它；要么检查先提交，转换随后继续执行，且看不到检查留下的任何东西。
- 没有 guard 时，在检查快照之前已提交的转换仍然可见。之后才提交的转换排在检查之后；
  这种顺序在有 guard 时同样可能发生，并且两种情况下转换观察到的状态相同。

每个方法都在返回前提交，所以即使有 guard，调用方根据判定结果行动时也没有持有任何锁。
检查通过与之后的 drain 之间的窗口本来就存在。检查之后的保护仍在原处：
`authorizeDispatch` 锁定 binding 行，并要求它在同一 generation 下处于 `READY`；
resident 派发在该事务内重新执行 Harness 检查；生命周期 authority 由生命周期协议写入的
claim generation 与租约来 fence。

## 受影响组件

- `JdbcRuntimeBindingRepository`：七个独立的 Harness 检查方法。
- `SharedHarnessOwnershipTest`：另一事务持有租户 guard 时，准入、Hook、recovery
  与 cleanup 的判定结果。

没有 schema、API 或配置变化。

## 风险

- 检查可能基于某次 drain 或 claim 提交前一刻的快照通过。这种顺序以前就可能发生，
  上面列出的检查后保护保持不变。
- 默认 READ COMMITTED 的引擎会让各读取使用不同快照；每个条件仍基于已提交数据检查。
  生产使用的 MySQL 和 MariaDB 为 REPEATABLE READ。

## 验证与验收

1. 另一事务持有租户 guard 时，打开状态的 Harness Session 的普通准入、Hook 准入和
   recovery 都能完成；正在 drain 的 Harness Session 的准入，以及没有匹配 claim 的
   cleanup，仍以 `runtime_admission_closed` 被拒绝。
2. 现有 Harness 测试继续通过：`SharedHarnessOwnershipTest`、
   `RuntimeHarnessDrainTest`、`WorkspaceLifecycleStoreTest` 与
   `WorkspaceProfileLifecycleTest`。
3. CI 运行 MySQL 和 Hosted profile。

## 未决问题

无。
