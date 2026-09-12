# Pooled MCP connection lifetime and teardown hardening

[简体中文](./2026-09-12-pooled-mcp-lifetime-infra.zh-CN.md) · Related issue: https://github.com/QwenLM/qwen-code/issues/11272

## Status

Extracted from #11392 as the first half of a split requested in review. This change covers the pool ownership and teardown paths that demand recovery will build on. One piece changes live behaviour: a pool-managed client now reflects an unexpected transport close in its status, which evicts the entry and removes the session's MCP tools. This change does not re-acquire anything; the recovery follow-up for issue #11272 is separate.

## Problem

The transport pool assumes a shared connection is only replaced on a configuration change or an explicit shutdown. Three of its rules are therefore correct only under that assumption, and all three are reachable once a parent agent and a derived agent share one pool under a single logical session id:

- Subscriptions are keyed by logical session id, so a derived agent's registry and its parent's collide on the same key. Acquiring the second registry overwrites the first's view, and releasing either drops the shared reference.
- A release names only the session, so a superseded handle could detach the connection that replaced it.
- An entry leaves the pool index when teardown starts, not when it finishes, so a concurrent acquire could spawn a second process for the same connection fingerprint before the previous one exited.

Separately, an EOF-killed stdio server was invisible: the SDK does not invoke `onerror` on that path, so the entry stayed `active` with the tools registered against a dead transport. And the SDK close path had no timeout, so a hung transport could leave teardown unresolved.

## Goals

- Make pool ownership and teardown ordering correct when a connection is replaced or shared by several registries, without changing existing behaviour for healthy paths.
- Detect an unexpected transport close for pool-managed clients so a dropped connection is observable and its entry is evicted.

## Non-goals

- Re-acquiring a failed connection, re-registering a session's declarations, or emitting recovery notices. That is the #11272 follow-up.
- Workspace budget refusal accounting, runtime-addition serialization, cross-registry inheritance, and the retry cooldown — deferred until the follow-up has a caller for each.
- Any new command, route, flag, or configuration key.

## Design

1. **Seat-scoped attachment.** Each pool subscription is indexed by a seat — the pair of logical session id and `ToolRegistry` identity. `release` and `releaseSession` detach per seat, so one registry cannot remove another's reference. Unpooled entries record their owning session for the same reason.
2. **Handle-identity release.** A connection handle carries its own identity and passes itself to the release callback. Detach succeeds only when the handle is still the one bound to the seat. Re-attaching a seat disposes the superseded handle (clears its listeners, marks it inert); its pool release then no-ops by identity, and the only unpooled caller builds a fresh entry per acquire.
3. **Cleanup barrier.** Closing a connection publishes a cleanup promise before subscribers are notified. Acquire waits for any in-flight cleanup of the same connection fingerprint (including entries already evicted from the index) under a deadline that is at least the teardown budget plus slack for the descendant pid sweep. On timeout the acquire fails closed and keeps the barrier, so a replacement process is never started over a previous one that has not finished exiting.
4. **Bounded teardown.** `transport.close()` and `client.close()` are bounded by `TRANSPORT_CLOSE_TIMEOUT_MS`; `MCP_TEARDOWN_TIMEOUT_MS` is the worst-case disconnect budget derived from it. Descendants are already signalled before this point, so a timed-out close cannot leak a process tree.

## Behaviour change: unexpected transport close is now observed

For pool-managed clients (`trackTransportClose`), an unexpected SDK close now records `lastTransportError` and flips the client status to `DISCONNECTED`. That reaches the entry's status listener, which transitions the entry to `failed`, emits `failed`, detaches each subscriber (each `view.teardown()` removes that session's MCP tools), and evicts the entry from the pool.

Before this change an EOF-killed server was invisible: the entry stayed `active`, status stayed `CONNECTED`, and the tools stayed registered against a dead transport. After it, the status flips and the tools are removed — observable through `/mcp`, `GET /workspace/mcp`, and the model's tool list. This is the detection half of #11272; re-acquisition is the follow-up.

## Invariants

- A release can only remove the seat and handle it actually owns.
- No two transports for the same connection fingerprint are started while an older one is still being torn down.
- Teardown is bounded, so the cleanup barrier always settles.

## Risks and limitations

- Acquire can wait up to the teardown budget plus slack while a prior teardown runs; on timeout it fails closed rather than spawning over it. A teardown that never settles (bounded) leaves the server unavailable until drain or restart; this change adds no forced-bypass path.
- Until the recovery follow-up lands, a dead pool-managed connection stays disconnected: the tools are removed and nothing re-acquires them.
- The seat and handle semantics require callers to pass their handle to `release`. Existing callers that omit it detach every seat for the session, which is the previous behaviour.

## Validation plan

- Unit tests for seat isolation across two registries on one logical session, handle-identity detach and superseded-handle disposal, the cleanup barrier (including timeout and draining), retirement accounting, and the `onclose`-driven status transition.
- `tsc --noEmit` for the core package and the affected suites.
- The two seat tests exercise the exact parent/derived-agent aliasing path described above and fail under the old session-only keying.

## Acceptance criteria

- Existing pool and MCP client tests pass.
- New tests pin each invariant above, and the aliasing regression is reproducible against the old keying.
- No new route, command, or config key; no production caller of any deferred primitive.

## Follow-up

Demand recovery (#11272): re-acquire a failed connection before a model send and re-register the session's declarations without replaying an interrupted call. The deferred primitives — a per-fingerprint retry cooldown, workspace budget refusal preservation, and raw-recipe access — land there, where they have callers.
