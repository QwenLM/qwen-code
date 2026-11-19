# Hosted MCP：连接消失后的迟到应答

[English](2026-10-20-mcp-closed-connection-late-settle.md) | [简体中文](2026-10-20-mcp-closed-connection-late-settle.zh-CN.md)

## 问题与范围

Issue #14880 第 1 项还剩一半。#14892 已为「连接存活」形态建了门禁：`unknown()` 记录 `outcome_unknown` 但不删除 pending 条目，所以同连接上到达的应答能恰好结算原操作一次。本文档处理另一半——应答到达之前连接已关闭——并记录它**无法被找回**，而不是提出一个并不存在的机制。

## 现状

- `managed-mcp-runtime.ts` 的 `control()` 在 Runtime 级去重：按 Session scope + `operationId` 查 Runtime 级 `operations` 表，内容相同的重试返回既有视图，改动请求内容则拒绝为 conflict。因此同 id 重试**不会**让工具执行第二次。
- `client.onclose` 只把连接标为关闭，并对 pending 操作调用 `unknown()`；它不删除连接对象，也不删 `pending` 表，所以记录与去重都活过这次关闭。
- 关闭只是把连接标为关闭——记录与去重都还在——而本 Runtime 不尝试恢复它；这比「协议禁止」窄得多。Streamable HTTP 定义了可恢复与重投递：客户端用 `Last-Event-ID` 重连，服务端重放断线期间的消息，包括原请求的响应，无需再次调用工具。Runtime 已经在用 `StreamableHTTPClientTransport`，但 `client.onclose` 从不尝试恢复，所以是本实现没有走这条路。要区分四种状态：物理 HTTP 连接中断（服务端保留会话则可恢复）、当前连接对象关闭（今天的行为：不恢复）、MCP 会话失效（无可重放）、stdio 进程退出（根本没有这条路）。下面的限制说的是本实现所走的路径，不是 MCP 允许什么。
- Harness 通过 `commitOperation` 记录 unknown 视图，后续读取走 `lookup()`，向 Broker 查 `mcp-status`。
- `ManagedMcpProtocol.RECOVERY_KINDS` 含 `mcp-status`/`mcp-cancel`/`mcp-release` 并按 `targetOperationId` 校验；迟到结果没有对应形态。

## 决定

1. **记录限制：对已关闭连接，`outcome_unknown` 是终态。** 同 id 重试拿回同一个 unknown，之后不会有任何东西结算原操作。
2. **持有与持久存储都找不回应答。** Broker 或 Runtime 的持有没有应答可等；把操作写进持久存储只保存了 Harness 已经通过 `accept()` / `commitOperation()` 落库的那个 unknown，存储无法取回一条从未到达的应答。持久存储解决的是另一个窗口——已收到的 receipt 跨 Runtime 重启存活——在这里不是解法。
3. **按顺序列出恢复路径，且都不在本切片内。** 其一，实现 Streamable HTTP 的恢复：用 `Last-Event-ID` 重连让服务端重投递错过的响应——协议已允许，Runtime 也已带该传输。其二，对不支持恢复的服务，用按业务身份重查的键。其三，对 stdio 与两者都不具备的服务，用幂等键让调用方重做并接受一次重复副作用。只有第三条需要调用方可见的契约；第一条是 Runtime 内部实现，第二条是服务端契约。
4. **不为该形态声称门禁。** 连接存活形态已由 #14892 覆盖；连接已关闭形态作为已记录的限制保留，因此下面的验收不含任何以结算路径为前提的条件。

## 待定问题

- 选哪条解除路径：服务端重查契约，还是幂等键 + 调用方重做。
- 是否实现 Streamable HTTP resume、本工作区哪些服务器能重投递。
- 对 stdio 与不可恢复的服务：用服务端重查键，还是幂等键 + 调用方重做。

## 验收

- 两种语言陈述同一限制、同样顺序的三条恢复路径，并同样不声称门禁。
- 关于 `control()`、`client.onclose` 与 `connection.pending` 的主张与受审提交的代码树一致。
