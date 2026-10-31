# Managed SQL query and mapping cleanup

[English](2026-10-14-managed-sql-query-cleanup.md) | [简体中文](2026-10-14-managed-sql-query-cleanup.zh-CN.md)

## Status and problem

Implemented together with [the millisecond timestamp design](2026-10-14-managed-sql-millisecond-timestamps.md). The canonical 32-table baseline and the existing public API remain the reference. The preceding implementation used wildcard projections, left joined columns unqualified, and omitted modification timestamps in successful mutations. Request receipts also crossed the JDBC boundary as generic maps. These made schema evolution and driver differences harder to assess.

## Scope

Replace production Managed table wildcard projections with explicit, statically declared columns. Qualify columns in joined queries. Advance existing modification timestamps with business mutations. Map the Session request receipt to a named Java record and normalize JDBC scalar types at the remaining recovery-document boundary.

Primary keys, foreign keys, ACLs, actor identities, idempotency domains, pagination contracts, recovery evidence, and JSON document shapes remain unchanged. Physical timestamp names and types follow the linked millisecond design. This change addresses the selected query and mapping rules, not every rule in the Alibaba MySQL chapter.

## Decisions

### Explicit projections

Store shared column projections alongside the shared Managed schema implementation. Projections declare literal column names and optionally qualify them with an internal table alias. They never discover columns from a live database or expand SQL wildcards at runtime. Full recovery-document projections preserve every previously exported field; ordinary typed readers can select narrower projections. Verify projection names against the canonical DDL to detect drift.

### Modification timestamps

Update `gmt_modified` in the same SQL statement as a successful business transition, using database epoch milliseconds. Existing compare-and-set predicates, claim generations, and idempotency checks remain intact. A refused or stale transition must not change the timestamp.

Lifecycle, storage-fence and registration upserts advance modification time only when persisted values change. Evaluate that assignment before changing the other columns, so the condition sees the original row. Same-value replay preserves modification time and original creation time; first insertion records actual database time.

Do not update timestamps whose semantics intentionally measure projection work or wake scheduling when changing only a read/wake watermark or coordination field. Immutable journal/resource identity and creation time remain unchanged. Document any retained coordination-only exceptions in the verification report.

### Result mappings

The Session request receipt uses a named Java record with deliberate identity, nullable boolean, and numeric readers instead of map casts. Recovery and CSI documents retain their existing versioned JSON shape. Their JDBC decoder reads integral, boolean, binary and text values explicitly so driver-specific `getObject` classes do not define the document types. Business timestamps are integer milliseconds. Boolean normalization preserves numeric SQL expressions, while the generated CSI guard always decodes as a boolean. Raw actor bytes and immutable payload bytes are not decoded as text.

Retain the incoming main-branch replay and ordering fixes when adapting them to this baseline: typed command receipts carry the recorder's raw actor key, Session pagination and its V3 index use immutable `gmt_create`, and relay ordering keeps `first_sequence` after creation time and Session identity. V3 and its upgrade fixtures use the same renamed timestamp columns as V1; this does not add migration support for databases created with the former timestamp baseline.

## Risks and validation

An omitted projection column can break a mapper or remove recovery evidence. Validate all 28 shared projections against the combined V1/V2 baseline and exercise existing receipt, Session, output, recovery, and broker repository tests. Nullable values, byte-exact identities and integer millisecond values must survive the mapping change. Keep the incoming CSI authority fields in the projections and preserve their mutation guards.

Reproduce receipt completion leaving its modification timestamp unchanged before fixing it. Verify successful completion advances the timestamp, conflicting/stale completion leaves the row unchanged, and idempotent replay preserves the recorded result. Check result mappings with differing integral JDBC representations and null values.

Run the Java package checks and relevant database contract tests, plus repository build/typecheck. Real MySQL evidence is reported separately from H2. Read the full diff through two consecutive clean self-audit passes before declaring completion.

## Acceptance criteria

- Production Managed table reads have no wildcard projection.
- Changed multi-table queries explicitly qualify their columns.
- Successful business mutations advance the existing modification timestamp atomically; rejected writes do not.
- Session receipts use a typed result and preserve identity and nullable fields.
- Recovery-document scalar types and bytes remain stable across supported JDBC drivers.
- Canonical keys and constraints, public response formats, and recovery/claim predicates are unchanged; timestamp storage follows the linked design.

## Local validation

The final combined validation results, test counts and platform limits are recorded in [the millisecond timestamp design](2026-10-14-managed-sql-millisecond-timestamps.md#validation-results). Production Managed reads have no wildcard projection. Native tests cover receipts, snapshots, channels, actions, task events, publication, recovery, CSI authority and query plans. Coordination-only timestamp exceptions retain their preceding scheduling semantics. This is local SQL validation; deployment acceptance is outside this change.
