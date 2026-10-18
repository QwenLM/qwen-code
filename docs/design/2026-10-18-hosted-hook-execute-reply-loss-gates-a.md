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
3. **One cell, one fixture.** The cell holds a solo command for one second
   and allows; the drop must not change the outcome or the call count.

## Case

| Case                 | Inject                                                                                                                  | Expect                                                                                                                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execute-reply-lost` | A `PreToolUse` command Hook runs; the broker proxy drops the `hook-execute` control reply after the worker admitted it. | Exactly one physical call; the retry resolves the same operation through the owner's status; the record settles `settled` with `outcome=success`; the allow reaches the model once; the proxy log records the drop. |

## Mutation witness

Each witness must turn the cell red before the slice merges.

- `execute-reply-lost`: break the operation-id idempotency of the dispatch
  so the retried request starts a second command. The fixture then reports
  two `hook.call` events and the one-call assertion fails.

## Non-goals

The rest of FG13a — `hook-catalog`, `hook-status`, `hook-cancel`, the store
acks of the `dispatch_started` and result commits, and a lost HTTP Hook
response — stays on #14449. Also out: FG13b, FG13e, FG13f, local non-managed
Hooks, Windows/macOS and #13133's design items.

## Validation

The full `hosted-harness-mysql` lane on Linux with MySQL 8.4 and a delegated
cgroup v2 root is the evidence. Checkstyle, the CI fork-budget guard and the
pinned class list move with the new class. A skipped cell is not a passing
gate.
