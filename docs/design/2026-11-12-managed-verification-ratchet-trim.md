# Managed Verification Ratchet Trim

[English](2026-11-12-managed-verification-ratchet-trim.md) | [简体中文](2026-11-12-managed-verification-ratchet-trim.zh-CN.md)

## Problem

The architecture review of `packages/managed-agent-server` found that the
`verification` module mixes behavior tests with a small set of meta-ratchets
that pin implementation text instead of behavior: an AST-scanned inventory of
store method signatures and SQL literals, a verbatim Javadoc preservation pin,
and two TSV inventories memorializing the 63 pre-merge legacy tables. These
gates redden on harmless internal edits (renaming a private helper, rewrapping
a SQL string, rewording a comment) while the behavior they gesture at is
already covered by real tests.

The `verification` module itself stays: it is the only test home for all
production modules (none has `src/test`), the agreed design in
[2026-10-29-managed-agent-maven-modules](2026-10-29-managed-agent-maven-modules.md),
and the anchor of the CI report-completeness guard. This change trims ratchets
inside it; it does not remove or relocate the module.

## Removed

- `SessionRowLockOrderTest` and `src/test/resources/lock-contract/`
  (`entries.txt`, `sql-owners.txt`). The test described itself as
  "Inventory only: executed branches are checked by StoreLockTrace and MySQL
  scenarios". The text snapshots themselves are dropped; the lock behavior
  they gestured at stays covered by `StoreLockTraceTest`,
  `AgentLockContractTest`, `JournalLockContractTest`,
  `AgentLockContractMySqlIT`, `JournalLockContractMySqlIT`, and
  `ManagedLockScopeConcurrencyMySqlIT`, which execute the real lock paths.
- `AgentStateStoreJavadocPinTest` and
  `src/test/resources/managed-agent/role-javadoc-inventory.txt`. The pin
  guarded one historical split regression (dropped member Javadoc); it locks
  comment text, not behavior, and the six role interfaces are stable.
- `ManagedSchemaMapping`, the `all63OriginalEntitiesHaveOnlyRealTargetDestinations`
  case of `ManagedSchemaTest`, and the two legacy inventories
  `original-managed-table-inventory.tsv` and
  `db/managed-schema/legacy-table-map.tsv`. The legacy tables were merged and
  deleted before the V1 baseline; the mapping no longer guards anything live.
  The rest of `ManagedSchemaTest` (schema validation, drift refusal, business
  keys, CHECK constraints) is unchanged.

## Kept

- `ClassSizeRatchetTest` and `class-size-ratchet.properties`: they ratchet
  production class size in `persistence` and `runtime-broker`, where god-class
  regrowth is a real, observed risk.
- `ModuleArchitectureTest` (ArchUnit module matrix), the OpenAPI contract and
  `SurfaceRegistry` gates, all MySQL ITs, and the Hosted/fault/MQ/OSS gates.

## Profile consistency fix

Nine local-focused Failsafe profiles (`hosted-process-crashes`,
`hosted-workspace-tools`, `hosted-channel-gates`, `hosted-monitor-run-gates`,
`hosted-session-relay-gates`, `hosted-workflow-gates`, `hosted-mcp-gates`,
`hosted-automation-gates`, `o4-oss-gates`) lacked the Surefire `skipTests`
block that the other gate profiles carry, so a focused local run re-ran the
entire unit suite first. They now skip Surefire like their siblings. No CI
lane invokes these profiles; the CI Hosted lanes run the same classes under
`hosted-harness-mysql`, which already skips Surefire.

`mysql-integration` deliberately keeps running the full H2 unit suite (the
fast tier skips that lane, which owns the suite) and is unchanged.

Deeper structural dedup of the profiles (moving the shared Failsafe version
and executions into `pluginManagement`) is intentionally not done: the
v0.26.5 release-repair patch
`scripts/patches/managed-runtime-v0.26.5-verification.patch`, exercised by
`scripts/tests/managed-runtime-release.test.js`, reverse-applies against the
current pom and pins the `pluginManagement` block byte-for-byte. Restructuring
it would break the pinned release repair for ~100 lines of XML savings.

## Documentation policy

Earlier design documents that name `SessionRowLockOrderTest` or the
lock-contract manifest record the acceptance criteria of their own changes;
they are historical records and are not rewritten. This document is the
forward-looking reference for the removal.

## Validation

- Local: focused `ManagedSchemaTest`, `ClassSizeRatchetTest`,
  `ModuleArchitectureTest` run (compiles every production module and the full
  verification test tree, proving no dangling reference to the deleted
  classes), plus Checkstyle over the changed test sources.
- CI: the full unit/H2 suite, both Checkstyle executions, SpotBugs, and the
  MySQL/Hosted/fault/MQ/OSS profiles on the accepted revision. The
  report-completeness guard scans the test tree dynamically, so the removed
  classes need no roster edit.

## Acceptance criteria

- The deleted classes and resources have no remaining source, script, or CI
  reference (historical design documents excepted).
- Focused tests and Checkstyle pass locally; CI gates pass on the accepted
  revision.
- The nine local profiles skip Surefire; `mysql-integration`, the default
  build, and `pluginManagement` are behaviorally unchanged.
