# Hosted MCP：连接消失后迟到应答的结算

[English](2026-10-20-mcp-closed-connection-late-settle.md) | [简体中文](2026-10-20-mcp-closed-connection-late-settle.zh-CN.md)

## 问题与范围

Issue #14880 第 1 项还剩一半。#14892 已为「连接存活」形态建了门禁：`unknown()` 记录 `outcome_unknown` 但不删除 pending 条目，所以同连接上到达的应答能恰好结算原操作一次。连接本身消失时，应答没有任何接收方——`client.onclose` 把 pending 操作逐个判成 unknown，随后连接对象连同其 `pending` 一起丢弃。见过 `outcome_unknown` 的客户端再也拿不到结论。

本文只定这条恢复路径该放在哪一层，不改变任何生产行为。

## 现状

- `managed-mcp-runtime.ts` 的 `control()` 在 Runtime 级去重：按 Session scope + `operationId` 查 Runtime 级 `operations` 表，内容相同的重试直接返回既有视图，改动请求内容则拒绝为 conflict。`client.onclose` 只把连接标为关闭并对 pending 操作调用 `unknown()`，不删除连接对象，也不删 `pending` 表。也就是说记录与去重都还在，丢的是能送达应答的那条传输。
- `client.onclose` 遍历 `connection.pending`，逐个调用 `unknown(pending, 'managed_mcp_connection_lost')`，之后连接关闭，没有任何地方保留这些 id。
- Harness 通过 `commitOperation` 记录 unknown 视图，后续读取走 `lookup()`，向 Broker 查 `mcp-status`。
- `ManagedMcpProtocol.RECOVERY_KINDS` 已含 `mcp-status`/`mcp-cancel`/`mcp-release`，并按 `targetOperationId` 校验其期望 id；迟到结果没有对应形态。
- 「同 id 重派发」**不能**作为 release 路径的安全推广：`${configurationId}:release` 能重发是因为 Runtime 对该 id 做了合并，而 `invoke()` 只在单连接的 `pending` 表内去重，连接消失后重派发会让工具执行第二次。

## 决定

1. **保留原操作，不重发。** 迟到应答必须写回客户端已知的记录，使 `mcp-status` 能在不二次 invoke 的前提下回答 `settled`。
2. **生产侧没有任何持有能收到应答。** MCP 的请求 id 以单条连接为作用域：`connection.pending` 是 Runtime 唯一的按 id 索引处，`client.onclose` 会把该表整体丢弃。连接消失后，服务端没有通道把该 id 的应答送回来，Broker 侧的窗口只会永远等下去。真正的两条路是（a）要求 MCP 服务暴露一个按业务身份重查的键，客户端在 `outcome_unknown` 后重问一次；（b）把 `outcome_unknown` 当作终态，由调用方重做，并接受一次重复副作用。本文档建议在当前契约下选（b），把（a）记录为解除该限制所需的契约改动。
3. **记录限制，不建持有。** 去重与记录都在、传输已失的情况下，`outcome_unknown` 对已关闭连接就是终态：同一 Runtime 内重试同 id 只会拿回同一个 unknown，重发救不回答案，Broker 侧窗口也只会永远等。
4. **写明什么能解除限制，并把它划出范围。** 要么 MCP 服务暴露按业务身份重查的键，让调用方在 `outcome_unknown` 后重问；要么生产侧有能活过 Runtime 的持久存储。内存里的有界窗口两者都不是。
5. **不为该形态声称门禁。** 连接存活形态已由 #14892 覆盖；连接已关闭形态在第 4 条落地前只作为限制记录，因此下面的验收不含任何以持有为前提的条件。

## 待定问题

- 选哪条解除路径：服务端的重查契约，还是生产侧的持久存储。
- `outcome_unknown` 之后由调用方重做是否可以接受一次重复副作用，还是领域先要幂等键。

## 验收

- 两种语言陈述同一限制、同样的两条解除路径，并同样不声称门禁。
- 关于 `control()`、`client.onclose` 与 `connection.pending` 的主张与受审提交的代码树一致。
