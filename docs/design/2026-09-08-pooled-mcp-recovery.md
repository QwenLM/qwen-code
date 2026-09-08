# Recovering lost MCP connections in active ACP sessions

Issue: https://github.com/QwenLM/qwen-code/issues/11272

## Reproduction and ownership

Baseline `bb79319ce5e0e2bbe64307c50dc3621621afc25c` was exercised through a real loopback `qwen serve` daemon and ACP WebSocket sessions, with a deterministic model endpoint and a counted stdio MCP fixture.

Ordinary cancellation delivered `notifications/cancelled`, left the child alive, and allowed both sessions to continue. A fixture that deliberately exited on cancellation exposed a stale CONNECTED status; a fixture that emitted an invalid JSON-RPC frame triggered `silent_drop`, removed session tool registrations, and left later turns unable to call tools. These are controlled fault injections, not proof of the original reporter's teardown mechanism.

There are three lifetimes:

- A tool invocation owns arguments, an abort signal, and one permission decision. It may already have applied a side effect when its response disappears.
- The pool owns the transport and stdio process, shared by connection fingerprint. Its cleanup owns process and descendant teardown.
- Each live session owns a pool reference and filtered tool/prompt/resource registrations. Removing an entry does not close the session, but previously nothing restored these registrations before its next model send.

The SDK's clean-close callback was not reflected in McpClient status. Separately, the invocation reconnect path could use the shared snapshot's bootstrap Config to spawn a private client while the real sessions retained stale handles.

## Design

1. Reflect unexpected SDK close in the existing disconnected status path. An intentional disconnect remains guarded by `isDisconnecting`.
2. Record a recovery candidate only when a held connection emits `failed`. Retain its transport fingerprint, not a tool invocation. Explicit disconnect/stop removes that candidate; initial discovery failure does not create one.
3. Before an ACP model send, recover eligible candidates through the pool and refresh declarations. Preserve the normal folder trust, disabled-server, approval, configuration fingerprint, transport authentication and per-tool permission checks. Recheck eligibility after acquisition so a late result cannot override revocation or shutdown.
4. Serialize a session's recovery with its discovery work. A configuration refresh queued behind recovery runs a full reconciliation afterward; stop invalidates queued refreshes. Reapply current trust and tool filters before attaching a recovered handle, since these fields are excluded from transport identity. Use the pool's existing spawn-in-flight coordination across sessions, wait for the previous entry's cleanup, and impose a shared five-second cooldown after acquisition failure. Each demand makes at most one attempt; there are no background timers or unlimited per-call retries. Explicit management discovery is not throttled by this cooldown.
5. Pool-projected tools delegate recovery to their session. They do not invoke the standalone reconnect/replay path, regardless of annotations. Copying a tool preserves this ownership.
6. Expose recovery success/failure as an ACP diagnostic message. If a turn is cancelled while waiting for a shared connection, stop waiting without cancelling that connection or executing a tool; retain the notice for the next send.

## Existing management interfaces and scope

PR #7309 remains open at `b5f111c02300e39c2c1563af7abbf229e8455341` at investigation time. Its workspace runtime management, authentication, approval and restart routes overlap the management surface, not this demand recovery implementation. Current main already owns a workspace MCP pool and the restart route. This change adds no route, chat command, management platform, authentication bypass, or generic retry framework. PR #11145 concerns initial workspace discovery after preheat; recovery here is limited to previously acquired connections.

## Validation contract

Use counted tools and PID logs, not model prose or `end_turn`, to judge success. Cover ordinary cancellation, cancellation plus controlled exit/error, independent child exit, simultaneous sessions, concurrent acquisition and failure cooldown, explicit disable/disconnect, late shutdown/revocation, discovery timeout and permission denial. Keep the cancelled invocation count at one. Distinguish local macOS daemon evidence from untested production DingTalk infrastructure, Windows/Linux process semantics and real OAuth providers.
