# Managed Turn command operations (Stage D7-1)

[English](2026-10-16-managed-turn-command-operations.md) | [简体中文](2026-10-16-managed-turn-command-operations.zh-CN.md)

Status: implemented in this change. Turn input and cancellation are durable command operations of the kinds `submit_input` and `cancel`, readable through the operation query, in contract `1.58.0` and schema V8. #14318 landed contract `1.52.0` and schema V7, and #14358, #14412, #14413, #14405 and #14414 landed contracts `1.53.0` through `1.57.0` before this change, so it follows them. Admission responses do not carry the operation yet; that is D7-3.

This is slice **D7-1** of [#14122](https://github.com/QwenLM/qwen-code/issues/14122) (the D7 umbrella of [#12380](https://github.com/QwenLM/qwen-code/issues/12380), Stage D), tracked by [#14168](https://github.com/QwenLM/qwen-code/issues/14168). #12380 lets Stage D expose `java_durable` only with durable command delivery and original-command reconciliation. This slice supplies the first half. D7-2 ([#14166](https://github.com/QwenLM/qwen-code/issues/14166)) supplies reconciliation, and D7-3 ([#14167](https://github.com/QwenLM/qwen-code/issues/14167)), the opt-in profile, waits for both.

## Problem

The contract's command operation already names `submit_input` and `cancel`, and `PublicTurn`, `CommandAdmission` and `WebShellAdmission` reserve `operation_id`, `admission_stage` and `delivery_state` for D7. The server has neither kind. A Turn submit or cancel answers `202` with a Turn id, but no operation records the command, so there is no original operation for a lost reply to resolve through. That is #12867's D7 exit check: a lost response resolves through the original operation without duplicate side effects.

## Current state

From `main` at `20ddb526ff` (contract `1.51.0`, schema V6):

- **Delivery already exists, on the Turn.** A submit commits the `ma_turn` row (`ACCEPTED`), its `SUBMIT_TURN` command receipt and the `turn.accepted` event in one transaction. `HarnessCoordinator` claims the Turn with a dispatch lease, submits it, and records the Harness's event epoch on the Turn (`recordAdmission`). Its one-second scan re-offers expired leases, and its retry budgets end every Turn. A cancel commits its `CANCEL_TURN` receipt and moves the Turn to `CANCELLING` in one transaction. The same dispatcher then cancels it before admission (`cancelBeforeAdmission`), through the Harness, or through runtime recovery.
- **Idempotency already exists, on the receipt.** A key replays its receipt's admission, and a different request digest under the same key answers `409 idempotency_conflict`.
- **The operation table has no Turn kinds.** `StoreModels.OperationKind` holds `CLOSE, ARCHIVE, DELETE, ACTION_RESPONSE, CWD_CHANGE, TASK_CANCEL`. `ManagedSchemaContract.OperationKind` is a superset, bridged by `valueOf(kind.name())`. The `ck_ma_operation_kind` CHECK enumerates every stored kind, so a new kind needs a migration.
- **The table's Session barriers enumerate kinds.** `SESSION_OPERATION_KINDS` feeds the open-operation guard (`hasOpenOperation`), the lifecycle claims and the read. `findDeliverableOperations`, `hasOpenExecutionOperation`, the workspace migration idle check and the recovery count each list their kinds explicitly.
- `contract-known-gaps.txt` has no entries. Its header still points at #12867, which is closed.

## Goals

- Record every Turn input and cancel command as one durable operation, saved in the transaction that admits the command, carrying the command's idempotency key and request digest.
- Make a replay of the key resolve to that original operation, never a new one, and keep a different payload under the key a conflict.
- Settle each operation from the Turn's own committed facts, so the existing Turn dispatcher remains the only deliverer of both commands.
- Serve both kinds through the existing operation query on both surfaces.

## Non-goals

- Returning the operation, admission stage and delivery state from the admission routes, and the `durable_operations` capability. That is the opt-in profile of D7-3; the fields stay `planned`.
- Generalizing `recovery_blocked` reconciliation across kinds (D7-2).
- The task-cancel surface (H4f, #13746). `TASK_CANCEL` is unchanged.
- Turns that no input command creates: a Session's initial input, channel ingress and automation runs. Their admission is `create_session` or their own ledgers.
- Capacity limits, which belong to deployment-profile selection.

## Decisions

### 1. Two kinds, named after the contract's wire type

`OperationKind` gains `SUBMIT_INPUT` and `CANCEL` in both enums in the same change, so the `valueOf` bridge cannot throw. The operation views lower-case the kind name, so the wire types are exactly the contract's `submit_input` and `cancel`. The kinds are lower-case on the wire and upper-case in storage, like every other kind, with no separate mapping.

### 2. One operation per command, saved with it

`insertTurnCommand` and `insertCancelCommand` insert the operation in their own transaction, after the command receipt. The operation is `PENDING`, `JAVA_DURABLE` and `PENDING`, with the command's idempotency key, key digest, request digest and recording actor, and the Session status at admission. Its target is the Turn (`target_kind = 'TURN'`, `target_key` the Turn id's key). Every caller of those two methods gets one: the public and WebShell input and cancel routes, and the child relay's internal stop, which keys its cancel by the parent run.

A `202` for input or cancel therefore means what #12867 asked: the command is saved and Java is responsible for delivering it. That was already true of the Turn row. Now the command itself is also durable and addressable.

### 3. The receipt names the operation

The command receipt stores the operation's key in `result_operation_key`, as the action-decision and channel-ingress receipts already do. `replayCommand` reads the receipt and returns the operation id it names, so a retry under the key, including the in-store replay probe and the duplicate-key arm, resolves to the original operation and inserts nothing. A different digest still fails on the receipt with `409 idempotency_conflict`, before any operation is read. `StoreModels.Admission` carries the operation id for D7-3 to return. The admission responses do not show it yet.

The idempotency domain stays the receipt's: tenant, command name and key. An input and a cancel under the same key string are two commands with two operations.

### 4. The Turn dispatcher stays the only deliverer

The new kinds have no scan, claim or coordinator. Input and cancel act on a Turn, and the dispatch lease on the Turn row is the only lease that may act on it: submission, the Harness attachment and stream, recovery takeover and cancellation all run under it. A second driver for the same Turn would race that lease. So the operation's lease, claim generation and attempt columns stay unused for these kinds, and its delivery state reads `pending` until an outcome is durable.

This is how general cancel extends `TASK_CANCEL` without forking it. It takes the task cancel's outcome contract: settle from the authority's committed evidence, never from a wire answer; a completed operation is confirmed and carries a receipt; a failed one stays `java_durable` and `blocked` and names why. It does not take its coordinator. That coordinator's send (the parent's child-operation route) and its evidence (the task record) belong to a task, and a Turn already has both a deliverer and evidence. D7-2 then generalizes reconciliation over one evidence-first rule, with two evidence sources rather than two delivery paths.

### 5. Outcomes come from the Turn's committed facts

A private `settleTurnCommands` runs inside every transaction that commits a Turn fact the outcome depends on: `recordAdmission` and `recordRecoveryAdmission` (the Turn gains a Harness event epoch), a terminal Harness batch in `recordHarnessEvents`, `cancelBeforeAdmission`, `failTurn`, and a cancel admitted on a Turn that has already ended. It reads the Turn and moves only `PENDING` operations:

| Turn fact                                   | `submit_input`                                                                              | `cancel`                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| holds a Harness event epoch                 | `completed`, `harness_confirmed`, `confirmed`, receipt                                      | unchanged                                                                                        |
| `CANCELLED`                                 | `cancelled`, `java_durable`, `blocked` (no epoch), otherwise as above                       | `completed`, `confirmed`, receipt; `harness_confirmed` with an epoch, `java_durable` without one |
| `COMPLETED` or `FAILED`                     | `failed`, `java_durable`, `blocked`, the Turn's `error_code` (no epoch), otherwise as above | `failed`, `java_durable`, `blocked`, `turn_already_settled`                                      |
| still `ACCEPTED`, `RUNNING` or `CANCELLING` | as above                                                                                    | unchanged (pending)                                                                              |

- **The event epoch is the admission fact.** The dispatcher records it when a Harness answers the submit, or when it adopts a Harness attachment for a Turn whose submission it already attempted. Every later dispatcher decision reads it; for example, `cancelBeforeAdmission` refuses a Turn with one. So completion means a Harness admitted the Turn, not that it finished, as the contract requires. A Turn that fails after admission leaves its input `completed`.
- **A cancel completes when the Turn is cancelled.** No durable fact records a Harness's answer to the cancel call itself, so the operation waits for the Turn's own outcome. A cancel admitted before any Harness admitted the Turn completes `java_durable`, because Java was the authority that stopped it. A Turn that ended any other way fails the cancel with `turn_already_settled`, mirroring `task_already_settled`.
- **Cancels of one Turn coalesce.** A second cancel of a `CANCELLING` Turn has no command effect and stays pending. When the Turn ends, both settle the same way, each with its own receipt. A cancel of a Turn that has already ended settles in its admission transaction.
- **Failed and cancelled operations never carry a receipt** and stay `blocked`, so nothing delivers them again. `recovery_blocked` is never written for these kinds. A Turn's own budgets end it, and the operation follows.

### 6. Neither kind is a Session barrier

`SESSION_OPERATION_KINDS` and every explicit kind list are unchanged, so a pending input or cancel never answers `session_operation_active`, never blocks a cwd change, migration or recovery, and is never delivered by the lifecycle or task-cancel scans. The Turn row stays the barrier (`turn_active`), exactly as before. The new operations target the Turn rather than the Session, so none of the Session-target queries can match them even by accident.

### 7. The operation query reads them

`findOperation` falls back to the Turn command kinds by Session scope and operation id when the Session-target lookup misses. `getSessionCwdOperation` and `webShellQueryCwdOperation` serve them as `PublicCommandOperation` and `WebShellCommandOperation`, with read authorization and tombstone behavior unchanged. The fallback scans the Session's own entries of the identity index, `(scope_key, operation_kind, target_key, operation_id)`, and is off the admission path.

### 8. Settlement uses current reads

Every settle caller locks the Session row first, but its REPEATABLE READ snapshot can predate that lock. `requireLegacyMutation`, for example, reads before `recordHarnessEvents` locks. A plain read could then miss a cancel committed in between and leave its operation pending forever. `settleTurnCommands` therefore reads the Turn with `FOR UPDATE` and finds pending operations with a locking read pinned to the Turn's prefix of `uq_ma_operation_identity` (`FORCE INDEX` in a MySQL executable comment, which H2 skips). Those reads cover one Turn's entries in one Session scope. The pin is required. Left to the optimizer, a Turn with a long settled history in a table with few pending rows steers the scan to `ix_ma_operation_claim`, whose `(operation_kind, state)` range holds every Session's pending rows, and two Sessions' settles then deadlock across their own Session locks. No caller inserts into `ma_operation` after them, so they cannot close an insert-gap cycle of the kind #13918 removed. The receipt insert, and the operation insert behind it, stay under the existing Session and tenant-guard order of the two admissions.

### 9. Schema V8 and contract 1.58

- `V8__turn_command_operations.sql` drops and re-adds `ck_ma_operation_kind`. It keeps every kind of the V7 constraint, `WORKSPACE_CREATE` included, and adds `SUBMIT_INPUT` and `CANCEL`. Each such migration re-adds the whole CHECK, so it must start from the constraint at the tip of the chain, not from the V1 baseline. `ManagedSchema.extend`, generalized by #14318, replaces the re-added CHECK in place in the canonical DDL. Flyway applies V8 on the server, and `ManagedSchema.initialize` applies it on the Broker. A V7 catalog validates as version 7 and upgrades.
- The contract moves to `1.58.0`. The operation route's description names every kind it serves, both `failure_code` descriptions name the new failures, both command operation schemas state what input and cancel completion mean, and the version note states what D7-1 does and does not change. The generated WebShell types change only in the WebShell operation's `failure_code` and schema descriptions.
- `contract-known-gaps.txt` still has no entries. Its header now points at #14122. That file being empty means D4's exit is met, not that no contract gap remains.

## Validation

- `ManagedTurnCommandOperationTest` (H2) covers:
  - admission with its identity;
  - replay through `replayCommand` and through the in-store probe, both returning the original operation;
  - digest conflict, with one operation per command;
  - input completion on admission, unchanged by a later Turn failure;
  - input completion when the dispatcher adopts a recovered admission;
  - input failure with the Turn's code;
  - cancellation before admission (`cancelled` input, `java_durable` cancel);
  - Harness cancellation completing two coalesced cancels with distinct receipts;
  - a cancel failing `turn_already_settled`, when its Turn completes and when the dispatcher fails it;
  - cancels of ended Turns settling at admission;
  - the absence of any barrier or scan effect.
- `ManagedTurnCommandOperationMySqlIT` runs the same cases on InnoDB. It adds three witnesses for decision 8, each pinned to REPEATABLE READ so the server default cannot void it. In the first, two Sessions each hold a pending cancel of a running Turn and then cancel an ended Turn with 1000 settled cancels; both settles succeed. Removing the index pin deadlocks them. In the second, a terminal transaction pins its snapshot, a cancel commits meanwhile, and the settle still fails that cancel `turn_already_settled`. In the third, a cancel pins its snapshot, the Turn fails meanwhile, and the cancel still settles at admission. Making the pending-operation lookup a plain read fails the second; making the Turn read a plain read fails the third.
- Removing any one settle hook, the receipt link or the read fallback fails at least one of the cases above.
- `HostedConcurrentTurnBurstMySqlIT`, the #13333 same-tenant burst, settles every round with no admission or renewal failures and the same lock-wait samples as the base build.
- `ManagedAgentApiContractTest` reads the `submit_input` and `cancel` operations of a Harness-cancelled Turn through both operation routes and validates them against the contract.
- The schema tests move to version 8. `ManagedSchemaTest` inserts every shipped operation kind after the full chain, through both the Broker initializer and Flyway. `WorkspaceCreationSchemaMySqlIT` upgrades a V7 catalog that already holds a `WORKSPACE_CREATE` operation, keeps the row and admits all three kinds. Dropping the `WORKSPACE_CREATE` arm from V8 fails both.

## Acceptance

From #14168, for both kinds:

- A lost reply resolves through the original operation: the receipt names it and the operation query reads it (decisions 3 and 7).
- A retry under the same key returns the original operation (decision 3).
- A different payload under the same key conflicts (decision 3).
- Retries retain identity: the operation keeps the command's key and digest, and settlement never mints a second operation (decisions 2 and 5).

## Follow-up work

- **D7-2:** one reconciliation rule over the evidence sources (the Turn row here, the task record for `TASK_CANCEL`), including whether a Turn-command operation ever needs `recovery_blocked`.
- **D7-3:** the opt-in profile, landed in [managed java_durable admission](2026-10-17-managed-java-durable-admission.md). Turn input and cancel admissions that ask for it return the operation with its admission stage and delivery state, Sessions advertise `durable_operations`, and `harness_confirmed` stays the default. `PublicTurn` keeps its operation fields planned.
