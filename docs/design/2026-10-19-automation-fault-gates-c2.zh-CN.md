# Hosted automation 故障门禁 FG11c，第 2 片：Spring 崩溃与 scanner 租约

[English](2026-10-19-automation-fault-gates-c2.md) | [简体中文](2026-10-19-automation-fault-gates-c2.zh-CN.md)

## 问题与范围

Issue #14446 是 #12380 的 Stage F 第 FG11 轮，覆盖自动化域 `schedule` 与
`automation_run`。第 1 片（已由 #14601 合入）门控 Harness 进程崩溃：在一个 run
的三个 revision 上各 SIGKILL 一次，跑在打包栈上。本片覆盖住在 Spring 里的格——
scanner 及其租约所在处：

| 用例                           | 注入                                                                                                    | 期望                                                                                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `spring-kill-before-answer`    | occurrence 处于 `firing`，Harness 已提交 run，夹具在 Spring 结算前扣住应答；SIGKILL Spring 子进程后重启 | 重新驱动的 fire 复用已提交的 `arun_` 身份：一条已提交的 `automation_run` 与一个被接受的 input，occurrence 恰好 `fired` 一次。杀进程会断开 Harness 会话，wake turn 可能被中止，因此不断言 Turn 数       |
| `spring-kill-before-watermark` | 应答已落（revision 2 已提交），夹具把 `advanceWatermark` 挂起；SIGKILL Spring 子进程后重启              | 同一 slot 不出现第二次 fire；watermark 追上，账本只有一条 run 链。杀进程会断开 Harness 的会话，wake turn 可能被中止，因此这一格不断言模型 Turn                                                         |
| `two-scanner-race`             | 两个 Spring 子进程共用一台 MySQL 与同一 tenant，只有一个到期 slot，二者都被驱动一次                     | 账本去重：一行 occurrence、一条已提交的 `automation_run`、一次模型 Turn。本用例不构造租约接管；fencing 由 store 在 `claim`、`settleOccurrence`、`advanceWatermark` 上的 `lease_owner`/`fence` 谓词保证 |
| `parked-tool-harness-kill`     | wake turn 停在 Runtime 工具调用上时 SIGKILL Harness 子进程                                              | 延期：见预算段说明                                                                                                                                                                                     |

live-run reconcile 格（存活 turn 经 overlap-`skip` slot 驱动 `reconcile_run`，run
保持 `running`）已由 #14480 的路由测试钉住，本片不重复。

## 门控的性质

每个 occurrence 至多一条 run 与一个被接受的 input；wake turn 跑完时只调用
一次模型，且该 slot 恰好一条已提交的 `automation_run`。fire 中途死掉的 Spring 在重启后不得
产生第二条 run。wake turn 已结算的 run 必须按 journal 的 `turn.settled` 结算，
绝不写成 `failed`/`outcome_unknown`，即使结算进程在写 revision 3 之前就死了。

这些用例门控的是去重，不是租约接管：fencing 由 store 在 `claim`、
`settleOccurrence`、`advanceWatermark` 上的 `lease_owner`/`fence` 谓词保证，
本片不构造 stale writer 的接管。

## 夹具

本片需要的 Spring 子进程夹具在 FG7c 已有现成先例：
`HostedChannelCrashFixtureMain` 在子 JVM 里启动应用，用 `ready.json` 公布内部
与控制面地址；`HostedChannelProcessCrashIT` 用 `destroyForcibly()` 杀进程，并在
同一端口起新一代。

本片沿用该形态，增加一份 automation 夹具主类，并补三处：

- **打开 automation。** `--qwen.managed-agent.automation.enabled=true`，`scan-delay`、
  `lease`、`late-tolerance` 按测试尺度调小；scanner 是 `AutomationScanner`，
  调度在 `managedAutomationScheduler` 上。
- **fire 挂起。** 夹具用 `BeanPostProcessor` 包装 `HarnessConnector`，把
  `runAutomationOperation` 在 Harness 提交之后停在控制面 arm 的闩锁上，
  使应答丢失而 run 已持久化。测试侧代理表达不了
  这个窗口：转接 Spring 与 Harness 的连接会破坏其流式通道，warm turn 永远
  不完成。
- **watermark 挂起。** `spring-kill-before-watermark` 由夹具注册一个 primary
  的 `AutomationLedgerStore`，其 `advanceWatermark` 停在闩锁上。schedule 行锁
  表达不了这个窗口：`settleOccurrence` 的 `HELD` 子查询会读同一行，外部锁把
  occurrence 的写入也堵住，崩溃点永远到不了。
- **两个子进程。** `two-scanner-race` 起两个夹具 JVM，共用同一 MySQL 与 tenant，
  并指向同一个 Harness。只有第一个绑定内部 listener；第二个关闭该 listener，并使用
  第一个子进程的 session-store URL——会话正是建在那个 store 上。

## 账本

事实来源是 Session journal、run 记录（`ma_session_record.task_state`）、
`ma_schedule_occurrence` 与 `ma_schedule`（watermark 与 lease），外加模型桩收到的
prompt。

## 变异见证

每个见证单独对各自的用例运行，并逐字节恢复。

| 见证 | 变异                                                                       | 预期变红处                                                         |
| ---- | -------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| s1   | `automationRunId` 每次调用加 nonce，重新驱动会派生出新的 run id            | `spring-kill-before-answer`：重新驱动的那条链旁边出现第二条 run 链 |
| s2   | `CronSlots.occurrenceKey` 每次调用加 nonce，使两个 scanner 派生出不同 slot | `two-scanner-race`：出现两行 occurrence 与两条 run 链              |
| s3   | 随延期格移除（结算顺序仍由第 1 片钉住）                                    | -                                                                  |

## 预算

该类跑五个测试——夹具烟测、fire 路径与三个窗口——同处一个 fork，共用一个
Harness 与最多两个 Spring 子进程。整类在 JDK 21 + MySQL 8.0.46 上实测 262.0 秒，
按 524 秒（2x）计入：`main` 的健康总和 6985 秒到 7509 秒，Hosted fork 由 7585 秒
升到 8109 秒（方法本身 600 秒上限不变），Verify 步骤由 137 分钟升到 146 分钟，
job 上限由 230 分钟升到 239 分钟。

`parked-tool-harness-kill` 延期：第 1 片的 `turn-crash` 已钉住「Harness 在 turn
中途死掉、run 恰好结算一次 `failed`/`outcome_unknown`」，已合入的 #14526 门禁
钉住按 run 取消的路径（被取消的 occurrence 不调用模型、不会重复执行）。
本格真正的增量只剩「Runtime 工具调用不重放」，
需要另造会发 tool-call 的模型桩与 broker 交互，成本高于增量价值。

## 验收

- `mvn -Pmysql-integration -DskipTests test-compile checkstyle:check` 干净，
  且本树上 `checkstyle:check@runtime-broker-checkstyle` 也干净。
- 已实现的每个用例在 JDK 21 + 真实 MySQL 上全绿，用
  `mvn -Phosted-automation-gates -Dit.test=HostedAutomationSpringCrashIT#<method>`
  `failsafe:integration-test` 单独选择；整类全绿。
- 每个见证都在表中位置变红，并逐字节恢复。
- `scripts/tests/hosted-process-ci.test.js` 在预算叠加后全绿。
- 本设计以中英双语交付，结构一致。

## 待定问题

- 崩溃的 scanner 是否应在启动时 reconcile 而不是等下一个到期 slot，是 #14116 的
  范围，不在本片。
- 受控的租约接管——一个 scanner 丢掉租约后再尝试写过期数据——不在这些用例的
  构造范围内；它需要在 scanner 认领内部设暂停点，产品未暴露该点。fencing 本身
  由 store 的 `lease_owner`/`fence` 谓词保证。
