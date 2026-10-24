# Hosted Hook store 确认门禁 FG13a

[English](2026-10-21-hosted-hook-store-ack-gates-a.md) | [简体中文](2026-10-21-hosted-hook-store-ack-gates-a.zh-CN.md)

> 跟踪 #14449。现有 store 故障缝在提交应用之前拒绝；本层补相反的故障：
> 提交已经落库，调用方永远收不到确认。

## 问题与范围

`StoreFaultGate` 在 Session store 的提交事务内、记录应用之前触发，因此整个
提交回滚。这钉住了拒绝路径，却没有钉住「store 提交成功、确认丢失」：调用方
不得重跑 Hook，之后的状态读取必须找到已落库的记录。

本切片给测试缝加确认丢失模式，并落一格：已结算 Hook 的结果提交。

## 用例

`HostedHookReplyLossFaultGatesIT` 的
`fg13aHookResultStoreAckLossSettlesWithoutASecondCallOnMySql`：

| 步骤 | 发生什么                                     |
| ---- | -------------------------------------------- |
| 1    | 一个 `PreToolUse` 命令 Hook 执行一次并结算。 |
| 2    | 结果提交落库，随后缝报告确认丢失。           |
| 3    | 用例读取已落库的记录与公共回合状态。         |
| 4    | 之后的 status 读取返回已结算记录。           |

期望：

- 物理调用在夹具证据中恰好一次，结果记录为 `settled`。
- 尽管确认丢失，已落库记录仍是 `settled` 且带结果。
- 之后的 status 读取返回 `settled`，不产生第二次调用。

## 接缝

`StoreFaultGate.armAck(phase, record)` 设定一种模式：`inspect` 不抛错。故障
store 在该模式启用时注册一个 `TransactionSynchronization` 回调，`afterApply`
在 `afterCommit` 中抛错。此时事务管理器已经提交，所以调用方看到的是「记录已
落库、确认丢失」而不是回滚——若在 `apply` 内部报告故障，它仍处在
`ManagedSessionStore.commit` 的事务里，会把写入一起撤销。

`StoreFaultGateTest` 钉住该模式：提交前钩子静默、提交后钩子抛错、plan marker
不被匹配。

## 覆盖

`HostedHookReplyLossFaultGatesIT` 已钉住结果提交被拒（FG13b）。本格在同一
提交上补确认丢失路径。

## 变异见证

- 改用 `arm` 而非 `armAck`：提交回滚，记录永不结算，已落库断言变红。
- 从故障 store 去掉 `afterApply`：不触发故障，用例读到零次尝试。
- status 读取时重跑 Hook：物理调用计数变成两次。

## 非目标

- `dispatch_started` 确认丢失与注册结算确认：FG13a 的其余格，仍在 #14449。
- store 客户端重试耗尽：由 FG13b 的拒绝格覆盖。

## 验证

证据来自 Linux 上的 `hosted-harness-mysql` 车道，MySQL 8.4 与委派的 cgroup
v2 根。`managed-agent-gate.yml` 在 `pull_request` 上只选 `fast` 档；完整套件
由维护者对 head 提交的首次批准触发。本格给共享 fork 增加 150 s。
