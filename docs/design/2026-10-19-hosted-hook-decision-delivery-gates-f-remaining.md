# Hosted Hook decision-delivery gates FG13f (remaining arms)

[English](2026-10-19-hosted-hook-decision-delivery-gates-f-remaining.md) | [简体中文](2026-10-19-hosted-hook-decision-delivery-gates-f-remaining.zh-CN.md)

> Stack layer 2/2 on #14701's branch. The deny arm is in the base; the cells
> below are planned for this layer and are not claimed implemented until each
> test lands.

## Problem and scope

FG13f covers decision and output delivery. #14701 pins a lost settled deny
reply; this layer adds the remaining arms tracked on #14449: a failClosed
failure reply, oversized single and aggregate outputs, the 4096 receipt cap
and the 16-running quota on a PermissionRequest, and a suppressed
MessageDisplay reload.

## Cases (planned)

| Case                     | Inject                                                                                                      | Expect                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `failclosed-reply-lost`  | A failClosed Hook fails; the broker proxy drops the first settled `hook-status` reply carrying the failure. | One physical call; the decision is persisted before the tool; the tool never runs; a later read settles the same failure. |
| `oversized-output`       | A Hook returns an oversized single output and an oversized aggregate output.                                | The output is a bounded failure under the saved policy; the record does not grow past the bound.                          |
| `receipt-cap`            | Exhaust the worker's 4096 receipt cap on a PermissionRequest.                                               | The request is denied whatever the fail policy; no second call.                                                           |
| `running-quota`          | Exhaust the 16-running quota on a PermissionRequest.                                                        | The refusal is `non_blocking_error`, so it denies only under failClosed.                                                  |
| `message-display-reload` | A MessageDisplay Hook suppresses output; reload the Session.                                                | The suppressed output never appears in the replay.                                                                        |

## Mutation witnesses

- `failclosed-reply-lost`: apply the decision after the reply arrives, or
  rerun the command. The tool runs or a second call appears.
- `oversized-output`: accept the oversized output. The bound assertion fails.
- `receipt-cap`: let one more receipt in, or serve the request. The deny
  assertion fails.
- `running-quota`: classify the refusal as blocking. It denies under the allow
  policy too.
- `message-display-reload`: retain the suppressed text. The reload replay
  contains it.

## Non-goals

The other FG13 rounds (FG13a store acks, FG13b, FG13e) and local non-managed
Hooks stay on #14449.
