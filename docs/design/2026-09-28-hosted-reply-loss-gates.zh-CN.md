# Hosted Broker 应答丢失门禁（FG6a）

[English](2026-09-28-hosted-reply-loss-gates.md) | [简体中文](2026-09-28-hosted-reply-loss-gates.zh-CN.md)

## 问题与范围

Issue #12872 FG6a 覆盖打包后的 Hosted Harness 与 Runtime Broker 之间的应答丢失。现有测试覆盖启动应答丢失和状态不可用，但 Workspace 集成夹具即使在 MySQL 任务中也使用 H2。Prepare 当前不会重试丢失的应答。

本次覆盖 acquire、prepare、start、status、cancel 和 release。Store 故障、进程崩溃、通用取消、SSE 断流、Shell、provider 控制和自动续跑仍属于 FG6b–f / W0e。不增加路由或执行契约。

## 设计

为 `HostedWorkspaceToolTurnIT` 增加独立故障驱动，使用现有打包 Harness 辅助类、假模型、Spring 服务和真实 worker。FG6a 测试要求提供 `mysql.url` 和 `mysql.user`；缺少兼容 MySQL 的数据库时必须失败。每个用例使用独立的已保存 Workspace 和 Session。保留现有正常路径驱动作为回归门禁。

代理转发请求并读完 Broker 的真实应答后，关闭下游连接。代理记录请求身份和上游应答，每个用例必须证明故障确实触发。Prepare 仅在传输失败时重试一次，复用原有预留字段。明确的 Broker 拒绝及无效应答不重试。连续丢失 prepare 应答仍保持阻塞。

| 应答         | 预期证据                                                     |
| ------------ | ------------------------------------------------------------ |
| acquire      | 没有预留或启动；Session 阻塞；存储所有权保留                 |
| prepare      | 两次请求、相同预留身份、一次执行和一次启动                   |
| prepare 两次 | 一个预留、没有启动；Session 阻塞；保留所有权                 |
| start        | 一次启动，状态只查询原执行；一次副作用                       |
| status       | 不新增启动或身份；Session 阻塞；模型不继续                   |
| cancel       | 预留后、启动前取消；即使取消已生效，丢回复仍阻塞；零副作用   |
| release      | 结果已持久化，没有终态 Turn；当前及冷加载 Session 均拒绝输入 |

Release 应答可能在**释放已经生效后**丢失，此时 Broker 已关闭准入并清除 Workspace 存储所有权。Harness 无法推断成功，必须保留未结算输入；它无法让已经完成释放的 Broker 继续持有所有权。另设一个 release 转发前失败的用例，验证释放未生效时存储所有权仍被持有。这个区别遵循现有释放协议；FG6a 不引入第二阶段释放确认。

驱动检查转录结果、模型调用次数、新输入及重新加载被拒绝，以及文件系统副作用。Java 独立核对 SQL 执行记录、派发代数、Runtime Session 和存储所有权。这些检查必须与代理记录的身份和启动次数一致。

Status 用例使用仅测试可见的 future 暂停真实 transport 的完成通知，worker 仍正常执行。第一次状态查询观察真实 executing 记录，然后打开本地回环测试屏障，等待真实 settled 记录，最后丢弃该应答。这样无需修改生产装配或额外丢弃 start 应答，就能确定性地触发状态查询。

## 集成与验证

涉及 Hosted Broker 客户端及其单元测试、Hosted 集成夹具和新增 TypeScript 驱动，以及本双语设计。Broker 客户端唯一的生产消费者为 `HostedWorkspaceToolTurn`，由 Hosted session 路由创建，由 Hosted 模型循环消费。所有请求保留原 Harness Session / Runtime Session 归属。

运行客户端和工具回合的定向测试、build、typecheck、bundle，以及连接 MySQL 或 MariaDB 的 `hosted-workspace-tools` Maven profile。现有 Hosted MySQL CI 任务提供相同数据库参数。先核对五分钟步骤预算内的实际耗时，再决定是否增加时限。

对每类故障临时移除对应的生产防护，要求门禁失败；每次变异之间恢复源码和 bundle。审计完整差异并反向质疑通过的证据，直到连续两轮干净。审计第五轮之后仅接受 Critical 修复。

已在 macOS、Node 22.22.2、Java 21 和 MariaDB 10.11.19 上验证：八个故障用例及原 Workspace 回归全部通过，同时通过 137 个 Java 单元测试和 53 个定向 CLI 测试。恢复后的 Maven 运行耗时 26.7 秒；CI 时限保持不变。Build、typecheck、格式检查、ESLint 和 Checkstyle 均通过。

九个临时生产变异均被检测到：将不确定 acquire 当作普通错误、移除 prepare 重试、更换预留身份、超过重试上限、重复 start、吞掉 status 或 cancel 丢回复，以及分别吞掉两个 release 场景的失败。每个变异均在行为断言处失败，其中身份更换会留下孤立预留，导致 release 被拒绝。源码和 bundle 已恢复，完整门禁再次通过。

## 验收与开放问题

每个用例触发声明的故障，只使用原始身份，并结合 SQL 与文件系统证据验证最多一次派发和副作用。未知结果不产生终态 Turn，重新加载后仍无法接收输入。Prepare/start 成功恢复后，先持久化一个结果再继续模型。不存在需要扩大本切片范围的未决实现问题。
