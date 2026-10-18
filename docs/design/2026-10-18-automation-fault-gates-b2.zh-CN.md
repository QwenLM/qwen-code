# Hosted automation 故障门禁 FG11b 第 2 片：Harness 侧存储故障

[English](2026-10-18-automation-fault-gates-b2.md) | [简体中文](2026-10-18-automation-fault-gates-b2.zh-CN.md)

## 问题与范围

Issue #14446 是 #12380 F 阶段的 FG11 轮。FG11b 覆盖存储故障。第 1 片（#14551，
[设计](2026-10-18-automation-fault-gates-b.zh-CN.md)）覆盖了 Spring 侧的账本写入。本切片覆盖
**Harness 侧的一半**：Harness 为一个 automation 操作发给 Session Store 的 journal 提交。

门禁要守的性质：一个 automation 操作的 journal 提交失败、或它的应答丢失时，Harness 在重新加载
之前绝不会再写这个 Session。调用方得到的是可重试的应答，绝不是拒绝。在重新加载的 Session 上，
同一个操作只完成一次：fire 是一条 run 链、一个模型 Turn，定义变更是一个 revision。

共四个用例，在一次启动里跑完，位于 `HostedAutomationFaultGatesIT` 的第三个方法
`fg11bHarnessStoreFaultsNeverRunTwiceOnMySql`：

| 用例              | 注入                                                                  | 预期                                                                                                                                                                                          |
| ----------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `store-transport` | store 已提交手动 run 的 revision 1，它给 Harness 的应答在连接上丢失   | store client 的有界重试再次发送同一个命令。store 把它当作已持有的那次提交来应答，fire 照常进行：手动 run 立即回答 `202`，这次提交被看到两次、只提交一次，一条 run 链、一个模型 Turn，无需重启 |
| `revision-1`      | MySQL 拒绝手动 run 的 revision 1（claim）的 journal 提交              | store client 尝试三次后返回 `503 automation_operation_unknown`。什么都没提交。拒绝撤掉后，同一个 key 仍然回答 `503`：这个 Session 不再写入任何东西。冷重启后，重试只 fire 同一个 run 一次     |
| `revision-2`      | MySQL 拒绝 revision 2（dispatch，连同输入和唤醒）                     | 同上，只是 claim 已提交并停在 `intent`。重启后，replay 补完 revision 2：`:1` 和 `:2` 各一次，一个被接受的输入，一个模型 Turn                                                                  |
| `projection`      | MySQL 在 journal 提交自己的事务内拒绝 `schedule` 镜像对一次更新的投影 | `503 automation_operation_unknown`。revision 随投影一起回滚：journal 和镜像都没有超过 revision 1。冷重启后，同一个 key 的重试只提交一次 revision 2，journal 与镜像一致                        |

每个用例结束时，该租户都没有 `skipped` 或 `unknown` 的 occurrence。

## 当前状态

- **提交。** Harness 通过它的 HTTP store client（`http-managed-session-store.ts`）提交每个
  journal 事务。不确定的失败最多一共尝试三次：429 或 5xx、传输错误或超时。重试发送同一个命令 id，
  store 对已持有的命令用那次提交的回执作答。
- **写入锁存。** 如果提交仍然失败，Session 的 authority 会记下这次失败
  （`writeFailure`，`managed-session-authority.ts`）。之后的每个命令都回答
  `ManagedSessionWritesStoppedError`，直到 Session 被重新加载。它无法知道这些记录是否已经落盘。
- **调用方看到的。** automation 路由把 store 故障回答为 `503 automation_operation_failed`。Spring
  的客户端把 Harness 的每个 5xx 都当作结果不明确，所以公开路由回答
  `503 automation_operation_unknown`（"retry the same key"）。手动 run 的 occurrence 保持 `firing`，
  由扫描器重驱。
- **投影。** `schedule` 镜像是在 store 的 journal 提交事务内投影的（`ManagedExtensionRecordStore` →
  `AutomationLedgerStore.projectSchedule`），所以投影被拒就等于这次提交被拒。

## 门禁账本

事实依据来自 Session journal（`ma_session_journal_tx`）、记录与镜像（`ma_session_record`、
`ma_schedule`、`ma_schedule_occurrence`）、writer generation（`ma_session_head`）、store relay 的
提交日志以及模型桩的 prompt。

拒绝沿用第 1 片按租户隔离的 trigger，这次建在 `ma_session_journal_tx` 和 `ma_schedule` 上。每个
都会记下它拒绝的内容（命令 id 或定义 revision），所以用例会检查每次尝试都是同一个提交，并且至少
尝试了三次。

## 夹具设计

- **store relay。** 只有这个方法在 Harness 和 Session Store 之间放一个 `HostedLifecycleRelay`
  （`session-store.base-url`）。它记录每次提交的命令 id，并在 store 提交之后丢掉它对那个预设命令的
  应答。
- **冷重启。** SIGKILL Harness，再用全新的 HOME 在同一端口启动。这个方法的 Spring writer lease 为
  15 s，所以死掉的 writer 的 lease 很快过期。下一个到达这个 Session 的请求会重新加载它，可能是
  用例自己的重试，也可能是扫描器的重驱。用例会检查已有新的 writer generation 持有这个 Session。
- **重试直到被接受。** 重启后，用例用同一个 key 重试同一个请求，直到它回答 `202`。在 lease 过期
  之前，冷 Harness 的加载会被拒绝，公开路由把它原样传成 `409 managed_session_writer_conflict`
  （见"发现"）。其他任何拒绝都会让用例失败。
- **teardown。** 逐个删除 trigger，一个删除失败不会让其他 trigger 留在共享 fork 的 schema 上。
  然后删除拒绝计数表。

## 发现

- **暂时性的 writer 冲突以 409 到达公开调用方。** Harness 重启后，在死掉的 writer 的 lease 过期
  之前，公开的手动 run 路由回答了 `409 managed_session_writer_conflict`。更新路由经过同一个转换
  （`ManagedAutomationService.translate`，Harness 的 409 仍是 409）。扫描器会重驱这种情况，因为这个
  错误码不在它的终局拒绝之列，所以手动 run 不会丢。但公开应答是一个客户端不太会重试的 4xx 冲突，
  而定义更新没有别的东西会重驱。用同一个 key 重试确实能恢复，因为回执保持已占用、未作答。本切片
  记录这一行为，门禁会重试越过它，而不把它钉住。

## 变异见证

每个见证都只针对它自己的用例单独跑过，并逐字节还原。

| 见证 | 变异                                                                                  | 变红处                                                                                                     |
| ---- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| c1   | 提交无法确认后 Harness 仍继续写这个 Session（对 bundle 中 `writeFailure` 锁存的补丁） | `revision-1`：拒绝撤掉后，同一个 key 不经重启就回答了 `202`                                                |
| c2   | `schedule` 投影的失败被吞掉，journal 在没有投影的情况下提交                           | `projection`：更新把 revision 2 提交到了 journal，而镜像停在 1，并回答 `automation_projection_unavailable` |
| c3   | store 不再把它已持有的命令当作那次提交来应答                                          | `store-transport`：丢失的应答没有被吸收，手动 run 回答了 `503`                                             |
| c4   | 应答无法取得的 claim 立刻被放弃（`MAX_FIRE_ATTEMPTS` 为 1）                           | `revision-2`：第一次失败后 occurrence 就落成 `unknown`，重试拿到的是这个结果，而不是一次重驱               |

## 预算

本地在 JDK 21 + MySQL 8.4.6 上，这个方法测得 62.1 s、72.4 s 和 71.6 s，其中包含三次冷重启。预算约 145 s
（最重一次的 2 倍），在推送时叠加到 `main` 的 fork 预算上：健康总和从 4888 s 调到 5033 s，fork 从
5498 s 调到 5643 s。fork + 600 s = 6243 s 仍在 Verify step 的 105 分钟以内，所以 step 和 job 的上限都不用调整。

## 验收

- `mvn -DskipTests test-compile checkstyle:check` 无报错。
- 三个测试方法在本地 JDK 21 + MySQL 8.4.6 上都通过，且合入前每个见证都已确认变红。
- `scripts/tests/hosted-process-ci.test.js` 通过，fork 预算已叠加。
- 四个用例共用一个 `@Test`，所以第一个红灯只指出一个用例，它之后的用例根本不会运行。请用
  `-Dqwen.fg11b.case=<case>` 逐个重跑。
- 本设计以两种语言发布，结构一致。

## 未决问题

- 公开的 automation 路由是否应当把 writer 冲突回答为可重试的 `503`，就像它回答其他所有结果不明
  的情况那样。见"发现"。
- store 在看到提交之前、每次尝试都发生的传输故障，表现与 `revision-1` 相同：什么都不提交，Session
  被锁存。本切片只覆盖应答丢失这一变体，也就是 store client 自己的重试能吸收的那种。
