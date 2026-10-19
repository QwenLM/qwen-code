# Hosted MCP 故障门禁 FG12d：release 状态格

[English](2026-10-18-mcp-release-fault-gates-d.md) | [简体中文](2026-10-18-mcp-release-fault-gates-d.zh-CN.md)

## 问题与范围

issue #14447 是 #12380 的 Stage F 轮次 FG12：为 Hosted MCP 的两个域 `mcp_configuration` 与 `mcp_operation` 补故障门禁。FG12c 的重启矩阵延后了一格 **`harness-kill-releasing`**，因为继续 `${configurationId}:release` 需要 lifecycle v2 的 close 序列。本切片实现该格。

整仓 Spring/Broker 重启两格仍然拆出。整仓 Spring 重启会替换内存中的 `WorkspaceStorageGuard`，而该守卫在 storage holder 仍被占用时拒绝 `register`；重启后的 Spring 会在到达 Broker release 之前回答 `workspace_unavailable`，无法隔离 owner-release 恢复。FG12d 不新增只替换 Broker 的接缝，也不做可持久恢复的守卫，因此那两格继续阻塞（FG12c 决策 2）。

## 现状

- `HostedMcpRestartFaultGatesIT` 启动打包 Harness、durable worker、真实 stdio MCP server、MySQL、Broker 前置代理与 lifecycle v2；FG12c 的五格已绿。
- lifecycle v2 的 close 序列是 `effects` → `prepare_resources` → `settle_resources`。`HostedMcpSession.closeResources` 在查询或派发 `${configurationId}:release` **之前**提交 `releaseState: releasing`；只有 release settled 之后，它才提交 `drained`、释放 owner 并标记 `released`。
- release 派发合法地先回答 `running`；后续 `mcp-status` 查询把它解析为 `settled`。因此替换 Harness 是通过查询原 operation id 续跑，而不是新造一个 release。

## 门禁账本

| Case                     | 注入                                                                                                | 期望                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness-kill-releasing` | 在 `releaseState: releasing` 已提交、且 `mcp-release` 派发被 Broker 代理持住时 SIGKILL 打包 Harness | 替换 Harness 加载同一 `runtimeSessionId` 与同一 lifecycle claim；按原 id 查询并完成 `${configurationId}:release`；恰好一次 `mcp-release`；没有第二次 `mcp-configure` 或 `mcp-invoke`；最终 `releaseState` 只在线上应答 settled 之后才为 `released`，绝不伪造 settled。结论性的 `mcp-status` 应答被持在代理内：它被扣住期间记录保持 `releasing`、`settle_resources` 尚未应答；只有应答交付之后才出现 `drained`/`released`。 |

## 决策

1. **扩展现有类，不新增类。** 该格复用 FG12c 的 boot 与夹具，因此“新增一个类”的 fork 预算六处账目不变。证据按 case 分目录：FG12c 留在 `target/fg12-cases/fg12c/`，FG12d 落在 `target/fg12-cases/fg12d/`。
2. **直接驱动 lifecycle v2。** Java 协调器不是本门禁的主体。测试用 `beginWorkspaceLifecycle(..., protocolVersion = 2)` 准入一个 CLOSE 操作并 claim 它，然后用同一 authority 依次发送三个阶段；在 `effects` 之后，它通过更新 `ma_session_head.phase` 代替协调器完成 DRAINING 迁移；协调器的 effects receipt 与时间戳未覆盖（协调器不在范围内）。
3. **持住 release 派发，在 `releasing` 之后杀进程。** 代理在转发前停住 `mcp-release`；测试先断言数据库记录为 `releasing` 且派发在飞，再 SIGKILL Harness。放开 hold 后，原派发到达 Runtime 并登记该操作，替换 Harness 的查询才有可结算的对象。
4. **带原 claim 重载。** load 携带 `lifecycleProtocolVersion: 2` 与原 `{operationId, claimGeneration}`；替换 Harness 在 release 仍为 `running` 时有界重试 `settle_resources`，settled 查询后提交 `drained`/`released`。
5. **先断言线上序列，再断言状态。** 恰好一次 `${configurationId}:release` 的 `mcp-release`、至少一次同 id 且 settled 的 `mcp-status`（有界重试可能发多次）、基线之后没有 `mcp-configure`/`mcp-invoke`、一次 `mcp.start`、`runtimeSessionId` 不变。只有该序列成立后才断言 `releaseState: released`。若 release 始终不 settle，路由回答 503，记录停在 `releasing`/`drained`；有界重试会失败，而不是接受伪造的 `released`。
6. **结论性应答用 hold 见证，不做事后推断。** 线上出现一次 settled 查询只能说明该应答存在过，不能说明状态等到了它。代理因此在 Broker 产出 settled `mcp-status` 之后扣住这条应答；扣住期间测试断言记录仍为 `releasing`、close 路由尚未应答，放开后才期待 close 完成且记录为 `released`。release 派发本身不能作为见证：它合法地先回答 `running`。

## 夹具设计

- 复用现有 rig：打包 Harness（`hosted-harness` profile、lifecycle v2 环境）、durable worker、`hosted-mcp-fault-process.mjs`、MySQL、Java Broker 代理与 lifecycle v2。
- 测试直接种 session 行，因此在准入 close 前把 `ma_session.tool_profile` 钉成 `hosted-workspace-mcp/1`；生产中的 Harness create 路由做同样的事。
- 代理除 hop-by-hop 头外全量透传，因此 `X-Qwen-Lifecycle-Operation-Id` 与 `X-Qwen-Lifecycle-Claim-Generation` 能到达 Broker；不新增 lifecycle 头白名单。
- 证据：`target/fg12-cases/fg12d/<tenant>/` 下的 `proxy.json`、`wire.json`、`harness.log` 与 `processes.jsonl`。workflow 已上传 `target/fg12-cases/`，新子目录自动包含。

## 预算

不新增类，因此六处 fork 账目不变：类 `@Timeout` 600 s、共享 healthy 与 CI fork（当前值见 `hosted-process-ci.test.js`）及其字面钉点、本地 `hosted-mcp-gates` profile（`**/HostedMcp*IT.java`）、workflow 注释、artifact 根 `target/fg12-cases/`。

JDK 21 实测（加入应答 hold 之后）：六格整类在 MySQL 8.0.46 上 32–37 s（两次）、在 MariaDB 10.11 上 40.5 s，release 格 6.0–7.0 s。FG12c 的 49 s 余量本就按 2×（约 98 s）预算，整类仍在该余量内；共享 healthy 和 CI fork 均不动。当前 `main`（含 #14618）两种 schema 均可校验。artifact 根已覆盖 `fg12d`，无需改上传路径或元测试。

## 验收

- `mvn -q -DskipTests test-compile checkstyle:check` 干净。
- `HostedMcpRestartFaultGatesIT` 在 JDK 21 + MySQL 8.0.46 与 MariaDB 10.11 上 6/6 绿；新格在杀进程前先自证注入（数据库 `releasing` 与在飞的 `mcp-release`）。
- `fg12d` 证据显示一次 `mcp-release`、至少一次同 id 且 settled 的 `mcp-status`、一次 `mcp.start` 与一次 `mcp.exit`、最终 `released`，且没有第二次 configure/invoke。
- settled 的 `mcp-status` 应答被扣住期间，记录仍为 `releasing`、`settle_resources` 尚未应答；两者只在应答交付后才推进。
- 本切片不跑 TS 变异见证（按 FG12d 任务书）。剩余风险：绿依赖 release 在 60×1 s 重试窗口内 settle；更慢的 Runtime 会让门禁变红，而不是带着未结算记录变绿。
- 整仓 Spring/Broker 重启在 `WorkspaceStorageGuard` 拒绝被占用 storage 期间继续拆出，不用第二套 rig 伪造。

## 待决问题

- 在 release 派发到达 Runtime **之前**杀进程，会走“同 operation id 重派发、查询未命中”的分支。本门禁故意让原派发落地以钉住查询路径；pre-dispatch 变体是后续候选。
