# Hosted Hook registration-ack gates FG13a

[English](2026-10-21-hosted-hook-registration-ack-gates-a.md) | [简体中文](2026-10-21-hosted-hook-registration-ack-gates-a.zh-CN.md)

> Tracks #14449. The last FG13a cell moves the ack loss to the
> `hook_registration` domain, where the caller is the admission path: a lost
> settle acknowledgement has to leave a registration the retry can reuse, not
> a second pin.

## Problem and scope

FG13b's table listed the registration settle as moved here, because the seam
had no catalog phase. The existing catalog cell drops the worker's
`hook-catalog` reply, which fails the first admission before the registration
is committed. It does not cover the opposite failure: the registration's
settle commit lands, the caller never sees the acknowledgement, and the
admission retry must find and reuse the durable pin instead of registering a
second time.

This slice adds a `hook_registration` phase to the seam and one cell over that
settle commit.

## Case

`fg13aRegistrationStoreAckLossReusesThePinnedRegistrationOnMySql` in
`HostedHookReplyLossFaultGatesIT`:

| Step | What happens                                                            |
| ---- | ----------------------------------------------------------------------- |
| 1    | The registration's settle commit lands, then the seam reports the loss. |
| 2    | The store client retries the same commit; the server replays it.        |
| 3    | Admission proceeds and reuses the durable registration at the pin.      |
| 4    | The Hook runs once and the model receives one tool result.              |

Expectations:

- One `hook_registration` record, `settled`, at the catalog pin the
  definition carries (`fg13-hooks`, revision 1).
- The fault fires exactly once: the client's retry replays the committed
  settle instead of re-applying it, and a re-apply would fire it again.
- One physical `hook.call`, one `hook.allow`, and one tool result for the
  emitted call.

## Seam

`StoreFaultGate.Phase.HOOK_REGISTRATION_SETTLED` matches the
`hook_registration` domain when `run.state` is `settled`; the target id is the
`registrationId`. The seam's domain allowlist now admits `hook_registration`,
so the commit is inspected at all. `armAck` keeps the same split as the other
cells: `inspect` stays silent, and `afterApply` throws from the transaction's
after-commit callback, so the settle is durable when the caller sees the
failure.

`StoreFaultGateTest` pins the phase: the admission commit is not matched, and
in ack mode the fault lands only on the settle.

## Coverage

- The catalog reply-loss cell drops the worker's reply before the registration
  commits; this cell lands the settle and loses its acknowledgement.
- FG13b's result cells pin what a lost settlement means for a Hook execution;
  this cell pins what it means for the registration the admission path reads
  back.

## Mutation witnesses

- Arm `arm` instead of `armAck`: the settle rolls back, the retry registers
  again, and the single-settled-registration assertion reddens.
- Drop `afterApply` from the faulting store: no fault fires and the wait on
  `attempts` times out.
- Start a new registration on the retry instead of reusing the durable one:
  a second record or a duplicate-pin rejection makes the one-record assertion
  red.

## Non-goals

- The dispatch ack loss: the previous cell in this stack.
- Store-client retry exhaustion: covered by the FG13b rejection cells.
- Moving the seam to production code: it stays test-only.

## Validation

The `hosted-harness-mysql` lane on Linux with MySQL 8.4 and a delegated
cgroup v2 root is the evidence. `managed-agent-gate.yml` selects the `fast`
tier on `pull_request`; the full suite runs on the first maintainer approval
of the head commit. The cell adds 150 s to the shared fork: healthy 10500 s,
fork 11100 s, Verify 195 minutes.
