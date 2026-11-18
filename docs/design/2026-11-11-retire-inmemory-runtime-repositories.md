# Retire the InMemory Runtime Broker Repositories

[English](2026-11-11-retire-inmemory-runtime-repositories.md) | [简体中文](2026-11-11-retire-inmemory-runtime-repositories.zh-CN.md)

Status: implemented (2026-11-11); local focused verification green (763 tests, Checkstyle, SpotBugs), full CI gates pending.

## Problem

The runtime broker persistence module ships two implementations of each
repository interface: the JDBC implementations used by all production wiring
(`RuntimeBrokerConfiguration` constructs only JDBC repositories) and three
InMemory implementations with zero production callers:

- `InMemoryRuntimeBindingRepository` (558 lines)
- `InMemoryRuntimeSessionRepository` (199 lines)
- `InMemoryToolExecutionRepository` (512 lines)

The InMemory classes exist solely as test fixtures: 42 test files in the
`verification` module instantiate them (448 construction sites). Their class
documentation mentions "single-node use", but no such wiring exists. Maintaining
a second implementation of the storage contract creates a permanent divergence
risk: broker orchestration tests run against fixture semantics that can drift
from the JDBC semantics production actually uses.

## Current state

A scenario-level coverage inventory (2026-11-11) classified all 42 consumer
files against the existing H2/JDBC-backed suites (`JdbcRepositoryContract` run
by `JdbcRepositoryTest` on H2 and `JdbcRuntimeBrokerMySqlIT` on MySQL,
`ExecutionTakeoverContract`, `RuntimeRecoveryContract`, and the H2-backed
service/IT suites):

- 7 hybrid files already contain JDBC twins of their InMemory tests; only the
  InMemory methods/parameter arms need removal.
- 1 file (`HostedExecutionTransportProbeTest`) only self-tests the
  `HostedCancellationProbe` and status-reply gate helpers. Their real consumers
  are the MySQL-only FG6d and FG6a cases of `HostedWorkspaceToolTurnIT`, which
  run in the `hosted-harness-mysql` profile.
- 4 files are already JDBC/H2-backed and pass InMemory repositories only as
  empty-shell arguments; a drop-in JDBC swap loses no coverage.
- ~27 files need real migration of fixture construction or gap scenarios,
  dominated by `RuntimeBrokerServiceTest` (~170 uncovered orchestration
  scenarios, 95 construction sites), `DurableRuntimeRecoveryTest` (~30), and
  `Issue13183RegressionTest` (~15). `RuntimeBrokerHttpServerTest` (44 tests)
  migrates through one centralized Fixture.

## Goals

- Delete the three InMemory implementations, `InMemoryRepositoryTest`, and
  `InMemoryTestAccess`.
- Preserve scenario coverage: delete only what an H2/JDBC-backed test already
  exercises; migrate every gap scenario to the JDBC repositories on H2.
- No production behavior change; production wiring is already JDBC-only.

## Scope boundaries

- Test code and the three unused fixture classes only. No SQL, schema,
  transaction, or recovery semantics change, so no new MySQL evidence is
  required beyond the existing CI profiles; the migrated suites gain H2
  coverage and keep their MySQL IT counterparts where they exist.
- The TypeScript `createInMemoryChannel` helper (acp-bridge) is unrelated and
  stays.

## Proposed solution

Phased execution, each phase independently compilable and testable:

1. **Phase A — mechanical cleanup.** Swap empty-shell InMemory arguments to
   JDBC in the 4 already-backed files; delete InMemory methods/arms in the 7
   hybrid files; delete `HostedExecutionTransportProbeTest`.
2. **Phase B — small/medium migrations.** Move centralized fixtures to H2
   (`RuntimeBrokerHttpServerTest`, `EmbeddedRuntimeBrokerTest`,
   `RuntimeProviderPluginsTest`, `SshRuntimeWiringTest`, pinning/fault-gate/
   provisioner tests) and migrate the 1–3 gap scenarios in each partial file.
3. **Phase C — large migrations.** `RuntimeBrokerServiceTest`,
   `DurableRuntimeRecoveryTest`, `Issue13183RegressionTest` gap scenarios.
4. **Phase D — retirement.** Delete `InMemoryRepositoryTest`,
   `InMemoryTestAccess`, and the three implementations; verify no references
   remain; run focused suites plus Checkstyle/SpotBugs.

## Design decisions and rationale

- **Delete covered scenarios instead of migrating them** (explicit product
  decision): the H2/JDBC contract and service suites are the authoritative
  coverage; duplicating them against a fixture adds maintenance cost without
  signal.
- **House H2 pattern**: per-test `jdbc:h2:mem:<uuid>;MODE=MySQL;
DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE` plus `ManagedSchema.initialize`,
  matching `JdbcRepositoryTest` and the existing hybrid tests. No new shared
  fixture abstraction.
- **Time control**: JDBC repositories read the database clock
  (`JdbcRepositorySupport.databaseNow`), so `MutableClock` scenarios convert
  to direct SQL updates of deadline/lease columns (the `expire`/`tamper`
  pattern already used by `JdbcRepositoryContract`), which behaves identically
  on H2 and MySQL.
- **Deterministic identity**: `JdbcRuntimeBindingRepository`'s ID-supplier
  constructor preserves assertions on generated IDs.
- **Decorator fixtures stay**: latched/fault-injecting delegates wrap the
  repository interfaces, so they wrap JDBC repositories unchanged.

## Constraints

- Module verification policy: JDK 21, Maven ≥ 3.8.9, task-local
  `-Dmaven.repo.local`, ≤ 10 minutes of local verification per increment;
  focused `-Dtest=` runs locally, full unit/H2/MySQL/Hosted profiles in CI.
- Checkstyle and SpotBugs apply to the production modules (the deleted classes
  live in `persistence`).

## Risks

- **Misclassified coverage** → a deleted scenario loses protection. Mitigation:
  deletions are limited to files with in-file JDBC twins or named H2
  equivalents; each deletion is spot-checked against the cited evidence.
- **Timing-semantic drift** when converting `MutableClock` to SQL time edits →
  a migrated test asserts the wrong thing. Mitigation: scenario-level review
  of each conversion; keep the original assertion structure.
- **Suite runtime growth** from H2 setup per test. Accepted: H2 in-memory is
  the established pattern across the module; CI owns the runtime gate.

## Validation plan

- Per phase: `mvn -Dtest=<affected classes> test checkstyle:check` from
  `packages/managed-agent-server` with the task-local repository.
- Phase D: repository-wide grep proves zero remaining references to the three
  classes; SpotBugs on `persistence`.
- CI: full `mvn verify` (unit/H2, Checkstyle, SpotBugs) plus the MySQL and
  Hosted profiles; acceptance stays pending until those gates pass.

## Acceptance criteria

- The three InMemory classes, `InMemoryRepositoryTest`, and
  `InMemoryTestAccess` are deleted; no source references remain.
- Every gap scenario identified in the inventory runs against JDBC
  repositories on H2 (or MySQL where an IT already exists).
- Focused local suites green; CI full gates green on the final revision.

## Implementation notes

Mechanisms established during the migration (all test-side; no production
behavior change):

- **CSI provision pin seeding**: JDBC `findOrCreate` enforces the pinned CSI
  Session root (`ma_session` row) the control plane writes before provisioning;
  InMemory did not. CSI fixtures seed the pin with the established INSERT
  pattern (`RuntimeHarnessDrainTest`, `RuntimeBrokerHttpServerTest`).
- **Guard unwrapping decorators**: JDBC cross-repository transactions
  (`admitSession`, `admitExecution`, `authorizeDispatch`, `recoverLost`,
  release paths) require raw same-`DataSource` JDBC repositories. Instrumenting
  doubles stay on the service read path; `JdbcGuardBindings` /
  `NativeAdmissionBindings` unwrap to the native delegate for guard calls
  (`Issue13183RegressionTest`, `RuntimeBrokerServiceTest`).
- **SQL-gated pinning witness**: `BrokerVirtualThreadPinningTest` cannot wrap
  the final session repository, so a `DataSource` proxy parks non-locking
  `ma_runtime_session` SELECTs (the guarded `findById` path) behind the latch;
  locking admission reads pass through.
- **Fake-clock DataSource shim**: continuous renewal-loop tests keep their
  exact `advanceAndAwaitRenewal` mechanism — a `DataSource` proxy rewrites the
  repository clock query (`SELECT UNIX_TIMESTAMP(), EXTRACT(MICROSECOND FROM
CURRENT_TIMESTAMP(6))`, exact match so schema INSERTs pass through) to
  literals from the test's `MutableClock`. Lease parameters use whole seconds
  because `JdbcRepositorySupport.leaseUntil` rounds up to seconds. The same
  shim restores the clock-skew family's repository-vs-service clock
  discrimination with two independent fake clocks.
- **One-shot expiry**: deadline/lapse scenarios convert clock advances to SQL
  `UPDATE` of the stored deadline (`expire` pattern); `renewDispatch` /
  `renewOperation` reject lapsed claims, so the expiry is stable against
  background renewal.
- **JDBC test access**: `RuntimeBrokerTestAccess.authorizeDispatch` /
  `insertExecution` / `compareAndSet` expose the package-private
  execution-level primitives for fixtures that deliberately omit CSI admission
  evidence, replacing `InMemoryTestAccess`.
- **Identity assertions**: `assertSame` on repository reads becomes
  `sameIdentity` + version + state equality (every JDBC write bumps the
  version, so version equality proves the no-write property).

Known limitations:

- Short operation-lease fixtures (100–200 ms) now expire against the real DB
  clock; lease/3 renewal margins keep them live, with a minor flakiness risk
  under heavy CI load.
- The two `MySqlIT` consumers were swapped to JDBC but run only in the CI
  MySQL profile (no local MySQL instance).
- Deleting `HostedExecutionTransportProbeTest` moves the probe helpers'
  coverage from the unit suite to the CI Hosted MySQL job, which runs on the
  full tier only. The deleted assertion that closing the probe restores the
  original transport on both the dispatch and cancellation paths, so it stops
  counting, has no direct replacement; the IT only closes the probe during
  cleanup.
- Dated design records that describe the in-memory repositories as they
  existed at the time are left unchanged as history.

## Open questions

- None blocking.
