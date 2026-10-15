# Managed SQL millisecond timestamps

[English](2026-10-14-managed-sql-millisecond-timestamps.md) | [简体中文](2026-10-14-managed-sql-millisecond-timestamps.zh-CN.md)

## Status and problem

Implemented and locally validated. The user chose all Managed business timestamp columns as BIGINT UNSIGNED Unix epoch milliseconds, accepting the loss of sub-millisecond precision. Before this change, the canonical fresh-database baseline mixed BIGINT milliseconds with DATETIME(6); creation/modification columns were named created_at/updated_at.

## Scope

Rename existing created_at to gmt_create and updated_at to gmt_modified throughout the active schema, SQL, projections, mappers, fixtures and recovery import/export readers. Convert every persisted business timestamp column, including leases, deadlines, retention, scheduling slots and retry times, to BIGINT UNSIGNED epoch milliseconds. Keep the remaining operational field names. Sequence, revision, count and duration fields are not timestamps. By explicit user choice, mount_birth_time remains the original filesystem identity fingerprint string; reducing it to milliseconds would change physical-directory identity checks.

The canonical resource is a fresh-database baseline, not an in-place upgrade. Do not alter user databases or add implicit conversion of old schema catalogs. Schema validation must reject signed timestamp columns on native MySQL. Primary/foreign keys, identity domains, JSONL record bytes, claim generations and ordering predicates remain intact. Public API JSON properties retain created_at/updated_at and their existing units (including public Turn timestamps expressed in seconds). Dynamic SQL recovery exports use the new physical field names and numeric values.

## Implementation

The Spring JDBC parameter boundary binds timestamp objects as epoch milliseconds. Existing plain JDBC Session writer paths bind numbers explicitly, including head updates and CSI journal inserts; recovery and CSI command-line wiring uses the managed adapter. Former DATETIME readers explicitly translate nullable integer values to existing Java temporal representations where needed; raw row exports retain integer milliseconds. The Runtime Broker's shared Instant binder/reader uses BIGINT. Database time remains the authoritative lease clock and is normalized to milliseconds. Durations shorter than one millisecond cannot produce a durable sub-millisecond lease.

Replace persisted DATETIME arithmetic and comparisons with integer milliseconds; remove FROM_UNIXTIME/UNIX_TIMESTAMP wrappers around stored fields. Preserve NULL and zero semantics, deadline/claim comparisons, paging tie-breakers, and refused/idempotent update behavior. Retention cursors must bind numeric time values. Preserve coordination timestamp exceptions from the preceding query cleanup.

Native Connector/J reads of nullable unsigned time columns request Long explicitly rather than casting the default BigInteger result. Completed GC ledgers set available_at to a never-due sentinel below 2^53, so the claim range scan skips them instead of walking the whole completed history; their SUCCEEDED state excludes them as well. A retention cutoff preceding the epoch yields no candidates, including resumed cursors.

The catalog validates BIGINT, UNSIGNED and nullability against the baseline on native MySQL. H2 supplies fast contract feedback but cannot establish unsigned enforcement.

The combined V1/V2 schema retains incoming CSI authority columns and constraints. All 28 shared full-row projections include their declared fields, while tests of a pre-V2 catalog omit its two absent Session fields until the V2 migration runs. Private mutation guards, original-holder evidence and activation checks remain intact.

## Validation

Establish the baseline with an independent test engineer before implementation. Test canonical types/names, unsigned rejection, nonnegative epoch values, nullable time values, exact millisecond round-trips, values beyond 2038, signed Java range handling, durable lease expiration, stale claim refusal, pagination ties, recovery/CSI import/export and final JSONL invariance. Replace microsecond-only drift assertions with one-millisecond drift assertions, keeping the same recovery checks.

Run repository build/typecheck/bundle and focused Java tests followed by appropriate package verification. Repeat on a task-owned MySQL 8.4 database, including schema validation, recovery, retention, publication and query plans. Audit the full cumulative diff through two clean passes and run independent code review. Report skipped/untested gates separately.

## Validation results

After integration with the current V1/V2 main baseline, SDK tests ran 247 cases with zero failures/errors and nine conditional skips. Broker's full run and corrected/final focused class reports yield 953 distinct effective cases with zero failures/errors and two skips; the final affected-path lane reran 87 cases. Server's full run passed 2755 cases before the final upsert changes, and 135 final affected-path cases passed afterward, yielding 2756 distinct effective cases with zero failures/errors and seven skips. Effective counts replace class reports without adding duplicate reruns. Final Broker/Server Checkstyle and SpotBugs passed. Repository build, typecheck and bundle, plus changed E2E script formatting/lint, passed.

Final MySQL 8.4.11 validation passed 76 Broker cases, 20 Server consolidated fixture cases and 262 Server integration cases, all without failures, errors or skips. These final native runs used the latest source and installed Broker artifact, including the lifecycle/fence/registration upsert corrections. Metadata confirmed 77 unsigned business timestamp columns and no persisted DATETIME/TIMESTAMP columns. Native checks include nullable/2050 unsigned reads through Connector/J, GC completion and reclaim refusal, recovery/CSI exports, query plans, connection/JVM timezone cases, process-crash JSONL replay, and CSI mutation/snapshot guards under native transaction isolation.

Actual JDBC/private CLI probes passed CSI ACK inspect with unchanged immutable evidence, CSI Session creation and exact replay with original millisecond timestamps, and Runtime SQL resolution before its required Kubernetes API setting. WorkspaceRecoveryMain hit its existing Linux-only gate on real macOS; its Linux CLI end-to-end path was not run. The expiry predicate retained future read leases and collected expired leases. Live Kubernetes/CSI/OSS, the complete Hosted/Harness script and the separate Broker fault-gate profile were not run. SDK skips require Windows or live daemon/Hosted endpoints; Broker's two skips require real worker infrastructure; Server's seven full-suite skips remain separately reported. No existing database was migrated.

Independent review and reverse audit found no remaining confirmed issue after fixes. Two final self-audit passes covered the cumulative diff, new files, CLI/unsigned/E2E wiring and upsert replay behavior. Final Java/source manifests and installed artifacts were checked against validation snapshots. Only task-owned temporary databases/users and the dedicated test MySQL daemon were used.

## Acceptance

- Every persisted business timestamp column is BIGINT UNSIGNED epoch milliseconds; the baseline has no DATETIME/TIMESTAMP columns.
- No active SQL reader/writer uses the old creation/modification column names.
- Native MySQL validates unsigned types and rejects negative timestamps.
- Lease fencing, NULL handling, cursor ordering and recovery guarantees remain correct at millisecond precision.
- Public DTO/API timestamp names and units, and immutable JSONL bytes, retain their declared contracts.
