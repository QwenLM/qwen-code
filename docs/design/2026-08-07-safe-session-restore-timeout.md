# Safe and observable large-session restore timeouts

## Context

Issue #8678 exposed that session restore reconstructs the persisted JSONL transcript before it can return an ACP `loadSession` or `unstable_resumeSession` response. Large transcripts can therefore exceed the bridge's former shared 10-second initialization timeout. The bridge cannot cancel the underlying ACP request because the current SDK does not expose its JSON-RPC request id or a cancellation operation.

The old timeout path stopped waiting while the child continued restoring. Channel cleanup could then kill a multiplexed child that still owned unrelated live sessions, or a late restore could create a session and writer lease after the caller had already received an error. The resulting error was also classified as a generic initialization timeout or plain 500, which hid the affected session and restore phase.

The 8 MiB live journal and 4 MiB compacted replay limits do not bound this work. They constrain client replay after reconstruction; they do not cap the on-disk transcript read.

## Goals and non-goals

This change gives restore a dedicated configurable deadline, makes timeout errors structured, keeps non-cancellable late work fenced until settlement, and provides phase-level traces across the daemon and ACP child.

It does not stream the JSONL parser, add a transcript index or snapshot, guarantee that every large transcript finishes within 60 seconds, or change the WebUI's detach-before-load transaction. Those are follow-up changes.

Two deliberate gaps are worth stating rather than leaving to be rediscovered.

**Transcript materialization is not separately attributable.** The child records `config_setup` as one stage, and the full JSONL read plus active-chain reconstruction both happen inside it. The JSONL read runs in `loadCliConfig` through `argv.resume`, which both load and resume handlers set; when chat recording and the writer lease are enabled, `config.initialize()` additionally performs an authoritative reload. So a restore that again exceeds its budget shows `config_setup_ms ≈ budget` without telling an operator whether the cost was the transcript or a regressed runtime setup, and the P1/P2 work cannot baseline the phase it exists to optimize from these traces alone. Issue #8678's P0 asks for transcript indexing/read and active-chain reconstruction as distinct phases; this change delivers the coarser split it claims (transcript/config work versus authentication, registration, and replay) and not that finer one. Closing it means instrumenting inside the core session loader — the same code P1/P2 restructures — so it is sequenced with that work. The contained version, if it is wanted sooner, is for the loader to record its own read duration on the resumed session data and for the child profiler to report it as a `transcript_read` stage under the existing attribute prefix.

**Sibling latency during a large restore is unmeasured.** Siblings keep their sessions and stay logically usable, which is asserted; nothing establishes that they stay responsive while a multi-hundred-megabyte transcript is reconstructed on the shared child's event loop. The instrument already exists — the child runs an event-loop lag monitor whose snapshot carries mean, p50, p99, and max — so a fixture slow enough to cross the deadline would close this and the untested empty-channel budget increase in one run.

## Timeout contract

The server restore budget resolves in this order:

1. `sessionRestoreTimeoutMs` / `--session-restore-timeout-ms`, which wins outright — including values below the default, for deployments that deliberately want restore to fail fast;
2. otherwise 60,000 ms, raised to an explicitly supplied `initializeTimeoutMs` / `--initialize-timeout-ms` when that value is larger.

A startup budget may raise the restore budget but never lower it. The two measure different work, and a deployment that tightened its child-initialize check must not silently inherit the sub-default restore deadline this change exists to remove.

Server values must be positive integers no greater than `2^31-1`. The daemon publishes the effective value as optional v1 field `limits.sessionRestoreTimeoutMs` in both bootstrap and runtime capabilities.

The TypeScript SDK chooses a restore timeout in this order: per-request `timeoutMs`, explicit global `fetchTimeoutMs`, cached server capability plus 10 seconds, then 70 seconds. Per-request zero disables the client timer and is not serialized. Calling `capabilities()` refreshes the cached static budget; a restore does not issue an implicit capability request.

The WebUI passes server budget plus 10 seconds to SDK load/resume and uses server budget plus 15 seconds for its own watchdog. Missing capability values fall back to 70 and 75 seconds. Attach retains its existing 30-second watchdog. A derived delay above the JavaScript timer ceiling disables that client-side timer so Node cannot compress it to approximately one millisecond.

## Restore ownership and terminal arbitration

`inFlightRestores` owns two promises: a public promise returned to callers and a settlement promise representing the real ACP request plus cleanup. It also owns the session-id fence and accounts for restore capacity. On normal success, registration transfers capacity to the live session and may release admission; after abandonment, the fence, admission, and in-flight capacity remain until real settlement.

An explicit lifecycle flag arbitrates the deadline and ACP result. Whichever observes `active` first changes the public terminal state. This avoids relying on `Promise.race` callback ordering at an equal-time boundary.

| State       | Meaning and allowed transition                                                                                                                                                                                                                                                                                                                                                          |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `active`    | Same-action, same-shape requests coalesce. ACP success may register the session; failure may return normally.                                                                                                                                                                                                                                                                           |
| `abandoned` | The deadline won. The public caller receives a structured timeout. The id is removed from pending restore events and fenced against late child notifications. Same-id retries receive `restore_in_progress` with `reason: awaiting_abandoned_cleanup` and a retry hint derived from the restore budget — clamped to at least 5 seconds and at most 120 — rather than a fixed 5 seconds. |
| overdue     | One further restore budget passed with no settlement. Existing sessions and workspace control remain usable, but fresh spawn/load/resume/branch work is rejected so the channel can drain — closing the transport is the only lever that releases a permanently hung request. The channel is never force-killed while live siblings remain.                                             |
| cleanup     | A late ACP success or failure triggers exactly one child `qwen/control/session/close`. Resource-not-found is already clean.                                                                                                                                                                                                                                                             |
| quarantined | Cleanup outcome is uncertain. Existing sessions and workspace control remain usable, but fresh spawn/load/resume/branch work is rejected until the channel drains.                                                                                                                                                                                                                      |
| settled     | Close succeeded, the resource was absent, or the transport closed. Restore admission, the capacity slot, and the in-flight entry are released. The notification fence remains until a new registration attempt for that id takes ownership or the channel exits.                                                                                                                        |

Abandonment retains ownership, but not indefinitely. `overdue` bounds the window in which a hung restore can hold an admission slot, an in-flight entry, and a session-id fence that nothing else can release: after the grace period the channel stops taking new work, and the ordinary drain path then recycles the child. Releasing capacity while the hidden work is still running would allow unbounded oversubscription, and force-killing a channel that still has live siblings would reintroduce exactly the failure this change removes — so neither is done.

The abandoned notification fence has no TTL and remains until the channel exits or a new registration attempt for the id explicitly takes ownership. Caller-supplied spawns and restores synchronously reserve that ownership before either path can await channel setup, so opposite-direction races cannot run two ACP registrations for the same id. The ownership transfer happens before the ACP registration call so legitimate startup notifications can be buffered; a failed attempt purges those frames and restores the ordinary 60-second closed-session tombstone.

## Channel safety

At timeout, the bridge removes the id from `pendingRestoreIds`, clears its early events, and records the id in the channel's `unsettledAbandonedRestores`. If the channel has no live sessions, pending spawn, other restore, or workspace-control operation, it is synchronously marked dying and its child is killed asynchronously; the 504 response does not wait for TERM/KILL escalation. The outer `qwen serve` process continues running.

If any sibling work exists, the child remains alive. A late cleanup failure sets a distinct quarantine bit and does not set `isDying`, so sibling attach, prompt, close, and workspace control continue. Fresh work is rejected before capacity checks so the stable error is `acp_channel_unavailable` rather than a coincidental session-limit response. Once visible work drains, the child is recycled and a subsequent request can create a clean channel.

Whether a channel is condemned is **derived, not sticky**. It is reaped once visible work drains while any of these still hold: an ordinary pending empty reap, a non-empty `unsettledAbandonedRestores`, or quarantine. Real settlement removes the id from that set, so a channel whose late restore landed and closed cleanly returns to the configured idle-channel policy rather than being forced into a cold respawn by a timeout it already recovered from. While a restore genuinely remains unresolved, draining is what closes the transport — the only lever that breaks a permanently hung request.

Shutdown waits each real settlement promise, but every ACP request is raced with `channel.exited`. Killing the channel therefore releases shutdown even if the SDK request promise itself never settles. All abandoned-result handlers are rejection-safe.

## Error contract

`SessionRestoreTimeoutError` subclasses `BridgeTimeoutError` but is classified first as `restore_timeout`. REST returns HTTP 504 with a budget-derived `Retry-After` clamped to 5–120 seconds and the fields `code`, `errorKind`, `retryable`, `sessionId`, `action`, and `timeoutMs`. ACP HTTP and WebSocket return JSON-RPC `-32603` with the same data plus `httpStatus: 504` and `retryAfterSeconds`.

A channel closed to fresh work rejects it with HTTP/ACP status 503 and code and error kind `acp_channel_unavailable`. `reason` distinguishes the two causes: `restore_cleanup_failed` (cleanup of a timed-out restore failed, so the child's state is unknown) and `restore_settlement_overdue` (an abandoned restore has still not settled one restore budget after its deadline).

## Observability

The bridge creates a restore span and always injects its trace context into ACP load/resume metadata. It records action, channel id, session id, configured budget, public result, late result, and cleanup or quarantine result without transcript content.

The child continues that context in `qwen-code.daemon.session_restore` and records durations for settings load, live restore or persistence existence check, config setup, authentication, filesystem setup, session registration/replay, and response construction. The first failing stage is recorded as `failed_stage`.

## Verification

Unit tests use deterministic delayed children and fake timers for empty-channel reap, sibling survival, same-id fencing, exactly-once late close, quarantine drain and recovery, capacity retention, transport-close arbitration, and hanging-request shutdown. REST and ACP mappings, capability propagation, SDK transport abort behavior, WebUI timer derivation, trace propagation, and failed-stage attribution are asserted independently.

The E2E plan uses a delayed child to validate the public deadline and process survival. An approximately 80 MiB transcript is a manual benchmark and trace fixture only; CI does not assert a machine-dependent latency.
