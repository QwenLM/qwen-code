# MySQL integration CI optimization

[English](2026-10-22-mysql-ci-optimization.md) | [简体中文](2026-10-22-mysql-ci-optimization.zh-CN.md)

Current database integration CI runs on MySQL 8.4 only. The two-engine descriptions and measurements below record the original optimization; the retained MySQL job still uses one independent instance per fork. See the [current database verification scope](managed-runtime-broker-jdbc.md#database-verification-scope).

## Problem and evidence

The main nightly [run 39664846210](https://github.com/QwenLM/qwen-code/actions/runs/39664846210) spent 33 minutes 41 seconds executing 1,060 integration tests in 52 classes. Their reported class times sum to 33 minutes 39 seconds, so execution was effectively serial. This excludes unit tests, Maven cache work, and the runner's Java lock wait.

`EventTransportConsumerMySqlIT` drops its database while its cached Spring context remains active. The same run then emitted 7,320 unknown-database exceptions over the following 30 minutes. A separate Spring/JUnit/MySQL probe reproduced the lifecycle error and verified closing the context through Spring's test lifecycle before dropping its database.

The SSH MySQL fixture also validates the same current schema three consecutive times without an intervening database mutation: its version assertion validates the catalog, its explicit validation repeats it, and its parent's initialization validates it again.

The local full-run reports also show that `ManagedSchemaLoadMySqlIT` inherits and repeats all 21 cases from `ManagedSchemaSessionMySqlIT`, in addition to its one unique load test. The two classes therefore execute 43 cases for 22 distinct scenarios.

## Changes

1. Mark the event-consumer MySQL context dirty after its class, and drop the owned database from a test listener after Spring has closed and evicted that context. Do not close the context prematurely inside JUnit's `@AfterAll`, because Spring's remaining listeners still use it.
2. Give only the `mysql-integration` Failsafe profile a fork-count property, defaulting to one for local runs. Each existing database matrix leg selects two reusable JVM forks and two independent instances of its own engine. The MySQL 8.4 and MariaDB 10.11 legs retain their respective images, startup arguments, readiness probes and clients. A test launcher listener resolves `${surefire.forkNumber}` to the corresponding database URL before test discovery and Spring initialization. Existing per-test UUID databases and method-level serial execution remain intact. Missing fork mappings fail the run instead of sharing the first database.
3. Have the SSH fixture's source factory return an initialized source. The H2 factory initializes its new database; the MySQL factory retains both migration stages and version assertions, and removes the redundant final validation. The parent setup no longer initializes it a second time.
4. Move the unique load test and its two private helpers unchanged into `ManagedSchemaSessionMySqlIT`, and remove `ManagedSchemaLoadMySqlIT`. The existing per-test database initialization and cleanup remain unchanged. The 21 inherited session cases and the load case now each execute once, without exclusions or a new fixture abstraction.

## Decisions and boundaries

Each database matrix leg still holds the existing host lock once, seeds one job-local Maven repository, builds once, runs unit tests once, and writes its dependency cache back once. Failsafe parallelizes integration classes inside that leg without introducing an extra workflow job and host-lock wait per fork. Surefire unit-test concurrency is unchanged. The existing complete-source-tree report check consumes the combined Failsafe reports, without a static class list or weakened coverage requirement.

Separate JVMs isolate tests that change `mysql.url` and the default time zone. Separate MySQL instances isolate both application tables and instance-wide InnoDB deadlock counters: `ToolPublicationLockOrderMySqlIT` deliberately causes a deadlock, while other tests assert that this counter does not increase. Separate schemas on one server would not satisfy that contract. Classes and methods must not run concurrently inside a fork. Schema mutation, migration, locking, recovery, and native-worker assertions remain enabled. Production schema validation is unchanged; fixtures that deliberately alter or drop schema objects continue to create a fresh database for each test.

The affected files are the event-consumer MySQL fixture, the two SSH fixtures, the session/load MySQL fixtures, the test launcher listener and its tests/service registration, the server Maven profile, the Java workflow, and its applicable workflow meta-tests. The workflow also supplies the original `mysql.url`, so releases checking out an older tag can still run serially. This change does not alter product behavior or artifact publishing steps.

Local Java verification guidance is centralized in the server's [Build and Verification rules](../../packages/managed-agent-server/AGENTS.md#build-and-verification). Local work selects affected behavior, reuses applicable evidence and has a bounded budget; full module acceptance remains with CI. This replaces the former unconditional local full-Maven requirement without weakening CI gates. The root AGENTS.md is unchanged: it already delegates Java-only verification to this module, while cross-language changes retain the root build/typecheck requirements. Skills, subagents and automation prompts working on this module reference its rules instead of maintaining separate copies. Documentation-only follow-ups do not rerun the unchanged Java suite.

## Verification and acceptance

- Reproduce the context leak, then verify that the real fixture's context closes before its database is deleted and that subsequent tests emit no unknown-database errors from that context.
- Compare the SSH MySQL class before and after on the same disposable MySQL 8.4 server; preserve both migration/version checks and all H2/MySQL business tests. Record class execution time separately from Maven build time.
- For the session/load consolidation, compare the selected real MySQL run with the deduplicated method identities in the two archived baseline reports: all 22 cases must pass without skips. Remove stale compiled output for the deleted class before the focused run. Relative to that archived baseline, consolidation removes one class and 21 duplicate executions, yielding 53 classes and 1,054 cases before any further upstream additions; leave the current full-suite confirmation to CI.
- Run the complete MySQL integration suite with two forks using distinct MySQL instances. Preserve all test selectors, compare the changed fixtures' test identities with their baseline, record full-suite counts, failures, skips and Failsafe time, and run the complete-report guard. Verify URL selection before Spring initialization, default serial behavior, and refusal of missing fork mappings. No speedup is accepted at the expense of missing tests.
- Run module verification, applicable workflow meta-tests, repository build/typecheck, formatting, and independent review. The global CLI cannot execute Maven test-fixture lifecycles, so the regression uses the actual Java test suite and a test-script reproduction rather than model-driven CLI prompts.

The historical class timings imply an ideal two-fork integration time near 17 minutes, but this is a planning estimate. Measured results must distinguish local macOS validation from Linux CI execution and disclose database, CPU, and runner contention differences.

The unchanged local SSH baseline took 71.379, 104.812 and 178.274 seconds for the same 17 passing tests. The shared 12-core host had load averages around 40–50. An additional full serial baseline would not produce a reliable before/after speed comparison under this changing contention, so it was cancelled before launch. Actual CI speedup must be measured on CI.

On JDK 21 and a disposable MySQL 8.4.11 instance, the actual event-consumer fixture passed all 12 original tests. At the real database-close call, its Spring context was inactive and absent from the cache while the schema still existed; the schema disappeared after the real DROP. Three more seconds in the same JVM produced no unknown-database or scheduled-task errors. The SSH fixture passed all 17 original test identities in each of three optimized runs: 44.342, 77.844 and 96.098 seconds. Host load had also fallen, so these measurements establish passing coverage and observed duration, not a precise CI speedup. The code removes exactly two redundant full schema validations per SSH test, or 34 per class run.

Before the session/load consolidation, the complete, unfiltered `clean verify checkstyle:check` run passed on 2026-10-22: Surefire reported 5,304 passing unit/H2 tests and 18 platform or environment conditional skips; Failsafe reported all 54 non-Hosted classes and 1,075 passing cases with no failures, errors or skips. The complete-source-tree report guard passed, as did Checkstyle and SpotBugs. All report properties selected the correct independent MySQL instance: 25 classes on fork 1 and 29 on fork 2. The complete log contained no unknown-database or scheduled-task errors. Build, bundle, typecheck and applicable CI script regressions also passed, with platform-conditional script skips recorded in the test report.

Local MySQL test execution took 1,419.755 seconds (23 minutes 40 seconds); the complete Maven command took 2,301.433 seconds. This used two native MySQL 8.4.11 instances with disk-backed data directories on shared macOS hardware. CI uses MySQL 8.4.6 and MariaDB 10.11.18 containers with tmpfs on Linux. These timings validate the implementation under the recorded local conditions; they are not a measured improvement over the historical CI run.

The subsequent session/load consolidation passed a focused real MySQL 8.4.11 run: all 22 distinct cases passed exactly once, with zero failures, errors or skips. Their method identities match the union of the two archived baseline reports, and Checkstyle reported zero violations. The moved test and helpers, inherited session tests, and per-test database lifecycle are unchanged. This selected run does not replace the pending full CI confirmation.

The PR also preserves the database matrix restored on main by #15003: shell regressions cover both engines, both fork ports, engine-specific readiness and client commands, and startup or cleanup failure of either instance. After rebasing, all nine workflow-consumer test files passed with 545 successful cases and 11 platform/capability skips. Repository build and typecheck, formatting, ESLint, workflow-size and local-reference checks passed. Real Linux container execution and the full rebased suite remain CI acceptance work.

## Status

Implementation and the recorded local checks are complete; full acceptance of the rebased revision remains pending CI. Results and the earlier failed verification attempt are preserved in `.qwen/e2e-tests/mysql-ci-optimization.md`. Online CI timing remains to be measured; no CI speedup percentage is claimed.
