# Managed restart cancellation recovery

[English](managed-restart-cancellation-recovery.md) | [简体中文](managed-restart-cancellation-recovery.zh-CN.md)

## Problem and scope

Process acceptance found three connected gaps: exhausted transient HTTP renewal retries stopped the background cadence; an unacknowledged prompt after writer expiry could not cancel; and terminal recovery refusal used plain cancellation even when the parked Turn required takeover. Public failure did not settle the native input, so the existing close gate correctly remained shut.

This change repairs these paths without enabling Full Access, replaying Shell, resuming expired writers, bypassing idle-journal checks, or adding public API fields. Automatic continuation after a full writer-lease outage remains outside scope.

## Decisions

1. Keep the healthy renewal cadence. After transport or retryable 5xx failures exhaust their request budget, reschedule at one second only while the original grant remains live. Stop on expiry, refusal or seal start, including in-flight close races. Never acquire a replacement grant implicitly. An activation heartbeat transaction may continue unchanged after three attempts only within the original writer lease captured at submission; ordinary transactions retain their three-attempt limit. Tenant-guard contention retains its shared request budget and cannot restart it through activation retries. Preserve transaction identity, bytes and digests, and retain any later lease obtained by concurrent writer renewal when applying the receipt. Stop background writer renewal after an unrecoverable journal append, except a known rollbackable non-commit refusal. Never clear the authority write-failure latch.
2. A missing admission epoch is not proof of non-admission. Only a dispatch owner with a live claim may cancel an ambiguous prompt after locking its Session and original head, proving the writer sealed or expired and the scoped, uncompacted journal completely idle. Withdraw the submission mark and cancel in the same transaction. Missing, foreign or incomplete evidence stays blocked; an accepted native input cannot use this shortcut.
3. Before terminal recovery failure, a plain cancel refused with `hosted_turn_recovery_required` must use cancellation takeover and the original checkpoint/activation/prompt. Cleanup failure remains retryable rather than making that work unreachable through a terminal public Turn.
4. An `await_runtime` snapshot with an unknown outcome may attempt cancellation of its original execution identity. This does not permit continuation or execution retry. Runtime cancellation must still observe a terminal result or preserve the existing abandoned/unobserved distinction before journaling settlement. Unknown agent/command waits remain ineligible.

## Constraints and risks

Keep tenant, actor, Workspace, dispatch ownership, writer generation and Runtime identity guards. Do not weaken `requireIdleJournal` or certify a stop from HTTP202, timeout or lease expiry. A permanently unreachable Runtime may still block cleanup; retries must preserve uncertainty. Cross-package SDK, Harness and Java consumers must be tested together.

## Validation and acceptance

- Preserve failing baseline tests and prior real Linux evidence separately.
- Cover exhausted writer and activation renewal budgets, identical retries, concurrent lease preservation, stopped renewal after unrecoverable append, rollbackable refusal, expiry/refusal, seal races and unchanged healthy cadence.
- Test live/expired/sealed writers, accepted native inputs, compacted/missing heads and lost dispatch claims.
- Test parked cancellation takeover, transient cleanup refusal, unknown Runtime cancellation with positive stop versus still unknown, no execute replay and one terminal public outcome.
- Build, typecheck and test affected TypeScript consumers; run SDK/server verification, disposable MySQL and matching Hosted recovery profiles.
- Independently repeat real Linux/MySQL Java/Harness replacement with original Worker identities, exact file/marker bytes, successful cancel/close and physical release. Keep the original demo untouched and restore test resources.
