# FG11d：retire、disable、close 与取消矩阵

[English](2026-10-19-automation-lifecycle-fault-gates.md) | [简体中文](2026-10-19-automation-lifecycle-fault-gates.zh-CN.md)

状态：`disable-span`、按 run 的取消格、`retire-at-intent`、「关闭后跳过」格与
「turn 在飞时拒绝关闭」格已实现并实跑绿；取消矩阵其余部分已定界但未实现。

Issue：#14446，FG11 tracker。`d` 行记载按 run 取消已由 #14526 实现，并声明
retire、disable、close 与 round 级取消矩阵并未因该合并而结清。

## 为什么

FG11a 已钉住 `retire_schedule` 的丢失应答（含丢 202 后只回答已提交的
retire、retire 之后无 slot fire），FG11b 钉住账本周围的存储故障。本轮不
重复该格，只覆盖两者都未回答的生命周期问题：

- 定义被 retire 时，已经以 `intent` 抵达 Harness 的 claim 会怎样？
- 已 retire 或已 disable 的定义是否还会再 fire，包括已经到期的那个 slot？
- Session 关闭时排队的 automation input 会怎样？
- cancel 是否只停止它自己的 occurrence，而保留 schedule、未来 slot、兄弟
  run 与前台工作？

`AutomationScannerTest` 在 H2 上覆盖 `session_not_active` 与 `count_limit`，
`WorkspaceSessionCloseMySqlIT` 覆盖工作区 Session 的 close，但没有任何打包
车道在真实 schema 与真实 scanner 上跑这些问题。

## 夹具

两片都落在 `HostedAutomationFaultGatesIT`：它已提供打包栈——进程内 Spring
（scanner 开启）、`HostedLifecycleRelay` 背后的真实 Harness、真实 MySQL 与
模型桩。故障由既有 relay 承载：`held(...)` 在 Harness 看到操作之前扣住它，
`relayed(...)` 丢掉一次应答，scanner 自己的调度器在用例布置期间被挂起。

`disable-span` 与 `retire-at-intent` 能直接跑在这套夹具上：relay 扣住
`fire_run`，把这次 fire 停在 occurrence 已提交、Harness 尚未准入之间，这正是
这一格需要的窗口。`close-*` 在同一夹具上、由用例启用 Workspace 生命周期后即可跑，记在「边界」里。

## 第 1 片：retire、disable、close

| 格子                 | 构造                                                                                    | 预期                                                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retire-at-intent`   | occurrence 已提交、Harness 尚未准入 `fire_run` 时 retire（relay 扣住操作）              | occurrence 结算为 `skipped`/`definition_retired` 且 attempts 为 0；不提交 run、不起模型 Turn，claim 绝不为 `unknown`                                 |
| `disable-span`       | 以禁用状态创建定义，跨两个到期 slot 后再 enable                                         | 禁止期内不产生 `fired` occurrence 与 run；重新 enable 后第一个 slot 恰好 fire 一次                                                                   |
| `close-queued-input` | 关闭一个挂着存活定义的 Session，并启用 Workspace 生命周期（持久 broker、0700 状态目录） | 关闭完成，其后的 slot 记 `skipped`/`session_not_active`，且不起模型 Turn；turn 在飞时的关闭请求被 `409 turn_active` 拒绝，因此关闭永远到不了排队输入 |

## 第 2 片：取消矩阵

按 run 的公开 `TASK_CANCEL` 只能停止目标 occurrence。矩阵断言：

- 被取消的 run 依据其已提交的证明进入 `cancelled`，occurrence 恰好结算一次；
- schedule、未来 slot、兄弟 run 与前台工作不受影响；
- 在任何尝试之前被取消的排队 input 结算且不调用模型；自然完成的 run 保留其结果
  ——已交付：结算之后到达的取消被 `409 task_action_unavailable`（`The task does
not accept a cancellation now.`）拒绝，run 保持 `completed`、occurrence 保持
  `fired`；
- `cancel-stops-only-the-target` 已交付：把 wake turn 扣在模型上时，公开 task
  cancel 让 task 与 run 在一秒内结算为 `cancelled`，schedule 保持 `live`；反之在
  收到 `202` 后立刻释放模型，turn 会先跑完——本格避开的正是这个顺序。
- 同一 key 重试取消复用其已提交的 operation 且不产生新动作——已交付：第二次请求
  返回已取消的 task，run 保持 `cancelled`、occurrence 恰好结算一次；
- 同一 key 的重试复用原 operation 与 run——已交付：第二次 `POST /runs` 返回它
  已经创建的 run，不产生第二个 occurrence，也不起第二个 Turn。被扣住的 cancel
  绝不重投仍未覆盖。

#14526 已实现按 run 取消；第 2 片在它周围钉住 round 级矩阵。

## 边界

- 这些格子不执行 Workspace 工具、不触及发布；FG11f 负责那些，并受其设计
  中记录的执行授权缺口阻塞。
- `retire-at-intent` 是 Harness 准入前的 retire，不是已提交的 intent。relay 在
  Harness 看到 `fire_run` 之前扣住它，因此只有 occurrence、没有 `automation_run`：
  此时 retire 让 occurrence 以 `skipped`/`definition_retired` 收口、attempts 为 0，
  没有可取消的 run。已提交 intent 是另一条路径——`HostedAutomationSession.fire()`
  在定义于其下 retire 后取消它已持有的 `intent`，由 CLI 侧用例「ends a claim its
  definition retired under as cancelled, never started」钉成 `cancelled` 与
  `not_started_proven`。本车道不执行那条分支，缺口在此保留，而不是被这一格当作
  已结清。
- `close-*` 需要的是 Workspace 生命周期，而不只是一个带工作区的 Session。close 路由经
  `SessionLifecycleService.admit` 准入，动作存储在缺失执行登记事实时拒绝绑定的 Session：
  `ManagedActionStore` 抛 `409 workspace_unavailable`，消息
  `Hosted Workspace execution is not available.`。这条既不是
  `WorkspaceExecutionStore` 的授权拒绝，也不是 `HarnessCoordinator` 的 workspace-files
  故障。让该检查通过的装配有四件：`durable-local-process`、owner-private 0700 的 broker
  状态目录、`verified-workspace-recovery-enabled`，以及存储 guard 的注册——第三件才让
  注册在 guard 不自启用的宿主上生效。四者齐备后关闭会完成，下一个 slot 记
  `skipped`/`session_not_active`。turn 在飞时的关闭请求被 `409 turn_active` 拒绝，
  这正是排队输入那一支的边界：队列的命运由 turn 决定，从不由关闭决定。
- task cancel 需要投影的任务 id，而不是 run 记录 id：传 `arun_…` 会得到
  `task_not_found`，而 `GET /v1/agents/sessions/{id}/tasks` 返回的 id 会被
  接受。把 wake turn 一直扣在模型上时，取消会赢：task 与 run 都在一秒内结算为
  `cancelled`，之后再释放模型也不会复活。反之，在收到 `202` 后立刻释放模型，
  turn 会先跑完，run 结算为 `completed`。因此扣住的模型本身就是这一格所需的
  扣留点；决定结果的是释放顺序，而不是夹具。
- 取消期间的租约接管不在范围内，与 FG11c 一致。
- stream gap 门禁（FG11e）不在此处。

## 验收

- 每片在 JDK 21 + 真实 MySQL 8 上全绿，用 `-Phosted-automation-gates` 选择。
- 移除某个守卫时，对应格子在其命名位置变红。
- 若该类运行时长变化，重组 `scripts/tests/hosted-process-ci.test.js` 的预算；
  不新增类。
- 中英双语交付，结构一致。
