# Hosted MCP fault gates FG12b: store failures

[English](2026-10-18-mcp-store-fault-gates-b.md) | [简体中文](2026-10-18-mcp-store-fault-gates-b.zh-CN.md)

## Problem and scope

Issue #14447 is Stage F round FG12 of #12380: fault gates for the Hosted MCP domains `mcp_configuration` and `mcp_operation`. This slice rejects writes in real MySQL transactions at the store boundary, at each step of the record state machine: the configuration's `intent`; `dispatch_started` for a configuration and for a raw operation; the settled commit after the response resource is published; and `releasing`, `drained` and `released`.

Process crashes are FG12c/d and stream gaps are FG12e/f. This slice adds no process fault and no product fault code.

## Current state

- The records are extension records in `ma_extension_record` (`mcp_configuration` / `mcp_operation`), committed by the Harness through its managed session store. The state sequence is `intent` → `dispatch_started` → `settled`, and `releasing` → `drained` → `released`.
- FG12a/c/d provide the packaged Harness, durable worker, stdio fixture, MySQL, Broker proxy and lifecycle v2. This slice reuses that rig; it adds a store-failure injector, not a second rig.
- The exact table columns and JSON paths are verified at implementation; the ledger below is the issue's acceptance.

## Gate ledger

| Case                              | Rejection                                                   | Expect                                                                                                    |
| --------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `store-reject-intent`             | the configuration `intent` commit                           | zero `mcp-configure` controls and zero fixture effects                                                    |
| `store-reject-configure-dispatch` | the configuration `dispatch_started` commit                 | zero controls and zero effects; no second record revision                                                 |
| `store-reject-operation-dispatch` | the raw operation `dispatch_started` commit                 | zero `mcp-invoke` controls and zero effects                                                               |
| `store-reject-settled`            | the settled commit after the response resource is published | one lookup settles the original; no second read/get; effect count 1                                       |
| `store-reject-releasing`          | the `releasing` commit                                      | the next detach resumes `${configurationId}:release` under the original id; no second configure or invoke |
| `store-reject-drained`            | the `drained` commit                                        | the Broker owner and the storage holder stay; no fabricated drain receipt                                 |
| `store-reject-released`           | the `released` commit                                       | records stay `drained`; after reload the next detach resends only the owner release                       |
| `store-reject-reload-revisions`   | any rejection above, then reload                            | no duplicate record revisions                                                                             |

## Decisions

1. **Inject at the MySQL boundary, not in product code.** A test-only `BEFORE INSERT/UPDATE` trigger on the extension-record table signals `45000` for a phase named in a test-owned fault row. This exercises real transaction rollback. If the record JSON path proves too brittle, a test `@TestConfiguration` store wrapper is the fallback.
2. **A failed settled commit resolves through a lookup, not a resend.** The proxy wire is the witness: one `mcp-status` on the original id, no second `mcp-invoke`.
3. **Failures before `dispatch_started` leave zero controls and zero effects.** The proxy wire and the fixture effect log are both asserted.
4. **Owner and storage retention are read from the owner/storage rows**, not inferred from a 503.
5. **A new `HostedMcpStoreFaultGatesIT` class** isolates the trigger lifecycle; the FG12a/c/d classes stay unchanged. The six fork accounts are re-pinned in the same diff.
6. **Teardown drops the trigger and the fault row.** A failed drop is best-effort and must not mask the case.

## Fixture design

- Reuse the FG12c boot. Add a test-owned fault row naming the phase; the trigger matches it and signals. The trigger is installed after the schema migrations and before the session opens.
- The test drives the baseline configure, a raw operation, the close and the reload; JDBC reads the records; the proxy wire counts controls; the fixture log counts effects.
- Evidence lands in `target/fg12-cases/fg12b/<tenant>/`; the workflow already uploads `target/fg12-cases/`.

## Budget

A new class re-pins the six fork accounts: the class `@Timeout`, `hostedForkHealthySeconds`, the CI fork literal, the local `hosted-mcp-gates` family profile, the workflow comments and the artifact root. Measure locally and keep the 2× allowance.

## Acceptance

- `mvn -DskipTests test-compile checkstyle:check` clean.
- The class green on JDK 21 + MySQL 8.x; every case self-proves the rejection (the trigger fired) before its expectation.
- At least one mutation witness red: make the rejected write succeed (or remove the store guard), show the case red, restore green.
- `hosted-process-ci.test.js` green with the measured budget; both design docs in sync.

## Open questions

- Does the current code publish the response resource before the settled commit? Verify before pinning `store-reject-settled`.
- The exact table columns / JSON path for each phase; trigger versus a test store wrapper.
- For a failed `released`, does the next detach resend only the owner release, or also repeat the `${configurationId}:release` lookup? Verify before asserting.
