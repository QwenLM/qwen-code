# Managed Action Parking (Stateless Harness Phase 4)

[English](2026-11-21-managed-action-parking.md) | [简体中文](2026-11-21-managed-action-parking.zh-CN.md)

Status: proposal, pre-implementation design. Date: 2026-11-21. This is the pre-implementation design for Phase 4 of the [stateless Hosted Harness design](2026-11-16-managed-stateless-harness.md), verified against `main` at `5ab25731e4`, which includes the merged Phase 1 (#17690), Phase 2 (#17749), and the 3a wake stamp (#17908). 3b (#17953) is not merged yet; this design does not depend on it and only reuses its seal-certificate approach. All benefits and costs below are code-level estimates, not measurements; measurement is the enablement gate.

## 1. Problem and current state

### 1.1 Harness: a waiting Turn is held in process memory

Tool approvals and `ask_user_question` first commit a durable wait in one journal transaction (`commitDurableWait`, which moves the checkpoint to `await_action`), then wait in process:

- **Approvals.** The approval branch and `ask()` in `hosted-workspace-tool-turn.ts` call `HostedApprovalWaiters.wait`, with an `expiresAt` timer and an optional `hostedLiveApprovalPoll` (`hosted-tool-approval.ts:636`). The poll reads the control plane's approval mode (`createHostedLiveApprovalReader` reads `session.stores.approvalSelection()`) and allows on the user's behalf once the mode no longer asks.
- **Questions.** `waitForHostedQuestion` (`hosted-question-wait.ts`) hands back the Workspace mount during the wait for a single-question batch on the `local-process` provisioner (`releaseQuestionMount`, `hosted-workspace-tool-turn.ts:5854`), and reacquires the original binding and generation after the decision (`acquireHostedQuestionRuntime`).
- **After the wait.** The same code ends an Action that is still `requested` as `signal.aborted ? 'cancelled' : 'expired'`, then calls `resolveDurableWait()`.

During the wait `session.active` is set, the Turn's `input.accepted` is unsettled, and the Turn usually owes a `hosted.cleanup`. The Phase 1 eligibility predicate (`hosted-harness-session.ts:5062`) therefore always refuses to suspend. The default approval timeout `HOSTED_APPROVAL_TIMEOUT_MS` is 10 minutes, and a definition's `approvalTimeoutMs` can be up to 24 hours (`hosted-tool-approval.ts:33-35`). The Turn also has an absolute deadline (`input.accepted.deadline`; timer at `hosted-harness-session.ts:3833-3855`), 30 minutes by default on the control plane (`turn-deadline`, `application.yml:95`).

### 1.2 Control plane: a Turn is held during the wait too

`HarnessCoordinator.coordinate` claims the `ma_turn` row, renews the dispatch lease at a fixed rate, and keeps reading the Harness event stream in `consumeStream` until a terminal event. It keeps reading through an approval wait, which costs an executor thread, an SSE connection, and one SQL statement per renewal period. That stream is itself the `session.streams.size > 0` term of the Phase 1 predicate.

When the stream ends before a terminal event, `consumeStream` throws `IllegalStateException`, which is classified as `transientFailure`: it spends retry budget and then re-attaches. So changing only the Harness to suspend during a wait would make the coordinator treat it as a failure and reload the Session immediately.

### 1.3 Existing basis: cold recovery from `await_action` is implemented and fault-tested

[G3 step 3](2026-10-09-hosted-g3-step3-recovery.md) already lets a replacement Harness take over a Turn that died in an approval wait:

- Before publishing the wait, the Turn stores an immutable `hosted-approval-continuation/1`, referenced by `continuationRef` in Action options v3 (approvals) or v4 (questions). A plan over the 64 KiB inline limit, and a wait whose batch has an uncaptured plan (`uncaptured`), carry no recovery guarantee.
- A takeover load whose checkpoint is in `before_model`, `await_action`, or `model_output_committed` recovers through `findHostedApprovalContinuation`: it keeps the original Action ID and deadline, re-registers the waiter and expiry handling, and runs the original batch once after the decision (`hosted-harness-session.ts:8385-8420`). This arm requires a Session with no Hooks and no MCP; extension command-step approvals have their own arm.
- The packaged fault gates cover several arms: a crash while the approval is requested, after the decision is committed, and during prepare; a lost decision or load reply; and a crash in the middle of mixed sibling approvals.

In other words, "drop the in-process Turn at the wait point, and let any Harness continue it from durable evidence" already works, but today it only happens after a crash. Phase 4 turns it into a deliberate, clean park.

The parent design names the resume path as "the existing Managed Runtime continue path". That is the G1 report/continue/cancel protocol for Runtime executions and does not handle approval waits; the approval-continuation driver above is what actually resumes the Turn. This design corrects the parent accordingly.

### 1.4 Benefit under default settings is small

Parking reuses the Phase 1 idle timer, and committing the wait is itself activity. With defaults, the approval expires after 10 minutes while idle suspension fires only after 10 minutes plus up to 10% jitter, so expiry always comes first and parking almost never happens. Even with a longer `approvalTimeoutMs`, the 30-minute Turn deadline bounds a single park to about 20 minutes.

The benefit appears only when a deployment raises the Turn deadline and the approval timeout, or when the idle period shrinks as the parent design intends. Phase 4's main value is removing the last common blocker on the way to the zero-idle end state, not saving resources under today's defaults. Whether parking should get its own shorter delay is an open question for measurement.

## 2. Goals and scope

Goals:

- An eligible Turn waiting for an approval or a question is suspended along with its Session: the Harness no longer holds the Session, and the control plane no longer holds the Turn's dispatch lease and event stream.
- On a decision, cancellation, approval-mode change, or expiry, any pool member can continue the original Turn through the existing approval-continuation driver. The original Action, Prompt, batch, and side-effect identities are kept; nothing is asked again or executed twice.
- Park and teardown failures follow the Phase 1 gate and bounded-recovery semantics. A wait that cannot be proven recoverable stays resident.

First-increment scope: park only waits that the cold-recovery arm already accepts today.

- The Session has no Hooks and no MCP (as the takeover recovery arm requires), and the wait is not an extension command-step approval.
- The wait's options carry `continuationRef`, its batch is not marked `uncaptured`, and the batch contains no v1/v2 approvals.
- The control plane dispatched the Turn, that is, its `input.accepted` is not a wake source (`isWakeOwnedInput` is false). Turns started by wake inputs such as monitor, channel, automation, or loop stay resident.
- Root Sessions (no lineage). Child Sessions stay resident.
- There is no pending input other than the Turn's own, and every other Phase 1 condition holds.

Non-goals:

- Extending cold recovery itself, including Hooks, MCP, child Sessions, wake-started Turns, and team plan approvals. These must first be proven recoverable on the G3 side before they become park-eligible.
- New public APIs, Action fields, or approval semantics. Web Shell and the public API still see a `RUNNING` Turn and a `requested` Action.
- Releasing the Turn's Runtime membership while parked (see §5 decision 4).

## 3. Overview

1. The Turn commits a durable wait and enters the in-process wait. The idle timer runs as usual.
2. When the timer fires, the Harness raises the gate and checks eligibility as in Phase 1: apart from one "parkable waiting Turn", there is no live work.
3. The Harness **freezes** that Turn: it removes the wait's timers, poll, and registrations, and neither wakes nor aborts it. The rest of the teardown is the same as Phase 1, except that the seal also writes a park certificate (Prompt ID, wake time, and approval revision) and the event streams are cut at the end.
4. The coordinator sees the stream end before a terminal event, reads a certificate that matches its Turn, and parks the `ma_turn` row with one CAS: it releases the dispatch lease and sets `retry_after` to the wake time.
5. A decision, cancellation, or approval-mode change unparks the Turn in its own transaction; expiry is triggered by the existing dispatch sweep through `retry_after`.
6. Dispatch re-attaches: the Harness cold-opens the Session, the takeover recovery arm rebuilds the waiter, and the Turn proceeds according to the decision, cancellation, or expiry; the coordinator replays events from its consumed watermark until the terminal event.

## 4. Mechanism

### 4.1 Eligibility: one predicate shared with the recovery arm

Parking is safe only when cold recovery would accept the same state. The acceptance conditions of today's takeover recovery arm (`hosted-harness-session.ts:8385-8420`) are therefore extracted into one function that both parking and recovery call, with tests asserting that both give the same answer for the same journal state. No separate copy of "equivalent-looking" conditions is written. The first increment shares the journal-state terms: the approval-continuation lookup and the original Prompt text that both approval recovery arms resume from. The Session-shape terms (Hooks, MCP, lineage, wake-owned input) still mirror the takeover arm's guards; folding them into the shared function needs a refactor of the load path and is deferred to a follow-up.

On top of the Phase 1 predicate, the Harness relaxes only these terms:

| Phase 1 condition                                             | Phase 4 relaxation                                                                           |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `session.active !== undefined`                                | Allowed if and only if it is the single Turn in a parkable wait (below)                      |
| `unsettledInputs` non-empty; `pendingSessionInputs` non-empty | Exempts only that Turn's own `turnId`                                                        |
| `hasHostedCleanupDebt`                                        | Exempts only debt whose descriptor names that Turn's `promptId`; the resumed Turn settles it |
| `session.streams.size > 0`                                    | Allowed; teardown cuts these streams, whose only reader is the coordinator (§4.5)            |

A "parkable wait" is tracked by an in-process flag that the wait code sets after `commitDurableWait` succeeds and the waiter is registered, and clears before the wait returns. Eligibility requires:

- the flag is set, the durable Action is still `requested`, and a recoverable continuation exists (the shared predicate above holds);
- no live-poll call and no `resolveHostedAction` call is running;
- for a question wait that handed back its mount, the handback has completed (the retry chain in `waitForHostedQuestion` is not running);
- for a wait with a live poll, the approval selection is read once more under the gate. If the new mode would allow on the user's behalf, the attempt reverts and the normal path allows; otherwise the revision read goes into the certificate (§4.4);
- the writer grant advertises both `wakeDispatch` and `actionParking` (§9): the park certificate rides on the wake stamp, which is sent only when wake dispatch is enabled (§4.4).

### 4.2 Freeze, do not unwind

The in-process Turn's call stack runs from the model loop down to `waiters.wait`. Unwinding it with an abort would make the code after the wait settle the Action as `cancelled` or `expired`, write a cancelled terminal, and release the Runtime. Teaching every abort consumer to distinguish "park" from "cancel" is too broad to review.

Freezing leaves the stack suspended at the `await`, so the code after the wait never runs:

- `HostedApprovalWaiters` gains `park(requestId)`: it clears the `expiresAt` timer and the poll timer and removes the resolver from the map **without** calling it, so the wait's promise stays pending.
- The Turn's deadline timer is cleared, and the Turn's `abort` is never called.
- The wait's registrations in instance-level collections are removed, for example the callback a question wait registers in `brokerOptions.mountHandbacks`. After the freeze no instance-level structure references the call chain, so the whole chain is collected once the Session is removed.
- The implementation must audit every timer and callback held by the wait's call chain, the same requirement as the Phase 1 timer audit.

To the journal, the frozen state is identical to "the process was SIGKILLed at this point", which is exactly the state the G3 fault gates already prove recoverable. Freezing is the first irreversible suspension step: afterwards the Turn can never return to in-process service and can only be continued through cold recovery.

### 4.3 Changes to the Phase 1 suspension flow

The Phase 1 flow is unchanged except for three points:

1. The parked Turn is frozen before step 2 (closing the wake scheduler). A failure before the freeze is reversible: clear the gate and re-arm the timer.
2. Step 4 (releasing the Runtime lease and reconciling hosted cleanup debt) leaves the Runtime held by that Turn alone; it stays in the same state as during a resident wait (§5 decision 4). The reconciliation also skips debt whose descriptor names that Turn, because the resumed Turn settles it. Other owners, leases, and debts are handled as usual.
3. The step 6 seal also carries the park certificate (§4.4). A park is counted as clean only when the certificate is confirmed together with the seal. The event streams are then cut and the resident removed.

Teardown failures and unknown outcomes follow Phase 1 and the [bounded-recovery supplement](2026-11-18-managed-suspension-bounded-recovery.md): the gate stays closed, the frozen Turn is never revived, and once the Session recovers, cold recovery continues the Turn.

### 4.4 Seal certificate

This reuses the 3a [wake stamp written at seal](2026-11-19-managed-control-plane-wake-seal-stamp.md): the optional `wake` object of `/writers:seal` gains `parkedTurn: {promptId, wakeAt, approvalRevision}`, sent only by a suspension teardown that parks a Turn. Today the suspension teardown sends the wake object only when `supportsWakeDispatch()` is true (`hosted-harness-session.ts:5211`), and the park CAS also relies on the `wake_seal_revision` it writes, so Phase 4 depends on 3a being enabled. `wakeAt` is the earlier of the Action's `expiresAt` and the Turn deadline, computed by the Harness, because both values live only in the Harness's durable records. `approvalRevision` is the approval selection revision read under the gate in §4.1; a wait without a live poll omits it, because mode changes do not affect such a wait.

`ma_session_head` gains three nullable columns, `wake_seal_parked_prompt_id`, `wake_seal_parked_until`, and `wake_seal_parked_approval_revision`. They are written in the same seal UPDATE as `wake_seal_revision`, which is fenced by the writer token, the generation, and `journal_revision = revision`; any generation-incrementing writer acquisition clears them. Per this module's rules, the V1 baseline is edited in place and no migration is added.

The same seal's `wake.pending` does not count the Turn's input as a wake input. Because §4.1 requires that no other input is pending, it is `false`.

Why not infer a park from "a clean wake stamp plus an unsettled Turn": the inference depends on an implicit rule that a suspension never leaves any other unsettled Turn, and later eligibility relaxations (such as the 3b background certificate) would silently break it. An explicit certificate follows the same approach as 3b's `wake_seal_background`.

### 4.5 Control plane: parking the Turn row

When the stream ends before a terminal event, `consumeStream` first flushes the batch it has read, then checks for a park certificate; without one, it keeps today's `transientFailure` path.

Parking is one CAS. It locks the `ma_turn` row first, following the existing lock order, and writes only if all of these hold:

- this coordinator still holds the dispatch lease and the Turn is `RUNNING` (not `CANCELLING`);
- the head's `wake_seal_parked_prompt_id` equals the Turn's `prompt_id` and `wake_seal_revision` is not null, that is, the certificate is still current;
- when the certificate carries an approval revision, the Session's current approval selection revision (the `revision` returned by `approvalSelection()`) equals it;
- the Session has no unfinished `ACTION_RESPONSE` operation;
- the Action projection for that Prompt in `ma_session_record` is still `requested`.

It writes `error_code = 'hosted_action_parked'` and `retry_after = wake_seal_parked_until`, and clears `dispatch_owner` and `dispatch_lease_until`; it counts against neither the retry budget nor the consecutive-failure count. The mark is dispatch bookkeeping, not a Turn error: public and Web Shell Turn reads omit it. If the CAS fails, the coordinator proceeds as today's `transientFailure`.

`findDispatchable` needs no change: it already skips rows whose `retry_after` has not passed and does not exclude this error code, so the existing sweep (every second by default) redispatches the Turn once the time passes. When `claimTurn` claims a parked row, it clears the error code in the same UPDATE, so the mark only ever means "unowned, waiting to be woken" and never stays on a Turn that is being dispatched. The error-code branches in `runClaimed` (`HARNESS_RECOVERY_BLOCKED`, `RUNTIME_RECOVERY_BLOCKED`, `WORKFLOW_RECOVERY_BLOCKED`) each match only their own code and are unaffected by the new one. `JdbcHostedCleanupDebtStore.OWED` already skips Sessions with a `RUNNING` Turn, so cleanup owed by a parked Turn does not trigger a cleanup-only load.

Only `HarnessCoordinator` reads the Harness event stream (`stream` and `observeStream`); the public SSE comes from the control plane's own event store. Cutting the stream in the Harness therefore affects no other consumer.

### 4.6 Unparking

A new store method clears `error_code` and `retry_after` on every `hosted_action_parked` row of the Session. It runs inside the following transactions, together with their main writes, and also locks the Turn row first:

- `ACTION_RESPONSE` admission (`JdbcManagedActionStore`);
- Turn cancel admission: the status becomes `CANCELLING`, and `findDispatchable` also requires `retry_after` to have passed for `CANCELLING`, so it must be cleared;
- approval-mode changes (today's entry point is `ManagedAgentService.changeWebShellSessionApproval`), because a mode switch can let the live poll allow on the user's behalf;
- lifecycle operations that cancel the Turn, which go through the cancel admission.

A dispatch may be kicked right after the commit to reduce latency, but correctness depends only on the sweep.

The Turn row lock serializes the race. If the unpark commits first, the park CAS sees the unfinished `ACTION_RESPONSE`, the `CANCELLING` status, or a newer approval revision, and fails; if the park commits first, the later transaction clears it. An approval-mode change leaves no unfinished operation behind, so the certificate must carry the approval revision: otherwise a mode change committed before the park CAS would let the CAS succeed, and the allow-on-behalf effect would be lost until expiry. There is no window where a decision, cancellation, or mode change has committed while the Turn stays parked until expiry.

Expiry needs no unpark: once `retry_after` passes, the sweep dispatches as usual. Clock skew only affects when the reload happens, not the outcome: the resumed driver decides expiry by the Harness's own clock, and if it arrives early it waits out the remaining time while resident.

### 4.7 Reopening

Dispatch enters the recovery path of `runClaimed` (the Turn already has `submission_attempted` and an event epoch):

- **Decision.** Decision delivery (`QwenHostedHarnessConnector.doResolveAction`) loads the Session on a cache miss before resolving, while the coordinator's dispatch performs a drive load. The two loads converge on one resident under the #17521 attachment rules. That load must enter the takeover recovery arm rather than receive the parked Session's 409; a test must confirm this. The recovery arm registers the waiter before reading the Action, which covers a decision that won before registration (G3 §4.2 step 3).
- **Cancellation.** As in G3: the resumed Turn sees `cancel.requested`, closes the wait, and settles as cancelled.
- **Approval-mode change.** The resumed driver rebuilds the live poll and, under the new mode, either allows on the user's behalf or keeps waiting. Whether the recovery arm rebuilds the live poll today must be confirmed by a test; if it does not, Phase 4 adds it.
- **Expiry or deadline.** The resumed driver immediately ends the Action as `expired`, or aborts on the deadline, and writes the cancelled terminal.

The coordinator replays from its consumed watermark, so no event committed during the park or after the resume is lost. With mixed sibling approvals, the next sibling's new Action is committed normally in the resumed Turn and can be parked again later.

If decision delivery is delayed, the resumed Session may be suspended again after one idle period. The park CAS then fails because an `ACTION_RESPONSE` is unfinished, the coordinator takes an ordinary retry, and the system converges once delivery lands. This is bounded churn, not a correctness problem, but its frequency is measured.

### 4.8 Recovery view and status

A parked Session's head is `SEALED` + `released`, but it has a `RUNNING` Turn. The "clean suspension → `ready`" arm of the [recovery-view supplement](2026-11-18-managed-suspension-recovery-view.md) already requires no unsettled Turn, so it never reports such a Session as ready. The other side needs no new arm: the existing active-Turn arm already reports "Turn in progress" ahead of `recovery_evidence_unavailable` and the operator arms, whether or not the park certificate is still current. A later writer acquisition clears the certificate while the Turn row stays `hosted_action_parked` until it is redispatched, so the view must not read the certificate at all. Public Session reads, Web Shell Session reads, and Turn reads all go through this view and are pinned by tests.

### 4.9 Lifecycle refinements (review round 2)

The second review round verified six lifecycle details against executed probes; each is now pinned by a regression:

1. **Resolution mutual exclusion counts overlaps (§4.2).** The freeze refusal marker is a per-Action count, not a presence bit: two overlapping resolutions of the same Action keep the park refused until the last one ends.
2. **Cleanup exclusion re-checks the journal (§4.3).** The debt snapshot is taken at a committed sequence; if the sequence advanced while descriptors were read, the check conservatively reports debt instead of admitting a suspension on a stale snapshot.
3. **Staged wake is not a client contradiction (§4.4).** Only the client's own `wake.pending()` or background claim refuses a park certificate. A wake-worthy staged row the Broker wrote after the certificate seals through the existing staged-wake path, which clears the parked fields.
4. **Approval-mode change admits a matching parked certificate (§4.6).** A parked head is `SEALED`/`released`, so the busy admission would refuse the change before it can unpark. Only a fully matching certificate — seal revision, parked prompt, approval revision, and the parked Turn as the Session's only live work — earns a narrow exemption; any mismatch keeps the refusal.
5. **A cold-recovered wait can park again (§4.7).** The recovery arm installs the same park registration, freeze override, and finally-unregister lifecycle as the original wait, keeping the original Action identity and expiry; the next idle parks it a second time, and one later Allow still executes the tool exactly once.
6. **Digest-match replay unparks in the same transaction (§4.6).** Both failed-delivery replay heals (delivery-failed and decision-expired) clear the park mark after the conditional repair UPDATE, so a decision the user already made does not wait for the original wake deadline.

## 5. Decisions and rationale

1. **Reuse G3 cold recovery instead of writing a new park/resume protocol.** G3 already covers the combinations of decision, cancellation, expiry, lost replies, and crashes, with packaged fault gates. Phase 4 adds only one entry point: a deliberate drop.
2. **Freeze, not abort.** Every abort consumer settles something; freezing confines the state to "crashed at the wait point", which is already proven recoverable.
3. **The control-plane park requires a Harness certificate.** Only the Harness knows whether a wait is recoverable; the control plane only performs the CAS and the timing, and infers nothing.
4. **The first increment does not hand back the Turn's Runtime membership.** A resident wait holds it today anyway, so parking is no worse than now, and the recovery arm already continues with the original Runtime owner. Mount handback is implemented only on the question path, and only for single-question batches on `local-process`; extending it to approvals would widen what cold recovery must prove. The effect of long parks on `LOCAL` maintenance and `EXTERNAL` storage contention is an open question for measurement.
5. **The wake time lives in the certificate; the timing lives in `ma_turn.retry_after`.** The deadline exists only in the journal, and the dispatch sweep already works from `retry_after`, so no new scheduler is needed. `wake_retry_at` is not reused because it belongs to the wake-recovery sweep.
6. **A switch, off by default.** As in 3a and 3b, the control plane advertises `actionParking` in the writer grant, and the Harness parks only when it is advertised. The control plane advertises it only when wake dispatch is enabled too, because the certificate depends on the wake stamp. An older control plane would treat the cut stream as a failure and reload, so the Harness cannot enable this on its own.

## 6. Interaction with Phases 1 to 3

- **Phase 1.** A park is a suspension with an extra certificate, using the same idle timer, gate, teardown, retry limits, and bounded recovery. The cold-open admission limit (`hosted_session_open_busy`) also applies to reopening a parked Turn, and the coordinator already treats it as a wait.
- **Phase 2.** The first increment excludes Sessions with MCP, so it does not intersect MCP parking. Once cold recovery supports MCP, reopening a parked Turn can reuse parked MCP connections and skip reconnecting.
- **3a.** Phase 4 depends on 3a: with wake dispatch disabled, a suspension sends no wake stamp and therefore no park certificate. The park seal's wake stamp is `pending = false`, so the wake-recovery sweep never loads a parked Session because of it. Sessions with pending wake inputs are not parked.
- **3b (#17953).** Both write a certificate on the seal. When a Session has both a background hold and a parked Turn, the first increment does not park, because §4.1 requires the parked Turn to be the only live work. Combining the two certificates is deferred until 3b merges.

## 7. Measurement (enablement gate)

Before enabling, record:

- the park rate and the park-duration distribution, grouped by approval timeout, Turn deadline, and idle period, to check the estimate in §1.4;
- the cost of reopening a parked Turn: latency from decision to tool start, split into dispatch-sweep latency, cold open (journal restore), and recovery-driver start;
- the resources saved while parked: Harness memory, writer and activation renewal SQL, and the coordinator's thread, connection, and renewal SQL;
- repeat suspensions and ordinary retries caused by delayed decision delivery;
- for long parks, the waits that the Turn's held Runtime membership causes for `LOCAL` maintenance and `EXTERNAL` contention.

## 8. Failure modes

- **Failure before the freeze.** Reversible: clear the gate, re-arm the timer, and the Turn keeps waiting while resident.
- **Failure or crash after the freeze and before the seal.** Phase 1 rules apply: the gate stays closed and bounded recovery converges. The head may still be `ACTIVE` with no certificate, so the coordinator re-attaches as for an ordinary failure, and cold recovery continues the Turn.
- **The seal succeeds but the coordinator crashes before the CAS.** After the dispatch lease expires, the sweep redispatches and cold-opens the Session; the Turn returns to a resident wait and can be parked again later. The cost is one extra load, with no state lost.
- **Stale certificate.** Any writer acquisition clears the certificate, and the park CAS checks that the certificate is still current.
- **A decision, cancellation, or approval-mode change racing the park.** Serialized by the Turn row lock and the certificate's approval revision (§4.6).
- **Control-plane restart during a park, or multiple instances.** All park state is in SQL; the dispatch lease and the CAS keep two coordinators from holding the same Turn.
- **Recovery failure.** Cold recovery's typed refusals and blocks are unchanged (G3 §3) and are not relaxed because the Turn was parked.

## 9. Rollout

- The control plane adds the setting `qwen.managed-agent.action-parking.enabled` (default `false`). It requires `qwen.managed-agent.wake-dispatch.enabled` as well: only when both are enabled does the control plane advertise `actionParking` in the writer grant, the same mechanism as `wakeDispatch` and `runtimeObservation`; enabling the former alone fails startup with an explicit configuration error instead of being silently ignored.
- The control-plane changes (certificate columns, park CAS, unparking, recovery view) land before the Harness change or ship in the same release. As with other Managed Agent changes, mixed old and new versions are not supported.
- After the switch is turned off, the Harness stops parking; already-parked Turns are redispatched as usual on expiry or unpark. A rollback must not drop certificates or treat parked Turns as failed.

## 10. Slices

1. **Control plane.** Certificate columns and the seal write, the park CAS and the `consumeStream` branch, `claimTurn` clearing the error code, unparking, the recovery view, and the switch. Fully inert until the Harness sends certificates.
2. **Harness.** The shared eligibility predicate, the parkable-wait flag, `HostedApprovalWaiters.park` and the freeze, the seal certificate, and the eligibility exemptions.
3. **Acceptance and measurement.** Real-process and MySQL 8.4 cases, the §7 measurements, and the decision on whether parking needs its own delay.

## 11. Verification plan

- **Shared predicate.** For the same journal state, park eligibility and the takeover recovery arm give the same answer; cover Hooks, MCP, `uncaptured`, mixed v1/v2 batches, wake-started Turns, child Sessions, and the plan-mode refusal.
- **Freeze.** After the freeze there are no journal writes, Broker calls, or timer callbacks, the code after the wait does not run, and instance-level registrations are removed; after the Session is removed the call chain is collectable (asserted with a weak reference or a heap snapshot).
- **Teardown.** Inject failures before and after the freeze and before and after the seal; verify that only failures before the freeze are reversible, and a frozen Turn is continued only through cold recovery.
- **Control-plane CAS.** Cover every interleaving of the park with `ACTION_RESPONSE` admission, cancel admission, approval-mode changes (including one committed before the park CAS), a stale certificate, and a lost lease; parking spends no retry budget; a `CANCELLING` Turn is never parked; claiming a parked row clears the error code, and the Turn takes the ordinary recovery path.
- **Reopening.** Allow, Deny, cancellation, allow after a mode switch, expiry, and deadline; the double load from decision delivery and coordinator dispatch converges; the load during decision delivery enters the takeover recovery arm; a second park during mixed sibling approvals; a repeat suspension caused by delayed decision delivery eventually converges.
- **View.** The public, Web Shell, and recovery views of a parked Session all report "Turn in progress, awaiting an Action".
- **Real process and MySQL 8.4.** Kill the Harness after the park and decide on another Harness generation; restart the control plane during the park; on the Allow path, each call runs exactly once, with one file effect and one terminal; reproduce and pass the races under the Turn row lock on MySQL. H2 results cannot replace these cases.

## 12. Acceptance criteria

- A wait that is not eligible behaves exactly as it does today.
- An eligible wait is cleanly parked after one idle period: the Session leaves `attachedSessions` and stops renewing; the `ma_turn` row releases its dispatch lease, and `retry_after` equals the certificate's wake time.
- After a park, a decision, cancellation, mode change, and expiry each complete the original Turn through one cold recovery: Action, Prompt, and batch identities are unchanged, nothing is asked again, Allow executes exactly once, and Deny zero times.
- A completed park never spends the Turn's retry budget. A park the CAS refuses because a decision, cancellation, or approval-mode change raced it falls back to one ordinary retry, which the Turn's next journaled progress resets. No committed decision, cancellation, or approval-mode change leaves the Turn parked until expiry.
- Every status read of a parked Session truthfully reports the Turn in progress.
- The real-process, MySQL, and fault cases required by §11 pass in CI, and the §7 measurements are complete, before the switch is turned on.

## 13. Open questions

1. Whether parking should get its own shorter delay. With defaults, parking almost never happens (§1.4), and a shorter delay turns more decisions into cold opens. Decided by §7.
2. Whether long parks should hand back the Turn's Runtime membership, as question waits do.
3. What to include once cold recovery is extended: Hooks, MCP, child Sessions, wake-started Turns, and team plan approvals. Proposed, except for team plan approvals, in the [coverage design](2026-11-22-managed-action-parking-coverage.md).
4. How to combine the two certificates when a 3b background hold coexists with a parked Turn. Proposed in slice S2 of the [coverage design](2026-11-22-managed-action-parking-coverage.md).
5. Placement reclamation for parked Sessions on members that have left the pool, the same as open question 1 of the parent design.
