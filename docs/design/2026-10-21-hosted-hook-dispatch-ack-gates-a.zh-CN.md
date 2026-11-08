# Hosted Hook 派发确认门禁 FG13a

[English](2026-10-21-hosted-hook-dispatch-ack-gates-a.md) | [简体中文](2026-10-21-hosted-hook-dispatch-ack-gates-a.zh-CN.md)

> 跟踪 #14449。结果提交切片把确认丢失模式落在已结算记录上；本层把同一故障
> 移到 `dispatch_started` 提交——在这里，确认丢失正是「worker 已被告知」与
> 「worker 从未被触达」的分界。

## 问题与范围

FG13b 的派发格在 `dispatch_started` 提交应用之前拒绝，事务回滚，记录停在
`intent`。这钉住了可重试路径，却没有钉住相反的一面：提交落库、调用方看到
失败，而记录已经声称了一次 worker 从未收到的派发。缺了这格，恢复路径可能
把该记录再派发一次，或把失败读成「什么都没发生」，让模型在没有 Hook 答复的
情况下继续。

本切片用上一片新增的确认丢失模式，在派发提交上补一格。

## 用例

`HostedHookReplyLossFaultGatesIT` 的
`fg13aHookDispatchStoreAckLossLeavesTheDurableDispatchOnMySql`：

| 步骤 | 发生什么                                          |
| ---- | ------------------------------------------------- |
| 1    | `dispatch_started` 提交落库，随后缝报告确认丢失。 |
| 2    | store 客户端重试，已提交的命令走重放。            |
| 3    | Hook 从这份已落库的派发执行一次并结算。           |
| 4    | 用例断言故障只触发一次、结果已结算。              |

期望：

- 故障恰好触发一次：重试走重放，不再经过记录 store；若是回滚，重试会再次
  提交派发并二次触发故障。
- 物理调用与 allow 各一次，记录以结果结算。
- 对已有 `dispatch_started` 重新 `fire()` 走的是 `lookup` 分支，本格不覆盖。

## 接缝

不需要新接缝。`StoreFaultGate.armAck(HOOK_DISPATCH_STARTED, null)` 复用结果格
新增的模式：`inspect` 静默，`afterApply` 在 `super.apply`/`super.applyNative`
返回之后抛错，因此调用方看到失败时该行已经持久化。

## 覆盖

- FG13b 钉住拒绝：回滚让记录停在 `intent`，且不产生派发。
- 本格钉住已落库的提交：记录持久存在，失败不能被读成「没有派发记录」。
- 对已有 `dispatch_started` 重新 `fire()` 走 `lookup` 分支而非再次派发，本格
  不覆盖该路径；TypeScript 的 `dispatches a recovered intent through its
original Runtime Session` 只覆盖 `intent` 窗口。

## 变异见证

- 改用 `arm` 而非 `armAck`：提交回滚，记录停在 `intent`，已落库阶段断言变红。
- 从故障 store 去掉 `afterApply`：不触发故障，等待 `attempts` 超时。
- 把已落库的派发恢复两次：物理调用计数变成两次，尾部上界断言变红。

## 非目标

- 注册结算确认：FG13a 的最后一格，堆叠在本分支之上。
- 前进方向恢复路径本身：由上述 TypeScript 单测钉住，不由本格覆盖。

## 验证

证据来自 Linux 上的 `hosted-harness-mysql` 车道，MySQL 8.4 与委派的 cgroup
v2 根。`managed-agent-gate.yml` 在 `pull_request` 上只选 `fast` 档；完整套件
由维护者对 head 提交的首次批准触发。本格给共享 fork 增加 150 s：healthy
10350 s、fork 10950 s、Verify 193 分钟。
