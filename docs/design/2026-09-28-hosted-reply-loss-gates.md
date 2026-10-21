# Hosted Broker reply-loss gates (FG6a)

[English](2026-09-28-hosted-reply-loss-gates.md) | [简体中文](2026-09-28-hosted-reply-loss-gates.zh-CN.md)

## Problem and scope

Issue #12872 FG6a covers lost replies between the packaged Hosted Harness and
the Runtime Broker. Existing tests cover a lost start reply and an unavailable
status, but the Workspace integration fixture uses H2 even in the MySQL job.
Prepare currently does not retry a lost reply.

This change covers acquire, prepare, start, status, cancel and release. Store
failures, process crashes, general cancellation, SSE gaps, Shell, provider
controls and automatic continuation remain FG6b–f / W0e work. No route or
execution contract is added.

## Design

Extend `HostedWorkspaceToolTurnIT` with an independent fault driver using the
existing packaged Harness helper, fake model, Spring server and real worker.
The FG6a test requires `mysql.url` and `mysql.user`; it must fail without a
MySQL-compatible database. Each case gets its own saved Workspace and Session.
The existing happy-path driver remains a regression gate.

The proxy forwards a request and consumes the real Broker reply before closing
the downstream socket. It records request identities and upstream responses;
each case must prove its fault fired. Prepare retries once only on a transport
failure, reusing the original reservation fields. Definite Broker refusals and
invalid replies are not retried. Repeated prepare loss remains blocked.

| Reply         | Expected evidence                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| acquire       | No reservation or start; blocked Session; storage owner retained                                        |
| prepare       | Two requests, identical reservation identity, one execution and one start                               |
| prepare twice | One reservation, no start; blocked Session; owner retained                                              |
| start         | One start, status reads only the original execution; one effect                                         |
| status        | No new start or identity; blocked Session; no model continuation                                        |
| cancel        | Cancel after reservation but before start; lost reply blocks even if cancellation applied; zero effects |
| release       | Result persisted, no terminal Turn; live and cold Session admission blocked                             |

A release reply can be lost **after release applied**: the Broker has already
closed admission and cleared the Workspace storage owner. The Harness cannot
infer that success and must retain its unsettled input. It cannot force the
Broker to retain an owner after a completed release. A separate failure before
forwarding release verifies that the storage owner stays held when release has
not applied. This distinction follows the existing release protocol; FG6a does
not introduce a second release acknowledgement phase.

The driver checks transcript results, model call counts, rejection of new
input and reload, and filesystem effects. Java independently checks the SQL
execution ledger, dispatch generations, runtime Session and storage ownership.
These checks must agree with the proxy's identities and start counts.

The status case holds the real transport's completion behind a test-only
future. The worker still executes normally. The first status request observes
the real executing record, opens a loopback test barrier, waits for the real
settled record, and loses that reply. This makes status polling deterministic
without changing production wiring or dropping an additional start reply.

## Integration and validation

The touched layers are the Hosted Broker client and its unit tests, the Hosted
integration fixture and new TypeScript driver, and this bilingual design.
The Broker client's only production consumer is `HostedWorkspaceToolTurn`,
created by the Hosted session route and consumed by the Hosted model loop.
All requests retain their original Harness Session / Runtime Session scope.

Run the focused client/tool-turn tests, build, typecheck, bundle and the
`hosted-workspace-tools` Maven profile against MySQL or MariaDB. The existing
Hosted MySQL CI job supplies the same database properties. Check elapsed time
against its five-minute step budget before increasing it.

For every fault, temporarily remove the relevant production guard and require
the gate to fail; restore the source and bundle between mutations. Audit the
complete diff and challenge the passing evidence until two consecutive clean
passes. After audit round five, accept only Critical fixes.

Verified on macOS, Node 22.22.2, Java 21 and MariaDB 10.11.19: all eight
fault cases and the original Workspace regression passed, together with 137
Java unit tests and 53 focused CLI tests. The restored Maven run took 26.7
seconds; the CI time limit is unchanged. Build, typecheck, formatting, ESLint
and Checkstyle passed.

Nine temporary production mutations were rejected: treating uncertain acquire
as an ordinary error, removing prepare retry, changing its reservation identity,
exceeding its retry bound, repeating start, swallowing status or cancel loss,
and swallowing release failure in each release case. Each failed at a behavior
assertion, including the orphan reservation preventing release after identity
replacement. The source and bundle were restored and the full gate passed again.

## Acceptance and open questions

Every case fires its declared fault, uses only original identities, and checks
SQL plus filesystem evidence for at most one dispatch/effect. Unknown outcomes
produce no terminal Turn and cannot accept new input after reload. Successful
prepare/start recovery persists one result before model continuation. No open
implementation question requires expanding this slice.
