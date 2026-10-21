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

## Follow-up cell: cancel before dispatch

#14880 item 2 asked for a pre-dispatch cancel: an `mcp_operation` at `run.execution = intent` when the cancel arrives, settling `not_started_proven` with zero effects. It recorded the window as unreachable without a row-seeding helper, because the public route starts the dispatch. The window is reachable through the supported routes: `invoke()` commits `intent`, then acquires the owner (`POST …/tool-sessions:acquire`), and only then commits `dispatch_started`. The cancel route is not gated by the in-flight invoke (`mcpBusy`), and the pre-dispatch cancel branch never contacts the Broker.

| Case                     | Injection                                                                                                                                                                | Expect                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cancel-before-dispatch` | The proxy parks the first owner acquire that arrives while the target `mcp_operation` is durably at `intent`; the test cancels it through `…/mcp/operations/{id}/cancel` | The cancel answers `settled` with `managed_mcp_cancelled` while the invoke is still parked; the record is `cancelled`/`not_started_proven`, `cancelRequested: true`, no `resultRef`. After the acquire is released the original invoke answers the same view, as do a same-id retry and a status read. No MCP control (`mcp-invoke`, `mcp-cancel`, `mcp-status`) reaches the Broker after the parked acquire, the fixture records no effect, and no second server starts. |

Decisions:

1. **Park an acquire, not a seeded row.** A seeded `intent` row would bypass the record writer and the authority's revision chain, which is the code under test. The acquire hold leaves every write to the Harness; the proxy only reads the durable record to choose which acquire to park. The `refresh()` acquire that precedes the intent commit passes, and the hold is one-shot, so an acquire the cancel would need (if the pre-dispatch branch were gone) is forwarded.
2. **Assert the wire after the parked acquire.** The resumed invoke would still answer `managed_mcp_cancelled` if it ignored the proof and asked the Runtime, because `accept()` re-reads the record first. Only the absence of an `mcp-status` after the parked acquire catches that, so the gate asserts no MCP control at all after it.

Mutation witnesses, each rebuilt into the bundle the case runs (`hosted-mcp-session.ts`):

| Mutant | Change                                                         | Result                                                                                                                                                |
| ------ | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1     | `cancel()` skips its `intent` branch                           | Red: the cancel acquires, sends a native `mcp-cancel` the Runtime never registered, and answers `outcome_unknown` instead of `managed_mcp_cancelled`. |
| M2     | `invoke()` does not re-read the record after the owner acquire | Red: the stale `dispatch_started` commit over the cancelled record is refused, and the resumed invoke answers 503.                                    |
| M3     | `invoke()` re-reads but ignores the local proof                | Red only on the wire: the resumed invoke still answers `managed_mcp_cancelled`, but an `mcp-status` follows the parked acquire.                       |

Each mutant was rebuilt into `dist/cli.js` and run against the single case; the unmutated control rebuilt afterwards is green.

Budget: the case measures 9.1 s inside the eight-case class run (94.5 s) on JDK 21, MySQL 8.4.6 and Linux aarch64. It adds 18 s (2x) to the shared healthy sum (9871 → 9889 s), so the `hosted-harness-mysql` fork moves to 10489 s and the 185-minute Verify step still wraps it (11089 s of fork plus wrap); the job ceiling stays 288. The `hosted-mcp-gates` 1200 s profile and the artifact root `target/fg12-cases/fg12d/` are unchanged.

Not covered: a pre-dispatch cancel of a configuration (configurations are cancelled only by `reconcileEffects()` during a close) and an MCP tool call (tool calls ride the ordinary tool lifecycle, not `mcp_operation`).

## Follow-up cell: R1-1 across a Spring restart

#14880 item 3, and the R1-1 cell of #14447's FG12d row: during a lifecycle v2 close, the owner release is refused before it reaches the Broker, after the drain receipt is committed; then the Broker is replaced by a Spring restart. #13109's real-stack round recorded that detach then answered 503 on every attempt and kept the storage holder, because the restarted Broker refused the release with `runtime_reconciliation_required`.

**The recorded blocker was the rig, not the guard.** "Problem and scope" above, and FG12c decision 2, record that a whole-Spring restart re-registers the storage and `WorkspaceStorageGuard` refuses that while the holder is booked. Production never re-registers on start: `register` is the operator step (`WorkspaceStorageRegistrationMain`), the registration lives in `ma_storage_owner`, and the mount roots come from configuration. The refusal came from the IT's own `startSpring()`, which registered the storage and inserted the Workspace rows on every boot. Seeding once makes the restart reachable with no product change.

**R1-1 no longer reproduces on `main`.** A replaced Broker holds no local context for the Session, so the Harness's retry reaches `releasedSession`. The Session row is still READY, the binding READY with the same generation, and the lifecycle v2 close has marked the Harness draining. #13673's branch in that path (`RuntimeBrokerService`, the managed-context `releaseSavedSession` arm) releases the saved Session directly. The retry the #13109 review recommended (acquire, then release) is therefore not needed for this path.

| Case                              | Injection                                                                                                                                                                       | Expect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `owner-release-refused-restarted` | After `prepare_resources`, the proxy refuses the owner release (`POST …/tool-sessions/{id}:release`) with 503 before forwarding it; then Spring and its embedded Broker restart | The refused `settle_resources` answers 503 `workspace_lifecycle_resources_unsettled`, with the record `drained`, the holder booked, and the binding and Runtime Session READY. The restart changes none of that. A bounded `settle_resources` retry then succeeds; after the restart the proxy sees exactly one call, the owner release, answered 200, with no acquire and no MCP control. The holder clears, the record is `released`, the Runtime Session is RELEASED, and there is one `mcp-release`, one `mcp.start` and one `mcp.exit`. |

Decisions:

1. **Restart in the JVM, not a killed JVM.** The Broker's `close()` cancels in-memory work and writes nothing, and the durable local provisioner does not terminate its workers on close, so the restarted Broker sees the same rows and the same live worker that a killed one would leave behind. That is the state R1-1 needs; a separate control-plane JVM would add a fixture without changing it.
2. **Tolerate the writer lease, nothing else.** The case's Session writer lease is 3 s, and Spring is down for about 3 s, so the first retry can answer `workspace_lifecycle_resources_unsettled` (the writer is not active) before the Harness re-acquires its lease. That attempt sends nothing to the Broker. The loop accepts only that code and `hosted_turn_active`, and the wire assertion after the restart is exact.

Mutation witness: disabling the #13673 branch (`if (false && record.isActive() && …isManagedContext() …)`) turns the case red: every retry forwards the owner release, the restarted Broker answers 503, and the holder stays booked, which is the R1-1 symptom #13109 recorded. Three runs, all red at the recovery assertion; the restored control is green.

Budget: the case measures 11.4–11.9 s inside the nine-case class run (103.4–103.8 s, two runs) on JDK 21, MySQL 8.4.6 and Linux aarch64, and passed five standalone runs in a row. It adds 24 s (2x) to the shared healthy sum (10050 → 10074 s), so the `hosted-harness-mysql` fork moves to 10674 s and the 188-minute Verify step still wraps it (11274 s of fork plus wrap, 6 s of margin); the job ceiling stays 291. The next cell added to this fork must raise the Verify step and the job ceiling as well.

Not covered: a Broker killed during the owner release itself (the request reaches a Broker that dies before answering), a Spring restart before `drained` (FG12c's split-out Spring cells; the same seeding change unblocks them), and cross-host recovery.
