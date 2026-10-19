# Hosted Hook decision-delivery gates FG13f

[English](2026-10-19-hosted-hook-decision-delivery-gates-f.md) | [简体中文](2026-10-19-hosted-hook-decision-delivery-gates-f.zh-CN.md)

## Problem and scope

Issue #14449 tracks FG13. FG13a covered lost replies for the command, catalog
and HTTP Hooks; this slice starts **FG13f, decision and output delivery**, with
the arm a deny pays first: the dispatch reply is lost after the worker settled
a deny.

A deny is a decision, not a result to re-derive. The worker persists it, and a
lost reply must resolve to that same decision through the record's status
instead of running the tool.

## Decisions

1. **Reuse the FG13a reply-loss rig.** The cell drops the first
   `hook-execute` control reply and lets the Harness fall back to `hook-status`
   on the record's own owner.
2. **The fixture grows a deny mode.** `hook-deny` writes `hook.deny` and answers
   `permissionDecision: deny`, so the cell exercises a real decision rather
   than an allow with a different label.
3. **One cell.** The dropped reply must still leave one physical call, one
   persisted deny, and a tool that never runs.

## Case

| Case              | Inject                                                                                                                 | Expect                                                                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deny-reply-lost` | A `PreToolUse` command Hook returns deny; the broker proxy drops the `hook-execute` reply after the worker settled it. | Exactly one physical call; the record settles with the deny (`outcome=blocking`); the tool never reads the file; the model sees the deny reason once; the drop is in the proxy log. |

## Mutation witness

- `deny-reply-lost`: apply the deny only after the dispatch reply arrives (or
  re-run the command on the retry). The tool then runs or a second `hook.call`
  appears, so the no-proof / one-call assertions fail.

## Non-goals

The rest of FG13f (a `failClosed` failure reply, oversized outputs, the receipt
cap and the 16-running quota, a suppressed `MessageDisplay` reload), FG13b,
FG13e and local non-managed Hooks stay on #14449.

## Validation

The `hosted-harness-mysql` lane on Linux with MySQL 8.4 and a delegated cgroup
v2 root is the evidence. Checkstyle and the CI fork-budget guard move with the
new cell. A skipped cell is not a passing gate.
