# ACP session initialization deadline

Status: implemented for PR3

Proposed PR title: `fix(daemon): Cancel timed-out session initialization`

## Problem

The daemon bounds `newSession`, but the timeout historically rejected only the Bridge wrapper. The ACP request continued inside the child. A slow `SessionStart` command hook could therefore finish after the caller had already received `init_timeout`, publish a real child Session that the Bridge never registered, and leave hook descendants or other session resources alive.

This is different from an ACP channel teardown. A shared channel can own healthy sibling Sessions, so killing the channel at the first session timeout would turn one failed create into unrelated session loss. It is also different from the HookRunner and ACP process-tree fixes: those changes provide tree-aware cancellation and channel cleanup, but neither decides when session initialization should be cancelled.

## Scope

This change makes the existing Bridge initialization budget authoritative for the standard trusted daemon-to-ACP path:

- the Bridge sends an absolute initialization deadline with each `newSession` request;
- the managed ACP Agent converts that deadline into an `AbortSignal`;
- Config and Gemini initialization forward the signal into `SessionStart` hook execution and check it at initialization boundaries;
- the Agent rejects before publishing a timed-out Session;
- the Bridge retains a compatibility lifecycle for an older Agent that ignores the deadline and settles late.

The public API remains the existing `init_timeout` failure. The private deadline and internal child error kind do not become HTTP or SDK fields.

## Deadline contract

The Bridge writes `qwen.daemon.sessionInitializationDeadlineMs` into `_meta` immediately before dispatching the actual ACP request. Its value is an absolute Unix timestamp derived from the configured `initializeTimeoutMs`. An absolute deadline prevents serialization, transport, and child scheduling time from accidentally granting a new full budget at each layer.

Only an ACP Agent that completed the private managed-parent capability handshake reads the field. An untrusted or standalone ACP caller cannot use request metadata to cancel initialization. A trusted value must be a positive safe integer within Node's supported timer range; malformed values fail before settings or session state is created.

The Agent owns one request-scoped `AbortController`. Its timer is unreferenced and cleared in `finally`. The signal is not stored on the resulting Session and cannot cancel later turns.

## Cancellation path

The signal follows the existing initialization ownership path:

`ACP newSession -> Config.initialize -> GeminiClient.initialize -> startChat -> SessionStart HookSystem -> HookRunner`

Config checks cancellation before registering initialization state and after awaited initialization phases. GeminiClient passes the signal into `SessionStart`, checks it after the hook result, and rethrows its abort reason instead of applying the hook's ordinary best-effort error policy. This is required because HookSystem can aggregate cancellation into a result instead of throwing it directly.

Before `QwenAgent` publishes the new Session in its session map, it checks the signal again. The child reports the private `session_initialization_timeout` error kind, and the Bridge maps it back to the existing `BridgeTimeoutError('newSession')` contract.

The change does not race the whole Config initialization against a rejecting wrapper Promise. Doing so would let cleanup run concurrently with initialization code that still owns the same Config. Operations without an AbortSignal API finish normally and are followed by a cancellation checkpoint; the Bridge compatibility lifecycle remains the outer containment boundary.

## Late-result compatibility

The Bridge observes the raw ACP request after its public timer fires. This protects rolling upgrades and other Agents that do not yet consume the private deadline.

- A late failure releases the hidden-work accounting and any caller-supplied ID fence.
- A late success is never registered. The Bridge sends one bounded `qwen/control/session/close` for the returned Session ID, and only `closed: true` is accepted as proof that cleanup completed.
- Resource-not-found means cleanup is already complete.
- A close failure quarantines only fresh session admission on that channel. Existing sibling Sessions continue until they drain, after which the channel is reaped.
- If the raw request remains unsettled for one additional initialization budget, the channel similarly refuses fresh Sessions until the request settles or the channel drains.
- An empty timed-out channel follows the existing immediate teardown path; a shared channel is not killed while siblings remain.

The Bridge holds the fresh-session admission reservation and a caller-supplied ID reservation until the raw request and cleanup settle. Abandoned requests count toward `maxSessions`, and shutdown awaits their settlement after initiating channel teardown. This prevents retries from overcommitting resources or reclaiming an ID that a late child response can still create.

## Failure semantics

- A deadline enforced by the new Agent and a wrapper timeout from an older Agent both surface as the existing public initialization timeout.
- A normal initialization failure remains unchanged.
- A timed-out Session is never inserted into the Agent or Bridge session maps.
- Existing Sessions on a shared channel remain usable during late settlement and cleanup.
- Cleanup uncertainty fails closed for new session creation but does not broaden into daemon-wide or sibling-session termination.
- Channel exit settles abandoned work through the existing transport-close race.

## Non-goals

- Changing the configured initialization timeout or adding per-endpoint deadlines.
- Cancelling load or resume, prompt execution, authentication APIs, MCP discovery APIs, or arbitrary extension initialization.
- Changing HookRunner timeout defaults or HookRunner process ownership.
- Replacing ACP process-group cleanup with cgroups, Windows Job Objects, or another OS supervisor.
- Changing standalone binding, session ownership, bridge routing, or HTTP response shapes.

## Verification

- Reproduce the baseline with a shared channel whose second `newSession` times out and later succeeds: the child creates a Session that the Bridge cannot see.
- Verify the Bridge sends an absolute deadline, preserves the public timeout type, closes a late-created Session, keeps a sibling alive, fences a requested ID, counts abandoned work against the cap, and quarantines fresh admission on cleanup failure or overdue settlement.
- Verify only a trusted managed parent can activate the Agent deadline and that abort rejects before Session publication.
- Verify Gemini initialization forwards the signal into `SessionStart` and does not swallow cancellation as an ordinary hook failure.
- Run the affected Bridge, Agent, Config/client, HookRunner, and process-tree tests, followed by build, typecheck, lint, formatting, and clean-diff audits.
