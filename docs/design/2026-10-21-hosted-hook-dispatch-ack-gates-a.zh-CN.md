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
| 2    | 用例读取失败留下的记录。                          |
| 3    | 清除门禁，等待静默。                              |
| 4    | 用例给恢复可发出的物理调用设上界。                |

期望：

- 已落库记录是 `dispatch_started` 且无结果——这正是它与 FG13b 拒绝格（停在
  `intent`）的分界。
- 物理调用至多一次：确认在派发发出之前丢失，恢复可以复用这个已落库的派发
  一次，绝不会执行两次。
- 前进方向的恢复路径（对已落库的 `dispatch_started` 重新 `fire()` 恰好发出
  一次派发）由 TypeScript 层钉住。

## 接缝

不需要新接缝。`StoreFaultGate.armAck(HOOK_DISPATCH_STARTED, null)` 复用结果格
新增的模式：`inspect` 静默，`afterApply` 在 `super.apply`/`super.applyNative`
返回之后抛错，因此调用方看到失败时该行已经持久化。

## 覆盖

- FG13b 钉住拒绝：回滚让记录停在 `intent`，且不产生派发。
- 本格钉住已落库的提交：记录持久存在，失败不能被读成「没有派发记录」。
- 前进方向的恢复路径——对已落库的 `dispatch_started` 重新 `fire()` 恰好发出
  一次派发——由 TypeScript 层 `hosted-hook-session.test.ts` 的
  `dispatches a recovered intent through its original Runtime Session` 钉住。

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
