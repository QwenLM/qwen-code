# ACP startup and restore budgets

[English](acp-startup-restore-budgets.md) | [简体中文](acp-startup-restore-budgets.zh-CN.md)

## Problem

PR #14985 gives child creation and the ACP initialize handshake separate budgets. Each phase receives `initializeTimeoutMs` (`T`), with an absolute deadline for their pair of `2T`. Failure teardown can additionally await up to `T`; it must retain its graceful termination and forced-kill escalation.

Session restoration currently starts its timeout after channel acquisition. A 9-second spawn, 9-second handshake, and 53-second restore therefore complete at 71 seconds, beyond the SDK's default 70-second request deadline. Both load and resume exhibit this with the actual bridge and deterministic ACP transport.

## Scope and decision

Keep the initialize setting, defaults, protocol limits, and client timeout formulas unchanged. Document the two startup phases and separate failure teardown accurately.

For a fresh restore, use one monotonic `sessionRestoreTimeoutMs` deadline from the beginning of owner preparation through the ACP load/resume request. Engine selection, channel acquisition, and remembered-language delivery consume this budget. Each preparation await is bounded, and the ACP request receives only the remaining budget. Expired preparation never dispatches a late load/resume request, even when an event-loop stall delays timer callbacks. System-clock corrections cannot change the remaining budget.

This includes readiness in the advertised restore budget instead of publishing a new startup limit or changing SDK/Web Shell headroom. At defaults, restoration has 60 seconds, while SDK requests retain 10 seconds of headroom and the Web Shell watchdog retains 15 seconds. Slow restores can time out earlier than with the previous extra unadvertised startup allowance; operators can configure a larger restore timeout.

The implicit restore budget remains `max(initializeTimeoutMs, 60000)`, not twice the initialize timeout. At an initialize timeout of 30 seconds, the two startup phases can consume the entire 60-second restore budget; above 30 seconds, their combined bound exceeds the implicit restore budget. For slow cold starts, explicitly set `--session-restore-timeout-ms` above twice `--initialize-timeout-ms`, with additional time for engine selection, remembered-language delivery, and the ACP restore request. For example, a 40-second initialize timeout still derives a 60-second restore budget, while startup alone can take 80 seconds. An explicit restore value always wins, even when shorter.

## Ownership and cleanup

The bridge remains scoped to its resolved workspace runtime, and execution-engine selection stays authoritative. No daemon route or runtime fallback changes.

Channel acquisition is shared. A restore deadline stops that caller's wait without cancelling another caller's channel startup. Late readiness may warm the channel, but cannot issue the expired caller's ACP restore. When `channelIdleTimeoutMs` is positive, the late channel enters the configured idle policy after shared work drains; at zero, it remains warm for first use. The existing owner finalizer releases admission, closes event buffers, and settles coalesced waiters when preparation fails.

Once ACP restoration starts, retain existing timeout fencing, late-result cleanup, and empty/shared-channel handling. Report preparation deadline failures as `SessionRestoreTimeoutError` with `dispatched: false` and a timeout public result. REST returns retryable `504 session_restore_timeout` with `dispatched: false` and no `Retry-After`; no abandoned-restore fence exists, so a same-ID retry is immediately allowed. Dispatched timeouts keep their existing fence and budget-derived `Retry-After` (clamped to 5-120 seconds). Preparation-expiry diagnostics identify `engine_selection`, `channel_readiness`, `language_delivery`, or `dispatch_boundary` in stderr and telemetry; these stage tokens do not change the wire contract and are absent from dispatched-timeout diagnostics. Warm-session attachment and post-restore state application retain their existing behavior.

## Validation and acceptance criteria

- With `T=50 ms`, a 45 ms factory and 30 ms handshake succeed; warm preheat reuses that channel.
- Clock jumps that leave 25 ms or exhaust the absolute startup deadline produce the clamped 25 ms or 1 ms handshake budgets. Removing the clamp or widening the deadline must fail these assertions; restoring the shared budget must fail the successful cold-start case.
- Both cold load and resume settle at the advertised restore deadline, before the SDK/Web Shell headroom, while a restore that fits the remaining budget succeeds.
- Preparation can time out while engine selection, channel acquisition, or remembered-language delivery is pending. A late preparation result issues no restore and does not retain an admission slot or damage a shared channel.
- Forward and backward system-clock corrections leave the restore deadline unchanged. An elapsed monotonic deadline blocks late channel acquisition after engine selection and late ACP dispatch after language delivery, even before the timer callback runs.
- Preparation expiry allows a same-ID retry without leaking admission and carries no budget-derived REST retry hint; dispatched expiry retains its fence and hint.
- A late channel after preparation expiry respects a positive idle timeout without disrupting shared work; a zero idle timeout retains the warm channel for first use. Preparation diagnostics distinguish the expired stage and classify non-timeout failures as failures.
- Existing restore abandonment, cleanup, coalescing, per-engine ownership, startup cancellation, and warm reuse remain covered by package tests.
- Build, bundle, typecheck, formatting, lint, and independent verification must pass. The original slow Windows workspace is unavailable; deterministic transport tests establish timing behavior, with built CLI smoke reported separately.

## Open questions

None required. Client deadline formulas and general post-restore processing deadlines are outside this fix.
