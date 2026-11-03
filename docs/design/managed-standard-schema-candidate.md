# Governed Managed Agent schema and Java integrity

[English](managed-standard-schema-candidate.md) | [简体中文](managed-standard-schema-candidate.zh-CN.md)

## Status and dependencies

Draft proposal based on the resident external Workspace changes in #16023. It overlaps the schema-conventions proposal in #16143 and requires an explicit reconciliation before either schema change can land. The exported branch has not been runtime-validated; earlier checks on an integration branch do not qualify this exact public revision.

## Physical schema and integrity

The 39 Managed tables use database-generated BIGINT UNSIGNED primary identities and retain non-null business unique keys. Booleans use is_* TINYINT UNSIGNED, timestamps retain epoch-millisecond values, and nine generated columns continue to enforce derived uniqueness. Normal MySQL writes require strict global and session SQL modes.

Some governed DDL workflows cannot retain CHECK definitions. This proposal moves the original 73 row predicates into Java complete-row validation and typed transactional write boundaries. Every referenced non-generated field must be supplied. Validation retains SQL FALSE/UNKNOWN behavior, exact closed domains, paired values, positive and safe-integer bounds, UTF-8 byte limits, and relative stream progress. The receipt namespace includes the existing EXTERNAL_WORKSPACE contract value.

Session admission, transaction-locked Session/Turn copying, head/stream reads, and canonical CSI restore/live decoding use these row rules. Raw numeric booleans are validated before coercion. Output-capture inserts explicitly supply database time. Physical NOT NULL, UNSIGNED, unique keys, generated expressions, ownership checks, CAS and lease fencing remain in place. Direct SQL writers bypass Java predicates and must not be treated as supported business writers.

## Locking

Integer primary keys change InnoDB lock placement. Existing guard rows are located by their business identity and locked by numeric primary key. Cold creation uses a catalog/tenant/domain-scoped named lock on the existing connection, with release tied to transaction completion; it never borrows another pooled connection. CSI missing-root probes do not insert authorization evidence. Under Repeatable Read, a root created after the snapshot may be conservatively reported missing until the next transaction.

This differs from #16143, which retains business-key clustering on two coordination tables. Real MySQL contention and pooled-connection cleanup must pass before choosing the integer-key approach.

## Catalog boundary

Default initialization and validation still require an exact dedicated Managed catalog. The explicit validation-only shared-catalog API allows unrelated business tables and views, while rejecting missing or unknown ma_* tables, legacy managed_agent_* tables, Managed views, and structural drift. No shared-catalog initializer or metadata proxy is provided. CSI maintenance validation remains strict; successful shared startup does not establish full CSI shared-catalog support.

## Verification and migration

V1 remains the single pre-release baseline. No V2 migration, schema-history rewrite, or automatic upgrade of old/partial catalogs is introduced; use fresh development catalogs for this proposal. Review must cover complete-row admission/restoration, physical metadata, strict-mode behavior, negative/invalid values, real MySQL lock order and contention, raw/Spring transaction cleanup, shared-catalog opt-in, Session/Worker reuse, tools and concurrent turns.

Retained regression sources are not proof of execution. Public CI and runtime acceptance remain pending, including cross-platform and Hosted/fault profiles.
