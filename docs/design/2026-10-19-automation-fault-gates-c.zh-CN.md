# Hosted automation 故障门禁 FG11c，第 1 片：Harness 进程崩溃

[English](2026-10-19-automation-fault-gates-c.md) | [简体中文](2026-10-19-automation-fault-gates-c.zh-CN.md)

## 问题与范围

Issue #14446 是 #12380 的 Stage F 第 FG11 轮。FG11c 门控进程崩溃。本片覆盖
**Harness 侧**：在一个 run 的三个 revision 上各做一次 SIGKILL，跑在打包栈上。
Spring 侧 —— occurrence 行为 `firing` 后、应答之前或之后杀 Spring，以及两个
scanner 争 lease —— 需要 Spring 子进程夹具，作为第 2 片交付。存活 run 的
reconcile 格已经在真实栈上由 FG11a 的 `reconcile-reply`（#14534）钉住，路由层
由 #14480 钉住；删掉 `session.active === undefined &&` 会让那个用例变红，所以
本片不重复它。

门控的性质：Harness 在 run 的三个 revision 中任意一点被杀，要么在重新驱动时
补完，要么诚实地恰好结算一次。不得出现第二个 run、第二个被接受的 input、第二次
模型 Turn。`turn.settled` 之后崩溃的 run 必须按 journal 结算为 `completed`，而
不是 `failed`/`outcome_unknown`。

三个用例同一次启动，位于 `fg11cHarnessCrashesNeverRunTwiceOnMySql`：

| 用例            | 注入                                                                                               | 期望                                                                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `claim-crash`   | 在 revision 1（claim）与 revision 2（dispatch）之间 SIGKILL；revision 2 被 Harness 停在 store 之前 | scanner 重新驱动同一个 claim；replay 在重新加载的 Session 上补完 revision 2。一条 run 链（`:1`、`:2`、`:3`）、一个被接受的 input、一次模型 Turn，occurrence 记为 `fired` |
| `turn-crash`    | 在 wake turn 的模型调用在飞时 SIGKILL；随后同一个每分钟定义的下一个 slot 到期                      | 后续 slot 的 reconcile 加载 Session；aftermath 把 run 恰好结算一次为 `failed`/`outcome_unknown`。一条 settle revision、一个被接受的 input、一次模型 Turn；turn 绝不重跑  |
| `settled-crash` | 在 `turn.settled` 之后、revision 3 到达 store 之前 SIGKILL                                         | 重新加载时 open 路径的 `reconcileRuns` 按 journal 的 `turn.settled` 把 run 结算为 `completed`，恰好一次。一条 settle revision、一个被接受的 input、一次模型 Turn         |

每个用例结束时，租户下不存在 `unknown` occurrence。

## 当前状态

- **三个 revision。** `fire` 提交 claim（revision 1），并在与 run 的 input、wake
  同一个事务里提交 dispatch（revision 2）（`hosted-automation-session.ts`）。
  `settleRun` 提交 revision 3。
- **replay。** 重新驱动的 fire 遇到状态为 `intent` 的 run 时补完 dispatch；遇到
  `dispatch_started` 的 run 时直接答复已提交的 run（`fire` 的
  `existing !== undefined` 分支）。
- **结算。** `settleRunUnserialized` 先读 journal 自己的 `turn.settled`，再退回
  投影出的 turn 结果，然后在 `settleRun` 下提交 revision 3。Session 打开时
  `reconcileRuns` 会扫过每个已 dispatch 且 turn 已结算的 run。
- **崩溃善后。** 在结算前死亡的 wake turn 会在 transcript 留下一次 prior
  attempt。pump 将其归类为 `recovery`，`wakeAftermath` 用
  `settleRunFailedUnknown` 把它恰好结算一次 —— `failed` +
  `outcome_unknown` —— 同时取消挂起的执行并消费 input。
- **写者租约。** 重启后的 Harness 要等死写者的租约过期才能接管 Session。本方法
  把它设为 15 秒。

## 门禁账本

事实来源是 Session journal（`ma_session_journal_tx` 的 command 与 event id）、
run 记录（`ma_session_record.task_state`）、`ma_schedule_occurrence` 行，以及
模型桩收到的 prompt。store relay 记录它见到的每一次 commit；崩溃用例会检查被
arm 的那次 commit 确实被停住且从未提交。

## 夹具设计

- **store relay。** 本方法在 Harness 与 Session Store 之间放一个
  `HostedLifecycleRelay`。它的 `before` 钩子停住被 arm 的那次 commit，并在
  Harness 被杀后将其丢弃：该 revision 从未到达 store。
- **冷重启。** SIGKILL Harness，然后用新的 HOME 在同一个端口启动。死写者的
  15 秒租约由用例的后续 slot 等待，做法与 FG11b 第 2 片一致。
- **后续 slot。** `turn-crash` 与 `settled-crash` 使用每分钟定义：后续 slot 的
  计数型拒绝会让 scanner 调用 `reconcile_run`，从而加载 Session 并走结算路径。
  目标 run 结算后退役该定义。
- **模型挂起。** 模型桩只挂起手动 occurrence 的 wake turn（`Occurrence:
manual:`），所以后续的定时 slot 仍能在崩溃 run 被 reconcile 期间运行。

## 发现

- **重新驱动次数不稳定。** `claim-crash` 在被接受前可能遇到瞬时 409：重启后的
  Harness 在死租约过期前的首次 load 会答复
  `managed_session_writer_conflict`，connector 还可能答复 `Hosted Harness
generation changed`。因此用例只断言该 occurrence 至少被 fire 过一次，绝不断言
  精确的重驱次数；journal 里的一条 run 链才是真正的不变量。
- **reconcile 可能失败一次，由下一个 slot 重试。** 实测运行中，`turn-crash`
  与 `settled-crash` 各记录一条 `automation reconcile failed ... Hosted
Harness generation changed` WARN；下一个到期 slot 会重新驱动修复，run 最终
  结算。这正是 issue 点名的 #14116 形态，不是丢 slot。
- **`settled-crash` 从不需要 reconcile 路由的修复。** 它的 input 在 revision 3
  之前已被消费，所以 `firstPendingWakeInput` 为 undefined，路由答复
  `repaired: false`；真正提交 revision 3 的是 open 路径的 `reconcileRuns`。

## 变异见证

每个见证都将在合入前单独对各自的用例运行，并逐字节恢复；下表记录
预期变红处。

| 见证 | 变异                                                       | 预期变红处                                                                          |
| ---- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| c1   | `intent` run 的 replay 直接答复已提交的 run，不再 dispatch | `claim-crash`：revision 停在 `:1`，run 永不完成                                     |
| c2   | `wakeHasPriorAttempt` 恒答复 false                         | `turn-crash`：pump 重跑 turn 而不是结算它，run 不是 `failed`，并出现第二次模型 Turn |
| c3   | open 路径跳过 `reconcileRuns`                              | `settled-crash`：revision 3 永不提交，run 停在 `running`                            |

## 预算

三个用例在本机 JDK 21 + MySQL 8.0.46 上单独选择时分别测得 48 秒、124 秒与
110 秒；整个方法在验收运行中测得 144.8 秒。方法按 550 秒（2×）计入预算，
叠加到 `main` 的健康总和：5743 秒 → 6293 秒；Hosted
fork 从 6353 秒升到 6893 秒（方法本身 600 秒上限）。Verify 步骤从 116 分钟升到
125 分钟，job 上限从 210 分钟升到 220 分钟。

## 验收

- `mvn -DskipTests test-compile checkstyle:check` 干净。
- 三个用例在本机 JDK 21 + MySQL 8.0.46 上全绿，每个都用
  `-Dqwen.fg11c.case=<case>` 单独选择；合入前每个见证都必须变红。
- `scripts/tests/hosted-process-ci.test.js` 在预算叠加后全绿。
- 三个用例共用一个 `@Test`，首次变红只报出一个用例，其后的用例不会运行。用
  `-Dqwen.fg11c.case=<case>` 逐个重跑。
- 本设计以中英双语交付，结构一致。

## 待定问题

- 崩溃的 run 是否应该在启动时 reconcile 而不是等后续 slot，是 #14116 的范围，
  不在本片。
- Spring SIGKILL 格与两个 scanner 争 lease 留给第 2 片；它们需要 Spring 子进程
  夹具。
