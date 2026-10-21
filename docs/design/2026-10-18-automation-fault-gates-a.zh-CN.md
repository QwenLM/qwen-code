# Hosted automation 故障门禁 FG11a：应答丢失

[English](2026-10-18-automation-fault-gates-a.md) | [简体中文](2026-10-18-automation-fault-gates-a.zh-CN.md)

## 问题与范围

Issue #14446 是 #12380 F 阶段的 FG11 轮：为 automation 两个域 `schedule` 和
`automation_run` 补故障门禁。这一轮有六个字母（FG11a–f）。本切片只实现
**FG11a，应答丢失**，不做其他字母。它同时搭起后续字母要复用的打包 automation 栈。

门禁要守的性质：一个 automation 操作已经提交、但应答丢了时，重驱要碰到**同一个身份**，
并回答已经提交的内容。它绝不会再提交一次，绝不会多跑一个模型 Turn，也绝不会记下一个
不真实的 occurrence。

- 定时 fire 的重驱碰到同一个派生出的 `arun_` run。
- 用同一个 Idempotency-Key 重试的手动 run 碰到同一个 run。
- 重试的定义变更回答它自己提交的 revision，绝不会覆盖更新的 revision。
- 丢失的 reconcile 应答让该时隙以它自己的拒绝原因记为 skipped，绝不会是 `unknown`。

共八个用例，在一次启动里跑完：

| 用例                   | 注入                                                                                   | 预期                                                                                                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create-reply`         | 创建（`define_schedule`）已提交后，丢掉 Harness 的 `202`                               | 公开应答为 `503 automation_operation_unknown`。用同一个 key 重试，重驱同一个 operation id，回答 revision 1。只有一次 `defineSchedule` 提交                                            |
| `update-reply`         | 丢掉一次更新的 `202`；随后另一个 key 的更新落地（revision 3）                          | 丢失的那次更新的重试回答它自己的 revision 2。定义停在 revision 3，总共三次 `defineSchedule` 提交                                                                                      |
| `noop-update-reply`    | 丢掉一次什么都没改的更新的 `202`                                                       | 重试回答 revision 1。只提交了创建和这次 no-op 的 replay 标记                                                                                                                          |
| `retire-reply`         | 丢掉一次 retire 的 `202`                                                               | 重试把已提交的 retire 当作它的 replay 作答（`X-Qwen-Idempotent-Replay: true`），不再问 Harness。只有一次 `retireSchedule` 提交。这个每分钟触发的定义在 retire 之后没有任何 occurrence |
| `manual-run-reply`     | 手动 run 的两个 run revision 已提交、Turn 已唤醒后，丢掉 `fire_run` 的 `202`           | `503 automation_operation_unknown`。用同一个 key 重试碰到同一个 run。一条 run 链（`:1`、`:2`、`:3`）、一个被接受的输入、一个 `turn.settled`、一个模型 Turn                            |
| `public-reply`         | Spring 已结清一次创建的回执，它自己发给调用方的 `202` 在路上丢了                       | 重试 replay 该回执（`X-Qwen-Idempotent-Replay: true`）。Harness 只见过这个操作一次                                                                                                    |
| `scheduled-fire-reply` | 扫描器对下一分钟时隙的 fire 已提交，丢掉它的 `202`                                     | 扫描器只重驱这个 occurrence 一次（`attempts` 为 1），并把它落定为 `fired`。每次 fire 都指向同一个 occurrence。一条 run 链、一个被接受的输入、一个 `turn.settled`、一个模型 Turn       |
| `reconcile-reply`      | 一个被挂住的手动 run 让 skip 策略的计数保持占满；丢掉下一个时隙 `reconcile_run` 的应答 | 该时隙以 `overlap` 或 `count_limit` 记为 `skipped`，绝不会是 `unknown`，被挂住的 run 保持 `running`。放开后它正常完成                                                                 |

每个用例结束时，该租户都没有 `unknown` 的 occurrence。

留给 #14446 后续切片：FG11b–f、Harness 侧 Session Store 的应答丢失（FG11b），以及所有
进程 kill（FG11c）。

## 当前状态

- 本切片之前，没有任何打包 lane 开启 automation。
  `qwen.managed-agent.automation.enabled` 默认是 `false`。仅有的 automation 测试都在 H2 上，
  对着 `AutomationHarnessFake` 跑。
- Harness 路由是 `POST /session/{id}/automations/operations`（`hosted-harness-session.ts`）。
  Spring 通过 `QwenHostedHarnessConnector.runAutomationOperation` 调到它，其客户端把丢失的应答
  变成 `MutationOutcomeUnknownException`，自身不重试。
- 扫描器（`AutomationScanner`）对这样的 occurrence 按退避（2 s、4 s、……）延后，最多重驱 64
  次。公开路由回答 `503 automation_operation_unknown`，用同一个 key 重试会重驱已占用的回执。
- 定义操作带着由租户和 Idempotency-Key 派生的 operation id，所以 Harness 的 `mutationReplay`
  会用它提交过的 revision 回答重驱。run 的 id 由 schedule 和 occurrence key 派生，所以重驱的
  fire 会碰到已提交的 run。

## 门禁账本

事实依据来自三处：

- relay 对 Spring 发给 Harness 的每个 automation 操作的记录，包括它的 kind、schedule、
  occurrence，以及回包是否被丢弃。
- Session journal（`ma_session_journal_tx` 的命令，以及从 `record_bytes` 解出的事件 id）。
- Java 镜像（`ma_schedule_occurrence`、`ma_session_record`）。

模型桩记录每一个 prompt，所以多出来的模型 Turn 会表现为第二个指向该 occurrence 的 prompt。

每个用例都先确认注入确实发生：relay 必须显示被丢掉的那次操作（`dropped=true`），而且运行
结束时每条预设的规则都必须已经触发。

## 夹具设计

`HostedAutomationFaultGatesIT` 沿用 `HostedPublicWorkspaceIT` 的启动方式：

- Spring 在测试 JVM 内启动，连真实 MySQL（缺失时失败而不是跳过），并开启 Harness 连接器
  和扫描器（`automation.enabled=true`、`scan-delay=1s`）；
- 一个 Workspace 挂载，在 Linux 上注册；
- 一个真实 Harness，以及一个模型桩：除非 prompt 带有 `FG11A_HOLD`，否则立即作答。

Spring 的 `harness.base-url` 指向一个 `HostedLifecycleRelay`。对匹配的 automation 操作，
relay 先让 Harness 作答，再不带回包地关闭连接，也就是提交之后的连接级丢失。第二个 relay
挡在 Spring 前面，供 `public-reply` 使用，按 Idempotency-Key 丢掉一次 `202`。

每个用例使用自己的 public Workspace Session。Session 先跑一个 Turn（见"发现"）。

三个依赖时钟的用例（`scheduled-fire-reply`、`reconcile-reply`、`retire-reply`）使用每分钟
触发的 cron。它们最先布置、最后落定，从而在其他用例运行期间共用同一个整分钟边界。

- 它们准备期间，`SchedulerHold` 挂住 `managedAutomationScheduler` 唯一的线程。任何时隙都
  不可能在它的故障布置好之前、或被挂住的手动 run 上线之前触发；手动 run 在请求线程上 fire，
  不受影响。挂住期间经过的整分钟边界，在扫描器恢复时仍处在迟到容忍范围内。
- 它们的"恰好一次"检查都限定在被测 occurrence 上：它的 fire、它的 run 的命令、它的输入、
  它的 `turn.settled` 和它的模型 prompt。慢 runner 上其他用例运行期间到期的、同一个每分钟
  定义的后续时隙，是它自己的合法 run。

用 `-Dqwen.fg11a.case=<case>` 可以只跑其中一个用例。

## 发现

- **在从未跑过 Turn 的 Session 上建 automation 会被拒绝。** Turn 和 rename 路径调用
  `createOrLoad` 时用 `loadExisting = session.harnessBootId() != null`。automation 各动作
  走的是 `attachment(…, true)`，永远只 load。没有输入就创建的 Session 从未在 Harness 上
  创建过，于是 load 回答 `404 managed_session_not_found`，建 automation 也就以这个错误码
  失败。夹具让每个 Session 先跑一个 Turn。修连接器还需要像 Turn 路径那样记录 Harness
  boot id，所以不放进这个只含测试的切片，单独报告。

## 变异见证

每个见证都对整个类跑过、确认变红，并逐字节还原。

| 见证 | 变异                                                                   | 最先变红处                                                                                                                                  |
| ---- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| m1   | `ManagedAutomationService.operationIdFor` 改成随机 id，不再由 key 派生 | `create-reply`：重试用第二个 operation id 重驱                                                                                              |
| m2   | `AutomationScanner.MAX_FIRE_ATTEMPTS` 改为 1，丢失的应答立刻被放弃     | 整个类里是 `manual-run-reply`；单跑 `scheduled-fire-reply`（`-Dqwen.fg11a.case=scheduled-fire-reply`）时：时隙落成 `unknown` 而不是 `fired` |
| m3   | 失败的 reconcile 把它的 occurrence 算作已解决                          | `reconcile-reply`：时隙没有落成 `skipped`                                                                                                   |
| m4   | `ManagedAutomationService.replay` 对已有应答的回执也重驱               | `public-reply`：Harness 见到了第二次 `define_schedule`                                                                                      |
| m5   | 手动 run 的 occurrence key 加上随机后缀，重试不再碰到它的 occurrence   | `manual-run-reply`：重试被它自己的第一个 run 挡住，以 `automation_run_skipped`（overlap）拒绝                                               |

另有一个更窄的变异是等价的，不作为见证：把失败的 reconcile 改为抛出，只会推迟这次决策。
单跑 `reconcile-reply` 时它保持绿色，因为一秒后的下一次扫描会再问一次，并记下同样的
`skipped`。

## 预算

本地在 JDK 21 + MySQL 8.4.6 上，这个类测得 46.3 s、85.0 s、57.1 s 和 67.0 s。差异主要来自等待
下一个整分钟边界。预算约 170 s（最重一次的 2 倍）。共享 fork 的健康总和与超时都按这个量
调整，在推送时叠加到 `main` 当时的数值上。叠加在 #14533 之后的 `main` 上，fork 达到
5218 s，所以 Verify step 从 95 分钟调到 100 分钟（fork + 600 s = 5818 s），job 上限从 190 调到 195。

## 验收

- `mvn -DskipTests test-compile checkstyle:check` 无报错。
- 这个类在本地 JDK 21 + MySQL 8.4.6 上通过，且合入前每个变异见证都已确认变红。
- `scripts/tests/hosted-process-ci.test.js` 通过：该类已加入钉住的列表，fork 预算已叠加。
- 八个用例共用一个 `@Test`，所以第一个红灯只指出一个用例，它之后的用例根本不会运行。要按用例
  解读红灯：用 `-Dqwen.fg11a.case=<case>` 逐个重跑，而不是把其他用例当作已通过。
- 本设计以两种语言发布，结构一致。

## 未决问题

- FG11c 要 kill Spring，扫描器及其 lease 都在 Spring 里，所以它需要像 `HostedProcessCrashIT`
  那样的子 JVM 夹具，而不是本类这种测试 JVM 内的 Spring。
- FG11b 在 Harness 侧注入 store 故障时，能否原样复用这个 relay，还是需要 FG9/FG10 relay
  门禁那种挡在 store 前面的代理。
