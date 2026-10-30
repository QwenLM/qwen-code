# Hosted MCP fault gates FG12b: store failures

[English](2026-10-18-mcp-store-fault-gates-b.md) | [简体中文](2026-10-18-mcp-store-fault-gates-b.zh-CN.md)

## Problem and scope

Issue #14447 is Stage F round FG12 of #12380: fault gates for the Hosted MCP domains `mcp_configuration` and `mcp_operation`. This slice rejects the managed session store's transactional writes at each step of the record state machine: the configuration's `intent`; `dispatch_started` for a configuration and for a raw operation; the settled commit after the response resource is published; and `releasing`, `drained` and `released`.

Process crashes are FG12c/d. Stream gaps are FG12e/f; FG12e folds into FG12f, so this slice does not cover streams.

## Current state

- The extension records live in **`ma_session_record`** (`record_kind = 'DOMAIN'`; legacy name `qwen_managed_session_extension_record`), not `ma_extension_record`. The record body is stored in `ma_resource` through `record_resource_id`; `run.execution` is inside that JSON. The row's `runtime_state` projects both `intent` and `dispatch_started` to `provisioning`; `releasing` / `drained` / `released` are not columns.
- The Harness commits through the HTTP managed session store; the Broker's `@Transactional` store writes the row. A rejected write surfaces to the Harness as a 5xx, and the HTTP client retries 5xx.
- FG12a/c/d provide the packaged Harness, durable worker, stdio fixture, MySQL, Broker proxy and lifecycle v2. FG12d is a case in the same class, not a second rig.

## Gate ledger

| Case                              | Rejection                                                        | Expect                                                                                                                                                                                                                                                 |
| --------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `store-reject-intent`             | the configuration `intent` commit                                | zero `mcp-configure` controls and zero fixture effects                                                                                                                                                                                                 |
| `store-reject-configure-dispatch` | the configuration `dispatch_started` commit, after owner acquire | zero controls and zero effects; the owner acquired before the rejection is recorded as retained until the next detach                                                                                                                                  |
| `store-reject-operation-dispatch` | the raw operation `dispatch_started` commit                      | zero `mcp-invoke` controls and zero effects; the owner is recorded as retained until the next detach                                                                                                                                                   |
| `store-reject-settled`            | the settled commit after the response resource is published      | the failed commit rolls back the staged response/catalog rows; the test disposes/reopens the failed authority from durable state (same operation/runtime pins) before the follow-up turn/close; exactly one lookup; no second read/get; effect count 1 |
| `store-reject-releasing`          | the `releasing` commit, before the release dispatch              | the next detach performs the first `${configurationId}:release` dispatch under that id; no second configure or invoke                                                                                                                                  |
| `store-reject-drained`            | the `drained` commit                                             | the Broker owner and storage holder stay; no fabricated drain receipt                                                                                                                                                                                  |
| `store-reject-released`           | the `released` commit, after the owner release                   | records stay `drained`; the next detach re-sends the owner release; its idempotency is asserted; the cell is green on MySQL 8.x and pins that ordering                                                                                                 |
| `store-reject-reload-chain`       | any rejection above, then a retry and reload                     | one logical record chain per id; no duplicate configuration record; the retried revision is not a duplicate of the rejected state                                                                                                                      |

## Decisions

1. **Inject through a test store wrapper inside the real transaction.** A `@TestConfiguration` wrapper around the Broker's transactional store delegates to the real store and throws for the named phase. A MySQL trigger is rejected: the row cannot identify the phase.
2. **Fail every retry for the phase.** The HTTP client retries 5xx; the wrapper keeps failing until the test clears the phase, and the case counts the attempts.
3. **A failed settled commit is driven, not self-healing.** The failure throws out of `install()`/`accept()`, so the test drives a follow-up turn or close; the proxy wire must show one `mcp-status` on the original id and no second invoke. A persistent 500 exhausts the HTTP commit retries and sets `ManagedSessionAuthority`'s write-failure latch; every later command throws `ManagedSessionWritesStoppedError`. The test must dispose/reopen the authority from the durable session store, keeping the original operation/runtime pins, before the recovery turn or lifecycle reconciliation.
4. **Staging is not durable publication.** `HttpManagedSessionResourceStore.publish()` stages bytes in memory; `commitResources()` embeds them in the transaction and the server inserts the `ma_resource` rows inside the same commit. A failed settled commit rolls back the new response/catalog rows; only resources committed earlier (arguments at intent) survive.
5. **Owner and storage retention are read from the owner/storage rows**, not inferred from the 5xx.
6. **A new `HostedMcpStoreFaultGatesIT` class** isolates the wrapper; the FG12a/c/d classes stay unchanged. The budget accounts and the roster/per-ceiling meta test are re-pinned in the same diff.
7. **`store-reject-released` pins the current ordering and is green.** `markReleased` commits after `broker.release()`; when that commit is rejected the records stay `drained` and the owner is already released, and the next detach re-sends the same release exactly once. The cell asserts that shape on MySQL 8.x, so a regression that skips the resend or answers it twice reddens it.

## Fixture design

- Reuse the FG12c boot; a test `@TestConfiguration` supplies the faulting store wrapper. The Harness sees a 5xx (a plain wrapper exception is 500 `internal_error`; a contract rejection is 409); JDBC reads the records and the owner/storage rows; the proxy wire counts controls; the fixture log counts effects. The test reopens the stopped authority from the durable session store after a persistent rejection.
- The wrapper resets the phase in teardown; a failed reset is best-effort and must not mask the case.
- Evidence lands in `target/fg12-cases/fg12b/<tenant>/`; the workflow already uploads `target/fg12-cases/`.

## Budget

The new class re-pins the shared fork accounts in the same diff: the per-case `@Timeout` ceilings, `hostedForkHealthySeconds`, the CI fork literal, `pom.xml`'s CI fork and the local `hosted-mcp-gates` family profile, the workflow comments, and the `hostedTestClasses` roster / per-ceiling `it(...)`. The artifact root already covers `fg12b`. Measure locally and keep the 2× allowance; the current shared values are read from `hosted-process-ci.test.js` and `pom.xml`, not copied here.

## Acceptance

- `mvn -DskipTests test-compile checkstyle:check` clean.
- The class green on JDK 21 + MySQL 8.x; every case self-proves the rejection (the wrapper fired and the attempt count is recorded) before its expectation.
- At least one mutation witness red: make the rejected write succeed, show the case red, restore green.
- `hosted-process-ci.test.js` green with the measured budget; both design docs in sync.

## Open questions

- Does the wrapper belong to the test Spring only, or does the Broker expose a supported fault seam? The wrapper is test-only; no product fault code.
- The `released` cell's red-on-main behavior and the owner-release retry idempotency must be verified before the case is promised.
- The authority reopen from durable state (same operation/runtime pins) must be verified for the settled cell and the later release-retry cells.
