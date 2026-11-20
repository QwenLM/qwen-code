# Managed Control-Plane Wake: Seal-Time Wake Stamp

[English](2026-11-19-managed-control-plane-wake-seal-stamp.md) | [简体中文](2026-11-19-managed-control-plane-wake-seal-stamp.zh-CN.md)

Status: accepted; implementation in progress. Date: 2026-11-19. Addendum to the [Phase 3 control-plane wake design](2026-11-19-managed-control-plane-wake.md) (#17805), checked against `main` at `adca3e7ddc`. It replaces the 3a wake-scheduling mechanism of that design — the commit-path head due-time hint, the separate due dispatcher, and the control-plane cold re-derivation of the unattempted proof — with a stamp the suspending writer writes in its seal. It does not change 3b, the passive-only wake verb, the seal-time unattempted proof of §4.3, or the load-counting invariants. §5 lists every parent section it supersedes.

## 1. Problem

The parent design's 3a mechanism has three defects, the first two reproduced on H2 against the production `JdbcWakeRecoveryStore` (the Java wake files are unchanged between the tested commit `4ed278b37c` and `adca3e7ddc`; H2 does not establish MySQL behavior):

1. **The backstop re-proves every suspended far-future head on every claim cycle.** A suspended head whose only pending input is a future loop wakeup keeps `is_wake_pending = 1` (OR-ed at accept, `JournalCommit.java:263`, and never cleared while a deferred input remains, `JdbcWakeRecoveryStore.java:253-262`), so it stays in `findPending` (`:98`) and is re-claimed whenever the 30 s claim delay lapses (`:123`). Today the complete deferred proof is memoized and a re-claim reads nothing. The parent's rule that a complete only-future proof is not cached (§4.1) turns each re-claim into a full replay. Reproduction: one sealed far-future head with a 10-transaction journal, 5 claim cycles — selected and claimed 5/5 times, never loaded; 10 journal reads with today's cache, 50 when each cycle starts without a cached proof, as the parent rule implies for this head. 3a makes this population routine; the cost grows with the number of suspended deferred Sessions times their journal length, and these heads occupy the backstop's 8-candidate page.
2. **Not caching complete only-future proofs does not remove the starvation for long journals.** A journal longer than the 32-transaction proof budget leaves a partial proof, which is still cached and stays resumable (`canResume`, `:296`) until its fire time, so the cache-full branch (`:275-291`) still refuses to memoize a due Session's proof. Reproduction: 128 far-future heads with 40-transaction journals scanned once; a due Session with a 40-transaction journal then polled 5 times reads 5 × 32 transactions, each poll restarting at revision 0, and never reads transaction 40. Under the parent rule a holder releases its slot only when its next poll completes it, and re-pins on the poll after; the starvation becomes slot churn, not gone.
3. **The cold unattempted proof is not cheap.** The parent §4.6 has the control plane re-derive, per pending input, whether a transcript attempt exists. The attempt marker is `daemonPromptId` inside each message body; the `message.committed` payload carries only `messageId`, `role`, `contentRef`, `modelAttemptId`, `parentMessageId` and `diagnosticsRef` (`managed-session-records.ts:965-975`), so Java must replay the journal and read every message body, as `JdbcManagedToolDetailsStore.java:109` does for one prompt. The recovery view backs every ordinary Session read ([recovery view addendum](2026-11-18-managed-suspension-recovery-view.md) §1), so this cost lands on the read path.

## 2. The fact that makes a simpler mechanism sufficient

Every journal commit requires the live writer (`JournalCommit.java:121`), and inputs are admitted through the Harness authority (`submitInput`). An unowned head's pending set therefore cannot change until a writer is acquired again: what is pending at a clean suspension stays exact until the next acquisition.

The suspending Harness already holds the full committed prefix and already computes both facts the control plane needs: the wake pump's pick (`hosted-harness-session.ts:7729-7817`) yields the deliverable wake inputs — wake sources, excluding a stopped run's messages — that are due now and the earliest deferred `notBefore`; and the parent §4.3 seal-time check proves every pending wake input unattempted (`wakeHasPriorAttempt`, the ownership-release predicate at `:4876-4893`). As the parent §1.1 observes, only the clock is resident. The writer can persist it in the seal, and the control plane needs neither a commit-path hint nor a re-derivation.

## 3. Mechanism

### 3.1 One head column, two writer-fenced writes

`ma_session_head` gains one nullable column, `wake_seal_revision`: the journal revision at which a clean suspension sealed the head and certified its wake projection.

- **Acquire.** The generation-incrementing writer acquisition (`JournalWriterLifecycle.java:288`) also writes `wake_seal_revision = NULL` and caps `wake_retry_at` at one claim delay from now (`LEAST(wake_retry_at, NOW + RETRY_MS)`). Any new writer — a wake, a user request, a load that later refuses — invalidates the previous stamp. The cap removes a stamped future due time, so a writer that accepts an immediate input and then crashes is recovered by the backstop on today's schedule; it never lowers the delay a claim just set, so a load that keeps refusing is still retried at the claim pace, not on every scan.
- **Suspension seal.** `/writers:seal` (`http-managed-session-store.ts:2947`; `SealWriterRequest`, `ManagedSessionStoreModels.java:164`) gains an optional `wake` object `{revision, pending, dueAt}` that only the suspension teardown sends (`hosted-harness-session.ts:5124`). Immediately before the seal the Harness recomputes, over the committed prefix, exactly what the pump would pick: `pending` is whether any deliverable wake input remains; `dueAt` is `0` if one is due now, otherwise the earliest deferred `notBefore`. The seal UPDATE (`JournalWriterLifecycle.java:399`), already fenced by writer token and generation, additionally requires `journal_revision = revision` and writes `wake_seal_revision = revision`, `is_wake_pending = pending`, `wake_head_revision = revision`, and, when pending, `wake_retry_at = dueAt`. The Harness store client fills `revision` from its writer grant. A revision mismatch refuses the seal (`409 managed_session_wake_stamp_stale`); the teardown treats it as a failed step, recomputing the stamp on each precise retry and escalating at the existing cap.
- Every other seal — a refused load's `managed.close()`, a bare `writers:seal`, the ownership release — sends no stamp, and the acquisition before it has already cleared any earlier one.

The stamp is authoritative because it is written by the authority that wrote the journal, from the full prefix, under the head lock at the exact revision; it cannot go stale because nothing commits until the next acquisition clears it.

### 3.2 Due-time dispatch is the existing backstop

The backstop already selects `is_wake_scan_pending AND wake_retry_at <= NOW` over unowned heads, ordered by `wake_retry_at` and served by `idx_ma_head_wake (is_wake_scan_pending, wake_retry_at, …)` (`V1__managed_schema.sql:224,1474`). After a stamp, a head with nothing pending leaves the scan set; a head whose earliest input is deferred is invisible until `dueAt`; a head with a queued input is selected on the next scan.

`WakeRecovery.scan` (`WakeRecovery.java:39-70`) gains one branch: after a successful claim, a candidate whose `wake_seal_revision` equals its journal revision skips `hasPendingInput` — the stamp already proves a due deliverable input at this revision — and proceeds to the existing parent-run check and passive `recoverForWake`. An unstamped head (crashed writer, refused load) keeps the existing proof path unchanged.

This removes, relative to the parent design: the `wake_due_at` column; commit-path hint maintenance (the null-safe `LEAST`, the pending-but-unknown state and its repair pass); the four-outcome proof; the separate `WakeDispatchJob` and its claim; and any change to the proof cache. Stamped heads never enter the cache and are never replayed before or at their due time, so the parent §5.1 question of a per-input index no longer arises. Due-to-load latency is bounded by the backstop scan period (`qwen.managed-agent.wake-recovery.scan-delay`, 2 s by default) plus the load; a transient load refusal retries after the claim delay (`RETRY_MS`, 30 s). §6 measures both.

The crash path is out of scope and unchanged: an unstamped head left by a crashed writer with only future inputs keeps today's 30 s re-claims against a memoized deferred proof, and the pre-existing cache pressure from such heads stays as it is on `main`. The parent's no-cache rule is withdrawn because, on that path, it turns each re-claim into a full replay (§1, item 1).

### 3.3 Recovery view

The `ready` arm accepts `wake_seal_revision == journal_revision` beside `wakeProven` (`SessionRecoveryService.java:147`); its other guards stay: sealed writer, released activation, current activation projection, no unsettled work. `wakeProven` is kept because a Harness without the capability sends no stamp, and its clean suspensions would otherwise stop reporting `ready`; it still cannot hold for a head with a pending input, so a stamped pending head becomes `ready` only through the stamp.

The stamp arm has no session-kind or compaction guard, so it widens `ready` beyond what the scan-based proof covers (recovery view addendum §3): a stamped child Session reports `ready` like a public one. The widening is intended, since the writer's certification does not depend on scan eligibility. Compaction runs only on a deleted head, so a compacted journal never reaches this arm for an `ACTIVE` Session.

Only a clean suspension writes the stamp, after the per-input unattempted proof; every acquisition clears it, so the seal of a load that refuses can never inherit an earlier stamp; and any commit moves `journal_revision`. This is the positive proof the recovery view addendum §2 requires, read from one column, with no journal replay and no message-body read on the read path. As a side effect, a suspension with nothing pending reports `ready` right after its seal rather than after the backstop's next proof.

### 3.4 Transport notice

The parent §4.2 due recheck stays and becomes a head-column condition in the wake fence (`TransportWakeActivator.java:125-139`): a head with `wake_seal_revision = journal_revision AND (is_wake_pending = 0 OR wake_retry_at > NOW)` either has nothing deliverable or has its next attempt already owned by the backstop at `wake_retry_at`, so the notice is dropped (`NOT_DUE`). Because the stamp certifies the whole projection, the `is_wake_pending = 0` arm is as safe as the future-due arm, and it covers a notice delayed past a seal whose input had already settled. A notice for a due stamped head still loads through the existing `activateForWake`; moving the transport to the passive verb is not part of this slice.

### 3.5 Rollout

The Harness relaxes the `pendingInputs` gate (parent §4.3) and sends the stamp only when the control plane advertises the wake-dispatch capability (`qwen.managed-agent.wake-dispatch.enabled`, default off; the parent's key), which it advertises only where the backstop runs. The advertisement is `wakeDispatch: true` in the writer grant that `writers:acquire` and `writers:renew` return, beside `activationLeaseRenewal`: the Store that issues the grant is the one that consumes the stamp, the backstop runs wherever that Store is enabled, and an older Harness ignores the field. The relaxed gate admits only deferred, unattempted wake inputs: a non-wake input or one with a transcript attempt keeps its existing recovery (the ownership release's predicate), a due input is the pump's to run now, and a stopped run's message waits for the relay's stop, whose flag is not durable. A due or stopped-message stamp, items (c) and (d) of §7, therefore comes only from an input committed between the gate's last check and the seal. Disabling it stops new relaxed suspensions; heads already stamped are still delivered by the backstop at their due time, and a control plane without the §3.2 branch delivers them through the ordinary proof. 3a therefore needs no rollback ordering; the parent's producer/consumer ordering applies to 3b staging only.

## 4. Decisions

- **The writer's seal-time projection replaces the control plane's independent replay for stamped heads.** The recovery view addendum §2 relies on the wake scan clearing the hint only after an independent replay; that independence protects against writer loss, which a completed seal rules out. A wrong pending computation in the Harness would equally misdeliver inputs while resident, because the stamp reuses the pump's own pick. Unstamped heads keep the independent replay.
- **Reuse `wake_retry_at` as the due time instead of adding `wake_due_at`.** The backstop already orders and indexes by it, and it is `NOT NULL`, so no null-safety rule is needed. The claim delay and the due time share the column without conflict: a claim happens only once the due time has passed, and it moves the value to 30 s after the claim.
- **One stamp serves dispatch, recovery view and transport.** The parent kept the clean-suspension proof only for `ready`; the same column also lets the backstop skip the replay and the transport skip a not-yet-due notice.

## 5. Parent sections superseded

| Parent section                                                                                                                                                                       | Status                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §1.2 "The gap" paragraph, §2 3a scope, §3.2 additions                                                                                                                                | The due time is stamped at the seal and served by the existing backstop (§3).                                                                                                     |
| §4.1 head due-time hint, proof-cache rule                                                                                                                                            | Replaced by §3.1; the no-cache rule is withdrawn (§3.2).                                                                                                                          |
| §4.2 steps 1, 2, 4                                                                                                                                                                   | Replaced by §3.2. Step 3 (passive verb), burst control and the takeover path are unchanged; the transport recheck is §3.4.                                                        |
| §4.3                                                                                                                                                                                 | The seal-time unattempted proof is unchanged and is now also the stamp's precondition; the rollout paragraph is §3.5.                                                             |
| §4.6 first two bullets                                                                                                                                                               | Replaced by §3.3. The 3b bullets and the rest are unchanged.                                                                                                                      |
| §5.1, §5.2                                                                                                                                                                           | Superseded by §2–§4 of this addendum.                                                                                                                                             |
| §7 items 2–3                                                                                                                                                                         | Replaced by §6.                                                                                                                                                                   |
| §8 risks: head-hint null safety; proof result must distinguish future-only from incomplete; proof-cache starvation; proof-replay cost; fast-scan selectivity; cold unattempted proof | Withdrawn; the mechanisms they guard no longer exist. Passive-only dispatch, load counting, transport recheck, attempted-input proof at seal and cancelled-input settle are kept. |
| §9 3a items: head-hint null safety; head-hint unknown state; proof refresh; proof-cache saturation; fast-scan selectivity; cold unattempted proof                                    | Replaced by §7. The other 3a items are kept unchanged.                                                                                                                            |
| §10 items 1–3                                                                                                                                                                        | Replaced by §8.                                                                                                                                                                   |
| §11 3a bullet and slice (1)                                                                                                                                                          | Slice (1) becomes: the `wake_seal_revision` column, acquire cap, seal stamp, backstop branch, `ready` guard, transport fence and capability gate, plus §6 measurement.            |

3b (§4.4, §4.5 and the 3b parts of §4.6–§11) is unchanged.

## 6. Measurement

Replaces parent §7 items 2–3; it extends the same rig.

1. **Due latency**: fire-to-turn-start for stamped heads with journals of 1, 40 and 200+ transactions; it should not depend on journal length. Choose the backstop scan period.
2. **Synchronized due batch**: N stamped heads due at once against `HOSTED_COLD_OPEN_LIMIT`; choose the scan page and the transient-refusal retry delay.
3. **Pre-due cost**: with N stamped far-future heads, backstop claims and journal reads before their due time should both be 0.

## 7. Acceptance

Replaces the parent §9 items listed in §5.

- **Stamp content**: suspensions with (a) nothing pending, (b) only a loop wakeup at `T`, (c) a queued immediate wake input, (d) only a stopped run's message input record `pending=0`; `pending=1` with `wake_retry_at=T`; `pending=1` with `wake_retry_at=0`; and `pending=0`, each with `wake_seal_revision = journal_revision`.
- **Fencing**: a seal whose stamp revision differs from the head's is refused and the teardown retries; an acquisition clears the stamp; a refused load's seal, a bare `writers:seal` and the ownership release leave no stamp.
- **Acquire cap**: acquiring a head stamped with a future `T`, accepting an immediate input and crashing leaves `wake_retry_at` at most one claim delay after the acquisition, so the backstop delivers the input as it does today; a load that keeps refusing is retried at the claim delay, not on every scan.
- **No pre-due work**: 128 stamped far-future heads cause zero claims and zero journal reads before `T`, while a due Session with a 40-transaction journal starts within one scan period (the inverse of the §1 reproductions).
- **Due dispatch without replay**: at `T` a stamped head is loaded through passive `recoverForWake` with zero journal reads; an unstamped crashed head follows the existing proof path.
- **Child invalidation**: a stamped child whose parent run is terminal or stop-requested has its hint cleared without a load.
- **Recovery view**: (a) a clean suspension with an unattempted deferred input returns `nextTurnAllowed=true` right after its seal; (b) an attempted input with a refused load is not `ready`; (c) a clean suspension followed by a load that refuses without committing is not `ready`, because the acquisition cleared the stamp.
- **Transport**: a delayed notice for (a) a stamped head due in an hour causes zero cold opens before `T`; (b) a stamped head with `pending=0` causes no cold open; (c) a stamped head that is due, or whose stamp names an older revision, loads as today.
- **Child scope**: the backstop scan selects a stamped child Session at its due time, and the recovery view reports a cleanly stamped child `ready`.
- **Rollback**: disabling the capability after stamped suspensions still delivers each input once at its due time.
- **MySQL**: the stamp, acquire cap and backstop branch pass the selected `mysql-integration` cases on MySQL 8.4; H2 alone is not acceptance.

## 8. Open questions

Replace parent §10 items 1–3.

1. The backstop scan period, page and transient-refusal retry delay, chosen by §6.
2. Resolved: `writers:seal` takes `wake: {revision, pending, dueAt}`, and the capability rides the writer grant (§3.5).
3. Whether the crash path should also set `wake_retry_at` to the earliest deferred `notBefore` after a complete deferred-only proof, removing its 30 s re-claims. 3a does not need it.

## 9. Review items closed

- **Parent §9 head-hint unknown state measures an arm that cannot run** (raised after merge): the unknown state no longer exists, and the criterion is withdrawn.
- **Steady-state backstop replay cost under no-caching** (raised after merge on parent §4.1): the no-cache rule is withdrawn, and stamped heads are never replayed before their due time (§1 item 1, §7).
- **Transport drop condition misses a stamped `pending=0` head** (raised after merge on §3.4): the condition gains the `is_wake_pending = 0` arm, with an acceptance arm in §7.
- **The stamp widens `ready` to heads the scan-based proof does not cover** (raised after merge on §3.3): §3.3 states the widening, and §7 adds the child-scope arm.
