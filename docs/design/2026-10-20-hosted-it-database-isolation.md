# Hosted integration-test database isolation

[English](2026-10-20-hosted-it-database-isolation.md) | [简体中文](2026-10-20-hosted-it-database-isolation.zh-CN.md)

## Problem

The `hosted-harness-mysql` profile runs `Hosted*IT` classes sequentially in one
Failsafe fork against one disposable MySQL schema. A class closes its Spring
contexts, but its durable rows remain. The next class's recovery coordinators
therefore discover operations and Turns belonging to earlier classes. Their
Runtime credentials and Workspace mounts belong to a different fixture, so
recovery cannot complete. See [#14850](https://github.com/QwenLM/qwen-code/issues/14850).

Production recovery deliberately spans tenants. Changing its predicates to
accommodate test fixtures would weaken the production coverage.

## Decision

Enable a test-only JUnit extension through service discovery in the
`hosted-harness-mysql` profile. Before each top-level test class, it connects to
the supplied `mysql.url` and truncates every `ma_` base table in that catalog.
It preserves table definitions, indexes, constraints, and `flyway_schema_history`.
The catalog must be a dedicated application catalog; missing and MySQL system
catalogs are refused.

Foreign-key checks are disabled and restored on the same short-lived connection
as the truncation. A cleanup failure fails class setup before Spring or a
recovery scanner starts. Cleaning before class setup also removes leftovers
from a failed earlier class or an earlier invocation.

The profile pins one fork and disables JUnit parallel execution. Existing class
teardowns remain responsible for closing their contexts and child processes.
The extension skips nested class contexts and never runs between test methods,
so a fixture's restart and recovery scenarios retain their durable state.

## Scope and tradeoffs

The extension is inactive in the normal unit suite, `mysql-integration`, and
other profiles. No production query, lifecycle behavior, or migration changes.
The selected database is exclusively disposable test data: all `ma_` rows are
deleted, including Session, Turn, operation, Broker, and automation state.
Unrelated tables are left alone.

Central class setup avoids a cleanup call in every fixture and avoids repeating
schema migrations in a fresh catalog for every class. It relies on sequential
execution and existing resource teardown. Sharing this database with another
test process is unsupported. Any future class-level parallelism must introduce
separate catalogs instead.

## Validation and acceptance

- Two independent Hosted classes each create a pending CLOSE operation. Each
  recovery scan must return only that class's tenant, in either execution order
  and on repeated runs against the same database.
- Regression coverage must verify operation and Turn cleanup, preservation of
  Flyway history and schema validation, and retention of state inside a class.
- Verify the profile activates the extension automatically and keeps execution
  sequential. Run module verification and the CI profile contract tests.
- The complete Linux/cgroup Hosted fault suite remains CI validation; a macOS
  MySQL regression run does not establish those process-recovery guarantees.
