# Hosted MCP 故障门禁 FG12c：重启矩阵

[English](2026-10-18-mcp-restart-matrix-c.md) | [简体中文](2026-10-18-mcp-restart-matrix-c.zh-CN.md)

## 问题与范围

issue #14447 是 #12380 的 Stage F 轮次 FG12：为 Hosted MCP 的两个域 `mcp_configuration` 与 `mcp_operation` 补故障门禁。FG12a（应答丢失）已由 #14499 合入。本切片实现 **FG12c，重启矩阵**——本轮次明确欠下的门禁：SIGKILL 打包 Harness、Runtime worker 与 stdio MCP server，并保留 `HostedExtensionsIT` 已有的两格。

Spring/Broker 重启两格（空闲，以及 `drained` 之前的 release 窗口）**拆出本切片**。整仓 Spring 重启会替换内存中的 `WorkspaceStorageGuard`，而该守卫在 storage holder 仍被占用时拒绝 `register`；重启因此会在到达 Broker release 之前就卡在 `workspace_unavailable`，无法隔离目标性质。FG12d 负责 `drained` 之后的 owner-release 恢复（R1-1）；它的前提是只替换 Broker 的接缝或可持久恢复的守卫。

## 现状

- `HostedMcpReplyLossIT`（FG12a）启动打包 Harness、durable worker、真实 stdio MCP server、MySQL、Broker 前置代理与 lifecycle v2。基线 turn 配置 revision 1；私有路由替换到 revision 2；代理记录线上序列并按名丢应答。
- `HostedExtensionsIT` 已钉住矩阵两格：空闲时 SIGKILL Harness，worker 与 MCP server 进程不变；server 把副作用落盘后在回复前退出，Turn 保持 `RUNNING`，新输入与关闭都返回 `409 turn_active`。
- Runtime 的回执只在单个 Runtime 代内有效，Runtime 物理丢失后不保留。

## 门禁账本

| Case                                             | 注入                                                          | 期望                                                                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness-kill-configure`                         | 在配置的 `dispatch_started` 之后 SIGKILL Harness              | 替换 Harness 沿用原 `runtimeSessionId`、binding 与 generation；配置通过 status 查询解决，绝不出现第二次 `mcp-configure`                       |
| `harness-kill-operation`                         | 在原始 `resource_read` 在飞（fixture 持有）时 SIGKILL Harness | 替换 Harness 按原 operation id 查询；没有第二次 `mcp-invoke`；fixture 副作用计数保持 1，或该操作成为 `outcome_unknown`，绝不伪造 settled 结果 |
| `harness-kill-releasing`（延后至 FG12d）         | 在 `releaseState: releasing` 之后 SIGKILL Harness             | 替换 Harness 用原 id 继续 `${configurationId}:release`；没有第二次 configure 或 invoke                                                        |
| `worker-kill-idle`                               | 空闲时 SIGKILL Runtime worker                                 | 死掉的 generation 绝不会被重铸成新的 owner；Session 保持 `recovery_blocked`/`outcome_unknown`                                                 |
| `worker-kill-operation`                          | 原始 `resource_read` 在飞时 SIGKILL Runtime worker            | 操作结算为 `outcome_unknown`（`managed_mcp_connection_lost`）；除原 Runtime 代的确定性应答外，没有任何东西能结算它                            |
| `stdio-kill-mid-request`                         | 请求中途 SIGKILL stdio MCP server                             | 该调用结算为 `outcome_unknown`（`managed_mcp_connection_lost`）；fixture 副作用计数不增长                                                     |
| `harness-kill-idle` 与 `server-effect-then-exit` | `HostedExtensionsIT` 已有的两格                               | 原样保留并在车道内重跑                                                                                                                        |

本切片落地 `HostedMcpRestartFaultGatesIT` 的五格：两格 Harness kill、两格 worker kill 与一格 stdio kill。release-state 格随 Spring 重启一起转入 FG12d，因为继续 `${configurationId}:release` 需要 lifecycle close 序列，而该序列由 R1-1 恢复接缝提供；在此钉住会把同一个接缝复制到错误的字母里。

## 决策

1. **worker SIGKILL 之后 stdio server 的去向要断言，而不是留空。** fixture 在 stdin EOF 时退出并记录 `mcp.exit`；门禁断言 fixture 不存活。真实 server 的行为不在本切片承诺范围内（只记录）。
2. **Spring 重启拆出。** 守卫拒绝为被占用的 storage 重新注册，空闲或 pre-drain 重启都无法到达 Broker release。FG12d 负责 R1-1 恢复；接缝是前提，而不是另搭一套 rig。
3. **新类，不改 FG12a。** `HostedMcpRestartFaultGatesIT` 通过复制复用 FG12a 的 boot 与 fixture，遵循 #13339 隔离规则；FG12a 类保持为应答丢失 letter。
4. **fixture 增加一个 hold。** `ext://hold` 的 `resources/read` 停住直到 release 文件出现，并记录 `mcp.hold`；`mcp.exit` 记录 stdin 关闭。这是唯一的 fixture 改动；FG12a 的 case 路径不变。

## 夹具设计

- IT 在 JVM 内启动 Spring（强制 MySQL），种一个 workspace 与存储注册，把 Harness 的 broker 地址钉在 Java 代理上，并以 `hosted-workspace-mcp/1` 启动打包 Harness。
- 驱动半边留在 IT：按记录的 pid SIGKILL、用同一 `runtimeSessionId` 重载、JDBC 读取 `mcp_configuration`/`mcp_operation`、代理 wire、fixture 副作用日志。
- 证据落在 `target/fg12-cases/fg12c/<tenant>/`；workflow 上传 `target/fg12-cases/`。

## 预算

新增 `Hosted*IT` 类要在同一 diff 重钉六处 fork 预算：类 `@Timeout` 上限、`hostedForkHealthySeconds`、CI fork 值与字面钉点、本地 profile、workflow 步骤注释、artifact 路径（见 `hosted-fork-budget-remeasure-duty`）。FG12c 五格在 JDK 21 + MariaDB 10.11 上实测 25–49 s 健康耗时（最重一轮 49 s，2× 预算约 98 s）。合入 FG13c 后共享 healthy 为 4238 s，CI fork 为 4848 s；FG12c 的 49 s 增量已计入。本地 `hosted-mcp-gates` profile 仍用 `**/HostedMcp*IT.java` 家族通配。

## 验收

- `mvn -DskipTests test-compile checkstyle:check` 干净。
- 该类在 JDK 21 + MySQL 8.x 上绿；每个 case 先自证注入生效（kill 标记、在飞请求、副作用计数），再断言期望。
- 至少一条变异见证红：重铸 worker generation（或 reload 路径重发而非查询），跑红后还原复绿。
- `scripts/tests/hosted-process-ci.test.js` 绿且预算按实测重钉；双语文档同构。

## 待决问题

- 在飞请求的释放用文件还是 FIFO（文件更简单，SIGKILL 后仍可读）。
- worker-kill 各格是否需要 cgroup 才能证明 stdio 子进程的收容；当前 fixture 的 stdin-EOF 退出行为足以支撑本切片的进程断言。
