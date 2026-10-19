# Hosted Hook decision-delivery gates FG13f (remaining arms)

[English](2026-10-19-hosted-hook-decision-delivery-gates-f-remaining.md) | [简体中文](2026-10-19-hosted-hook-decision-delivery-gates-f-remaining.zh-CN.md)

> Builds on #14701, now in main. The deny arm shipped there; the cells below
> are planned for this layer and are not claimed implemented until each test
> lands.

## Problem and scope

FG13f covers decision and output delivery. #14701 pins a lost settled deny
reply; this layer adds the remaining arms tracked on #14449: a failClosed
failure reply, oversized single and aggregate outputs, the 4096 receipt cap
and the 16-running quota on a PermissionRequest, and a suppressed
MessageDisplay reload.

## Cases (planned)

| Case                     | Inject                                                                                                                                                                                                                                                     | Expect                                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `failclosed-reply-lost`  | A failClosed Hook fails; the broker proxy drops the first settled `hook-status` reply carrying the failure. The fixture needs a failure mode first (see Prerequisites).                                                                                    | One physical call; the decision is persisted before the tool; the tool never runs; a later read settles the same failure. |
| `oversized-output`       | A Hook returns an oversized single output and an oversized aggregate output through the Hosted path. The worker bound is already unit-covered, so this cell's subject is the harness aggregate/settle bound and the transport leg. Both bounds are 60 KiB. | The output is a bounded failure under the saved policy; the record does not grow past 60 KiB.                             |
| `receipt-cap`            | Exhaust the worker's 4096 receipt cap on a PermissionRequest.                                                                                                                                                                                              | The request is denied whatever the fail policy; no second call.                                                           |
| `running-quota`          | Exhaust the 16-running quota on a PermissionRequest.                                                                                                                                                                                                       | The refusal is `non_blocking_error`, so it denies only under failClosed.                                                  |
| `message-display-reload` | A MessageDisplay Hook suppresses output; reload the Session.                                                                                                                                                                                               | The suppressed output never appears in the replay.                                                                        |

## Prerequisites

`failclosed-reply-lost` needs a failure mode in `hosted-hook-fault-process.mjs`.
The fixture currently answers allow/deny and exits 0, so the first commit of
this layer adds the failure mode; the cell is not planned against a fixture
that does not exist.

## Coverage

Already on main: the failClosed wrap (`hosted-hook-session.test.ts`), the
oversized worker bound (`managed-hook-runtime.test.ts`: a 70 KiB handler return
against the 60 KiB `MAX_BYTES`, receipt under 1 KiB), and the receipt cap and
the running quota (the 4096-operation worker test). The Hosted cells add what
the in-process tests cannot see: the harness aggregate/settle bound, the
transport leg, owner restart and lifecycle. For `receipt-cap` that marginal
value is delivery — a cap refusal crosses the broker as a deny — not the cap
arithmetic; its 4096 `hook-execute` requests are why the cell is budgeted
separately.

## Mutation witnesses

- `failclosed-reply-lost`: apply the decision after the reply arrives, or
  rerun the command. The tool runs or a second call appears. The fixture must
  first grow a failure mode (see Prerequisites).
- `oversized-output`: mutate the layer the witness names. The worker bound is
  already pinned by `managed-hook-runtime.test.ts`; reverting it turns that
  test red, not this cell. This cell's witnesses are the harness
  aggregate/settle bound and the transport leg.
- `receipt-cap`: let one more receipt in, or serve the request. The deny
  assertion fails.
- `running-quota`: classify the refusal as blocking. It denies under the allow
  policy too.
- `message-display-reload`: retain the suppressed text. The reload replay
  contains it.

## Non-goals

The other FG13 rounds (FG13a store acks, FG13b, FG13e) and local non-managed
Hooks stay on #14449.

## Validation

The `hosted-harness-mysql` lane on Linux with MySQL 8.4 and a delegated cgroup
v2 root is the evidence. The base is `main`, so the lane fires on
`pull_request` again. A skipped cell is not a passing gate.
