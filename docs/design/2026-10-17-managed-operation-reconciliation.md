# Managed operation reconciliation (Stage D7-2)

[English](2026-10-17-managed-operation-reconciliation.md) | [简体中文](2026-10-17-managed-operation-reconciliation.zh-CN.md)

Status: phase 1 landed in #14443 (contract `1.59.0`), phase 2, the SSH Workspace registration, in #14456 (contract `1.60.0`), and phase 3, the Session title, in #14475. No phase changes the schema. Decision 9 landed in #14669 and decision 10 in #14681; the `CANCELLING`-lane cancel is implemented in this change. The cross-kill fault gate stays on #14166.

This is slice **D7-2** of [#14122](https://github.com/QwenLM/qwen-code/issues/14122) (the D7 umbrella of [#12380](https://github.com/QwenLM/qwen-code/issues/12380), Stage D), tracked by [#14166](https://github.com/QwenLM/qwen-code/issues/14166). #12380 lets Stage D expose `java_durable` only with durable command delivery (D7-1, [#14168](https://github.com/QwenLM/qwen-code/issues/14168)) and original-command reconciliation (this slice). D7-3 ([#14167](https://github.com/QwenLM/qwen-code/issues/14167)), the opt-in profile, waits for both. The design note on #14166 classifies every site this slice touches.

## Problem

`recovery_blocked` is meant to say "acceptance unknown: reconcile before re-executing". On `main` at `7d6dcc8c95` it says three different things, decided in three places:

| Kind                                       | Writer                       | Meaning                                                 | Next                                                                    |
| ------------------------------------------ | ---------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------- |
| `TASK_CANCEL`                              | `TaskCancelCoordinator.park` | acceptance unknown                                      | `reconcileParked` reads the task record; never re-sent                  |
| `CLOSE`, `DELETE` (in theory `CWD_CHANGE`) | `blockLifecycleOperation`    | a published wait on a precondition; acceptance is known | re-claimed and re-driven, with keyed effect receipts against duplicates |
| `WORKSPACE_CREATE`                         | `SshWorkspaceStore.fail`     | any non-retryable failure                               | nothing; stays forever and keeps its directory reserved                 |

Two defects follow:

- **`claimOperation` accepts `RECOVERY_BLOCKED` for every Session kind**, `TASK_CANCEL` included. A cancel parked at its first claim (`runtime_session_not_found`) is kept from a re-send only because the scans never offer it. The claim budget guard (`claimGeneration > ATTEMPT_BUDGET`) does not cover it.
- **D7-1 records an input `failed` when its Turn failed after a submission no Harness answered.** `HarnessCoordinator` itself notes that a null event epoch does not prove non-admission (R10-4): the reply may have been lost after the Harness admitted the prompt. That is acceptance unknown, recorded as not accepted.

## Goals

- One rule decides what an acceptance-unknown `recovery_blocked` operation does next, and it reads only that operation's own keyed evidence.
- No claim ever takes such an operation, and nothing sends it again.
- `submit_input` gets the same rule, with the Session journal as its evidence.
- The other meanings of `recovery_blocked` are named and documented as distinct.

## Non-goals (later phases)

- ~~`WORKSPACE_CREATE`~~: phase 2, below.
- ~~`RENAME`'s `UNKNOWN` state and its reader (the Harness title revision)~~: phase 3, below.
- ~~The Turn-level recovery reads and park~~: decisions 9 and 10, below. The fault gate that kills a Harness around a v2 execution stays on #14166.
- Renaming the public `recovery_blocked` token for lifecycle waits. That is a contract change better made in D7-3, which exposes delivery state anyway.
- Removing the never-written readers (`ma_turn.status = 'RECOVERY_BLOCKED'`, the Session-kind `UNKNOWN`) and folding the hand-written `INSERT INTO ma_operation` statements into one writer.

## Decisions

### 1. Kind decides the meaning

`ManagedAgentStore` names the two sets:

- `ACCEPTANCE_UNKNOWN_KINDS` = `TASK_CANCEL`, `SUBMIT_INPUT` and, since phase 3, `RENAME`. Here `RECOVERY_BLOCKED` means the command's acceptance is unknown.
- `LIFECYCLE_WAIT_KINDS` = `CLOSE`, `ARCHIVE`, `DELETE`, `CWD_CHANGE`. Here it is a published wait on an operation whose acceptance is known, re-driven by the lifecycle coordinator.

The public status stays `recovery_blocked` for both. The contract now says which meaning applies to which kind.

### 2. No claim takes an acceptance-unknown row

`claimOperation` takes `PENDING` and `RUNNING` rows as before, and a `RECOVERY_BLOCKED` row only for a lifecycle wait kind. A parked task cancel is no longer claimable once it is due, however early it parked.

### 3. One reconciler, one evidence source per kind

```java
public interface AcceptanceEvidence {
    OperationKind kind();
    AcceptanceVerdict read(OperationRecord operation); // COMMITTED, NOT_COMMITTED (with code) or UNKNOWN
}
```

`OperationReconciler` replaces `TaskCancelCoordinator`'s parked scan. Every second it reads due parked rows of the acceptance-unknown kinds (`findParkedOperations`), asks the kind's evidence, and settles through `settleParkedOperation`:

- **committed** completes the operation: `harness_confirmed`, `confirmed`, a receipt.
- **not committed** fails it: `java_durable`, `blocked`, the proven failure code, and `available_at` past every scan.
- **unknown** parks it again for `RECHECK` (5 minutes).

The settle applies only while the row is still parked and unclaimed (`state = 'RECOVERY_BLOCKED' AND delivery_state = 'BLOCKED' AND claim_owner IS NULL`), so a reconciliation never rewrites a recorded outcome. Evidence that cannot be read parks the row for a whole recheck, so it never pins the head of the page. The scan leads with kind and state, so it reads only parked rows, never a kind's settled history.

`TaskCancelCoordinator` is the `TASK_CANCEL` evidence source. Its `verdict`, which reads the task's committed record, is unchanged; only its scan moved.

### 4. A Turn input parks when its submission went unanswered

`settleTurnCommands` now parks the input when the Turn failed with `submission_attempted` set and no event epoch: `recovery_blocked`, `java_durable`, `blocked`, `submit_input_unconfirmed`, due at once. A Turn that failed without any submission attempt still fails its input with the Turn's code, because then non-admission is proven. Cancelled Turns are unchanged: Java cancels a Turn before admission only when its submission mark is clear, and a Harness cancellation carries an epoch.

### 5. The Session journal is the input's evidence

The Harness admits a prompt by committing `submitInput` to the managed Session journal with `commandId = promptId` and the payload digest as `contentDigest`. Java stores that commit in `ma_session_journal_tx`, keyed by `commandKeyHash("submitInput", promptId)`. `turnInputAcceptance` reads the journal row and the head in one statement:

- an event epoch on the Turn, or a journal row for the prompt whose content digest matches the Turn's payload digest: **committed**;
- no such row, and a `MANAGED_SESSION` head in `DELETING` or `DELETED` whose compaction has not started: **not committed**, with the Turn's error code;
- anything else: **unknown**.

Absence proves nothing while a writer may still commit. An `ACTIVE` or `SEALED` head can still take a writer, and the hosted submit handler reads the Session's authority only after it awaits, so even a later writer generation may commit a submit that arrived earlier. A head in `DELETING` or `DELETED` refuses every writer, and a commit that preceded the deletion is visible beside it. The two facts come from one statement on purpose: a statement has a single read view under any isolation level, whereas two statements under READ COMMITTED let an admission and the deletion commit between them, which would read as a complete journal without the admission and fail an admitted input for good. Once compaction starts, the journal may have lost the row, so absence proves nothing again. A digest that differs from the Turn's is not this input's admission, and is logged and left unknown.

An input on a Session without a managed journal, or whose journal was compacted first, stays parked. It holds no barrier: Turn commands are not Session operations.

### 6. Barriers keep their difference

`hasOpenOperation` excludes a parked task cancel, so it holds no lifecycle hostage (H4f). `WorkspaceMigrationStore.requireIdle` and the `WorkspaceRecoveryStore` source check still count it. The difference is deliberate: a migration moves the storage that the cancel's task may still be using.

### 7. Phase 2: an SSH Workspace registration reconciles from its node

`SshWorkspaceService.register` runs claim, probe, `reserve`, `register-storage` on the node, a final probe, and `complete`. Only `reserve` and `register-storage` have effects. `reserve` writes the storage alias and the physical directory's owner (`FENCE_ONLY`, `UNVERIFIED`) and records the registration in `result_json`. `register-storage` writes the marker on the node.

- **Unreserved means never sent.** `register-storage` runs only after `reserve` committed, so a registration without `result_json` never reached its node. Its non-retryable refusal is now final, `failed` (`ssh_runtime_version_mismatch`, `storage_already_registered`, `runtime_node_forbidden`, …), and nothing is left to release.
- **Reserved means acceptance unknown.** A reserved one parks `recovery_blocked` (`java_durable`, `blocked`) with its failure code. It is due one delay (`PARK_DELAY_MILLIS`, 5 minutes) after its last attempt, so a `register-storage` that was still running on the node when its caller gave up has ended before the node is read.
- **The node is the evidence.** `SshWorkspaceService` is the `WORKSPACE_CREATE` evidence source. It probes the reserved root, read-only. The reserved identity holding this registration's marker is **committed**, and `completeParked` finishes the registration as the original attempt would have: the storage is registered, the owner ready, and the Workspace and its owner access created. The reserved identity without a marker, or a different directory at the root, is **not committed**, and `releaseParked` fails it and deletes the alias and the owner, only while both are still this registration's unfinished reservation. Anything else proves nothing and parks it again: an unreadable node, a node that no longer admits the actor, or another registration's marker.
- **Outside any Session.** The registration is tenant-scoped, so the Session-scoped scan never reads it. The source lists its own parked rows, and its settlement has effects of its own. The reconciler therefore takes stored kind names, and an evidence source may override `settle` and `parked`.
- **Rows parked before this change** reconcile the same way. An unreserved one fails at once, without a probe.

A marker that a zombie `register-storage` writes after a release is left on a directory nobody owns. Any later registration of that directory sees a foreign marker and is refused, so the failure stays safe: two registrations never own one directory.

### 8. Phase 3: a Session title reconciles from the Session journal

A title delivery (kind `RENAME`, see [rename delivery](2026-10-08-managed-session-rename-delivery.md)) claims its row, marks it `SUBMITTED` and sends the title with its revision. A failure before `SUBMITTED` proves the title never left, and the row retries as before. A failure after it, or a claim that expired while `SUBMITTED`, leaves acceptance unknown. Since #14069 such a row parked `UNKNOWN`: never sent again, its key answering `409 operation_outcome_unknown`, and nothing ever settling it.

- **One parked state.** It now parks `RECOVERY_BLOCKED` (`java_durable`, `blocked`, `session_title_unconfirmed`), due at once, and `RENAME` joins `ACCEPTANCE_UNKNOWN_KINDS`. The per-second delivery sweep converts a legacy `UNKNOWN` row the same way. The conversion runs at runtime, not as a migration: `ManagedSchema` infers a catalog's version from its DDL, so a data-only version could never be detected, and a catalog initialized without Flyway would skip it. The key still answers `409 operation_outcome_unknown` while its row is parked.
- **The claim stays.** The row keeps its claim owner and generation, so the delivery's own reply, arriving after its lease expired, still completes it, as it did for `UNKNOWN`.
- **The receipt retires.** Parking moves the title's command receipt from `PENDING` to `FAILED`, as an abandoned delivery's already was. A row parked by an expired claim used to keep its receipt `PENDING`, and that receipt answered `409 session_operation_active` to every later title and lifecycle change of the Session, for good. A late reply and the reconciler both complete a retired receipt.
- **The journal is the evidence.** The Hosted Harness commits a fenced title to the Session journal as `renameSession` under `commandId = hosted-title:<revision>`, with the title's SHA-256 as `contentDigest`. `renameAcceptance` reads that row and the head in the same single statement as a Turn input (`journalEvidence`, decision 5): a matching digest is **committed**; no row under a `DELETING` or `DELETED` head before compaction is **not committed** (`session_title_undelivered`); anything else, a different digest included, is **unknown**.
- **The title settles itself.** `RenameEvidence` overrides `settle` with `settleParkedRename`, under the tenant and Session locks. Committed completes the receipt and the row (`harness_confirmed`) and shows the title with a `session.updated` event, in whatever status the Session has reached since, except `DELETING` and `DELETED`, where nothing is left to show it on. Not committed fails the row, `available_at` past every scan, and the key may then retry under a new revision, as any failed title key does; a later supersession leaves that outcome alone. Unknown parks it again for the recheck.
- **Barriers.** A parked title is no longer a pending delivery, so close, archive, delete, cwd and approval changes proceed, as they do beside a parked task cancel or input. The rename-delivery design held them until the delivery finished, because a title the Harness accepted could otherwise stay missing from the public Session. A parked title now reaches the public Session from the journal instead, and the deletion that closes the journal is what lets the reconciler prove a non-commit. A later title still supersedes a parked one. A Workspace migration still waits for a parked title, and no longer counts superseded or failed ones: it counted every row that was not `COMPLETED`, so one superseded title held its storage for good.

### 9. The Turn-level recovery reads the Broker's evidence

A Turn parked at `await_runtime` owes Runtime executions a dead Harness generation dispatched. The two takeover loads now ask the Broker for the original command's evidence instead of reading a state nobody refreshes; the rule is decision 3's, applied to a Runtime execution rather than an operation row.

- **The cancellation load** reads each parked execution with `?reconcile=true`. A settled answer becomes `known` with the observed state. An answer the Runtime still cannot prove stays `unknown`; an unusable lease invalidates the binding, so the record stays unknown until the LOST drain has loss evidence to fence it `abandoned`, which the report keeps as known/`abandoned`. The coordinator's existing cancel-over-abandoned and unknown routes then apply unchanged.
- **The continuation load** asks once when its read reports the record still `UNKNOWN`: the follow-up read sends `?reconcile=true`. A settled answer is journaled under its own execution id as before. A terminal fence is reported as known/`abandoned`; a still-unproven outcome is reported `unknown`. It does not poll `waitForUnknown` on the gap and never dispatches the command again.
- **What is not an answer.** A transport or protocol fault still fails the load retriably. The Broker's own "cannot prove" answers — a still-UNKNOWN record, `runtime_execution_evidence_unavailable`, `runtime_reconciliation_required`, `runtime_execution_reconcile_failed`, and a definitive not-found — become `unknown`, never a transient fault and never a second effect.
- **Park and recheck.** Decision 10, below, parks a Turn whose evidence remains unknown and re-drives the cancellation load on the reconciler's cadence. Decision 9 only makes the reads ask, so the coordinator sees the truth.

### 10. A Turn whose Runtime evidence remains unknown parks and is re-checked

The unknown gate used to call `transientFailure` with the budget-exempt flag, so a Workspace-bound Turn re-attempted the cancellation load on every backoff while its evidence stayed unknown. It now parks on `hosted_runtime_recovery_blocked`:

- **The park.** The Turn keeps its active status, so its input stays unsettled and it is never written `FAILED`. The park releases the dispatch lease and sets `retry_after` to `OperationReconciler.RECHECK` (5 minutes). A user cancel clears that `retry_after` when it moves the Turn to `CANCELLING`, so the cancel is driven at once instead of behind the recheck window.
- **The sweep.** `findDispatchable` excludes the code for a non-`CANCELLING` Turn. A cancel still scans the row; the `CANCELLING` lane keeps its existing retry path (a capped backoff; the attempt count is not budget-bounded), and a pending cancel blocked on the unknown outcome is never written `FAILED` over — the cancel route may still settle it `CANCELLED`.
- **The recheck.** The existing one-second scan also reads due parked Turns. Each recheck claims the Turn, discards the cached takeover snapshot through the connector, and re-drives the cancellation load — never the continuation, because the Turn was parked on an outcome a continuation could not prove safe. Ready: the existing cancel route journals the observed results and the Turn is marked `managed_runtime_recovery_blocked`. A terminal fence takes the existing cancel-over-abandoned path. Still unknown: the Turn parks again. A recheck that throws re-parks rather than spinning on the same row.
- **The snapshot.** `discardManagedRecovery` drops the cached attachment and the pending-recovery marker, so the next load asks the Broker again instead of answering from the report the park was decided on.

## Validation

- `OperationReconcilerTest`: a parked cancel resolves only from its record (unknown, then committed), a cancel whose task ended without a stop fails `task_already_settled`, unreadable evidence parks for a whole recheck, a parked input settles from the store's journal verdict only, a row no longer parked is left alone, and one kind has one evidence source. No case sends, claims or calls the Harness.
- `ManagedTaskCancelOperationTest.aParkedCancelHoldsNoLifecycleHostage`: a parked cancel that is due is still not claimable, and the generic settle parks, completes, and refuses to rewrite it.
- `ManagedTurnCommandOperationTest`: an input whose submission went unanswered parks with `submit_input_unconfirmed`; its verdict stays unknown with no journal, with an `ACTIVE` head and with a `SEALED` head, becomes committed once the journal holds the matching admission, and settles completed with a receipt. A `DELETING` head without the admission proves non-commit with the Turn's code, a mismatched digest proves nothing, and a started compaction proves nothing.
- `WorkspaceMigrationStoreTest.refusesAStorageWithAParkedTaskCancelUntilItSettles`: a parked task cancel holds a storage migration until it settles.
- `TaskCancelCoordinatorTest` keeps its delivery cases; its two parked cases moved to `OperationReconcilerTest`.
- Phase 2: `SshWorkspaceStoreTest` covers an unreserved registration failing outright, a reserved one parking for the delay, `completeParked` finishing it once, `releaseParked` failing it and freeing the directory for another registration, and a release that leaves an owner another registration finished. `SshWorkspaceServiceTest` covers the verdicts: the marker landed, no marker, another directory at the root, another registration's marker, a revoked actor, an unreadable node, and an unreserved legacy row without a probe. Each case only ever probes. `OperationReconcilerTest.aKindOutsideAnySessionScansAndSettlesThroughItsSource` covers the source's own scan and settle.
- Phase 3: `ManagedRenameReconciliationTest` (H2, and InnoDB in `ManagedRenameReconciliationMySqlIT`) covers a submission that threw parking with its claim and a retired receipt, never claimed or delivered again and holding no close; a crash-parked title that refused a later title until the sweep parked it, then superseded; a legacy `UNKNOWN` row converted; the verdict unknown without a journal, with an `ACTIVE` head and with another title's digest, then committed, completing the receipt, the row and the title with one event, and replaying the key; a committed title on a closed Session shown, on a deleting one not; a `DELETING` head proving non-commit while a started compaction proves nothing, and the failed key retrying under a new revision without being marked superseded; an unknown verdict re-parking with one more attempt; the claim's late reply completing a parked title; an unsubmitted failure still retrying and holding the lifecycle; a row without its title never read as committed yet still failed by a complete journal; and, through the store's `@Transactional` proxy with an injected statement fault, parking with its receipt retirement and a committed settle with its title, event and receipt, each rolling back whole. `OperationReconcilerTest.aParkedTitleSettlesThroughItsOwnSettle` covers the title settling through its own settle, never the generic one. `ManagedSessionLifecycleTest` now closes a Session beside its parked title, without resending it. `WorkspaceMigrationStoreTest` counts parked and legacy titles, and no longer completed, superseded or failed ones.
- Turn-level reads: `hosted-workspace-broker.test.ts` pins the reconcile query on the recovery read, exactly one reconcile attempt per unknown, the one-shot decision (a settled answer returns, a still-executing or still-unknown one does not poll), and the terminal fence. `hosted-runtime-recovery.test.ts` covers a passive load reconciling each execution, an unreadable evidence answer reported unknown, and a continuation journaling a settled result or reporting unknown/abandoned without journaling.
- Turn cancel: `HarnessCoordinatorTest.workspaceRecoveryFailureUsesTheMatchingCancellationAuthority` keeps a pending cancel on its existing retry path (capped backoff, budget-exempt) and never writes `FAILED` over the unknown-outcome case; `managed_runtime_recovery_incomplete` still takes the terminal path.
- Turn park: `HarnessCoordinatorTest` covers the park instead of the budget-exempt retry, the recheck discarding the snapshot and asking again, the re-park on a still-unknown answer, and the settle once the cancellation is ready.

## Acceptance (from #14166)

- An operation whose acceptance is unknown never produces a second side effect: no claim takes it (decision 2), and the reconciler never sends (decision 3).
- Reconciliation reads the original command identity: the task record by the operation's task, the journal row keyed by the Turn's prompt and checked against its payload digest, and the journal row keyed by the title's revision and checked against its title (decisions 3, 5 and 8).
- One rule decides what `recovery_blocked` means next for the acceptance-unknown kinds, and the lifecycle wait is named as a different concept (decision 1). The binding, Session-head and extension-run vocabularies were shown to be distinct on #14166.
- The Turn-level takeover reads the original command's Broker record (decision 9): both loads reconcile once, a settled answer is observed, and a still-unproven outcome is reported unknown instead of failing as a transient fault or dispatching again.
- A Turn whose outcome stays unknown parks and is re-checked on the reconciler's cadence instead of being retried budget-exempt or dispatched again (decision 10).
- A pending cancel on a `CANCELLING` Turn blocked on an unknown Runtime outcome is never written `FAILED` over; the cancel lane retries and the cancel route may still settle it `CANCELLED` (decision 10). `managed_runtime_recovery_incomplete` still takes the terminal path.
