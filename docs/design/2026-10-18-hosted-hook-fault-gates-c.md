# Hosted Hook fault gates FG13c

[English](2026-10-18-hosted-hook-fault-gates-c.md) | [简体中文](2026-10-18-hosted-hook-fault-gates-c.zh-CN.md)

## Problem and scope

Issue #14449 tracks FG13, the Stage F fault-gate round for the Hosted Hook
domains `hook_registration` and `hook_execution`. Like FG9 and FG10, the round
lands in slices. This document is the first slice: **FG13c, the
owner-restart matrix** — the one Hook-specific item that both
`docs/design/managed-agent-delivery-ledger.md:186` and #13129 say was never
run.

A managed command Hook is a decision gate with a process behind it. The
command runs in the Runtime worker's delegated cgroup v2 unit
(`hook-command-cgroup.ts`), and its receipt lives in that worker's memory
(`managed-hook-runtime.ts:516`). Which process restarts therefore decides
the outcome: a Harness restart can read the receipt through the record's
original owner and settle honestly; a worker loss cannot, and must stay
`recovery_blocked` / `outcome_unknown`.

## Decisions the issue asked for

1. **Spring/Broker restart is out of this slice.** The embedded broker lives
   in the Spring test JVM, next to the JDBC ground truth and the cgroup
   observation. Killing it kills the observer with it, so the gate could only
   assert from the next boot. FG8c took the same decision
   (`2026-10-16-monitor-run-fault-gates-c.md:97`). The
   Harness↔Broker disconnect arms belong to FG9's relay gates, which run
   dedicated proxies. #13129's "Broker/Runtime-owner" wording is satisfied
   by the worker-loss cells here; a standalone-broker restart rig is a
   separate topology and a separate round.
2. **The orphaned Hook unit is asserted, not cleaned up by the platform.**
   After a worker SIGKILL the command and its descendant keep the unit
   populated with no owner, receipt or timer. The worker-kill cell asserts
   that state before teardown, then teardown kills the unit. This pins the
   accepted H2 limit exactly as observed; it does not ask the product to
   reclaim the unit, which would be #13133 work.

## Rig

A new `HostedHookFaultGatesIT` (Linux, `hosted-harness-mysql`) with a
Hook-only definition on `hosted-workspace-files/1`:

- No MCP server in the definition, so Hooks do not ride MCP's owner
  (`hosted-harness-session.ts:4619-4625`).
- The profile is Hook-capable and closes under lifecycle protocol 1
  (`WorkspaceToolProfiles.java:26-33`), so a Turn reload after a kill mints a
  fresh owner. Recovery must therefore reach the record's own
  `runtimeSessionId`, not the current activation.
- The packaged Harness, the in-JVM Spring with its embedded broker, a real
  MySQL 8.4 schema, the durable worker, and a delegated cgroup v2 root.
- `HostedHookFaultProcess` (`src/test/resources/hosted-hook-fault-process.mjs`)
  records its PID, start ticks, boot id and cgroup, and optionally holds with
  a live descendant.

The model fixture advertises the files profile's `read_file`; the IT asserts
that a Hook-blocked read never returns the file body, so "the tool never ran"
is physical evidence, not a status read.

## Cases

| Case                          | Inject                                                                                              | Expect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness-kill-during-command` | A `PreToolUse` command Hook holds with a live descendant; SIGKILL the Harness; start a replacement. | Exactly one physical call. The replacement load answers the interrupted call; while the command still holds, a new prompt is refused with 409. The Session is then re-attached to the replacement (the passive recovery load) and the operation is read through the authenticated Harness status route, which asks the record's original `runtimeSessionId` and settles it from the worker's receipt. The record settles `settled` with a result; the unit reaches `populated 0`, and the worker and generation were unchanged at settlement. |
| `worker-kill-during-command`  | The same held Hook; SIGKILL the durable worker.                                                     | The record becomes `recovery_blocked` / `outcome_unknown`; never `settled` or `cancelled`. Exactly one physical call. The command and descendant survive as an ownerless populated unit. Close is refused (409 `turn_active` or 503) and the Session stays open. The generation is not re-minted.                                                                                                                                                                                                                                             |
| `command-kill`                | SIGKILL the Hook command while it runs, with no descendant.                                         | `non_blocking_error` under the saved `failClosed` policy: the record settles, the read never returns the file body, and the model sees the Hook's block. The unit is empty.                                                                                                                                                                                                                                                                                                                                                                   |

## Mutation witnesses

Each witness must turn its case red before the slice merges.

- `harness-kill-during-command`: make both `executionBroker` and `lookup`
  use the current owner instead of the record's own `runtimeSessionId`. The
  record can no longer settle from the original receipt, so the `settled`
  assertion fails.
- `worker-kill-during-command`: remove the `recovery_blocked` commit before
  the `HostedHookRecoveryRequiredError` for an unavailable receipt. The
  record then stays `running`, so the state assertion fails. (A deleted
  owner check is masked here because any lookup failure already answers
  `outcome_unknown`; the witness has to remove the honest commit instead.)
- `command-kill`: make `failClosed` pass a non-success outcome through. The
  block assertion fails.

## Non-goals

FG13a, FG13b, FG13d, FG13e and FG13f stay on #14449. Also out: local
non-managed Hooks, Windows/macOS, #13133's design items, snapshot-child Hook
policy (#14440), and prompt-Hook provider faults beyond the crash row.

## Validation

The full `hosted-harness-mysql` lane on Linux with MySQL 8.4 and a delegated
cgroup v2 root is the evidence; macOS H2 runs cannot establish any cell.
Checkstyle, SpotBugs and the CI fork-budget guard move with the new class.
A skipped cell is not a passing gate.
