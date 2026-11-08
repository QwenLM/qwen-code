# Hosted Hook dispatch-ack gates FG13a

[English](2026-10-21-hosted-hook-dispatch-ack-gates-a.md) | [简体中文](2026-10-21-hosted-hook-dispatch-ack-gates-a.zh-CN.md)

> Tracks #14449. The result-commit slice landed the ack-loss mode on a settled
> record; this layer moves the same fault to the `dispatch_started` commit,
> where the lost acknowledgement is the difference between "the worker was
> told" and "the worker was never reached".

## Problem and scope

The FG13b dispatch cell rejects the `dispatch_started` commit before it is
applied, so the transaction rolls back and the record stays at `intent`. That
pins the retryable case. It does not pin the opposite one: the commit lands,
the caller sees a failure, and the durable record now claims a dispatch that
the worker never received. Without a cell here, a recovery path could dispatch
that record a second time, or read the failure as "nothing happened" and let
the model proceed without the Hook's answer.

This slice adds one cell over the dispatch commit, using the ack-loss mode the
previous slice added.

## Case

`fg13aHookDispatchStoreAckLossLeavesTheDurableDispatchOnMySql` in
`HostedHookReplyLossFaultGatesIT`:

| Step | What happens                                                         |
| ---- | -------------------------------------------------------------------- |
| 1    | The `dispatch_started` commit lands, then the seam reports the loss. |
| 2    | The store client retries; the committed command replays.             |
| 3    | The Hook runs once from that durable dispatch and settles.           |
| 4    | The cell asserts the single fault and the settled result.            |

Expectations:

- The fault fires exactly once: the retry replays the committed command
  instead of re-running the record store. A rollback would re-commit the
  dispatch and fire the fault a second time.
- One physical call and one allow decision; the record settles with a result.
- A new `fire()` over an existing `dispatch_started` takes the `lookup`
  branch; this cell does not cover that path.

## Seam

No new seam. `StoreFaultGate.armAck(HOOK_DISPATCH_STARTED, null)` reuses the
mode added with the result cell: `inspect` stays silent, and `afterApply`
throws from the transaction's after-commit callback, so the row is durable
when the caller sees the failure.

## Coverage

- FG13b pins the rejection: rollback leaves the record at `intent` and nothing
  is dispatched.
- This cell pins the landed commit: the record is durable and the failure
  cannot be read as "no dispatch was recorded".
- A new `fire()` over an existing `dispatch_started` takes the `lookup`
  branch instead of dispatching; that path stays out of scope here. The
  TypeScript case `dispatches a recovered intent through its original Runtime
Session` covers only the `intent` window.

## Mutation witnesses

- Arm `arm` instead of `armAck`: the commit rolls back, the record stays at
  `intent`, and the durable-phase assertion reddens.
- Drop `afterApply` from the faulting store: no fault fires and the wait on
  `attempts` times out.
- Resume the durable dispatch twice: the physical-call count becomes two and
  the trailing bound reddens.

## Non-goals

- The registration-settle ack: the last FG13a cell, stacked on this branch.
- The forward resume path itself: pinned by the TypeScript unit test named
  above, not by this cell.

## Validation

The `hosted-harness-mysql` lane on Linux with MySQL 8.4 and a delegated
cgroup v2 root is the evidence. `managed-agent-gate.yml` selects the `fast`
tier on `pull_request`; the full suite runs on the first maintainer approval
of the head commit. The cell adds 150 s to the shared fork: healthy 10350 s,
fork 10950 s, Verify 193 minutes.
