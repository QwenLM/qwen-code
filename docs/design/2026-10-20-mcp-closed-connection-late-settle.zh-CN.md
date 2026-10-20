# Hosted MCP：连接消失后的迟到应答

[English](2026-10-20-mcp-closed-connection-late-settle.md) | [简体中文](2026-10-20-mcp-closed-connection-late-settle.zh-CN.md)

## 问题与范围

Issue #14880 第 1 项还剩一半。#14892 已为「连接存活」形态建了门禁：`unknown()` 记录 `outcome_unknown` 但不删除 pending 条目，所以同连接上到达的应答能恰好结算原操作一次。本文档处理另一半——应答到达之前连接已关闭——并记录它**无法被找回**，而不是提出一个并不存在的机制。

## 现状

- `managed-mcp-runtime.ts` 的 `control()` 在 Runtime 级去重：按 Session scope + `operationId` 查 Runtime 级 `operations` 表，内容相同的重试返回既有视图，改动请求内容则拒绝为 conflict。因此同 id 重试**不会**让工具执行第二次。
- `client.onclose` 只把连接标为关闭，并对 pending 操作调用 `unknown()`；它不删除连接对象，也不删 `pending` 表，所以记录与去重都活过这次关闭。
- 关闭真正摧毁的是传输。MCP 的请求 id 以单条连接为作用域，服务端没有通道把该 id 的应答送到另一条连接；pending 条目还在，但再没有任何东西能填上它。
- Harness 通过 `commitOperation` 记录 unknown 视图，后续读取走 `lookup()`，向 Broker 查 `mcp-status`。
- `ManagedMcpProtocol.RECOVERY_KINDS` 含 `mcp-status`/`mcp-cancel`/`mcp-release` 并按 `targetOperationId` 校验；迟到结果没有对应形态。

## 决定

1. **记录限制：对已关闭连接，`outcome_unknown` 是终态。** 同 id 重试拿回同一个 unknown，之后不会有任何东西结算原操作。
2. **持有与持久存储都找不回应答。** Broker 或 Runtime 的持有没有应答可等；把操作写进持久存储只保存了 Harness 已经通过 `accept()` / `commitOperation()` 落库的那个 unknown，存储无法取回一条从未到达的应答。持久存储解决的是另一个窗口——已收到的 receipt 跨 Runtime 重启存活——在这里不是解法。
3. **只列两条解除路径，且都划出范围。** 要么 MCP 服务暴露按业务身份重查的键，让调用方在 `outcome_unknown` 后重问；要么领域引入幂等键，允许调用方重做并接受一次重复副作用。两者都是契约改动，不是 Hosted 内部能决定的。
4. **不为该形态声称门禁。** 连接存活形态已由 #14892 覆盖；连接已关闭形态作为已记录的限制保留，因此下面的验收不含任何以结算路径为前提的条件。

## 待定问题

- 选哪条解除路径：服务端重查契约，还是幂等键 + 调用方重做。
- 若选后者，哪些工具能容忍重复副作用、哪些必须先有幂等键。

## 验收

- 两种语言陈述同一限制、同样的两条解除路径，并同样不声称门禁。
- 关于 `control()`、`client.onclose` 与 `connection.pending` 的主张与受审提交的代码树一致。
