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
