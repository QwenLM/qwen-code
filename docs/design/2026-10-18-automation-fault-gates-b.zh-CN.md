# Hosted automation 故障门禁 FG11b 第 1 片：Spring 侧存储故障

[English](2026-10-18-automation-fault-gates-b.md) | [简体中文](2026-10-18-automation-fault-gates-b.zh-CN.md)

## 问题与范围

Issue #14446 是 #12380 F 阶段的 FG11 轮：为 automation 两个域 `schedule` 和
`automation_run` 补故障门禁。FG11a（#14534）覆盖了应答丢失，并搭起了打包的 automation
栈。本切片实现 **FG11b（存储故障）的 Spring 侧一半**，并加上 tracker 关于 FG11b 的讨论
中要求的 revision 竞态用例。

门禁要守的性质：存储故障绝不会让一个时隙 fire 两次，绝不会记下一个不真实的时隙，也绝不会
把一个时隙落成 `skipped`。只有终局性的拒绝，或者已过期、已 retire、已不存在的定义，才可以
这样做。

共六个用例，在一次启动里跑完：

| 用例                | 注入                                                                       | 预期                                                                                                                                                                                                                          |
| ------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `occurrence-insert` | MySQL 拒绝扫描器为下一个时隙写记录（`ma_schedule_occurrence` 的 insert）   | 记录被拒期间什么都不 fire，也不存在任何行；每次拒绝都针对同一个时隙。拒绝撤掉后，正是这个时隙（仍未超出迟到容忍）被记录并只 fire 一次（`attempts` 为 0）：一条 run 链、一个模型 Turn。如果是后面某一分钟顶替它 fire，用例失败 |
| `occurrence-settle` | fire 已在 Harness 上提交，把它的 occurrence 落成 `fired` 被拒绝            | occurrence 保持 `firing`，按退避重驱。每次重驱指向同一个 occurrence。拒绝撤掉后落成 `fired`：一条 run 链、一个被接受的输入、一个模型 Turn                                                                                     |
| `watermark`         | 时隙已 fire 并落定，之后推进 watermark 被拒绝                              | 之后每个 tick 都重新推导出同一个时隙，而它已记录的决策保持不变：一个 occurrence、一次 fire。拒绝撤掉后 watermark 推进                                                                                                         |
| `receipt-claim`     | MySQL 拒绝创建请求的回执                                                   | 返回服务端错误，而不是调用方不会重试的拒绝。什么都没到达 Harness。拒绝撤掉后，重试只创建一次定义                                                                                                                              |
| `receipt-settle`    | Harness 已提交创建，Spring 结清回执被拒绝                                  | 返回服务端错误。重试发现回执已占用但未作答，用同一个 operation id 重驱，回答 revision 1，只有一次 `defineSchedule` 提交                                                                                                       |
| `revision-race`     | 扫描器对 revision 1 的 fire 被挂在 relay 上，期间一次更新提交了 revision 2 | Harness 回答 `409 automation_revision_stale`。扫描器重新钉住 occurrence，用 revision 2 再 fire，落成 `fired`。一条 run 链，它唯一的模型 Turn 带着 revision 2 的 prompt                                                        |

每个用例结束时，该租户都没有 `skipped` 或 `unknown` 的 occurrence。

Harness 侧的存储故障属于 FG11b 第二片：

- 拒绝一个 run 的 revision 1 或 revision 2；
- 拒绝 `schedule` projection，让它随 journal 一起回滚；
- 让 Harness 的 store 传输失败。

这些会让 Harness 上的 Session 停止写入，所以这些用例需要重启 Harness。见
[第 2 片的设计](2026-10-18-automation-fault-gates-b2.zh-CN.md)。

## 当前状态

- 扫描器在询问 Harness 之前，先把 occurrence 记为 `firing`（`AutomationScanner.decide`）。
  所以被拒绝的 insert 会在任何 fire 之前抛出；该定义的扫描记录这次失败，并释放它的 lease。
- settle 抛出的 fire 会像丢失的应答一样被延后（`AutomationScanner.defer`）：`attempts` 加 1，
  然后按 2 s、4 s 等退避。重驱（`redrive`）再次 fire 已存储的 occurrence，Harness 回答已提交的
  run。
- watermark 推进在一个 tick 的所有时隙之后执行。它抛出时，下一个 tick 从旧的 watermark 开始，
  `decide` 会发现这个时隙的决策已经记录过了。
- 创建、更新和 retire 在转发前先占用一条请求回执（`ManagedAutomationService`），拿到应答后再
  结清。重试会 replay 已结清的回执；对已占用但未作答的回执，则用由 key 派生的 operation id
  重驱。
- 碰到更新定义的 fire 会回答 `409 automation_revision_stale`。扫描器重新读取定义、重新钉住
  occurrence 并再 fire 一次（`AutomationScanner.fire`）。#14446 的讨论通过静态阅读发现，在同一
  个 Harness 内 define 和 fire 不可能竞态成 `automation_operation_conflict`，因为两者都经过同一
  个串行队列。这个用例就是 tracker 要求的分类见证。

## 门禁账本

事实依据来自 relay 的操作日志、Session journal、Java 镜像（`ma_schedule_occurrence`、
`ma_schedule`、`ma_request_receipt`）以及模型桩的 prompt。

每个拒绝都是一个按本租户隔离的 MySQL `BEFORE` trigger。和 FG9b、FG10c 一样，它会拒绝所有
匹配的写入，直到被删除。它先往一张 MyISAM 表写一行（不会随回滚消失），所以用例可以在删除
trigger 之前数出拒绝次数。这一行还记录被拒绝的是什么（occurrence key 或 watermark 时隙），所以
`occurrence-insert` 和 `occurrence-settle` 会检查它们恢复的时隙正是被拒绝的那个。

模型 Turn 的检查同时按 prompt 里的 `Automation ID` 和 `Occurrence` 匹配，因为四个依赖时钟的
定义共用同一个时隙 key。

## 夹具设计

这些用例在 `HostedAutomationFaultGatesIT` 的第二个测试方法
`fg11bStoreFaultsNeverFireTwiceOnMySql` 里运行，复用 FG11a 的启动方式。字母决定租户
（`fg11-b-…`）、用例选择器（`-Dqwen.fg11b.case=…`）和证据目录（`target/fg11-cases/fg11b/`）。

- 四个依赖时钟的用例像 FG11a 那样，在 `SchedulerHold` 挂住扫描器期间完成准备，所以每个拒绝或
  挂住都在整分钟边界之前就位。
- relay 新增一种挂住规则，把匹配的操作停在到达 Harness 之前。`revision-race` 在 fire 被挂住的
  那一刻由后台任务提交更新，然后放开它。被挂住超过连接器 30 s 请求超时的 fire 会被单独重驱。
  早先一版在 settle 阶段才发更新，正好暴露了这一点：被挂住的请求还在等待时，重驱已经用
  revision 1 fire 了出去。
- teardown 会放开所有挂住，然后逐个删除 trigger（一个删除失败不会让其他 trigger 留下），再删除
  拒绝计数表，所以不会有东西泄漏到共享 fork schema 上之后运行的类里。

## 变异见证

每个见证都只针对它自己的用例单独跑过，并逐字节还原。

| 见证 | 变异                                                     | 变红处                                                                   |
| ---- | -------------------------------------------------------- | ------------------------------------------------------------------------ |
| b1   | 被拒的记录被吞掉，决策照样 fire                          | `occurrence-insert`：记录被拒期间，有一次 fire 到达了 Harness            |
| b2   | 每次重驱都用一个新的 occurrence key，而不是已占用的那个  | `occurrence-settle`：在仍为 `firing` 的那一行旁边多出了第二行 occurrence |
| b3   | 已记录的决策和它的 outcome 都挡不住之后的 tick 再次 fire | `watermark`：之后的 tick 又 fire 了这个时隙                              |
| b4   | 被拒的回执占用被吞掉，创建照样转发                       | `receipt-claim`：创建在没有回执的情况下到达了 Harness                    |
| b5   | 重驱新生成一个 operation id，而不是用 key 派生的那个     | `receipt-settle`：重试的 define 带着第二个 operation id                  |
| b6   | 过期的应答从不重新读取、重新钉住                         | `revision-race`：时隙落成了 `skipped`（`revision_stale`）                |

另有一个更窄的变异是等价的，不作为见证。只去掉对已记录决策的查找（b3a）时，`watermark` 保持
绿色：occurrence 的 insert 在主键下保留第一次的决策（`INSERT IGNORE`），而已记录的 `fired`
outcome 会挡住这次 fire。b3 同时去掉了这两层。

## 预算

本地在 JDK 21 + MySQL 8.4.6 上，`fg11bStoreFaultsNeverFireTwiceOnMySql` 测得 30.8 s、64.5 s 和 64.1 s。
差异主要来自等待下一个整分钟边界。预算约 130 s（最重一次的 2 倍），在推送时叠加到
`main` 的 fork 预算上。叠加在 #14541 之后的 `main` 上，健康总和从 4758 s 调到 4888 s，fork 从
5368 s 调到 5498 s。fork + 600 s = 6098 s 超出了 Verify step 的 100 分钟，所以该 step 调到 105 分钟，
job 上限从 195 调到 200（各 step 合计 185，加上未设上限的准备步骤 13，再加 2）。

## 验收

- `mvn -DskipTests test-compile checkstyle:check` 无报错。
- 两个测试方法在本地 JDK 21 + MySQL 8.4.6 上都通过，且合入前每个见证都已确认变红。
- `scripts/tests/hosted-process-ci.test.js` 通过，fork 预算已叠加。
- 六个用例共用一个 `@Test`，所以第一个红灯只指出一个用例，它之后的用例根本不会运行。请用
  `-Dqwen.fg11b.case=<case>` 逐个重跑。
- 本设计以两种语言发布，结构一致。

## 未决问题

- 第二片的 Harness 侧故障会让 Session 停止写入。每一个都需要重启，它的预期要在重新加载的 Session
  上验证。[第 2 片](2026-10-18-automation-fault-gates-b2.zh-CN.md) 回答了这个问题：公开应答是可重试的
  `503 automation_operation_unknown`，重新加载的 Session 只完成一次该操作。
- `revision-race` 是否也应覆盖被挂住超过请求超时的 fire。那种交错会在原请求仍在路上时，用旧
  revision 重驱。本切片只记录它的存在。
