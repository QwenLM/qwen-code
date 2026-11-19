# Monitor run 故障门禁 FG8c

[English](2026-10-16-monitor-run-fault-gates-c.md) | [简体中文](2026-10-16-monitor-run-fault-gates-c.zh-CN.md)

## 问题与范围

Issue #14163 跟踪 FG8 为 `monitor_run` 与 `child_run` 的 `shell` kind
补的故障门禁。FG8e/FG8f 已由 #14120 合入（轮次设计
`docs/design/2026-10-13-monitor-run-fault-gates.md`），FG8a/FG8b/FG8d 已由
#14334 合入（`docs/design/2026-10-15-monitor-run-fault-gates-abd.md`）。本文是最后
一个字母 **FG8c —— 进程崩溃** 的设计：在一个存活的后台 run 之下，真实地杀掉
（或停住）Harness、managed worker 以及后台进程本身，并用 JDBC 地面真值钉住平台
接下来的行为。

FG8c 曾排在 #13986（让 held-Runtime 的 drain 义务重启可证）之后，因为后者改写
了本字母要钉住的重启行为。#13986 已作为 `c24e99e9cb` 合入，本字母针对合入后的
实现编写。

rig 沿用 #14120 与 #14334：一个 IT 类（`HostedMonitorRunFaultGatesIT`）、一个
probe（`HostedMonitorRunProbe`）、一个按用例运行的 TypeScript driver
（`integration-tests/helpers/hosted-monitor-run-fault-driver.ts`）、真实的打包
Harness、带内嵌 broker 的进程内 Spring、真实的 MySQL/MariaDB，以及每个用例一个
命名的变异见证。与前几片不同，本片带 **一处生产修复**：门禁发现 cgroup launcher
把一个被 SIGKILL 的后台进程报告成了退出码为 1 的正常退出（见「发现：信号死亡被读
成 exit 1」）。

## 现状（已核实）

在 `main` = `b4614845f0`（其中包含以 `5af87595f3` 合入的 #14334，以及 #14303 对
never-started 探测的并发化）上阅读，并在真实车道（Linux、cgroup v2、MySQL 8.4.6、
JDK 21、打包 CLI）上逐个用例确认：

- **拓扑。** 内嵌 broker 为每个 Harness Session 的 binding 拉起一个 managed
  worker，它是 Spring JVM 的直接子进程（`node dist/cli.js
managed-runtime-worker`）。worker 通过 cgroup v2 单元（`qwen-bg-<callId>` /
  `qwen-mon-<callId>`）监管每个后台 run：worker → launcher → shell → 命令。没有
  任何东西会让替补 worker 重新附着到正在运行的单元；且在
  `durable-local-process=false` 下 provisioner 从不产出 stopped-writer 证据，所以
  一个丢失的 binding 永远不会被释放。
- **Harness 重启。** Harness 只能通过 worker 推送到其进程内 publisher 的数据来
  观测后台 run，没有跨启动的重新附着。因此重新加载永远不会重新认识一个 run。
  #13986 恢复的是义务：加载时 Harness 把 Session 存活的 hold 行
  （`POST /tool-sessions:active-holds`）读进它的持有集合，close 再以
  `{ drain: true }` 逐个 drain
  （`packages/cli/src/serve/hosted-harness-session.ts:5849-5867`、
  `:9971-10013`）。
- **冷加载拒绝。** 启动轮次从未结算的重新加载会在 `unsettled_input` 门处被拒，
  答 409 `hosted_turn_recovery_required`，reason 为 `turn_unsettled`
  （`hosted-harness-session.ts:5750-5776`）。never-started reconcile 只读取
  `:process` 行，并把 broker 仍持有的任何行——这里是 PREPARED 的行——当作含糊而
  跳过（`hosted-never-started-reconcile.ts:76-90`）。
- **worker 死亡。** broker 惰性地发现它（`isUsable` 即 `process.isAlive()`）。
  对死 worker 的 release 被分流到 `releaseUnusableSession`
  （`RuntimeBrokerService.java:2889-2894`），后者把 binding 置为 LOST 且没有停止
  证据，并答 503 `runtime_reconciliation_required`（`:3015-3019`）；Harness 的
  close 容忍这个回答，把 drain 记为未证明，并让 Session 退役
  （`hosted-harness-session.ts:9996-10013`）。后台进程作为孤儿活过 worker。
- **generation。** 丢失之后，第一次 warm 答 503 `runtime_provision_failed`；下一
  次答 503 `runtime_broker_runtime_lost`（`RuntimeBrokerService.java:3864-3886`），
  此前 reclaim 的清理已以 `<bindingId>:1:journal-lost` 放弃了该 generation 未结算
  的行（`:3888-3993`）。slot 仍把
  LOST 的 binding 视为活跃，所以不会铸出 generation 2：释放一个 LOST binding 需要
  丢失 **且** 停止的证据（`RuntimeBindingRecord.java:202-204`）。
- **worker 被停住。** 被停住的 worker 对 broker 而言仍然存活。release sweep 的
  status 读会撞上 broker 对 worker 请求的 30 s 上限，失败被吞掉
  （`RuntimeBrokerService.java:2769`），例行 release 仍答 409
  `runtime_session_held`（`:2923-2953`）。没有任何东西把 Runtime 标为丢失；
  `SIGCONT` 之后 run 继续运行，并由自己的证据结算。
- **Monitor 自动停止。** idle 或配额停止会通过 broker 的 `monitor-stop` 去问
  worker（`hosted-monitor-remote-executor.ts:50-66`）；除退出证据之外的任何结果
  都会让记录 park（`hosted-monitor-loop.ts:459-472`），成为 `recovery_blocked` /
  `runtime_lost` / `outcome_unknown`（`hosted-monitor-session.ts:298-308`）。

## 范围决策

1. **门禁钉住物理、账本与记录层面的真相，而不是分支逻辑**，与 #14334 的范围决策
   2 一致。每条断言都读取 JDBC（`ma_tool_execution`、`ma_runtime_binding`、
   `ma_runtime_slot`、`ma_runtime_session`、`ma_session_record` 的记录体、
   session journal、输出资源），或 driver 的物理证据（发出的信号、pid 存活或消
   失、按声明错误码记录的 broker 回答）。
2. **不杀 Spring**（轮次设计决策 3）。FG8c 杀的是 Harness、worker 与后台进程；
   控制面保持在线，因此进程内 Spring 与它的 probe 全程持续提供地面真值。
3. **用例跟随代码，而不是原计划的表。** 轮次设计里的 FG8c 表早于 #13986 及合入
   后的恢复实现。其中两条期望并不成立，门禁钉住的是实际成立的部分：
   - 启动轮次已结算后的重新加载 **不会** 被拒——它加载成功（200）、恢复被持有的
     Runtime，而它的 close 会 drain 那个它从未见过的 run；
   - 未结算的 `child_run` 不会进入阻塞状态——记录停留在 `running`（只有 monitor
     会 park，而且只能经由它自己的进程内 loop）。门禁钉住的是：记录永远不会在无人
     产出的证据上结算，而账本说的是真话。
4. **第七个用例 `monitor-worker-kill`。** 原计划的表里没有 monitor 用例。worker
   已死的 watch 正是 #13896 规则在真实故障下的情形——idle 停止的 `monitor-stop`
   碰到的是拒绝，而不是 FG8a `monitor-stop-reply` 里的丢失应答——因此在这里设门。
5. **一处生产修复，而不是测试绕行。** 在旧 launcher 上 `process-kill` 无法诚实
   地通过（见下文发现）；修复很小，落在两个使用方都已预期的证据路径上，并在同一
   PR 中附带单元测试。
6. **观察到但不断言：孤儿进程。** worker 死后，在这种拓扑下后台进程会活过 worker
   与 Session 的 close；它归 Workspace 级联所有（#13986 R2-1）。断言这个孤儿等于
   钉住一个泄漏；门禁只在清理阶段杀掉它。

## 发现：信号死亡被读成 exit 1

worker 对一个后台 run 的退出证据，是 cgroup launcher 自身的退出；而 launcher 的
退出处理以 `process.exit(code ?? 1)` 结束
（`packages/core/src/hooks/hook-command-cgroup.ts`）。被信号杀死的命令其
code 为 null，于是 launcher 以 1 退出：在车道上，一个被 SIGKILL 的后台进程把
`child_run` 记录结算成了 `exited`，带 `exitCode: 1, exitSignal: null`，
`:process` 行也带着同样的证据。状态 1 是这个进程从未返回过的值。

修复让 launcher 对自身重新发出命令的信号，使其等待方看到同一个信号。只有无法重
新发出的信号保留原来的兜底：会产生 core dump 的信号会让 launcher 也 dump，Node.js
自己占用 SIGUSR1 并忽略 SIGPIPE。hook runner 读取的是同一个 launcher，并且早已把
null 退出码当作「被信号杀死」（`hookRunner.ts`）——而只要被杀的仅是命令本身，旧
launcher 就让这个分支无法到达。单元测试（SIGKILL、SIGTERM、SIGUSR2）钉住这一行为，
在旧 launcher 上变红。

修复覆盖的是作为 launcher 直接子进程的被杀进程，这正是后台 Shell 所运行的：
`bash -c` 会 exec 一条简单命令。复合命令会让 bash 留在中间，此时 bash 对被信号杀死
的子进程给出的自身状态（128 + N）就是 launcher 所运行进程的诚实证据。

## 门禁账本

每个用例运行一个 Session（每用例独立的 workspace mount 与 storage），以及一个由
轮次启动的后台 run，该轮次的第一次模型调用就是工具调用，并使用 10 s 的 writer 租
约：重新加载不用等一分钟就能越过被杀 writer 的租约；崩溃或已关闭的 Session 留下的
OPEN capture 会在几秒内过期——夹具租户只容许四个活跃 capture，在 60 s 租约下连续
七个用例会在第七个用例时将其耗尽；而在租约一半时到期的续约，在高负载车道上仍有
5 s 的余量。所有用例共有的断言：发出的
信号就是该用例的故障（故障确实发生）；在所有启动、重新加载与后续 prompt 中，broker
恰好只应答过一次 `:start`，且恰好存在一个 `:process` 行（没有重复派发）；Session
恰好持有一个 binding，generation 为 1，其 slot 的 `last_generation` 为 1 且该
binding 处于活跃（任何用例中都没有重铸）。

| 用例                    | 注入                                                                                                   | 期望（JDBC / 证据）                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness-kill-dispatch` | 在 broker 代理处扣住已提交的 `:start` 应答（进程已在运行），SIGKILL Harness，在新 Harness 上重新加载   | 重新加载答 409 `hosted_turn_recovery_required` / `turn_unsettled`；它的 broker 流量只有读操作（never-started probe 的 `status` 读），且不再询问模型；run 保持存活且结局未知——记录为 `running` / `dispatch_started`，`stopReason` 为 null，`:process` 行为 PREPARED，journal 中没有 `turn.settled` 事件                                                                                                           |
| `harness-kill-capture`  | 启动轮次结算且至少 3 个完整段提交之后，SIGKILL Harness；重新加载；close                                | 重新加载时已有 ≥ 3 个完整段，重新加载答 200，唯一的 broker 调用是 `active-holds`；close 恰好发出一次 release，`drain: true`，指名启动轮次的 Runtime Session，答 200；正是这次 drain 结束了进程（重新加载后仍存活，close 后消失）；`:process` 行由停止的证据结算（`error`、信号，绝不是 `success`），Runtime Session 为 RELEASED；记录保持 `running`；持久前缀逐字节相同，被杀 writer 被 fence 之后没有任何段落盘 |
| `worker-kill`           | 在存活 run 下 SIGKILL 该用例的 worker；close                                                           | close 的 drain 答 503 `runtime_reconciliation_required`，close 仍答 204；binding 为 LOST 且没有停止证据，`:process` 行保持 PREPARED，Runtime Session 没有被释放；记录保持 `running`，`stopReason` 为 null                                                                                                                                                                                                        |
| `worker-stop`           | SIGSTOP worker；driver 发出的例行 release 等满 broker 对 worker 的 30 s 上限；SIGCONT；打开 run 的闸门 | release 在 ≥ 25 s 后答 409 `runtime_session_held`；停住期间记录为 `running`、`:process` 行为 PREPARED、binding 为 READY；恢复后 run 由自身证据结算——记录 `exited`、exit 0；`:process` 行 SETTLED `success`、exit 0；binding 保持 READY                                                                                                                                                                           |
| `process-kill`          | SIGKILL 后台进程本身（pid 由 producer 写出）                                                           | 记录结算为 `exited`，`exitSignal: SIGKILL`，`exitCode` 为 null，`stopRequested` 为 false；`:process` 行为 SETTLED `error`，带同样的证据；binding 保持 READY                                                                                                                                                                                                                                                      |
| `generation-remint`     | SIGKILL worker；之后两个 prompt 各自要求一次前台 Shell；close                                          | 第一个 prompt 的 warm 答 503 `runtime_provision_failed`，第二个答 503 `runtime_broker_runtime_lost`（各自是该 prompt 唯一的拒绝）；不存在其他执行行（丢失的 generation 上什么都没跑）；binding 为 LOST，有丢失证据而无停止证据；`:process` 行以 `<bindingId>:1:journal-lost` 被 ABANDONED 且没有结果；close 的 drain 答 503 `runtime_reconciliation_required`；记录保持 `running`                                |
| `monitor-worker-kill`   | 一个 idle 窗口为 60 s 的 watch 产出一次观测后沉默；SIGKILL worker；idle 停止触发；close                | 每个 `monitor-stop` 的回答都是拒绝（≥ 400）；记录 park 为 `recovery_blocked` / `runtime_lost` / `outcome_unknown`，`stopReason` 为 null，且 `notifiedThrough == observationSequence ≥ 1`；binding 为 LOST 且没有停止证据，`:process` 行为 PREPARED；close 的 drain 答 503 `runtime_reconciliation_required`                                                                                                      |

## 夹具设计

**Probe。** 在 `state` 与 `ledger` 之外新增两个只读阶段：`workers` 返回 JVM 中带
`managed-runtime-worker` 参数的存活子进程（进程内 broker 以直接子进程的方式拉起
worker）；`runtime` 返回该 Session 的 binding（隔离粒度是 Harness Session）、它们
的 slot 与 Runtime Session，以及其执行行完整的丢失字段。driver 在用例第一次派发
前后对 `workers` 做差集，以确定它要发信号的那一个 worker。

**Driver。** 一个 `runCrashCase` 服务整个字母。broker 代理新增一份应答日志（操
作、状态、声明的拒绝码、control kind，以及 release 的 Runtime Session 与臂），以
及一个臂 `holdCommittedStart`：扣住 broker 已提交的 `:start` 的应答，并在 Harness
被杀之后销毁它。create 与 `/load` 共用同一个 Session 请求体，因此重新加载带上的是
新 Harness 的 writer 身份；崩溃用例的 Session 直连 store，因此在上传中途被杀的
Harness 不会让 store 代理留下一个被中止的请求（broker 代理也把请求中途离开的客户
端视为没有请求）。重新加载会对 writer 冲突重试，直到被杀 writer 的租约过期——它最
后一次续约可能恰好在 kill 之后才提交——段计数则在重新加载之后才取，那时死去的
writer 已被 fence，它在途的提交要么已落盘、要么已被拒。模型可以用一次前台 Shell 回答崩溃后的 prompt
（`foregroundNext`），且只有 `monitor-worker-kill` 的 watch 使用 60 s 的 idle 窗口：
窗口从 watch 最后一次 flush——这里就是它唯一的那次观测——开始计时，而在高负载的
车道上，从那时到 kill 之间过去了约 25 s（10 s 的窗口先到期，停止碰到的是存活的
worker），因此该用例会断言 kill 时 watch 仍为 `running`。
worker 按 pid 发信号；后台进程按其 producer 写出的 pid；Harness 按其子进程句柄。
除了重新加载前等 writer 租约过期以及冲突重试之间的间隔之外，每次等待都是等一个
状态，而不是 sleep。清理阶段会恢复被停住的 worker，并杀掉孤儿后台进程。`FG8_CRASH_STATE` 行
记录 JDBC 快照；`FG8_PROCESS_CRASH_OK` 是本字母的终态标记。

**IT。** `fg8cProcessCrashesNeverDuplicateOrFabricateOnMySql` 通过 `runLetter`
运行这七个用例（`@Timeout(600)`，选择器 `-Dqwen.fg8c.case`），`assertCrashCase`
持有账本中的全部断言，并读取 session journal 做终态事件检查。

**走索引的地面真值读取。** `ma_resource` 以 Session 的 `session_scope_key` 为键，
并存放 inline capture 字节；probe 的 `state` 读取以及 IT 的 `extensionRecord` /
`loadOutputRows` 只按未建索引的 `tenant_id` / `session_id` 列过滤它，于是每次轮询
都会扫描车道迄今写入的全部 inline capture 字节。在一次车道运行内这些数据只增不减
（FG8f 每个用例 inline 数十 MiB），每个靠后的字母轮询得都更慢：在本地一张 664 MB
的表上，一个用例的「run live」等待花了 12–15 s 而不是约 2 s，足以把时序敏感的等待
推出其上限。现在这些读取以 `session_scope_key`
（`ManagedSessionStore.sessionScopeKey`）开头，并保留 tenant 与 session 条件：记录
体的读取从全表扫描变为走 `uq_ma_resource_id` 唯一索引，资源列表变为走以
`session_scope_key` 开头的索引；`ma_session_record` 的读取为保持一致也以同一个键
开头。

## 变异检查

每一个都经过施加、证明让其用例变红、再还原（备份拷贝式变异；TypeScript 的变异
打进打包产物，让门禁运行的就是被变异的二进制）：

1. `harness-kill-dispatch` —— 跳过冷加载的 `unsettled_input` 拒绝：在重新加载的
   状态处变红（期望 409，实际 200）。
2. `harness-kill-capture` —— 去掉 #13986 的恢复（active-holds 的回答从不回填持有
   集合）：在 close 的 release 处变红（期望一次，实际零次）。
3. `worker-kill` —— 对死 worker 的 release 不再拒绝，而是走存活 worker 的路径：
   drain 失败，close 也随之失败（期望 204，实际 503）。
4. `worker-stop` —— release sweep 把失败的 status 读成 Runtime 丢失：在「被停住
   的 worker 不是丢失的 Runtime」处变红（期望 READY，实际 LOST）。
5. `process-kill` —— 还原 launcher 修复：在「kill 就是证据」处变红（期望
   `SIGKILL`，实际为 null 且 exit 1）。
6. `generation-remint` —— 仅凭丢失证据就释放 LOST binding：broker 去重铸，第二个
   prompt 的 warm 答 409 `workspace_unavailable` 而不是
   `runtime_broker_runtime_lost`。
7. `monitor-worker-kill` —— 远端 terminate 不问 worker 就回答「已证明停止」
   （#13929 去掉的那一类捷径）：watch 停留在 `running` 且无人再观测它，用例在等
   待 park 处变红。

## CI 接线与预算

本字母在 `hosted-harness-mysql` 车道运行，无需改 workflow：该类本就属于这条车道，
车道已经为后台 run 委托了所需的 cgroup v2 根，`check-failsafe-reports.js hosted`
也已要求该类必须产出报告。在全新的 MySQL 8.4.6 上，本地七个用例共耗时 144 s（其
中 `monitor-worker-kill` 约 65 s 用于等满它的 idle 窗口，`worker-stop` 约 30 s 用于
等满 broker 对 worker 的上限）。按 FG9 的惯例，这次新增按本地实测的两倍把
`hostedForkHealthySeconds` 从 2640 调到 2930；`@Timeout(600)` 的上限让单上限关系
（600 + 2930 ≤ 3600）保持在 3600 s 的 fork 之内，并由本分支上的一次车道运行来确
认。

## 验证与验收

- launcher 单元测试为绿，其中的信号用例在旧 launcher 上为红；core 的 hook 与 supervisor 套件
  为绿。
- 本字母在本地 Linux 车道（已委托 cgroup v2 根、MySQL 8.4.6、JDK 21、打包 CLI）上
  为绿，每个用例的故障都被正向观测到。在全新数据库上，整个
  `HostedMonitorRunFaultGatesIT` 类与新字母并存运行：FG8c、FG8e 与 FG8f 为绿；
  #14334 的三个用例（`dispatch-reply`、`page-envelope-commit`、
  `cancel-reply-lost`）为红，且在不含本改动的 #14334 head 上以同样方式变红——它们
  是那个 PR 尚未关闭的评审项，而不是本字母的问题。
- 七个变异各自为红；源码与打包产物均已还原。
- `hosted-process-ci.test.js` 为绿；driver 的 ESLint、Prettier 与类型检查干净；
  Java 源码的 Checkstyle 干净。
- 按 AGENTS.md 连续两轮干净的无方向审计与反向审计。

## 未决问题与后续

1. **跨启动的记录。** Harness 重启之后，`child_run` 记录会永远停留在 `running`，
   即便恢复出来的 drain 已经停掉了进程、账本也已结算。rebuild driver 与跨启动情形
   的设计仍未完成（`docs/design/2026-10-03-managed-shell-monitor-runtime.md`）；
   它落地后，`harness-kill-capture` 的记录断言改为它产出的结算形态。
2. **worker 死亡后的孤儿。** 在这种拓扑下，没有任何东西回收死 worker 曾监管的后台
   进程；Workspace 级联是否应为此设门，归属于该级联自己的门禁。
3. **launcher 不重发的信号。** 会 core dump 的信号、SIGUSR1 与 SIGPIPE 仍会被读
   成 exit 1；通过 launcher 的 fd 3 报告叶子进程的证据可以覆盖它们，代价是改动
   supervisor 的协议。
