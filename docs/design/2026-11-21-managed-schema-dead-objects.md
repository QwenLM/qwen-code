# Removing dead Managed schema objects

[English](2026-11-21-managed-schema-dead-objects.md) | [简体中文](2026-11-21-managed-schema-dead-objects.zh-CN.md)

## Status and scope

- Status: **implemented** by the change that adds this document.
- Date: 2026-11-21. Source baseline: `origin/main` at `3d7571f2db`.
- Scope: the shared `V1__managed_schema.sql`, `ManagedSchemaProjection`, `ManagedSchemaRows`, the Action decision lookup in `JdbcManagedActionStore`, and two verification tests. Pre-release policy applies: the single V1 baseline is edited in place and development catalogs are recreated; no V2+ migration.
- Context: same pattern as [removing redundant storage keys](2026-11-20-managed-storage-redundant-keys.md). The [identity de-hash](2026-11-20-managed-identity-varchar-dehash.md) would otherwise convert or redefine several of these objects; removing them first makes that batch smaller.

## Problem

The V1 baseline still carries schema objects that no code writes or reads, or whose guarantee another constraint already provides. Each one costs storage, index maintenance on every write, and de-hash work to convert something that has no effect.

## Current state

### A. Generated unique columns whose guarantee is already held

1. **`ma_session.public_session_id` and `uk_ma_session_public_session_id`.** The column is generated as `session_id` for `PUBLIC` rows and `NULL` for `CONTROL` rows, so the unique key makes `PUBLIC` IDs unique across tenants. No SQL reads the column. The only two `PUBLIC` writers in `AgentSessionAdmissions` (top-level and child Session creation) generate `session_id` with `UUID.randomUUID()`. No production path promotes a `CONTROL` row to `PUBLIC` or copies a Session to another tenant. The Harness indexes Sessions by ID without tenant, and the check it relies on is in `JdbcHarnessPlacementStore.assign`: before exposing a handle it counts `ma_session` rows with that `session_id` in every tenant and refuses with `harness_session_scope_ambiguous`. That check covers `PUBLIC` and `CONTROL` rows alike.
2. **`ma_request_receipt.decision_scope_key` and `uk_ma_decision_slot`.** The only `ACTION_DECISION` writer, in `JdbcManagedActionStore`, sets `scope_key` to the action scope `key(Session scope, actionId, inputRevision)`, `idempotency_digest` to `key(actionId)`, and `receipt_key` to `receiptKey(ACTION_DECISION, tenant, SESSION, actionScope, actionId)`. Two decisions for the same `(tenant_key, scope_key)` therefore have the same `idempotency_digest` and the same `receipt_key`, so `uk_ma_request (namespace, tenant_key, scope_key, idempotency_digest)` and `uk_ma_request_receipt_business_key` already reject the second one.

### B. Columns that nothing writes

These columns appear only in `ManagedSchemaProjection` (and `provider_id` also in `ManagedSchemaRows.IDENTITIES`). No production code writes them, no reader uses the selected value, and no trigger or projection-driven insert fills them. Their last readers were in the CSI inventory that #16910 removed.

| Column                                                                               | Note                                                                           |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `ma_delivery.source_record_key`, `source_revision`, `provider_id`, `payload_version` | `payload_version` always holds its default `1`                                 |
| `ma_operation.payload_version`                                                       | Always `1`; the only other reference is a term in `ck_ma_operation_generation` |
| `ma_operation_work.payload_version`                                                  | Always `1`                                                                     |
| `ma_message.tool_call_key`                                                           |                                                                                |
| `ma_output_capture.manifest_sha256`                                                  | `seal_manifest_sha256` is the digest in use                                    |
| `ma_runtime_binding.first_activation_journal_revision`                               |                                                                                |

### C. Redundant indexes

| Index                                                             | Covered by                                                     |
| ----------------------------------------------------------------- | -------------------------------------------------------------- |
| `idx_ma_work_page (operation_key, work_kind, target_key)`         | `uk_ma_operation_work_business_key`, the same columns in order |
| `idx_ma_work_session_page (operation_key, work_kind, session_id)` | Left prefix of `idx_ma_work_pending`                           |
| `idx_ma_operation_claim (operation_kind, state, claim_until)`     | Left prefix of `idx_ma_operation_result_lease`                 |

No statement names these indexes in a hint, and no test asserts them in a plan.

## Goals and non-goals

Goals:

- Remove every object in A, B, and C.
- Keep every isolation check, lock target, and refusal path.

Non-goals:

- Generated unique columns that carry a real guarantee stay: `ma_side_query.active_slot` (one active side query per actor and kind; admission checks with a non-locking read first), `ma_operation.publication_command_id` (caller-supplied output command IDs shared by three operation kinds), `ma_workspace.default_tenant`, and `ma_journal_pack.active_from_revision`.
- The `ma_session` hash keys belong to the identity de-hash.
- No public API, serialized payload, or lock-order change.

## Proposed change

1. DDL: drop the columns, constraints, and indexes in A, B, and C. `ck_ma_operation_generation` loses its `payload_version > 0` term.
2. Remove the same columns from `ManagedSchemaProjection`, and `public_session_id` and `provider_id` from `ManagedSchemaRows.IDENTITIES`.
3. The reserved-decision lookup in `JdbcManagedActionStore` filters on `scope_key = ?` instead of `decision_scope_key = ?`. With `namespace` and `tenant_key` already bound, it uses the left prefix of `uk_ma_request`. Both columns are `CHAR(64)` under a PAD SPACE collation, and the action scope is a 64-character hex digest, so `RTRIM` in the old generated column changed nothing.
4. Tests: `ManagedSchemaTest.retainsBytePreciseIdentitiesAndSeparatePublicUniqueness` becomes `retainsBytePreciseTenantScopedSessionIdentities` and asserts that a `PUBLIC` ID may repeat in another tenant. A comment in `ManagedSessionHistoryTest` that cited the old rule is corrected.

## Design decisions

- **Drop `public_session_id` instead of replacing it with `UNIQUE (session_id)`.** `CONTROL` rows may legitimately share an ID across tenants (`HarnessPlacementStoreTest` pins the resulting refusal). Worse, `ToolPublicationRetentionStore.lockSessionRoot` inserts `CONTROL` rows with `INSERT … ON DUPLICATE KEY UPDATE`; a tenant-independent unique key would make that statement update another tenant's row and then fail to find its own.
- **Drop `decision_scope_key` instead of redefining it for the de-hash.** It adds no guarantee beyond `uk_ma_request`, which the de-hash rebuilds on raw columns anyway.
- **One change.** All items are deletions in the same V1 file and projection enum, with no shared behaviour to stage.

## Lock and concurrency impact

- Lock targets and orders do not change.
- Inserts into `ma_session`, `ma_request_receipt`, and `ma_operation` maintain one fewer secondary index, and inserts into `ma_operation_work` two fewer, so they take fewer index-record and gap locks.
- Concurrent Action decisions: the second receipt insert still conflicts on `uk_ma_request_receipt_business_key` and `uk_ma_request`, and is rejected as before.
- A cross-tenant `PUBLIC` ID collision, reachable only through a UUID collision, is now refused at Harness placement (`harness_session_scope_ambiguous`) instead of at insert.

## Risks

- A future writer that creates `PUBLIC` Sessions with caller-supplied IDs must add its own cross-tenant check. Placement still refuses an ambiguous ID.
- A future `ACTION_DECISION` writer that uses a caller-chosen idempotency key would need its own single-decision guarantee.
- `packages/sdk-java/managed-kubernetes-archive` still names some removed columns. It is outside the Maven reactor and CI and is not changed.
- Development catalogs must be recreated.

## Validation

- H2: `ManagedSchemaTest`, `ManagedSchemaProjectionTest`, `ManagedSchemaCatalogTest`, `ManagedSchemaRowsTest`, `ManagedActionStoreTest`, `ConsolidatedActionStoreTest`, `ManagedActionsTest`, `ManagedSessionHistoryTest`, plus Checkstyle on all production modules.
- MySQL 8.4: `ManagedSchemaMySqlIT`, and the full `mysql-integration` profile in CI.

## Acceptance criteria

- V1 contains none of the removed columns, constraints, or indexes, and catalog validation passes on H2 and MySQL.
- No production source under `packages/managed-agent-server` references them.
- The focused H2 suites pass, and the MySQL profile passes in CI before acceptance.
