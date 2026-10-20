# Hosted MCP：连接消失后迟到应答的结算

[English](2026-10-20-mcp-closed-connection-late-settle.md) | [简体中文](2026-10-20-mcp-closed-connection-late-settle.zh-CN.md)

## 问题与范围

Issue #14880 第 1 项还剩一半。#14892 已为「连接存活」形态建了门禁：`unknown()` 记录 `outcome_unknown` 但不删除 pending 条目，所以同连接上到达的应答能恰好结算原操作一次。连接本身消失时，应答没有任何接收方——`client.onclose` 把 pending 操作逐个判成 unknown，随后连接对象连同其 `pending` 一起丢弃。见过 `outcome_unknown` 的客户端再也拿不到结论。

本文只定这条恢复路径该放在哪一层，不改变任何生产行为。

## 现状

- `managed-mcp-runtime.ts` 以 `control.operationId` 为键把在飞操作放在 `connection.pending`；`settled()` 删除条目，`unknown()` 不删。
- `client.onclose` 遍历 `connection.pending`，逐个调用 `unknown(pending, 'managed_mcp_connection_lost')`，之后连接关闭，没有任何地方保留这些 id。
- Harness 通过 `commitOperation` 记录 unknown 视图，后续读取走 `lookup()`，向 Broker 查 `mcp-status`。
- `ManagedMcpProtocol.RECOVERY_KINDS` 已含 `mcp-status`/`mcp-cancel`/`mcp-release`，并按 `targetOperationId` 校验其期望 id；迟到结果没有对应形态。
- 「同 id 重派发」**不能**作为 release 路径的安全推广：`${configurationId}:release` 能重发是因为 Runtime 对该 id 做了合并，而 `invoke()` 只在单连接的 `pending` 表内去重，连接消失后重派发会让工具执行第二次。

## 决定

1. **保留原操作，不重发。** 迟到应答必须写回客户端已知的记录，使 `mcp-status` 能在不二次 invoke 的前提下回答 `settled`。
2. **生产侧没有任何持有能收到应答。** MCP 的请求 id 以单条连接为作用域：`connection.pending` 是 Runtime 唯一的按 id 索引处，`client.onclose` 会把该表整体丢弃。连接消失后，服务端没有通道把该 id 的应答送回来，Broker 侧的窗口只会永远等下去。真正的两条路是（a）要求 MCP 服务暴露一个按业务身份重查的键，客户端在 `outcome_unknown` 后重问一次；（b）把 `outcome_unknown` 当作终态，由调用方重做，并接受一次重复副作用。本文档建议在当前契约下选（b），把（a）记录为解除该限制所需的契约改动。
3. **同一 operation id 只有一个写者。** 窗口内的并发 `mcp-status` 查询合并到同一个被持有的操作上，而不是各自发起持有；第一个确定性应答结算它，所有等待者读同一结果。
4. **窗口是配置常量，不是每次调用的参数。** 客户端无法延长它，重试压力因此不能把 Runtime 拖住。
5. **门禁必须能变红。** 见证用「派发后断连、在替换连接上应答」的夹具；断言恰好一次落库结算、一次物理副作用、一次 `mcp-invoke`；移除持有的变异必须让它变红。

## 待定问题

- 窗口长度：既要覆盖一次重连（秒级），又要短到不让被放弃的操作长期占用 Runtime 槽位。上线前需在 Hosted 车道实测再钉值。
- 持有的键：仅 `operationId`，还是 `(runtimeSessionId, operationId)`；前者在单个 Session 内已唯一。
- 窗口内收到 `mcp-cancel` 是否应提前关闭持有；安全默认是「是」。

## 验收

- 先由设计评审判定上述三个待定问题，代码后落地。
- 实现必须与门禁同 diff；移除持有后门禁必须变红。
