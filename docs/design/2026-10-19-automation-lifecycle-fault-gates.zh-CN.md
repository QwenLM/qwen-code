# FG11d：retire、disable、close 与取消矩阵

[English](2026-10-19-automation-lifecycle-fault-gates.md) | [简体中文](2026-10-19-automation-lifecycle-fault-gates.zh-CN.md)

状态：第 1 片部分交付。`disable-span` 已实现并实跑绿；其余两格与第 2 片已定界但未实现。

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

只有 `disable-span` 能直接跑在这套夹具上。`retire-at-intent` 需要在
「run 已提交、wake turn 未开始」之间扣留，`close-*` 需要夹具当前能够接受的
会话关闭；两点记在「边界」里，而不是当作已就绪。

## 第 1 片：retire、disable、close

| 格子                 | 构造                                                       | 预期                                                                                                                              |
| -------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `retire-at-intent`   | claim 以 `intent` 停在 Harness 时 retire（relay 扣住操作） | claim 结算为 `cancelled`/`not_started_proven`；occurrence 不是 `unknown`                                                          |
| `disable-span`       | 以禁用状态创建定义，跨两个到期 slot 后再 enable            | 禁止期内不产生 `fired` occurrence 与 run；重新 enable 后第一个 slot 恰好 fire 一次                                                |
| `close-queued-input` | 有 automation input 排在 held turn 之后时关闭 Session      | 排队的 input 结算且不产生模型 Turn；关闭 Session 上的存活定义每个 slot 记 `skipped(session_not_active)`，这是今天的行为，在此钉住 |

## 第 2 片：取消矩阵

按 run 的公开 `TASK_CANCEL` 只能停止目标 occurrence。矩阵断言：

- 被取消的 run 依据其已提交的证明进入 `cancelled`，occurrence 恰好结算一次；
- schedule、未来 slot、兄弟 run 与前台工作不受影响；
- 在任何尝试之前被取消的排队 input 结算且不调用模型，自然完成的 run 保留
  其结果；
- 同一 key 的重试复用原 operation 与 run，被扣住的 cancel 绝不重投。

#14526 已实现按 run 取消；第 2 片在它周围钉住 round 级矩阵。

## 边界

- 这些格子不执行 Workspace 工具、不触及发布；FG11f 负责那些，并受其设计
  中记录的执行授权缺口阻塞。
- `retire-at-intent` 需要 claim 先存在。relay 在 Harness 之前扣住 `fire_run`
  时，Spring 根本不会提交 `automation_run`，首次构造拿到的是空 run 列表，
  没有东西可以结算成 `cancelled`。要构造它，需要在「run 已提交、wake turn
  尚未开始」之间扣留，本夹具暂未暴露该注入点。
- `close-*` 需要工作区支撑的 Session：automation API 拒绝没有工作区的
  Session（`session_not_found`），而在本夹具里关闭工作区 Session 会得到
  `workspace_unavailable`，来自托管会话的 workspace 执行可用性检查，而非
  FG11f 命中的 store 级授权。
- task cancel 需要投影的任务 id，而不是 run 记录 id：传 `arun_…` 会得到
  `task_not_found`，而 `GET /v1/agents/sessions/{id}/tasks` 返回的 id 会被
  接受。把 wake turn 扣在模型上时，该取消在 120 s 内没有让 run 结算，
  Harness 连接以 socket EOF 断开；要构造这一格需要换一个扣留点。
- 取消期间的租约接管不在范围内，与 FG11c 一致。
- stream gap 门禁（FG11e）不在此处。

## 验收

- 每片在 JDK 21 + 真实 MySQL 8 上全绿，用 `-Phosted-automation-gates` 选择。
- 移除某个守卫时，对应格子在其命名位置变红。
- 若该类运行时长变化，重组 `scripts/tests/hosted-process-ci.test.js` 的预算；
  不新增类。
- 中英双语交付，结构一致。
