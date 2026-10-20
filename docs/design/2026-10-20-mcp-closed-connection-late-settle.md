# Hosted MCP: settling a late reply after the connection is gone

[English](2026-10-20-mcp-closed-connection-late-settle.md) | [简体中文](2026-10-20-mcp-closed-connection-late-settle.zh-CN.md)

## Problem and scope

Issue #14880 item 1 has one half left. #14892 gated the live-connection case: `unknown()` records `outcome_unknown` without removing the pending entry, so an answer that arrives on the same connection settles the original exactly once. When the connection itself is gone, the reply has no receiver at all — `client.onclose` marks the pending operations unknown and the connection object, with its `pending` map, is dropped. A client that saw `outcome_unknown` can never learn the conclusive answer.

This document proposes where that recovery belongs. It is a design only: no production behaviour changes here.

## Current state

- `control()` in `managed-mcp-runtime.ts` deduplicates at Runtime scope: it looks the operation up by Session scope plus `operationId` in the Runtime-level `operations` map, returns the existing view for an identical retry and rejects a changed request as a conflict. `client.onclose` marks the connection closed and calls `unknown()` on its pending operations; it does not delete the connection object or its `pending` map. So the record and the dedup survive — what is lost is the transport that could deliver a reply.
- `client.onclose` iterates `connection.pending` and calls `unknown(pending, 'managed_mcp_connection_lost')` for each, then the connection is closed. Nothing retains the ids afterwards.
- The Harness records the unknown view through `commitOperation` and resolves later reads with `lookup()`, which asks the Broker for `mcp-status`.
- `ManagedMcpProtocol.RECOVERY_KINDS` already carries `mcp-status`/`mcp-cancel`/`mcp-release`, and validates their expected id against `targetOperationId`. There is no equivalent for a late result.
- A same-id re-dispatch is **not** a safe generalisation of the release path: `${configurationId}:release` is re-sent because the Runtime joins that id, while `invoke()` deduplicates only inside one connection's `pending` map, so a re-dispatch after the connection is gone runs the tool a second time.

## Decisions

1. **Keep the original operation, do not re-issue it.** The late reply must be written back to the record the client already knows, so `mcp-status` can answer `settled` without a second invoke.
2. **No producer-side hold can receive the reply.** MCP request ids are scoped to one connection: `connection.pending` is the only place the Runtime keys an operation, and `client.onclose` drops that map. Once the connection is gone there is no channel on which the server could deliver an answer for that id, so a Broker-side window would wait forever. The two real options are (a) require MCP servers to expose a re-query keyed by business identity, so the client can ask again after `outcome_unknown`, or (b) accept `outcome_unknown` as terminal and let the caller redo the work, accepting a duplicate side effect. This document recommends (b) for the current contract and records (a) as the change that would lift the limit.
3. **Record the limitation; do not build a hold.** With the dedup and the record intact but no transport left, `outcome_unknown` is terminal for a closed connection: retrying the same id inside the same Runtime returns the same unknown, so a re-send cannot recover the answer and a Broker window would wait forever.
4. **Name what would lift it, and leave it out of scope.** Either MCP servers expose a re-query keyed by business identity, so a caller can ask again after `outcome_unknown`, or the producer keeps a durable store that survives the Runtime. A bounded in-memory window is neither.
5. **Claim no gate for this case.** The live-connection variant is already gated by #14892; the closed-connection variant is documented as a limitation until item 4 lands, so no acceptance criteria below assume a hold.

## Open questions

- Which lifting option to pursue: a server-side re-query contract, or a durable producer-side store.
- Whether a caller redoing the work after `outcome_unknown` may accept a duplicate side effect, or whether the domain needs idempotency keys first.

## Acceptance

- Both language versions state the same limitation, the same two lifting options and the same absence of a gate.
- The claims about `control()`, `client.onclose` and `connection.pending` match the tree at the reviewed commit.
