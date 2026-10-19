# Hosted automation 故障门禁 FG11c，第 2 片：Spring 崩溃与 scanner 租约

[English](2026-10-19-automation-fault-gates-c2.md) | [简体中文](2026-10-19-automation-fault-gates-c2.zh-CN.md)

## 问题与范围

Issue #14446 是 #12380 的 Stage F 第 FG11 轮，覆盖自动化域 `schedule` 与
`automation_run`。第 1 片（已由 #14601 合入）门控 Harness 进程崩溃：在一个 run
的三个 revision 上各 SIGKILL 一次，跑在打包栈上。本片覆盖住在 Spring 里的格——
scanner 及其租约所在处：

| 用例                           | 注入                                                                                                          | 期望                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `spring-kill-before-answer`    | occurrence 行已记 `firing`，Harness 的 fire 应答被测试代理停住；SIGKILL Spring 子进程后重启                   | 重新驱动的 fire 命中同一个派生的 `arun_` id。一条 run 链、一个被接受的 input、一次模型 Turn；occurrence 恰好 `fired` 一次 |
| `spring-kill-before-watermark` | 应答已落（revision 2 已提交），测试持住 schedule 行使 watermark 写入阻塞；SIGKILL Spring 子进程后释放锁并重启 | 同一 slot 不出现第二次 fire；watermark 追上，一条 run 链、一次模型 Turn                                                   |
| `two-scanner-race`             | 两个 Spring 子进程共用一台 MySQL 与同一个 tenant，租约设短，只有一个到期 slot                                 | 恰好一个子进程认领该 slot；输者不写 occurrence、不写 run、不推进 watermark，账本只有一条链                                |
| `parked-tool-harness-kill`     | wake turn 停在 Runtime 工具调用上时 SIGKILL Harness 子进程                                                    | run 恰好结算一次为 `failed`/`outcome_unknown`，挂起的执行被取消、Workspace 租约释放、input 被消费；工具不重放             |

live-run reconcile 格（存活 turn 经 overlap-`skip` slot 驱动 `reconcile_run`，run
保持 `running`）已由 #14480 的路由测试钉住，本片不重复。

## 门控的性质

每个 occurrence 至多一条 run、一次模型 Turn。fire 中途死掉的 Spring 在重启后
不得产生第二条 run；丢了租约的 scanner 不得推进 watermark 或账本。wake turn 已
结算的 run 必须按 journal 的 `turn.settled` 结算，绝不写成
`failed`/`outcome_unknown`，即使结算进程在写 revision 3 之前就死了。

## 夹具

本片需要的 Spring 子进程夹具在 FG7c 已有现成先例：
`HostedChannelCrashFixtureMain` 在子 JVM 里启动应用，用 `ready.json` 公布内部
与控制面地址；`HostedChannelProcessCrashIT` 用 `destroyForcibly()` 杀进程，并在
同一端口起新一代。

本片沿用该形态，增加一份 automation 夹具主类，并补三处：

- **打开 automation。** `--qwen.managed-agent.automation.enabled=true`，`scan-delay`、
  `lease`、`late-tolerance` 按测试尺度调小；scanner 是 `AutomationScanner`，
  调度在 `managedAutomationScheduler` 上。
- **Harness 代理。** 夹具的 `FG7C_HARNESS_URL` 指向测试自持的 HTTP 代理，代理再
  转发给真实打包 Harness。代理只停住被 arm 的 `POST
/session/:id/automations/operations`，其余照常转发。这是把
  「`firing` 之后、应答之前」窗口做成确定性的手段，而不是靠轮询撞时机。
- **watermark 锁。** `spring-kill-before-watermark` 由测试在自己的连接上对
  schedule 行持 `SELECT ... FOR UPDATE`，使 scanner 在应答提交之后的 watermark
  写入阻塞；在这个窗口里杀进程，事后再释放锁。
- **两个子进程。** `two-scanner-race` 起两个夹具 JVM，共用同一 MySQL 与 tenant，
  各自内部端口与 `ready.json`，并指向同一个 Harness。

## 账本

事实来源是 Session journal、run 记录（`ma_session_record.task_state`）、
`ma_schedule_occurrence` 与 `ma_schedule`（watermark 与 lease），外加模型桩收到的
prompt 和代理的请求日志。代理记录它见到的每一次 fire，所以即使两次都被应答，
第二次 fire 也看得见。

## 变异见证

每个见证单独对各自的用例运行，并逐字节恢复。

| 见证 | 变异                                                     | 预期变红处                                                         |
| ---- | -------------------------------------------------------- | ------------------------------------------------------------------ |
| s1   | scanner 不先认领 occurrence 就 fire                      | `spring-kill-before-answer`：重新驱动的那条链旁边出现第二条 run 链 |
| s2   | watermark 更新去掉租约 fence 谓词                        | `two-scanner-race`：输掉的子进程推进了 watermark                   |
| s3   | 结算先读投影的 turn 结果、后读 journal 的 `turn.settled` | `parked-tool-harness-kill`：turn 已结算，run 却记成 `failed`       |

## 预算

四个用例同属一个类，共用一个 Harness（parked-tool 用例会杀掉并重启它）与最多两个 Spring 子进程。合入前把实测
耗时记在此处，并由与第 1 片相同的元测试叠加进 `hostedForkHealthySeconds` 以及打包
lane 的 Verify 与 job 上限。用例未在验收机上实测之前，不把任何预算数字写成断言。

## 验收

- `mvn -Pmysql-integration -DskipTests test-compile checkstyle:check` 干净，
  且本树上 `checkstyle:check@runtime-broker-checkstyle` 也干净。
- 四个用例在 JDK 21 + 真实 MySQL 上全绿，每个用
  `-Dqwen.fg11c2.case=<case>` 单独选择；整类全绿。
- 每个见证都在表中位置变红，并逐字节恢复。
- `scripts/tests/hosted-process-ci.test.js` 在预算叠加后全绿。
- 本设计以中英双语交付，结构一致。

## 待定问题

- 崩溃的 scanner 是否应在启动时 reconcile 而不是等下一个到期 slot，是 #14116 的
  范围，不在本片。
- 输掉的 scanner 应当立即观察到赢家的认领，还是只在下一次 tick 观察到，维持今天
  的行为；门禁只钉「它什么都没推进」，不钉它观察到的时点。
