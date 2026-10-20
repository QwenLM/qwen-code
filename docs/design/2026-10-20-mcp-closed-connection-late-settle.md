# Hosted MCP: settling a late reply after the connection is gone

[English](2026-10-20-mcp-closed-connection-late-settle.md) | [简体中文](2026-10-20-mcp-closed-connection-late-settle.zh-CN.md)

## Problem and scope

Issue #14880 item 1 has one half left. #14892 gated the live-connection case: `unknown()` records `outcome_unknown` without removing the pending entry, so an answer that arrives on the same connection settles the original exactly once. When the connection itself is gone, the reply has no receiver at all — `client.onclose` marks the pending operations unknown and the connection object, with its `pending` map, is dropped. A client that saw `outcome_unknown` can never learn the conclusive answer.

This document proposes where that recovery belongs. It is a design only: no production behaviour changes here.

## Current state

- `managed-mcp-runtime.ts` keys an in-flight operation by `control.operationId` inside `connection.pending`. `settled()` removes the entry; `unknown()` does not.
- `client.onclose` iterates `connection.pending` and calls `unknown(pending, 'managed_mcp_connection_lost')` for each, then the connection is closed. Nothing retains the ids afterwards.
- The Harness records the unknown view through `commitOperation` and resolves later reads with `lookup()`, which asks the Broker for `mcp-status`.
- `ManagedMcpProtocol.RECOVERY_KINDS` already carries `mcp-status`/`mcp-cancel`/`mcp-release`, and validates their expected id against `targetOperationId`. There is no equivalent for a late result.
- A same-id re-dispatch is **not** a safe generalisation of the release path: `${configurationId}:release` is re-sent because the Runtime joins that id, while `invoke()` deduplicates only inside one connection's `pending` map, so a re-dispatch after the connection is gone runs the tool a second time.

## Decisions

1. **Keep the original operation, do not re-issue it.** The late reply must be written back to the record the client already knows, so `mcp-status` can answer `settled` without a second invoke.
2. **No producer-side hold can receive the reply.** MCP request ids are scoped to one connection: `connection.pending` is the only place the Runtime keys an operation, and `client.onclose` drops that map. Once the connection is gone there is no channel on which the server could deliver an answer for that id, so a Broker-side window would wait forever. The two real options are (a) require MCP servers to expose a re-query keyed by business identity, so the client can ask again after `outcome_unknown`, or (b) accept `outcome_unknown` as terminal and let the caller redo the work, accepting a duplicate side effect. This document recommends (b) for the current contract and records (a) as the change that would lift the limit.
3. **One writer per operation id.** Concurrent `mcp-status` queries inside the window coalesce onto the same held operation rather than each starting a hold; the first conclusive answer settles it and every waiter reads that answer.
4. **The window is a configuration constant, not a per-call argument.** The client cannot extend it, so retry pressure cannot hold a Runtime open.
5. **The gate must be able to go red.** The witness is a fixture that drops the connection after dispatch and answers on a replacement connection; the gate asserts one committed settle, one physical effect and one `mcp-invoke`, and a mutation that removes the hold makes it red.

## Open questions

- Window length: long enough to cover a reconnect (seconds), short enough that an abandoned operation does not pin a Runtime slot. Needs a measurement on the Hosted lane before the value is pinned.
- Where the hold is keyed: by `operationId` alone, or by `(runtimeSessionId, operationId)`, since the former is already unique per Session.
- Whether `mcp-cancel` arriving inside the window should close the hold early; the safe default is yes.

## Acceptance

- A design review settles the three open questions above before any code lands.
- The eventual implementation lands with its gate in the same diff, and the gate fails when the hold is removed.
