# Hosted MCP fault gates FG12c: the restart matrix

[English](2026-10-18-mcp-restart-matrix-c.md) | [简体中文](2026-10-18-mcp-restart-matrix-c.zh-CN.md)

## Problem and scope

Issue #14447 is Stage F round FG12 of #12380: fault gates for the Hosted MCP domains `mcp_configuration` and `mcp_operation`. FG12a (lost replies) landed in #14499. This slice implements **FG12c, the restart matrix**, the gate the round specifically owes: SIGKILL the packaged Harness, the Runtime worker and the stdio MCP server, and keep the two `HostedExtensionsIT` cells.

The Spring/Broker restart cells (idle, and during a release before `drained`) are **split out**. A whole-Spring restart replaces the in-memory `WorkspaceStorageGuard`, whose `register` refuses while the storage holder is still booked; the restart therefore blocks at `workspace_unavailable` before the Broker release and cannot isolate the target property. FG12d owns the post-`drained` owner-release recovery (R1-1); a Broker-only seam or a durable guard recovery is its prerequisite.

## Current state

- `HostedMcpReplyLossIT` (FG12a) boots the packaged Harness, a durable worker, a real stdio MCP server, MySQL, a Broker-fronting proxy and lifecycle v2. A baseline turn configures revision 1; the private route replaces to revision 2; the proxy counts the wire and drops named replies.
- `HostedExtensionsIT` already pins two matrix cells: an idle Harness SIGKILL keeps the same worker and MCP server; a server that makes its effect durable and exits before replying leaves the Turn `RUNNING`, and both new input and close answer `409 turn_active`.
- The Runtime's receipts are local to one Runtime generation and do not survive physical Runtime loss.

## Gate ledger

| Case                                              | Injection                                                        | Expect                                                                                                                                                                                |
| ------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness-kill-configure`                          | SIGKILL the Harness after a configuration's `dispatch_started`   | The replacement Harness reuses the original `runtimeSessionId`, binding and generation; the configuration resolves through a status lookup, never a second `mcp-configure`            |
| `harness-kill-operation`                          | SIGKILL the Harness with a held `resource_read` in flight        | The replacement looks up the original operation id; no second `mcp-invoke`; the fixture effect count stays 1 or the operation is `outcome_unknown`, never a fabricated settled result |
| `harness-kill-releasing` (deferred to FG12d)      | SIGKILL the Harness after `releaseState: releasing`              | The replacement resumes `${configurationId}:release` under the original id; no second configure or invoke                                                                             |
| `worker-kill-idle`                                | SIGKILL the Runtime worker while idle                            | The dead generation is never re-minted into a fresh owner; the Session stays `recovery_blocked`/`outcome_unknown`                                                                     |
| `worker-kill-operation`                           | SIGKILL the Runtime worker with a held `resource_read` in flight | The operation settles `outcome_unknown` (`managed_mcp_connection_lost`); nothing but a conclusive answer from the original generation settles it                                      |
| `stdio-kill-mid-request`                          | SIGKILL the stdio MCP server mid-request                         | The call settles `outcome_unknown` (`managed_mcp_connection_lost`); the fixture effect count does not grow                                                                            |
| `harness-kill-idle` and `server-effect-then-exit` | The two existing `HostedExtensionsIT` cells                      | Kept unchanged and re-run in the lane                                                                                                                                                 |

This slice lands `HostedMcpRestartFaultGatesIT` with five cells: the two Harness kills, the two worker kills and the stdio kill. The release-state cell moves to FG12d with the Spring restart, because resuming `${configurationId}:release` needs the lifecycle close sequence that the R1-1 recovery seam provides; pinning it here would duplicate that seam in the wrong letter.

## Decisions

1. **The stdio server's fate after a worker SIGKILL is asserted, not left open.** The fixture exits on stdin EOF and records `mcp.exit`; the gate asserts that the fixture does not survive. What a real server does is out of scope (recorded, not promised).
2. **Spring restart is deferred.** The guard refuses to re-register a held storage, so an idle or pre-drain restart cannot reach the Broker release. FG12d owns the R1-1 recovery; the seam is a prerequisite, not a second rig.
3. **A new class, not a change to FG12a.** `HostedMcpRestartFaultGatesIT` reuses the FG12a boot and fixture by copy, following the #13339 isolation rule; the FG12a class stays the lost-reply letter.
4. **The fixture gains a hold.** `resources/read` for `ext://hold` parks until a release file appears and records `mcp.hold`; an `mcp.exit` event records stdin close. This is the only fixture change; the FG12a cases keep their paths.

## Fixture design

- The IT boots Spring in-JVM (MySQL required), seeds one workspace and storage registration, pins the Harness broker URL at the Java proxy, and starts the packaged Harness with `hosted-workspace-mcp/1`.
- The driver half stays in the IT: SIGKILL by recorded pid, reload with the same `runtimeSessionId`, JDBC reads of `mcp_configuration`/`mcp_operation`, the proxy wire, and the fixture effect log.
- Evidence lands in `target/fg12-cases/fg12c/<tenant>/`; the workflow upload carries `target/fg12-cases/`.

## Budget

A new `Hosted*IT` class re-pins the fork budget in the same diff: the class `@Timeout` ceiling, `hostedForkHealthySeconds`, the CI fork value and its literal pin, the local profile, the workflow step comment, and the artifact path (the six accounts recorded in `hosted-fork-budget-remeasure-duty`). FG12c measured 25–49 s healthy over the five cases on JDK 21 + MariaDB 10.11 (49 s on the heaviest run, ~98 s budgeted at 2×). With FG13c merged, the shared healthy sum is 4238 s and the CI fork 4848 s; FG12c's 49 s allowance is included. The local `hosted-mcp-gates` profile already matches `**/HostedMcp*IT.java`.

## Acceptance

- `mvn -DskipTests test-compile checkstyle:check` clean.
- The class green on JDK 21 + MySQL 8.x, every case proving its injection (kill marker, held request, effect count) before its expectation.
- At least one mutation witness red: re-mint the worker generation (or resend instead of lookup on the reload path), shown red, then restored green.
- `scripts/tests/hosted-process-ci.test.js` green with the measured budget; both design docs in sync.

## Open questions

- Whether the held-request release should be a file or a FIFO (the file is simpler and readable after a SIGKILL).
- Whether the worker-kill cells need a cgroup to prove the stdio child's containment; the current fixture's stdin-EOF exit makes the process assertion sufficient for this slice.
