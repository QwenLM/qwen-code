# Hosted Hook cancel and timeout gates FG13d

[English](2026-10-18-hosted-hook-cancel-drain-gates-d.md) | [简体中文](2026-10-18-hosted-hook-cancel-drain-gates-d.zh-CN.md)

## Problem and scope

Issue #14449 tracks FG13, the Stage F fault-gate round for the Hosted Hook
domains. FG13c covered the owner-restart matrix; this slice is **FG13d's
first half: cancellation and timeout**, the arms that close the rest of
"cgroup execution/drain" that `HostedExtensionsIT` did not.

A managed command Hook runs in the Runtime worker's delegated cgroup v2
unit, and a command may leave a descendant behind. Cancelling or timing it
out therefore has to signal the whole unit, escalate to `cgroup.kill` when a
descendant ignores the graceful signal, and only report a terminal outcome
once the unit is empty (`hook-command-cgroup.ts:227-248`,
`hookRunner.ts:1415-1439`).

## Decisions

1. **Reuse the FG13c rig.** The new class borrows the Hook-only definition,
   the packaged Harness, the durable worker and the delegated root from
   `HostedHookFaultGatesIT`, so the gate measures the same owner path.
2. **The fixture gets a TERM-ignoring descendant.** A cancel that only sends
   SIGTERM cannot empty the unit while a descendant ignores it; the fixture
   child installs a `SIGTERM` handler in the `hook-ignore-term` mode.
3. **Independent cells, each its own fixture.** Cancellation, timeout and the
   stopped-worker cancel boot separate Spring/Harness/worker stacks, so a
   stall in one cannot mask the other. Each keeps `@Timeout(300)`, and the
   class is budgeted at 350 s.
4. **The cancel and status probes use the Harness routes.** Both go through
   the authenticated `/session/:id/hooks/operations/:operationId` routes
   with the contract headers, the same entry the FG13c status probe uses.

## Cases

| Case                         | Inject                                                                                                                    | Expect                                                                                                                                                                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cancel-held-command`        | A `PreToolUse` command Hook holds with a descendant that ignores SIGTERM; cancel the operation through the Harness route. | The command gets SIGTERM; the descendant survives it, so the unit is only emptied by `cgroup.kill` after the grace. The record settles `cancelled` and only then reports; the unit reaches `populated 0`; exactly one physical call; `failClosed` turns the cancelled outcome into a block and the tool never runs. |
| `timeout-held-command`       | The same held command with a 2 s Hook timeout and a descendant that ignores SIGTERM.                                      | The command times out, its output is not applied, the record settles with `outcome=timeout`, the unit is killed and reaches `populated 0`, and the model sees the block instead of the file body.                                                                                                                   |
| `cancel-with-stopped-worker` | The same held command; SIGSTOP the durable worker, then cancel through the Harness route.                                 | The cancel is recorded, but the owner cannot answer: the record stays `recovery_blocked` / `outcome_unknown`, the command and its descendant keep the unit populated, and no second call happens.                                                                                                                   |
| `cancel-with-dropped-reply`  | The same held command; the broker proxy drops the `hook-cancel` control reply after the worker aborted.                   | The cancel is already recorded, so the later status poll of the same owner settles it: the record is `cancelled`, the unit drains once, exactly one physical call, and the proxy log proves the drop.                                                                                                               |

## Mutation witnesses

Each witness must turn its cell red before the slice merges.

- `cancel-held-command`: remove the `cgroup.kill` fallback from
  `CommandCgroup.terminate` (leave only the SIGTERM pass). The descendant
  keeps the unit populated, the `populated 0` assertion fails, and the
  record cannot honestly report `cancelled`.
- `timeout-held-command`: skip termination on the timed-out branch so the
  unit is left running. The cgroup assertion fails while the record still
  settles `timeout`.
- `early-terminal` (both cells): publish the result before
  `processUnit.terminate` returns, so the record reaches its terminal state
  while the unit is still populated. `awaitTerminalDrained` inspects the
  first terminal observation, so both cells fail on the populated unit.
- `cancel-with-stopped-worker`: drop the honest unknown commit in `status()`
  (the branch that records `recovery_blocked` / `outcome_unknown` when the
  owner cannot answer). The record stays `running`, so the state assertion
  fails.
- `cancel-with-dropped-reply`: break the operation-id idempotency of the
  cancel dispatch (or remove the status re-poll that resolves the same
  occurrence). The retry then issues a second physical call, or the record
  stays unknown; the one-call or `cancelled` assertion fails.

## Non-goals

The rest of FG13d — cancel before dispatch and the DELETE async-drain with
`SessionEnd`/`SessionDelete` — stays on #14449. Also out: FG13a, FG13b,
FG13e, FG13f, local non-managed Hooks, Windows/macOS and #13133's design
items.

## Validation

The full `hosted-harness-mysql` lane on Linux with MySQL 8.4 and a delegated
cgroup v2 root is the evidence. Checkstyle, the CI fork-budget guard and the
pinned class list move with the new class. A skipped cell is not a passing
gate.
