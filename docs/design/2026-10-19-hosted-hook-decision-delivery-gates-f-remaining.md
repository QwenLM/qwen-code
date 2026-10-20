# Hosted Hook decision-delivery gates FG13f (remaining arms)

[English](2026-10-19-hosted-hook-decision-delivery-gates-f-remaining.md) | [简体中文](2026-10-19-hosted-hook-decision-delivery-gates-f-remaining.zh-CN.md)

> Builds on #14701. Both decision cells shipped: the deny arm there, and
> `failclosed-reply-lost` in #14803. The remaining rows are assessed below.

## Problem and scope

FG13f covers decision and output delivery. #14701 pins a lost settled deny
reply; this layer adds the remaining arms tracked on #14449: a failClosed
failure reply, oversized single and aggregate outputs, the 4096 receipt cap
and the 16-running quota on a PermissionRequest, and a suppressed
MessageDisplay reload.

## Cases

`failclosed-reply-lost` is implemented in
`fg13fFailClosedReplyLossReplaysTheBlockedFailureOnMySql`; the other rows are
assessed under Remaining arms.

| Case                     | Inject                                                                                                                                                                                                                                                     | Expect                                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `failclosed-reply-lost`  | A failClosed Hook fails through the fixture's `hook-fail` mode; the broker proxy drops the first settled `hook-status` reply carrying the failure.                                                                                                         | One physical call; the decision is persisted before the tool; the tool never runs; a later read settles the same failure. |
| `oversized-output`       | A Hook returns an oversized single output and an oversized aggregate output through the Hosted path. The worker bound is already unit-covered, so this cell's subject is the harness aggregate/settle bound and the transport leg. Both bounds are 60 KiB. | The output is a bounded failure under the saved policy; the record does not grow past 60 KiB.                             |
| `receipt-cap`            | Exhaust the worker's 4096 receipt cap on a PermissionRequest.                                                                                                                                                                                              | The request is denied whatever the fail policy; no second call.                                                           |
| `running-quota`          | Exhaust the 16-running quota on a PermissionRequest.                                                                                                                                                                                                       | The refusal is `non_blocking_error`, so it denies only under failClosed.                                                  |
| `message-display-reload` | A MessageDisplay Hook suppresses output; reload the Session.                                                                                                                                                                                               | The suppressed output never appears in the replay.                                                                        |

## Prerequisites

Resolved. `hosted-hook-fault-process.mjs` now answers `hook-fail` by recording
`hook.fail` and exiting 1 without a decision, so the settled receipt is a
failure rather than a deny.

## Coverage

Already on main: the failClosed wrap (`hosted-hook-session.test.ts`), the
oversized worker bound (`managed-hook-runtime.test.ts`: a 70 KiB handler return
against the 60 KiB `MAX_BYTES`, receipt under 1 KiB), and the receipt cap and
the running quota (the 4096-operation worker test). The Hosted cells add the
transport leg, owner restart and lifecycle; the aggregate/settle bound is
in-process too (see Remaining arms). `failclosed-reply-lost` adds the
Hosted path for the wrap: the settled failure reply is dropped, the record
shows `recovery_blocked` / `outcome_unknown`, and a later status read persists
the wrapped block before the tool. For `receipt-cap` that marginal
value is delivery — a cap refusal crosses the broker as a deny — not the cap
arithmetic; its 4096 `hook-execute` requests are why the cell is budgeted
separately.

## Remaining arms

Three rows are covered in-process and are not planned as Hosted cells:

- `oversized-output`: the 60 KiB aggregate/settle bound is pinned by
  `hosted-hook-session.test.ts` ("bounds combined ... decisions without losing
  denial"), which runs two 36 KiB Hooks on PreToolUse and PermissionRequest,
  with and without a lost final-marker write.
- `receipt-cap` and `running-quota`: the 4096-operation worker test pins both
  refusals and their outcomes.

A Hosted cell for any of them would add the transport leg alone, at 150 s of
the shared fork each. That is deferred until a transport-specific defect
appears; the arms stay tracked on #14449.

`message-display-reload` remains planned: suppression is display state in the
Harness model, and no Hosted cell pins that it survives a reload.

## Mutation witnesses

- `failclosed-reply-lost`: stop dropping the settled failure reply; the record
  settles immediately and never reads `recovery_blocked`. Remove the
  `failClosed` wrap and the result carries `success:false` with no
  `decision:'block'`, so the tool runs. Rerun the command on a lost reply and
  `hook.call` counts two.
- `message-display-reload`: retain the suppressed text. The reload replay
  contains it.

## Non-goals

The other FG13 rounds (FG13a store acks, FG13b, FG13e) and local non-managed
Hooks stay on #14449.

## Validation

The `hosted-harness-mysql` lane on Linux with MySQL 8.4 and a delegated cgroup
v2 root is the evidence. The base is `main`, so the lane fires on
`pull_request` again. A skipped cell is not a passing gate.
