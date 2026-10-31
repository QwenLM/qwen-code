# Managed channel delivery as a task, and its cancel (#13746 F3)

[English](2026-10-17-managed-delivery-task-cancel.md) | [简体中文](2026-10-17-managed-delivery-task-cancel.zh-CN.md)

Status: implemented in this change. A channel delivery projects as a task of its route Session (kind `channel_delivery`), and the public task cancel serves it while no adapter has claimed it. The contract names the kind in `1.57.0`. There are no new routes, operation types or failure codes. The change builds on [H4f-c](2026-10-17-managed-h3-task-cancel.md) (merged), whose cancellable-kind rule and delivery switch it shares.

This is F3 of [#13746](https://github.com/QwenLM/qwen-code/issues/13746), "the H5 half": one cancellation path serves both a child task and a channel delivery, and neither grows its own vocabulary. It belongs to stage H of [#12380](https://github.com/QwenLM/qwen-code/issues/12380) under [#12827](https://github.com/QwenLM/qwen-code/issues/12827). It replaces decision 10 of the [H4f note](2026-10-10-managed-task-cancel.md), which kept deliveries out of the task model and left their cancel to H5's public mutation routes. The issue's own framing settles that question: channel deliveries are tasks with a delivery line.

## Problem

A channel reply waits in the outbox as a `planned` delivery until the adapter pulls it. A caller who sees the reply should not go out has no way to stop it:

- the public channel routes are read-only;
- they read the delivery ledger, which has a row only once an adapter claimed the delivery, so a planned one is not even visible;
- the Hosted `cancel_delivery` verb exists, but nothing outside the fault gates calls it.

## Current state

Checked at H4f-c on `b4614845f0` (contract `1.54.0`):

- **The record.**
  - `channel_delivery` is a record of the route Session. It carries a delivery line (`planned` → `sending` → `partial`, `delivered`, `unknown`, `rejected`, or `cancelled`) and a set-once `cancelRequested` flag.
  - `cancelled` needs the flag and zero receipts, so only a planned delivery can end cancelled (`ManagedChannelRecords.java:178`).
  - The record projects no task (`ManagedExtensionProjection.java:62`, and the TS mirror).
- **The Hosted verb.**
  - `cancel_delivery` on `/session/:id/channels/operations` settles a planned delivery `cancelled` with the flag in one revision.
  - On a delivery an adapter already claimed it records the flag only, and the send proceeds.
  - A terminal delivery is answered unchanged (`hosted-channel-session.ts:707`).
  - Its only callers are the FG7d fault gates.
- **The claim.** The adapter's pull discovers `planned` and `partial` records (`ChannelInstanceStore.java:263`, `:296`). A cancelled one is never claimed.
- **Public reads.** Delivery list and detail read the ledger; a planned delivery answers `404 delivery_not_found` (`ManagedChannelService.java:502`).
- **The task path.**
  - Task list, detail, events and cancel are served for every task-projecting record of a Session.
  - A record row gets its `task_kind` when it is first inserted, and later revisions update only the projected state (`ManagedExtensionRecordStore.java:1350`, `:1383`).

## Decisions

1. **A delivery projects as a task of its route Session.**
   - The `channel_delivery` body's task kind becomes `channel_delivery`, in both languages and in the shared projection fixtures, and the contract's `TaskKind` gains the value.
   - The states follow the run block like every other kind:

     | Delivery line                 | Run         | Task state  |
     | ----------------------------- | ----------- | ----------- |
     | `planned`                     | `admitted`  | `pending`   |
     | `sending`, `partial`          | `running`   | `running`   |
     | `unknown` (and its `partial`) | `waiting`   | `waiting`   |
     | `delivered`                   | `settled`   | `completed` |
     | `rejected`                    | `failed`    | `failed`    |
     | `cancelled`                   | `cancelled` | `cancelled` |

   - The run has no execution, so the task carries no `runtime_state`. It also has no Artifact reference.
   - Each change of the view is journaled on the H3 per-task event journal, as for every kind.
   - The task is visible to exactly the readers of the route Session, which is a Session of the channel's Workspace. That is the same set the channel reads admit.

2. **Rows written before this change stay non-tasks.** A row's kind is set at its insert, and every later revision follows the kind the row stores, not the one its body would project now: a delivery planned before the upgrade writes no task state and journals no task event on any later revision, and never projects a task. No backfill: such a delivery is past its cancel window by the time anyone could act on it, and the channel reads still show it once claimed.

3. **Cancel is admitted only while the delivery is `pending`.**
   - `taskActions` gives `channel_delivery` one state rule of its own: `cancel` is advertised, and a new cancel admitted, only for a `pending` (planned, unclaimed) delivery in an active Session.
   - A claimed delivery is on its way to the provider. Its view advertises nothing, and a new cancel answers `409 task_action_unavailable`.
   - Everything else is the H4f path unchanged: the A6 admission order, the Workspace OPERATOR rule, replay and the one-open-operation rule.

4. **The delivery arm and the verdict reuse the task cancel.**
   - `TaskCancelCoordinator` sends `cancel_delivery` through the route Session's channel operation route, keyed by the operation's attempt.
   - The verdict reads the committed record, and the `cancelRequested` flag is the stop request:

     | Committed record                | Operation outcome                                  |
     | ------------------------------- | -------------------------------------------------- |
     | `cancelRequested` is set        | `completed` with a receipt                         |
     | the delivery ended without it   | `failed` `task_already_settled`                    |
     | the delivery is live without it | send `cancel_delivery`, then read the record again |

   - An adapter that claims the delivery between the admission and the send wins the race. The verb records the flag, so the operation completes, and the delivery keeps sending to its natural outcome, as a completion that wins keeps its outcome in the task contract.
   - Unproven outcomes retry within the budget and then park, as H4f decision 5 says.

5. **No new vocabulary.** There is no delivery route, operation type, delivery id property or failure code. The F3 exit check holds literally: one cancellation path serves both kinds.

## Contract changes (1.57.0)

- `TaskKind` gains `channel_delivery`.
- `TaskActionCapability`'s description names the kind and its `pending`-only rule.
- `info.description` gains the v1.57 paragraph.
- The generated WebShell types gain the enum value.

## Validation

- **Projection, both languages.** The shared projection fixtures map `channel_delivery` to its kind and list it among the task kinds. Both channel record contract tests pin that a delivery projects a task and a route does not. The TS authority's delivery chain and its reopen now carry the delivery's task view.
- **Real records** (`ManagedExtensionRecordStoreTest`):
  - a planned delivery reads as a `pending` task with `cancel` and no runtime state;
  - a claimed one reads `running` with no action;
  - a cancelled one reads `cancelled`, with its request on the record the verdict reads;
  - a delivery row stored without a kind, as a server before this change wrote it, writes no task state and journals no task event on its next revision.
- **Admission** (`ManagedTaskCancelOperationTest`): a `pending` delivery admits and replays. Every other state answers `task_action_unavailable`.
- **Delivery** (`TaskCancelCoordinatorTest`):
  - a pending delivery takes `cancel_delivery` through the channel route, never the child operation route, and completes from the flag;
  - a delivery claimed meanwhile completes with the flag recorded;
  - a delivered one without the flag fails `task_already_settled` with no send;
  - a route the Workspace authority refuses retries, parks after its budget and is never sent again; the parked cancel fails `task_already_settled` once the delivery is sent without the flag.
- **Connector** (`QwenHostedHarnessConnectorTest`): `cancel_delivery` takes the channel route's Workspace check on a cached attachment, as `submit_input` does, and nothing is forwarded while it fails.
- **Real stack** (FG7d, `HostedChannelFaultGatesIT`, MySQL 8.4, packaged Harness, the email reference adapter):
  - `task-cancel-planned`: the route Session's task list shows the planned delivery as a `pending` task with `cancel`. The public cancel answers `202`, the operation completes and its key replays, and the task reads `cancelled`. The outbox pull reaches the control plane and sends nothing, and the ledger stays empty.
  - `task-cancel-claimed`: while the adapter's send is parked, the task reads `running` with no action, and a public cancel answers `409 task_action_unavailable`. Released, the delivery is sent once and the task reads `completed`.
  - The whole FG7 class and the channel crash IT pass beside the new cases.
- **Not covered:** listing delivery tasks in the WebShell panel (the panel's own change); a real provider other than the email fixture.

## Constraints and risks

- **More rows in a route Session's task list.** Every reply of a channel Session is now one task there, and every revision is one task event. The journal's bounds and retention floor apply unchanged.
- **The race is visible.** A cancel whose admission saw `pending` can complete while the reply still goes out, if an adapter claimed it first. The operation's `completed` is the recorded request, and the task's `completed` is the physical outcome, as the contract keeps them apart.
- **A creator without the execution grant parks the cancel.** The channel operation route re-runs the route Session's Workspace execution authority on every operation, a cached attachment included (`QwenHostedHarnessConnector.runChannelOperation`), and `cancel_delivery` takes it like `submit_input`. While the creator lacks the grant, a delivery cancel sends nothing, retries on the budget and parks `recovery_blocked`. A parked cancel is never sent again ([H4f decision 5](2026-10-10-managed-task-cancel.md)). Once the grant returns, a new cancel can still stop a delivery that is still pending, since a parked one is not open; but an adapter may claim and send it first, and the parked cancel then fails `task_already_settled`. This is the H4f limitation for a creator who lost the grant, scoped to this route: a child task's cancel takes the child operation route, which runs no Workspace check of its own on a cached attachment.
- **Legacy rows.** Deliveries planned before the upgrade are not tasks (decision 2).
- **Rollback floor.** A server older than this change writes a null task state on every revision of a row it does not know projects a task. Rolled back, it would keep listing the delivery tasks inserted meanwhile (their kind is stored), with a null state and a kind its contract does not name. Roll back below this change only after those Sessions are closed, or accept such rows reading wrong until they are.

## Follow-up work

| Item           | Scope                                                                                                                                                             |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public resend  | A resend of an `unknown` or `rejected` delivery is still a trusted-adapter verb; a public one needs its own contract work (H5 open question 4).                   |
| WebShell panel | **Delivered by #14415:** the panel lists every kind under its label and admits cancel by `actionCapabilities` alone, so a pending delivery shows with its cancel. |
| Partial stop   | Stopping the remaining segments of a `partial` delivery needs a record contract change; no adapter produces one today.                                            |
