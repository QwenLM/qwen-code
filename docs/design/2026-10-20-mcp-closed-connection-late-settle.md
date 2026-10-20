# Hosted MCP: a late reply after the connection is gone

[English](2026-10-20-mcp-closed-connection-late-settle.md) | [简体中文](2026-10-20-mcp-closed-connection-late-settle.zh-CN.md)

## Problem and scope

Issue #14880 item 1 has one half left. #14892 gated the live-connection case: `unknown()` records `outcome_unknown` without removing the pending entry, so an answer that arrives on the same connection settles the original exactly once. This document covers the other half — the connection is closed before the answer arrives — and records that it cannot be recovered, rather than proposing a mechanism that does not exist.

## Current state

- `control()` in `managed-mcp-runtime.ts` deduplicates at Runtime scope: it looks the operation up by Session scope plus `operationId` in the Runtime-level `operations` map, returns the existing view for an identical retry, and rejects a changed request as a conflict. Retrying the same id therefore does **not** execute the tool twice.
- `client.onclose` marks the connection closed and calls `unknown()` on its pending operations. It does not delete the connection object or its `pending` map, so the record and the dedup both survive the close.
- What the close does destroy is the transport. MCP request ids are scoped to one connection; there is no channel on which the server could deliver an answer for that id to a different connection. The pending entry stays, but nothing can ever fill it.
- The Harness records the unknown view through `commitOperation` and resolves later reads with `lookup()`, which asks the Broker for `mcp-status`.
- `ManagedMcpProtocol.RECOVERY_KINDS` carries `mcp-status`/`mcp-cancel`/`mcp-release` and validates their expected id against `targetOperationId`. There is no equivalent for a late result.

## Decisions

1. **Record the limitation: `outcome_unknown` is terminal for a closed connection.** A retry of the same id returns the same unknown; nothing settles the original later.
2. **Neither a hold nor a durable store recovers the answer.** A Broker or Runtime hold has no reply to wait for. Persisting the operation only persists the unknown the Harness already committed through `accept()` / `commitOperation()`; a store cannot fetch a reply that never arrived. A durable store helps a different window — a received receipt surviving a Runtime restart — and is not a solution here.
3. **Name the only two lifting options, and leave both out of scope.** Either MCP servers expose a re-query keyed by business identity, so a caller can ask again after `outcome_unknown`, or the domain adopts idempotency keys so a caller may redo the work and accept a duplicate side effect. Both are contract changes, not Hosted-internal ones.
4. **Claim no gate for this case.** The live-connection variant is already gated by #14892; the closed-connection variant stays a documented limitation, so no acceptance criterion below assumes a settlement path.

## Open questions

- Which lifting option to pursue: a server-side re-query contract, or idempotency keys plus caller redo.
- If the second is chosen, which tools can tolerate a duplicate side effect and which need a key first.

## Acceptance

- Both language versions state the same limitation, the same two lifting options and the same absence of a gate.
- The claims about `control()`, `client.onclose` and `connection.pending` match the tree at the reviewed commit.
