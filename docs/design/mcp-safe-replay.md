# Safe replay after MCP connection loss

## Problem

An MCP tool can complete a side effect before its response connection fails. Reconnecting and sending the same `tools/call` again can therefore repeat a write while the user sees only the second result. MCP tool annotations are optional and default to non-idempotent behavior, so missing annotations cannot justify automatic replay.

## Replay policy

Qwen Code automatically replays a failed invocation only when all of the following are true:

- The failure is classified as a connection loss by the existing MCP connection checks.
- The MCP server has `trust: true`.
- The current workspace passes the workspace trust gate.
- The tool declares `idempotentHint: true`, or declares `readOnlyHint: true` without `destructiveHint: true` or `idempotentHint: false`.

Conflicting annotations are not treated as safe. In particular, a tool that declares itself read-only while also declaring destructive or non-idempotent behavior is not replayed. An explicit idempotency declaration can cover a mutating operation, but it does not override contradictory read-only annotations.

The same decision is applied to both execution paths: the direct MCP client used for progress-aware calls and the callable fallback. Abort errors, non-connection errors, and MCP `isError: true` protocol results retain their existing behavior.

After reconnecting, Qwen Code applies the same trust and annotation checks to the newly discovered tool before sending the replay. It does not carry a previous server process's trust or annotations into the new invocation.

## Failure behavior

When a connection failure is not safe to replay, the current invocation does not reconnect or construct a second invocation. It returns a stable error explaining that the operation may have completed and must not be retried automatically. The error does not include tool arguments or the upstream transport error.

Connection recovery for later, independent calls remains the responsibility of the existing health monitor, an explicit reconnect, or the normal discovery lifecycle. Safe calls retain the existing bounded reconnect behavior.

## Compatibility

This is an intentional conservative change. Tools without annotations no longer receive transparent connection-loss replay, even when an older Qwen Code release retried them. Servers that want replay must provide accurate annotations, and administrators must opt into server trust in a trusted workspace.

MCP annotations are behavior hints supplied by the server, not an authorization boundary. Qwen Code uses them for replay only after both server and workspace trust gates pass.

## Verification

Tests cover the direct client and callable fallback, safe idempotent and read-only declarations, missing and contradictory annotations, both trust gates, re-discovered tools that lose trust or annotations, connection error classification, aborts, protocol errors, reconnect failure, and the retry limit. A separate local E2E record exercises a server that commits a side effect before dropping the response connection and verifies that an unsafe call reaches the server only once.
