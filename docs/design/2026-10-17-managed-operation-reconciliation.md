# Managed operation reconciliation (Stage D7-2)

[English](2026-10-17-managed-operation-reconciliation.md) | [简体中文](2026-10-17-managed-operation-reconciliation.zh-CN.md)

Status: phase 1 implemented in this change, in contract `1.59.0`. No schema change.

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

- `WORKSPACE_CREATE`: splitting deterministic refusals into `failed`, an evidence reader for the node marker, and releasing the reservation when evidence proves non-commit.
- `RENAME`'s `UNKNOWN` state and its reader (the Harness title revision).
- The Turn-level unknown tool outcome (`managed_runtime_recovery_blocked`), which needs the Runtime Broker's `reconcileExecution` wired to the Turn, together with #13847.
- A `CANCEL` pending on a `CANCELLING` Turn that the dispatcher fails with `managed_runtime_recovery_blocked`.
- Renaming the public `recovery_blocked` token for lifecycle waits. That is a contract change better made in D7-3, which exposes delivery state anyway.
- Removing the never-written readers (`ma_turn.status = 'RECOVERY_BLOCKED'`, the Session-kind `UNKNOWN`) and folding the hand-written `INSERT INTO ma_operation` statements into one writer.

## Decisions

### 1. Kind decides the meaning

`ManagedAgentStore` names the two sets:

- `ACCEPTANCE_UNKNOWN_KINDS` = `TASK_CANCEL`, `SUBMIT_INPUT`. Here `RECOVERY_BLOCKED` means the command's acceptance is unknown.
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

The Harness admits a prompt by committing `submitInput` to the managed Session journal with `commandId = promptId` and the payload digest as `contentDigest`. Java stores that commit in `ma_session_journal_tx`, keyed by `commandKeyHash("submitInput", promptId)`. `turnInputAcceptance` reads, in one snapshot:

- an event epoch on the Turn, or a journal row for the prompt whose content digest matches the Turn's payload digest: **committed**;
- no such row, and a `MANAGED_SESSION` head in `DELETING` or `DELETED` whose compaction has not started: **not committed**, with the Turn's error code;
- anything else: **unknown**.

Absence proves nothing while a writer may still commit. An `ACTIVE` or `SEALED` head can still take a writer, and the hosted submit handler reads the Session's authority only after it awaits, so even a later writer generation may commit a submit that arrived earlier. A head in `DELETING` or `DELETED` refuses every writer, and a commit that preceded the deletion is visible in the same snapshot. Once compaction starts, the journal may have lost the row, so absence proves nothing again. A digest that differs from the Turn's is not this input's admission, and is logged and left unknown.

An input on a Session without a managed journal, or whose journal was compacted first, stays parked. It holds no barrier: Turn commands are not Session operations.

### 6. Barriers keep their difference

`hasOpenOperation` excludes a parked task cancel, so it holds no lifecycle hostage (H4f). `WorkspaceMigrationStore.requireIdle` and the `WorkspaceRecoveryStore` source check still count it. The difference is deliberate: a migration moves the storage that the cancel's task may still be using.

## Validation

- `OperationReconcilerTest`: a parked cancel resolves only from its record (unknown, then committed), a cancel whose task ended without a stop fails `task_already_settled`, unreadable evidence parks for a whole recheck, a parked input settles from the store's journal verdict only, a row no longer parked is left alone, and one kind has one evidence source. No case sends, claims or calls the Harness.
- `ManagedTaskCancelOperationTest.aParkedCancelHoldsNoLifecycleHostage`: a parked cancel that is due is still not claimable, and the generic settle parks, completes, and refuses to rewrite it.
- `ManagedTurnCommandOperationTest`: an input whose submission went unanswered parks with `submit_input_unconfirmed`; its verdict stays unknown with no journal, with an `ACTIVE` head and with a `SEALED` head, becomes committed once the journal holds the matching admission, and settles completed with a receipt. A `DELETING` head without the admission proves non-commit with the Turn's code, a mismatched digest proves nothing, and a started compaction proves nothing.
- `WorkspaceMigrationStoreTest.refusesAStorageWithAParkedTaskCancelUntilItSettles`: a parked task cancel holds a storage migration until it settles.
- `TaskCancelCoordinatorTest` keeps its delivery cases; its two parked cases moved to `OperationReconcilerTest`.

## Acceptance (from #14166)

- An operation whose acceptance is unknown never produces a second side effect: no claim takes it (decision 2), and the reconciler never sends (decision 3).
- Reconciliation reads the original command identity: the task record by the operation's task, and the journal row keyed by the Turn's prompt and checked against its payload digest (decisions 3 and 5).
- One rule decides what `recovery_blocked` means next for the acceptance-unknown kinds, and the lifecycle wait is named as a different concept (decision 1). The binding, Session-head and extension-run vocabularies were shown to be distinct on #14166.
