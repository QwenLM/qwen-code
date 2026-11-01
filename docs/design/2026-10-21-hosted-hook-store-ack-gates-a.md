# Hosted Hook store-ack gates FG13a

[English](2026-10-21-hosted-hook-store-ack-gates-a.md) | [简体中文](2026-10-21-hosted-hook-store-ack-gates-a.zh-CN.md)

> Tracks #14449. The existing store-fault seam rejects a commit before it is
> applied; this layer adds the opposite failure: the commit lands and the
> caller never sees its acknowledgement.

## Problem and scope

`StoreFaultGate` fires inside the Session store's commit transaction, before
the record is applied, so the whole commit rolls back. That pins the rejection
path. It does not pin what happens when the store commits successfully and the
acknowledgement is lost: the caller must not re-run the Hook, and a later
status read must find the durable record.

This slice adds an ack-loss mode to the test seam and one cell: the result
commit of a settled Hook.

## Case

`fg13aHookResultStoreAckLossSettlesWithoutASecondCallOnMySql` in
`HostedHookReplyLossFaultGatesIT`:

| Step | What happens                                                 |
| ---- | ------------------------------------------------------------ |
| 1    | A `PreToolUse` command Hook runs once and settles.           |
| 2    | The result commit lands, then the seam reports the lost ack. |
| 3    | The cell reads the durable record and the public turn state. |
| 4    | A later status read returns the settled record.              |

Expectations:

- One physical call in the fixture evidence, and one settled result.
- The durable record is `settled` with a result, despite the lost ack.
- The later status read returns `settled` without a second call.

## Seam

`StoreFaultGate.armAck(phase, record)` sets a mode where `inspect` does not
throw. The faulting store registers a `TransactionSynchronization` callback
while the mode is armed, and `afterApply` throws from `afterCommit`. The
transaction manager has already committed at that point, so the caller sees a
lost acknowledgement over a durable record instead of a rollback — reporting
from `apply` itself would sit inside `ManagedSessionStore.commit`'s
transaction and undo the write.

`StoreFaultGateTest` pins the mode: the pre-commit hook stays silent, the
post-commit hook throws, and the plan marker is not matched.

## Coverage

`HostedHookReplyLossFaultGatesIT` already pins the result-commit rejection
(FG13b). This cell adds the acknowledgement-loss path over the same commit.

## Mutation witnesses

- Arm `arm` instead of `armAck`: the commit rolls back and the record never
  settles, so the durable-record assertion reddens.
- Drop `afterApply` from the faulting store: no fault fires and the cell
  reports zero attempts.
- Re-run the Hook on the status read: the physical-call count becomes two.

## Non-goals

- `dispatch_started` ack loss and the registration-settle ack: remaining
  FG13a cells on #14449.
- Store-client retry exhaustion: covered by the FG13b rejection cells.

## Validation

The `hosted-harness-mysql` lane on Linux with MySQL 8.4 and a delegated
cgroup v2 root is the evidence. `managed-agent-gate.yml` selects the `fast`
tier on `pull_request`; the full suite runs on the first maintainer approval
of the head commit. The cell adds 150 s to the shared fork.
