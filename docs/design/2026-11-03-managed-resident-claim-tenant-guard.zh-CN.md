# 去掉 Resident claim 的租户 guard

[English](2026-11-03-managed-resident-claim-tenant-guard.md) | [简体中文](2026-11-03-managed-resident-claim-tenant-guard.zh-CN.md)

## 问题与现状

[目录成员设计](2026-11-03-managed-workspace-membership-cas.zh-CN.md)已经为 LOCAL 和
SSH_LOCAL 的 `claim`、`release` 去掉了租户 placement guard，并把 resident（CSI）
分支列为非目标。该分支仍会开启事务，获取 `WorkspaceStorageKindGuard.lockDomain(tenant)`，
再执行 `requireResidentHeld`。因此，resident Workspace 上 Runtime Session 的获取和
释放，都要等待当前持有该 guard 的任何租户事务：Runtime placement、CSI 预留与退役、
迁移、维护以及 retention。

`requireResidentHeld` 只读不写。它检查 Runtime Session、其 binding、活动 slot 以及
处于 `RESERVED` 的 CSI 目录行是否仍与配置的 resident 注册一致，并检查同一 binding
generation 中没有其他未释放的 Runtime Session。两个分支都不写任何行。

## 目标与范围

在不改变哪些请求成功的前提下，为 `WorkspaceExecutionStore.claim` 和 `release` 的
resident 分支去掉租户 guard。CSI 预留、CSI 退役、resident 准入（`requireCreation`）
以及其他 guard 持有者不在范围内，继续持有 guard。

## 设计

两个 resident 分支保留事务，只去掉 guard。检查在该事务中以非锁定读执行，因此在
MySQL 和 MariaDB（REPEATABLE READ）上，所有查询基于同一个一致快照。

由于检查不写任何行，可能的结果保持不变：

- 有 guard 时，并发的状态转换要么先提交、检查能看到它；要么检查先提交，转换随后
  继续执行，且看不到检查留下的任何东西。
- 没有 guard 时，在检查建立快照前已提交的转换仍然可见，与以前一致。在快照之后提交
  的转换，排在检查之后。这种顺序在有 guard 时同样可能发生，并且两种情况下转换观察
  到的状态相同。

因此，这次改动只是在已有的结果之间改变了时序。获取之后的保护从来不依赖这把锁：

- `assertHeld` 与 `isHeld` 在获取之后、释放之前，本来就在没有事务、没有 guard 的
  情况下执行 `requireResidentHeld`。
- 同一 binding generation 中的第二个 Runtime Session 会被"其他会话"检查拒绝。
  resident 准入（`requireCreation`）和 `admitSession` 保留各自的锁。
- CSI 回收（`verifyClosed`）通过锁定读要求所有 Runtime Session 都为 `RELEASED`、
  所有工具执行都已结束，因此正在获取或仍存活的 Session 会阻止回收，与这把 guard
  无关。

## 受影响组件

- `WorkspaceExecutionStore`：`claim` 与 `release` 的 resident 分支。
- `ResidentWorkspacesTest`：另一事务持有租户 guard 时，resident claim、对第二个
  Session 的拒绝以及 release 都能完成。
- 目录成员设计：resident 非目标指向本文。

没有 schema、API 或配置变化。

## 风险

- resident `claim` 可能基于某个转换提交前一刻的快照通过。这种顺序以前就可能发生，
  获取后的 `assertHeld` 检查和回收的锁定读都没有变化。
- 默认隔离级别为 READ COMMITTED 的引擎会让各查询使用不同快照。每个条件仍基于已
  提交数据检查；生产使用的引擎为 REPEATABLE READ。

## 验证与验收

1. 另一事务持有租户 guard 时，resident 的 `claim`、`assertHeld` 和 `release` 都能
   完成，第二个 Session 的 `claim` 仍被拒绝。
2. 现有 resident 测试继续通过：`ResidentWorkspacesTest`、
   `WorkspaceCsiReservationStoreTest`、`ResidentWorkspaceReuseConcurrencyTest`，以及
   resident 退役和回收相关测试。
3. CI 运行对应的 MySQL 测试。

## 未决问题

无。
