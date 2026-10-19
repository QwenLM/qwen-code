# Hosted MCP fault gates FG12d: the release-state cell

[English](2026-10-18-mcp-release-fault-gates-d.md) | [简体中文](2026-10-18-mcp-release-fault-gates-d.zh-CN.md)

## Problem and scope

Issue #14447 is Stage F round FG12 of #12380: fault gates for the Hosted MCP domains `mcp_configuration` and `mcp_operation`. FG12c's restart matrix deferred one cell, **`harness-kill-releasing`**, because resuming `${configurationId}:release` needs the lifecycle v2 close sequence. This slice implements that cell.

The whole-Spring/Broker restart cells stay out. A whole-Spring restart replaces the in-memory `WorkspaceStorageGuard`, whose `register` refuses while the storage holder is still booked; the restarted Spring answers `workspace_unavailable` before the Broker release and cannot isolate owner-release recovery. FG12d does not add a Broker-only seam or a durable guard recovery, so those cells remain blocked (FG12c decision 2).

## Current state

- `HostedMcpRestartFaultGatesIT` boots the packaged Harness, a durable worker, a real stdio MCP server, MySQL, a Broker-fronting proxy and lifecycle v2. FG12c's five cases are green.
- The lifecycle v2 close sequence is `effects` → `prepare_resources` → `settle_resources`. `HostedMcpSession.closeResources` commits `releaseState: releasing` **before** it looks up or dispatches `${configurationId}:release`; only a settled release lets it commit `drained`, release the owner and mark `released`.
- A release dispatch legally answers `running`; a later `mcp-status` lookup resolves it to `settled`. The replacement Harness therefore resumes through a lookup of the original operation id, not a new release.

## Gate ledger

| Case                     | Injection                                                                                                                               | Expect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness-kill-releasing` | SIGKILL the packaged Harness after `releaseState: releasing` is committed, while its `mcp-release` dispatch is held at the Broker proxy | The replacement loads the same `runtimeSessionId` and the same lifecycle claim; it looks up `${configurationId}:release` under the original id and finishes it; exactly one `mcp-release`; no second `mcp-configure` or `mcp-invoke`; the final `releaseState` is `released` only after the wire answer is settled, never a fabricated settled. The conclusive `mcp-status` reply is held inside the proxy: while it is parked the record stays `releasing` and `settle_resources` is still unanswered; `drained`/`released` appear only after it is delivered. |

## Decisions

1. **Extend the existing class, not a new one.** The case shares the FG12c boot and fixture, so the fork-budget accounts for a new class do not change. Evidence is per case: FG12c keeps `target/fg12-cases/fg12c/`, FG12d lands in `target/fg12-cases/fg12d/`.
2. **Drive lifecycle v2 directly.** The Java coordinator is not the subject. The test admits a CLOSE operation with `beginWorkspaceLifecycle(..., protocolVersion = 2)` and claims it, then posts the three phases with the same authority. It stands in for the coordinator's DRAINING transition after `effects` by updating `ma_session_head.phase`; the coordinator's effects receipt and timestamps are not exercised (the coordinator is out of scope).
3. **Hold the release dispatch, kill after `releasing`.** The proxy parks `mcp-release` before forwarding, the test asserts the database record is `releasing` and the dispatch is in flight, then SIGKILLs the Harness. Releasing the hold lets the original dispatch reach the Runtime and register the operation, so the replacement's lookup has something to settle.
4. **Reload with the original claim.** The load carries `lifecycleProtocolVersion: 2` and `lifecycleAuthority` = the original `{operationId, claimGeneration}`. The replacement retries `settle_resources` (bounded) while the release is `running`; a settled lookup commits `drained`/`released`.
5. **The gate asserts the wire, then the state.** One `mcp-release` for `${configurationId}:release`, a settled `mcp-status` lookup for the same id (the bounded retry may issue more than one), no `mcp-configure`/`mcp-invoke` after the baseline, one `mcp.start`, and `runtimeSessionId` unchanged. `releaseState: released` is asserted only after that sequence. If the release never settles the route answers 503 and the record stays `releasing`/`drained`; the bounded retry fails rather than accepting a fabricated `released`.
6. **The conclusive reply is held, not reconstructed.** A settled lookup in the wire only shows that the answer existed, not that the state waited for it. The proxy therefore parks the settled `mcp-status` answer after the Broker produced it; while it is parked the case asserts the record is still `releasing` and the close route has not answered, then releases the answer and expects the close to complete with `released`. The release dispatch itself is not a witness: it legally answers `running`.

## Fixture design

- The existing rig is reused: packaged Harness (`hosted-harness` profile, lifecycle v2 env), durable worker, `hosted-mcp-fault-process.mjs`, MySQL, the Java Broker proxy and lifecycle v2.
- The session row is seeded directly by the test, so the case pins `ma_session.tool_profile` to `hosted-workspace-mcp/1` before admitting the close; the Harness create route does the same in production.
- The proxy forwards every header except the hop-by-hop set, so `X-Qwen-Lifecycle-Operation-Id` and `X-Qwen-Lifecycle-Claim-Generation` reach the Broker; no lifecycle-header allowlist is added.
- Evidence: `target/fg12-cases/fg12d/<tenant>/` with `proxy.json`, `wire.json`, `harness.log` and `processes.jsonl`. The workflow already uploads `target/fg12-cases/`, which includes the new subdirectory.

## Budget

No new class, so the six fork accounts stay unchanged: the class `@Timeout` 600 s, the shared healthy sum and CI fork (current values in `hosted-process-ci.test.js`) and its literal pin, the local `hosted-mcp-gates` profile (`**/HostedMcp*IT.java`), the workflow comments, and the artifact root `target/fg12-cases/`.

Measured on JDK 21 after the held reply was added: the six-case class is 32–37 s on MySQL 8.0.46 (two runs) and 40.5 s on MariaDB 10.11, with the release case at 6.0–7.0 s. FG12c's 49 s allowance was already budgeted at 2× (~98 s), so the class stays inside that allowance; the shared healthy sum and the CI fork do not move. Both schemas validate on current `main` after #14618. The artifact root already covers `fg12d`, so no upload or meta-test edit is needed.

## Acceptance

- `mvn -q -DskipTests test-compile checkstyle:check` clean.
- `HostedMcpRestartFaultGatesIT` 6/6 green on JDK 21 + MySQL 8.0.46 and MariaDB 10.11; the new case proves its injection (`releasing` in the database and a held `mcp-release`) before the kill.
- The `fg12d` evidence shows one `mcp-release`, at least one settled `mcp-status` for the same id, one `mcp.start` and one `mcp.exit`, `released`, and no second configure or invoke.
- While the settled `mcp-status` reply is parked, the record is still `releasing` and `settle_resources` has not answered; both advance only after the reply is delivered.
- No TS mutation witness in this slice (per the FG12d brief). Remaining risk: the green depends on the release settling within the 60×1 s retry window; a slower Runtime fails the gate rather than passing it with an unsettled record.
- The whole-Spring/Broker restart stays out while `WorkspaceStorageGuard` refuses a held storage; it is not faked with a second rig.

## Open questions

- A kill **before** the release dispatch reaches the Runtime would exercise the re-dispatch branch (same operation id, no lookup hit). This gate deliberately lets the original dispatch land so the lookup path is pinned; the pre-dispatch variant is a candidate follow-up.
