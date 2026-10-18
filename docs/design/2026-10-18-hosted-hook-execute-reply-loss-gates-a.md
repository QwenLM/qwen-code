# Hosted Hook execute reply-loss gates FG13a

[English](2026-10-18-hosted-hook-execute-reply-loss-gates-a.md) | [简体中文](2026-10-18-hosted-hook-execute-reply-loss-gates-a.zh-CN.md)

## Problem and scope

Issue #14449 tracks FG13, the Stage F fault-gate round for the Hosted Hook
domains. FG13c covered the owner-restart matrix and FG13d the cancellation
and timeout arms; this slice starts **FG13a, lost replies**, with the arm a
command Hook pays first: the reply to `hook-execute` is lost after the
worker admitted the operation.

The dispatch reply is the one place where a lost answer could look like a
lost call. The worker already owns the receipt, so the retry must resolve
the same operation through the owner's status instead of dispatching a
second command.

## Decisions

1. **Reuse the FG13d rig and broker proxy.** The class borrows the Hook-only
   definition, the packaged Harness, the durable worker and the forwarding
   proxy from the FG13d stack base; only the `hook-execute` control reply is
   dropped, and every other call passes through.
2. **The retry is a status poll, not a second execute.** The Harness falls
   back to `hook-status` on the record's own `runtimeSessionId` when the
   dispatch reply is lost, which is what keeps the physical call at one.
3. **Two cells, one fixture each.** Both hold a solo command for one second
   and allow; a dropped dispatch reply must resolve through status, and a
   dropped status reply must stay unknown until a later poll of the same
   owner settles it. Neither may add a second physical call.

## Case

| Case                 | Inject                                                                                                                  | Expect                                                                                                                                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execute-reply-lost` | A `PreToolUse` command Hook runs; the broker proxy drops the `hook-execute` control reply after the worker admitted it. | Exactly one physical call; the retry resolves the same operation through the owner's status; the record settles `settled` with `outcome=success`; the allow reaches the model once; the proxy log records the drop.           |
| `status-reply-lost`  | The same solo command; the broker proxy drops the reply to a `hook-status` poll after the dispatch.                     | The dropped poll cannot prove the end, so the record first reports `recovery_blocked` / `outcome_unknown`; a later poll of the same owner settles it `success`, with exactly one physical call and the drop in the proxy log. |

## Mutation witness

Each witness must turn the cell red before the slice merges.

- `execute-reply-lost`: break the exercised fallback — make the dropped
  dispatch reply answer `outcome_unknown` instead of looking up the receipt
  (for example, remove the `hook-status` fallback in `fire`). The record
  then never settles and the `settled` assertion fails. The execute
  operation-id deduplication is a separate witness: explicitly replay the
  `hook-execute` operation.
- `status-reply-lost`: drop the honest unknown commit in the `fire` loop
  (the branch that records `recovery_blocked` / `outcome_unknown` when the
  poll cannot prove the end). The record stays `running`, so the state
  assertion fails.

## Non-goals

The rest of FG13a — `hook-catalog`, `hook-cancel`, the store acks of the
`dispatch_started` and result commits, and a lost HTTP Hook response — stays
on #14449. Also out: FG13b, FG13e, FG13f, local non-managed
Hooks, Windows/macOS and #13133's design items.

## Validation

The full `hosted-harness-mysql` lane on Linux with MySQL 8.4 and a delegated
cgroup v2 root is the evidence. Checkstyle, the CI fork-budget guard and the
pinned class list move with the new class. A skipped cell is not a passing
gate.
