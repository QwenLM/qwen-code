# Session（重）获取时的后台进程退出观测（#13533 B1)

[English](2026-10-10-background-exit-observation.md) | [简体中文](2026-10-10-background-exit-observation.zh-CN.md)

## 问题陈述

一个**自然退出**（无人停止）的后台 Shell 进程在生产中从未被 Broker 观测。`observeBackgroundProcess` 没有生产调用者；唯一的观测入口是 release 时的清扫（`settleUnprovenBackgroundRows`，由 `releaseSession` 调用）。由此产生两个缺口：

1. 在 run 所属 Session 存活期间，其 `:process` 账本行在进程退出后一直保持 `PREPARED`，直到某次 release 恰好清扫到它。
2. Broker 重启后缺口变成永久：（重）获取扫描（`scanExecutions`）用 `needsReconciliation()` 过滤，而它不覆盖 `PREPARED`(`ToolExecutionRecord.java:320`)，于是该行从此再也不会被询问——若之后 binding 被判丢失，该 run 报告的是 `runtime_lost`（被遗弃），而不是它真实、可证的退出。unknown/被遗弃的结果是刻意不可重放的，于是一个只需要退出事实的 Session 会因此 park 而非结算。

## 提议的改动

扩展（重）获取扫描，对非终止的后台 `:process` 行按持久证据观测。对扫描批中的每个这样的行，运行现有的 `observeProcessRow` 原语（向物理属主发一次 `shell-status` 控制）:

- 回答 `exited` 时，按该证据结算该行（`settleBackgroundProcess` 已有的映射：exit code 0 → `success`，其余 → `error`)。
- 任何其它回答、或查询失败，该行保持非终止并继续持有——wedge 语义不变：不能被证明的结果永远不变成被声称的终结。

观测与扫描的 reconcile 臂一样是 fire-and-forget：获取不等待它，观测失败的唯一表现是该行保持非终止。

## 设计决定

| 决定                                              | 理由                                                                                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 调用者放在 `scanExecutions`(Session 获取/重获取） | 需要退出事实的时刻恰好是（重）获取与 release。release 已有清扫（`settleUnprovenBackgroundRows`，含为重启后上下文准备的持久回填）；缺口在获取。   |
| 不做周期清扫                                      | 调度器会对每个 READY Session 永远产生 `control` 流量，去维护一个没人在读的事实。设计文档的 Recovery 节保持重启机制不变；按获取观测正是这个形状。 |
| 不走 status 读路径                                | 今天生产中没有任何调用者读 `:process` 行的 status，而读时改账本会破坏 Broker 纯证据的读取面。                                                    |
| 不在 daemon 侧                                    | daemon 从不指名 `:process` 行；Broker 拥有物理观测契约（对属主的 `shell-status`)。                                                               |
| 原样复用 `observeProcessRow`/`controlProcessRow`  | 该原语已携带 wedge 语义（只在证明 `exited` 时结算；`requireUsableLease`；控制栅栏）。本改动只是扫描多一条臂，不是新机制。                        |

## 范围

- `RuntimeBrokerService.scanExecutions` 增加观测臂。
- `RuntimeBrokerServiceTest` 增加一个见证。
- 不动 daemon、契约、schema、API。不新增调度器。

## 验收标准

按 #13533 B1，且可按文验证：

1. 后台进程的自然退出在 Session（重）获取时以退出证据结算其 `:process` 行——包括 Broker 重启后，同一 run 报告与重启前相同的结果。
2. 移除扫描的观测臂时有一个见证测试失败。
3. 属主无法证明退出的行继续持有（wedge 语义不回归——现有 `unprovenProcessStatusKeepsItsHold` 一类见证保持绿色）。

## 验证计划

- 单元：见证用重启后的 Broker（在 `RuntimeRecoveryContract.Fixture` 的持久状态上新建 `RuntimeBrokerService`，配可收养的 provisioner）驱动一个可证已退出的后台行，断言重获取时按证据结算；另加不可证臂、控制通道故障臂与孤儿行臂。
- 物理：在 Linux 验收 rig 上启动一个生产者会自行退出的后台 run，重启 Broker(Spring)，重新获取，读 `:process` 行——必须以退出证据结算为 `exited`，且 Session 不得 park。

## 未决问题

无。release 时清扫及其持久回填保持原样；turn 结算 drain 的议题在 #13533 单独跟踪，此处不涉及。
