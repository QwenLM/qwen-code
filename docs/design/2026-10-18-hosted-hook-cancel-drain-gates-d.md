# Hosted Hook cancel and timeout gates FG13d

[English](2026-10-18-hosted-hook-cancel-drain-gates-d.md) | [简体中文](2026-10-18-hosted-hook-cancel-drain-gates-d.zh-CN.md)

## Problem and scope

Issue #14449 tracks FG13, the Stage F fault-gate round for the Hosted Hook
domains. FG13c covered the owner-restart matrix; this slice covers **FG13d's
cancellation, timeout and async-drain arms**, the rest of "cgroup
execution/drain" that `HostedExtensionsIT` did not.

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
3. **Independent cells, each its own fixture.** Cancellation, timeout, the
   stopped-worker cancel and the DELETE drain boot separate
   Spring/Harness/worker stacks, so a stall in one cannot mask the other. The
   Hook cells keep `@Timeout(300)`; the DELETE-drain cell uses
   `@Timeout(600)` because it waits for both lifecycle Hooks. The class adds
   150 s to the shared fork.
4. **The cancel and status probes use the Harness routes.** Both go through
   the authenticated `/session/:id/hooks/operations/:operationId` routes
   with the contract headers, the same entry the FG13c status probe uses.

## Cases

| Case                            | Inject                                                                                                                    | Expect                                                                                                                                                                                                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cancel-held-command`           | A `PreToolUse` command Hook holds with a descendant that ignores SIGTERM; cancel the operation through the Harness route. | The command gets SIGTERM; the descendant survives it, so the unit is only emptied by `cgroup.kill` after the grace. The record settles `cancelled` and only then reports; the unit reaches `populated 0`; exactly one physical call; `failClosed` turns the cancelled outcome into a block and the tool never runs. |
| `timeout-held-command`          | The same held command with a 2 s Hook timeout and a descendant that ignores SIGTERM.                                      | The command times out, its output is not applied, the record settles with `outcome=timeout`, the unit is killed and reaches `populated 0`, and the model sees the block instead of the file body.                                                                                                                   |
| `cancel-with-stopped-worker`    | The same held command; SIGSTOP the durable worker, then cancel through the Harness route.                                 | The cancel is recorded, but the owner cannot answer: the record stays `recovery_blocked` / `outcome_unknown`, the command and its descendant keep the unit populated, and no second call happens.                                                                                                                   |
| `cancel-with-dropped-reply`     | The same held command; the broker proxy drops the `hook-cancel` control reply after the worker aborted.                   | The cancel is already recorded, so the later status poll of the same owner settles it: the record is `cancelled`, the unit drains once, exactly one physical call, and the proxy log proves the drop.                                                                                                               |
| `delete-drains-held-async-hook` | An acknowledged async `PreToolUse` command holds with a TERM-ignoring descendant; `DELETE` the Session.                   | The async command and its descendant are drained before `SessionEnd` and `SessionDelete` run, each lifecycle event runs exactly once, and the Session is released only after they settle.                                                                                                                           |

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

- `delete-drains-held-async-hook`: skip the async drain before the lifecycle
  events, so `SessionEnd` runs while the unit is still populated; the
  drain-order and unit assertions fail.

## Pre-dispatch cancel (unit instrument)

The `intent` window between the record commit and `dispatch_started` is too
short to observe by polling, and the first-turn `executionBroker` makes no
network call. A unit test blocks `executionBroker`, cancels while the Hook
execution record is still `intent`, and asserts `cancelled` /
`not_started_proven` with zero `hook-execute` requests.

The assertion that carries the pin is the `commitExtensionRecord` spy. A third
cancel checkpoint after the `dispatch_started` commit catches the same
condition, so removing the post-acquisition check leaves the final record and
the zero-`hook-execute` count green. What changes is the child record's
`dispatch_started` commit, and the spy catches it.

## Non-goals

Pre-dispatch cancel is pinned by the unit test above. Also out: FG13a, FG13b,
FG13e, FG13f, local non-managed Hooks, Windows/macOS and #13133's design items.

## Validation

The full `hosted-harness-mysql` lane on Linux with MySQL 8.4 and a delegated
cgroup v2 root is the evidence. Checkstyle and the CI fork-budget guard move
with the new cell; the pinned class list is unchanged. A skipped cell is not
a passing gate.
