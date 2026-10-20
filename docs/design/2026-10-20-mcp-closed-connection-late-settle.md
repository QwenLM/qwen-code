# Hosted MCP: a late reply after the connection is gone

[English](2026-10-20-mcp-closed-connection-late-settle.md) | [简体中文](2026-10-20-mcp-closed-connection-late-settle.zh-CN.md)

## Problem and scope

Issue #14880 item 1 has one half left. #14892 gated the live-connection case: `unknown()` records `outcome_unknown` without removing the pending entry, so an answer that arrives on the same connection settles the original exactly once. This document covers the other half — the connection is closed before the answer arrives — and records that it cannot be recovered, rather than proposing a mechanism that does not exist.

## Current state

- `control()` in `managed-mcp-runtime.ts` deduplicates at Runtime scope: it looks the operation up by Session scope plus `operationId` in the Runtime-level `operations` map, returns the existing view for an identical retry, and rejects a changed request as a conflict. Retrying the same id therefore does **not** execute the tool twice.
- `client.onclose` marks the connection closed and calls `unknown()` on its pending operations. It does not delete the connection object or its `pending` map, so the record and the dedup both survive the close.
- The close only marks the connection closed — the record and the dedup stay — and this Runtime does not resume it. That is a narrower claim than a protocol-wide prohibition. Streamable HTTP defines resumability and redelivery: a client reconnects with `Last-Event-ID` and the server replays what it missed, including the original response, with no second tool call. The Runtime already constructs `StreamableHTTPClientTransport`, but `client.onclose` never attempts to resume, so this implementation does not use that path. Four states have to be told apart: a physical HTTP connection drop (resumable if the server keeps the session), the current connection object being closed (today's behaviour: no resume), an invalidated MCP session (nothing to replay), and a stdio server exit (no such route at all). The limitation below is about the paths this implementation uses, not about what MCP allows.
- The Harness records the unknown view through `commitOperation` and resolves later reads with `lookup()`, which asks the Broker for `mcp-status`.
- `ManagedMcpProtocol.RECOVERY_KINDS` carries `mcp-status`/`mcp-cancel`/`mcp-release` and validates their expected id against `targetOperationId`. There is no equivalent for a late result.

## Decisions

1. **Record the limitation: `outcome_unknown` is terminal for a closed connection.** A retry of the same id returns the same unknown; nothing settles the original later.
2. **Neither a hold nor a durable store recovers the answer.** A Broker or Runtime hold has no reply to wait for. Persisting the operation only persists the unknown the Harness already committed through `accept()` / `commitOperation()`; a store cannot fetch a reply that never arrived. A durable store helps a different window — a received receipt surviving a Runtime restart — and is not a solution here.
3. **Name the recovery paths in order, and leave all of them out of scope here.** First, implement Streamable HTTP resume — reconnect with `Last-Event-ID` and let the server redeliver the missed response; the protocol already allows it and the Runtime already carries the transport. Second, for servers without resumability, a re-query keyed by business identity. Third, for stdio and for servers with neither, idempotency keys so a caller may redo the work and accept a duplicate side effect. Only the third needs a caller-visible contract; the first is internal to the Runtime, and the second is a server contract.
4. **Claim no gate for this case.** The live-connection variant is already gated by #14892; the closed-connection variant stays a documented limitation, so no acceptance criterion below assumes a settlement path.

## Open questions

- Whether to implement Streamable HTTP resume, and which servers in this workspace can redeliver at all.
- For stdio and non-resumable servers: a server-side re-query key, or idempotency keys plus caller redo.
- If the second is chosen, which tools can tolerate a duplicate side effect and which need a key first.

## Acceptance

- Both language versions state the same limitation, the same three recovery paths in the same order, and the same absence of a gate.
- The claims about `control()`, `client.onclose` and `connection.pending` match the tree at the reviewed commit.
