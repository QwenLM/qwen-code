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
4. Serialize a session's recovery with its discovery work. A configuration refresh queued behind recovery runs a full reconciliation afterward; a later stop or explicit disconnect invalidates that queued work. Reapply current trust and tool filters before attaching a recovered handle, since these fields are excluded from transport identity. Use the pool's existing spawn-in-flight coordination across sessions. All acquisition paths wait for the previous entry's cleanup; shutdown includes evicted entries still being cleaned within its existing deadline. A shared five-second cooldown covers acquisition and session-acceptance failures. Each model send can demand recovery, including tool-loop continuations and scheduled model turns; there are no background reconnect timers or invocation retries. Explicit management discovery is not throttled by this cooldown.
5. Pool-projected tools delegate recovery to their session. They do not invoke the standalone reconnect/replay path, regardless of annotations. Copying a tool preserves this ownership.
6. Refresh tools and ACP prompt commands after recovery; expose success/failure as an ACP diagnostic. Identical notices appear once per logical turn, while each send still refreshes registrations after recovery. If a turn is cancelled while waiting for a shared connection, stop waiting without cancelling that connection or executing a tool; retain its notice until the next send or superseding configuration/management action.

Runtime add and recovery use the same effective transport configuration, including the session cwd for implicit stdio servers. The raw runtime overlay remains unstamped so it can follow a workspace relocation. Retiring a transport settles the SDK's old pending requests and removes its callbacks before reconnecting; a late child-close event cannot clear the SDK's replacement transport. Releasing an unavailable resource handle also detaches its session listener.

Pool-owned tool failures keep an explicit unknown-outcome/no-replay warning, even though they skip invocation-level reconnect. Preventing the SDK from replaying is insufficient if a bare connection error encourages the model to issue the same operation again. This warning does not prove that arbitrary future model decisions will never duplicate a business operation; the client recovery itself performs no tool calls.

A session-acceptance failure can impose the remaining cooldown on another session even if the pool still has a healthy entry. This conservative bound avoids repeated registration failures and concurrent successful returns erasing a failure record. Budget refusals retain the workspace refusal batch and receive budget-specific advice. When pooling is disabled, legacy per-session recovery remains outside this change.

## Existing management interfaces and scope

PR #7309 remains open at `b5f111c02300e39c2c1563af7abbf229e8455341` at investigation time. Its workspace runtime management, authentication, approval and restart routes overlap the management surface, not this demand recovery implementation. Current main already owns a workspace MCP pool and the restart route. This change adds no route, chat command, management platform, authentication bypass, or generic retry framework. PR #11145 concerns initial workspace discovery after preheat; recovery here is limited to previously acquired connections.

## Validation contract

Use counted tools and PID logs, not model prose or `end_turn`, to judge success. Cover ordinary cancellation, cancellation plus controlled exit/error, independent child exit, simultaneous sessions, concurrent acquisition and failure cooldown, explicit disable/disconnect, late shutdown/revocation, discovery timeout and permission denial. Keep the cancelled invocation count at one. Distinguish local macOS daemon evidence from untested production DingTalk infrastructure, Windows/Linux process semantics and real OAuth providers.

## Review follow-up

Session projection deliberately clones a discovered tool to disable standalone reconnect; it is not a zero-allocation path. Tests use an unprojected discovery snapshot and verify that the shared snapshot keeps standalone behavior. Cooldown records expire after five seconds even if their configuration is removed. These expiry timers perform bookkeeping, never connection attempts.

Recovery before model send can delay a turn: stdio discovery defaults to 30 seconds (remote discovery to five seconds), in addition to waiting for old-entry cleanup. The five-second retry cooldown is not a turn deadline. Cancellation stops the caller waiting. This change preserves existing discovery timeout configuration rather than adding another timeout policy.
