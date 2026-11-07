# Hosted MCP 故障门禁 FG12e：事件流断流

[English](2026-10-18-mcp-stream-gap-e.md) | [简体中文](2026-10-18-mcp-stream-gap-e.zh-CN.md)

## 问题与范围

issue #14447 列出公开/WebShell 事件流在长 MCP 工具调用与配置替换期间的断开/续传门禁。本设计核实后确认：MCP 记录不产生 task 事件（issue 自己引用 H1 设计 `:27`）；`ext://hold` fixture 是原始 `resource_read`，不是工具调用；公开/WebShell 流承载的是 Spring event store 的 turn/agent 事件，不是 MCP 记录事件。

围绕原始 operation 的独立门禁观察不到事件；lane 的 model/tool 路径可以驱动 MCP 工具调用。**结论：把流断言延迟到 FG12f**，复用现有 model/tool 夹具；不新增类或预算账目。

## 现状

- 公开流是 `GET /v1/agents/sessions/{sessionId}/events`，由 `ManagedEventStreamService` 提供，用 `Last-Event-ID` / `after` 续传。
- WebShell 流是 `POST /api/agent/web-shell/v1/events/stream`，`afterSequence` 在 body 里，没有 `Last-Event-ID` 头。两条路由不是同一机制。
- 两条流都从 Spring event store（`ma_public_event` / 事件记录）重放，不是 Harness journal；Harness 的 `/session/:id/events` 是第三条路由。
- MCP 原始操作 fixture（`ext://hold`）不产生 turn/tool 事件。lane 确实有模型驱动的 turn：`HostedExtensionsIT.modelReply()` 为发现的 MCP 工具发出 `tool_calls`，并通过公开事件 API 提交 turn；FG12c rig 也启动本地模型服务并驱动 baseline prompt。`HostedMcpRestartFaultGatesIT.modelReply()`（FG12c）发的是 `FG12C_DONE`；`HostedMcpReplyLossIT`（FG12a）发的是 `FG12_DONE`。两个 stub 都不发 `tool_calls`；`HostedExtensionsIT.modelReply()` 才发，所以工具调用需要该路径，或让 stub 发出 tool call。

## 账本

FG12e 不设独立账本。流续传用例属于 FG12f / turn 投递；本切片只记录结论与路由事实，不制造空门禁。

## 决策

1. **FG12e 并入 FG12f。** 不新增 `HostedMcpStreamFaultGatesIT`、不新增 fork 预算账目、不建 `fg12e` 证据根。
2. **公开流与 WebShell 流机制不同。** 公开路由用头续传；WebShell 路由用 body 游标。不要写成同一种续传机制。
3. **流来源是 Spring event store**，不是 Harness journal；见证必须读对的序列。
4. **延迟是范围选择，不是缺夹具。** 现有 model/tool 路径可以驱动流续传用例；FG12f 应复用 `HostedExtensionsIT.modelReply()`（tool_calls）或让 stub 发出 tool call，而不是新预算一个模型夹具。

## 验收

- FG12f 设计记录该延迟，并在任何流用例中复用现有 model/tool 夹具。
- 本文档指向 FG12f，不宣称存在 MCP 流门禁。
- 不新增类，不改预算。

## 待决问题

- 通用的 turn 级公开/WebShell 流续传门禁是否值得单独开一个切片（现有 model/tool 夹具已具备）？
- WebShell 路由是否需要在 FG12f 设计里单独写续传契约？

## 跟进：Runtime 连接替换（2026-10-22）

FG12f 之后，#14447 状态表与 #12380 的 Stage F 表仍列着 e 的一个未覆盖边界：真正的 Runtime MCP 连接替换。FG12f 的替换用例（其决策 5）在运行中的 Session 保持固定的前提下提交新的 AgentDefinition 修订，并没有替换任何 Runtime 连接。FG12f 认为 Harness 私有配置路由无法为 Spring 创建的 Session 承担这个用例。这个限制来自测试入口，不来自产品：

- client id 由 Harness 在为 create 或 load 打开 Session 时签发（`hosted-harness-session.ts` 中的 `clientId: randomUUID()`），随 attachment 返回，与 Broker 无关。Spring 把它保存在 `QwenHostedHarnessConnector.attachments` 的 `HarnessSessionRef` 上，并在每次调用 Harness 时带上。公开 API 从不暴露它，所以只用公开 API 的测试发不出这条命令。
- Spring 从不发送 `POST /session/:id/mcp/configurations`，显式替换仍是 Harness 私有命令，与 issue 的约束一致。自 #15119 起，`HostedHarnessClient` 会发送 Session 级 MCP 管理路由（`POST /session/:id/mcp/management`），但该路由在 Turn 进行中以 `hosted_turn_active` 拒绝，所以经 Spring 发出的变更不会落在被挂住的调用期间。FG13 的 Hook 门禁已经读取同一个 attachment 来调用 Harness 私有的 status 路由，本用例做法相同。
- 该路由只在 `mcpBusy`、`mcpRecovering` 或 `blocked` 置位时拒绝，Turn 进行中并不拒绝，所以替换可以落在一次被挂住的模型驱动 MCP 工具调用期间。
- Runtime 把替换作为一条新连接打开：更高的 `configRevision`、新的连接代、新的 stdio 进程。随后把旧的兄弟连接标为 `retiring`。有未决调用的兄弟连接要等该调用结束才关闭：`settled()` 在 retiring 连接的 `pending` 清空后关闭它。

### 用例

`HostedMcpStreamGapIT#runtimeConnectionReplacementDuringTheHeldCallKeepsBothStreamsOnMySql`，复用现有类与启动流程：

1. 发布修订 1，创建 Session，打开一个公开观察者和一个 WebShell 观察者，提交 `EXT_HOLD`。夹具把调用挂在修订 1 的进程上。切断两个观察者。
2. 以 Spring 的 attachment 发送修订 2 的 configure 命令，`expectedRevision: 1`。命令在调用仍被挂住时就已 settled。
3. 释放调用，等 Turn 结束，两个观察者各用自己的游标（`Last-Event-ID` 或 `afterSequence`）续传。
4. 提交 `EXT_REPLACED`。

用例断言：

- 每条路由的并集都是从序列 1 起的已提交账本，无缺口、无重复，并且恰好携带一次被挂住调用的结果。
- 替换启动了第二个 server 进程（修订 `[1, 2]`），提交了第二条已 settled、连接代更高的配置，公开 catalog 报告修订 2。此时修订 1 的进程仍然存活，副作用尚未发生。
- 被挂住的调用只应答一次，由它启动时所在的进程应答：模型看到 `EXT_MCP_1_EXT_HOLD`，副作用的 pid 是修订 1 的 pid。修订 1 的进程在调用排空后退出。
- 下一次调用跑在替换后的连接上：模型看到 `EXT_MCP_2_EXT_REPLACED`，副作用的 pid 是修订 2 的 pid。没有第三个进程启动，证明文件有两行。

### 变异见证

每个见证都改动该类运行的打包 bundle（`dist/`），两者均为红：

- **M1（Runtime）：** 即使兄弟连接仍有未决调用也关闭它。替换 settled 后立即在「revision 1 is retiring, not closed, while its call holds」处变红。
- **M2（Harness）：** 替换后保留该 server 的第一份 catalog（只在缺失时 `catalogs.set`）。在「Turn … expected COMPLETED」处变红：被挂住的调用仍只应答一次，但下一次模型请求前的 refresh 会重新 configure 过期的修订 1 catalog，Runtime 拒绝后 Turn 以 `Runtime MCP configuration failed.` 失败。

### 预算

在 Linux aarch64、JDK 21、MySQL 8.4.6 上实测：三次整类运行中本用例分别耗时 12.9 s、13.8 s、13.7 s，整类 4/4 全绿，分别为 143.3 s、144.6 s、144.4 s；单独运行（含冷启动）为 25.9 s。它比另外三个用例短，是因为它的第二个 Turn 会写入被切断客户端留下的半开 SSE 连接，Tomcat 30 s 的优雅关闭因此没有需要等待的请求。按类内最大耗时的 2 倍计预算：在 FG11d queue-one 用例（#15187）之上再加 28 s，健康总和由 10636 s 升至 10664 s，fork 由 11236 s 升至 11264 s。fork 加包裹共 11864 s，仍在 198 分钟的 Verify 步之内，余 16 s，job 上限不变。

### 不覆盖

- 经 Spring 的 Session 级 MCP 管理路由（#15119）发出的变更。该路由在 Turn 进行中会拒绝，不会落在被挂住的调用期间，本用例也不覆盖它。
- 原始 `mcp_operation` 进行中时的替换。`mcpBusy` 置位期间该路由返回 `409 hosted_mcp_operation_active`。
- retiring 连接未能排空、非 stdio 传输，以及替换之后的 Harness 或 Spring 重启。
- 被取代配置在关闭时的释放。本用例让 Session 保持打开；FG12a 的 configure 替换用例（`HostedMcpReplyLossIT`）通过 Harness 关闭了一个替换过的 Session。
