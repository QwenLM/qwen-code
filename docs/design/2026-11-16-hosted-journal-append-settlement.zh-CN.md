# 结算一次未被确认的 Hosted 日志提交

[English](2026-11-16-hosted-journal-append-settlement.md) | [简体中文](2026-11-16-hosted-journal-append-settlement.zh-CN.md)

状态：提案

## 问题陈述

`POST /transactions:commit` 丢失回执时，Hosted 轮次会变成
`hosted_harness_recovery_blocked`。权威层已经把这一次事务留在
`unsettledAppend` 里，下一次追加本来会询问持久化日志头它是否落盘。Harness
不会再发起那一次追加：它把失败包成 `HostedToolRecoveryRequiredError`，并设置
`session.blocked`。原来的写事务此后仍可能提交或回滚。没有人再问，轮次就停在那里。

同一次卡顿也会让 macOS 存储身份探针超时。预热把这个超时记成终端的
`environment.failed` / `runtime_warm_failed`，而这本是身份已经对不上的信号。

## 现状

`JournalCommit.commit` 在第一次一致性读之前用 `FOR UPDATE` 锁住会话行，并持有到写事务结束。写事务预算是 30 秒（`writerTransactions.setTimeout(30)`）。客户端同一次提交的全部尝试共享 30 秒（`DEFAULT_REQUEST_TIMEOUT_MS`）。这把锁的顺序来自 [2026-11-03 的设计](2026-11-03-managed-journal-commit-tenant-guard.zh-CN.md)，是会话围栏。把锁后移会让生命周期准入在提交过程中插进来。

遇到 `ManagedSessionAppendUnsettledError` 时，`LocalManagedSessionAuthority.commit` 保存 marker、events 和 branches，然后抛出。`runSerial` 只在下一次操作开始时调用 `settleUnsettledAppend`。`landed` 会应用这些事件。`absent` 会丢掉它们，不再提交。持锁事务还可能占着这一行时，丢掉是错的：日志头还没变，读取就回答 `absent`，这笔事务稍后提交会把权威层 fencing 住。

`MacOsHostIdentity.read` 在探针 5 秒内没有退出、以及退出码非零时，使用同一句 `IOException`：`macOS native identity probe failed`。`HarnessCoordinator.runtimeWarmResult` 对每一次预热失败都写入 `environment.failed` 和 `runtime_warm_failed`。

H2 默认等锁 2 秒。加长等锁时间不是这次改动。更长的等待会让同租户的其他提交排在一个持有者后面。

## 目标

- 丢失的提交回执在 Harness 停住会话之前被结算，或按同一个 command id 再提交一次。
- 已经执行过的工具不重新执行。只结算它保存下来的那批日志。
- 日志被 fencing、写租约无法重新取得、以及日志头被另一个 command 推进时，仍然立刻停住会话。
- 5 秒内没有完成的探针不记录 `runtime_warm_failed`。真正的身份不匹配仍然记录。

## 范围边界

- 会话行锁仍是 `commit` 的第一处一致性读，并持有到该事务结束。
- 已经停在 0.27.4 进程里的轮次不会被这次改动解开。那一轮取消，或在新任务里继续。
- 本地 JSONL 日志没有 `settleAppend`。那里的未知追加仍然会停住 writer。

## 方案

### 同命令续交

`unsettledAppend` 同时保留确切的记录批次。在 `commit` 把异常抛给 Harness 之前，以及下一次 `runSerial` 操作开始时，权威层续交这批记录：

1. `settleAppend` 回答 `landed`：`applyCommitted` 应用保存的事件。调用方看到的是提交成功。
2. `settleAppend` 回答 `absent`：`appendTransaction` 把保存的字节再提交一次。原事务已经提交时，服务端按 `operation` + `commandId`（含 `transactionId` 和 `recordDigest`）重放。原事务已回滚时，这一次是唯一写入。原事务仍开着时，这一次等在会话行锁上。这次续交自己的回执再丢失，就继续保留 `unsettledAppend`。`absent` 路径不丢掉事件。
3. 续交的等待独立于已经耗尽的客户端预算。上限是 30 秒写事务预算，截止后再允许一次结算读。到点仍不能区分，就抛出 `ManagedSessionAppendUnsettledError`，Harness 按今天的方式停住会话。
4. `ManagedSessionJournalFencedError`、写租约重新取得失败，以及其他确定的存储失败，会清掉保存的批次、停住这个 writer，并停住会话。

Harness 仍只在这个最终失败以 `HostedToolRecoveryRequiredError` 出现时设置 `session.blocked`。续交成功则作为成功回到工具轮次，模型循环从已提交的记录继续。

### 身份探针超时

`MacOsHostIdentity.read` 在 `waitFor` 超过 5 秒时抛出 `MacOsIdentityProbeTimeoutException`。非零退出仍是原来的 `IOException`。`parseBirthTime` 仍拒绝不匹配的设备号、inode 或 birth time。

`HarnessCoordinator.runtimeWarmResult` 沿 cause 链查看，并匹配简单类名 `MacOsIdentityProbeTimeoutException`。控制面不依赖 `runtime-host`，因此不能 import 这个类型。探针超时只记日志，不落事件。包括身份不匹配在内的其他预热失败，仍在 `runtime:failed:{turnId}` 下追加 `environment.failed` / `runtime_warm_failed`。

## 设计决策

- 续交使用保存的字节，因为重放会比较 `transactionId`、`commandId`、`recordDigest` 以及其余提交身份。把事件重新编码会生成新的 record digest，从而冲突。
- `absent` 选择再提交，而不是丢掉。日志头没动，不能证明持有者已经回滚。
- 会话行锁不改。它让续交等到原事务结束，然后恰好重放或写入一次。
- 探针超时不是身份变化。把它记成 `runtime_warm_failed` 会告诉客户端环境已经终态失败。

## 约束

- 续交路径不生成新的 command id、序号，也不重新执行工具。
- 再提交只有一次。它的 HTTP 预算是存储客户端自己的请求超时。权威层不循环这次尝试。
- 预热分类保持在 `HarnessCoordinator` 的包可见范围内，并通过简单类名匹配 `MacOsIdentityProbeTimeoutException`。

## 风险

- 在字节并未持久化时应用 `landed`，会使权威层和存储分叉。续交只在 `settleAppend` 之后应用 `landed`，只在再提交返回之后应用 `absent`。保存的批次就是失败的那次调用试图写入的批次。
- 长于 30 秒预算的存储中断仍会停住轮次。这就是现有的恢复阻塞，只是更晚到达。

## 验证计划

- 权威层：回执丢失且 `landed` 时，同一次调用应用原来的事件。`absent` 时按同一命令再提交一次。再提交仍然未被确认时，事件留在 `unsettledAppend`。结算被 fencing 时停住 writer。预算在截止后允许一次结算读，并且不等待墙上时钟。
- Harness：提示词的第一次日志追加丢失回执并随后以 `landed` 结算时，结束状态的 `recoveryBlocked` 为 false。被 fencing 的追加结束时 `recoveryBlocked` 为 true。
- Java：`/bin/sleep 20` 抛出 `MacOsIdentityProbeTimeoutException`。超时 cause 不追加 `environment.failed`。身份不匹配的 `IOException` 会追加。

## 验收标准

- 会话行 `FOR UPDATE` 仍是 `JournalCommit.commit` 的第一处一致性读。
- 未被确认的提交不会在 `absent` 时被丢掉。
- 这次提交随后结算或被重放时，Harness 不设置 `session.blocked`。
- 探针超时不发出 `runtime_warm_failed`。身份不匹配仍然发出。
