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
   proxy from the FG13d stack base. The first three cells drop one named broker
   control reply and pass every other call through; the HTTP cell drops the
   endpoint's response instead.
2. **For the two command cells, the retry is a status poll, not a second
   execute.** The Harness falls back to `hook-status` on the record's own
   `runtimeSessionId` when the dispatch reply is lost, which is what keeps the
   physical call at one.
3. **Four cells, one fixture each.** The first two hold a solo command for one
   second and allow; a dropped dispatch reply must resolve through status, and a
   dropped status reply must stay unknown until a later poll of the same owner
   settles it. Neither may add a second physical call. The third drops the
   catalog reply before the registration commits: the failed admission is
   retried, and the retry must register the pinned catalog once. The fourth
   sends an HTTP Hook request and drops the endpoint's reply: the receipt stays
   unknown, the tool never runs, and the request is never resent.

## Case

| Case                 | Inject                                                                                                                  | Expect                                                                                                                                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execute-reply-lost` | A `PreToolUse` command Hook runs; the broker proxy drops the `hook-execute` control reply after the worker admitted it. | Exactly one physical call; the retry resolves the same operation through the owner's status; the record settles `settled` with `outcome=success`; the allow reaches the model once; the proxy log records the drop.           |
| `status-reply-lost`  | The same solo command; the broker proxy drops the reply to a `hook-status` poll after the dispatch.                     | The dropped poll cannot prove the end, so the record first reports `recovery_blocked` / `outcome_unknown`; a later poll of the same owner settles it `success`, with exactly one physical call and the drop in the proxy log. |
| `catalog-reply-lost` | The broker proxy drops the reply to the first `hook-catalog` control call, before the registration commits.             | The admission fails, the coordinator retries the Turn, and the retry settles one `hook_registration` at the pinned catalog revision; the Hook runs exactly once, and the proxy log records the drop.                          |
| `http-reply-lost`    | A `PreToolUse` HTTP Hook posts to a local endpoint that consumes the request and drops the reply.                       | The endpoint receives exactly one request; the record stays `recovery_blocked` / `outcome_unknown`; the tool never runs; the endpoint is never called again.                                                                  |

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
- `catalog-reply-lost`: treat the lost catalog reply as an empty catalog
  instead of surfacing the failure, so `configure` proceeds without a
  registered pin. The Turn then runs with no Hook, and both the `hook.call`
  and the one-registration assertions fail. A second witness caches the
  catalog in memory before the registration commits; the retry then answers
  from that cache, leaving no settled `hook_registration`, and the one-record
  assertion fails.
- `http-reply-lost`: treat a dropped HTTP reply as a completed receipt, or
  retry the request. The record then settles, and/or the endpoint count becomes
  two, so the unknown and one-request assertions fail.

## Non-goals

The rest of FG13a — `hook-cancel` and the store acks of the `dispatch_started`
and result commits — stays on #14449. Also out: FG13b, FG13e, FG13f, local
non-managed Hooks, Windows/macOS and #13133's design items.

## Validation

The full `hosted-harness-mysql` lane on Linux with MySQL 8.4 and a delegated
cgroup v2 root is the evidence. Checkstyle and the CI fork-budget guard move
with the new cell; the pinned class list is unchanged. A skipped cell is not a
passing gate.
