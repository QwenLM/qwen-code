# Removing redundant storage keys

[English](2026-11-20-managed-storage-redundant-keys.md) | [简体中文](2026-11-20-managed-storage-redundant-keys.zh-CN.md)

## Status and scope

- Status: **proposal**. No code or schema is changed by this document.
- Date: 2026-11-20. Source baseline: `origin/main` at `18846c6e4b`.
- Scope: `packages/managed-agent-server` (persistence, runtime-broker persistence, verification) and the shared `V1__managed_schema.sql`. Pre-release policy applies: the single V1 baseline is edited in place and development catalogs are recreated; no V2+ migration.
- Context: this is the follow-up that the identity de-hash increment (PR #17927) deferred. That PR removed hash keys whose only role was to duplicate a unique key in the same table and that no other table, cursor, or lock order used. The two removals here have the same redundancy, but they sit on storage coordination paths and change many test fixtures, so they need their own change and MySQL evidence.

## Problem

Two storage tables carry a second unique key that identifies exactly the same rows as the business key:

1. `ma_storage` has `uk_ma_storage_business_key (alias_key)` and `uk_ma_storage_alias (tenant_key, storage_key)`. With `alias_key = key("qwen-csi-alias/1", tenant_id, storage_id)`, `tenant_key = valueKey(tenant_id)` and `storage_key = valueKey(storage_id)`, both keys are functions of the same `(tenant_id, storage_id)`.
2. `ma_storage_owner` has `uk_ma_storage_owner_business_key (storage_key)` and `uk_ma_storage_owner_physical (physical_key)`. Every writer stores the same value in both columns.

Each extra key costs a column, a unique index, an extra duplicate check on every insert, and a second index path that can lock the same row. The storage lock-order test already calls out that second path as a hazard (`StorageRowLockOrderMySqlIT.migrationAbortClearsTheFenceThroughTheAliasIndex`).

## Current state

### `ma_storage`: two keys from a table merge

The [schema consolidation](2026-10-13-managed-schema-consolidation.md) merged `qwen_runtime_storage_fence` (primary key `(tenant_key, storage_key)`) and `managed_workspace_csi_registration` (primary key `alias_key`) into `ma_storage`, and kept both keys.

Writers. All five production inserts write both keys from the same `(tenant, storage)` pair:

| Writer                                                     | Statement shape                    |
| ---------------------------------------------------------- | ---------------------------------- |
| `JdbcRuntimeBindingRepository.requestStorageFence`         | `INSERT … ON DUPLICATE KEY UPDATE` |
| `WorkspaceMigrationStore` (fence insert)                   | `INSERT … ON DUPLICATE KEY UPDATE` |
| `WorkspaceStorageGuard` (local registration upsert)        | `INSERT … ON DUPLICATE KEY UPDATE` |
| `JdbcSshWorkspaceStore` (SSH fence-only row)               | `INSERT … ON DUPLICATE KEY UPDATE` |
| `ExternalStorageRegistrationStore` (external registration) | plain `INSERT`, duplicate → 409    |

Readers of `tenant_key` / `storage_key`. Only two:

- `RuntimeAdmissionFences.storageFence`: a non-locking `SELECT … WHERE tenant_key = ? AND storage_key = ?` that re-checks the raw `tenant_id` / `storage_id` and throws on a hash collision. It is reached from the admission checks in `RuntimeAdmissionFences` and `JdbcRuntimeBindingRepository`, from `requestStorageFence`, and from `isStorageFenced`.
- `ExternalWorkspaceMaterializationStore`: a `COUNT(*)` with `alias_key = ? AND tenant_key = ? AND storage_key = ? AND physical_key = ? AND registration_revision = ?`. The same transaction has already locked this row with `alias_key = ? AND tenant_id = ? AND storage_id = ? … FOR UPDATE`, so the two hash predicates add nothing.

`RuntimeAdmissionFences.storageFenceKey()` has no other production caller. `ManagedSchemaProjection.STORAGE` lists both columns. No join, cursor, `ORDER BY`, `FORCE INDEX` hint, other table, or TypeScript code uses either column or `uk_ma_storage_alias`. `alias_key` itself stays: `ma_runtime_binding.storage_alias_key` references it, and `LocalStorageOwners` locks aliases in `alias_key` order.

### `ma_storage_owner`: `physical_key` always equals `storage_key`

The consolidation design keys `storage_owner` "by canonical physical identity". `storage_key` comes from the old execution-lease table; `physical_key` was added later for CSI. Today both columns hold the canonical physical identity:

- The four inserts (`ExternalStorageRegistrationStore`, `JdbcSshWorkspaceStore`, and two in `WorkspaceStorageGuard`) bind the same value to both columns.
- The only update that touches either column, in `WorkspaceIdentityReattestationStore`, sets both to the same `next` value.
- No writer sets one without the other, and none writes `NULL`.
- Alias rows join to owners with `ON o.storage_key = s.physical_key`.

Readers of `ma_storage_owner.physical_key`:

| Kind                                        | Sites                                                                                                                                                                                                                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQL filter                                  | `ExternalStorageRegistrationStore` pre-check (`WHERE physical_key = ?`); `ExternalWorkspaceMaterializationStore` and three `WorkspaceIdentityReattestationStore` reads (`storage_key = ? AND physical_key = ?`; the materialization read and one reattestation read are `FOR UPDATE`) |
| Java equality after `WHERE storage_key = ?` | `LocalStorageOwners.requireOwner`, `WorkspaceStorageGuard.row`, `RuntimeAdmissionFences` physical admission, `JdbcRuntimeBindingRepository` holder lock, `JdbcExternalWorkspaceOwnership` owner check, `WorkspaceMigrationAdmission` external physical admission                      |
| Projection and evidence                     | `ManagedSchemaProjection.STORAGE_OWNER`; `WorkspaceMaintenanceRecovery.MOUNT_FIELDS`, which builds the `mount` snapshot that recovery evidence records and later compares                                                                                                             |

Two tests write a different value into `physical_key` to simulate drift (`LocalStorageAliasTest.driftedPhysicalMappingAndCopiedMarkersCannotAuthorizeAnAlias` and `WorkspaceMigrationAdmissionTest.localAliasesCanShareAnOwnerButCannotNameADifferentPhysicalIdentity`). No production path can produce that state.

## Goals and non-goals

Goals:

- Remove `ma_storage.tenant_key`, `ma_storage.storage_key`, and `uk_ma_storage_alias`.
- Remove `ma_storage_owner.physical_key` and `uk_ma_storage_owner_physical`.
- Preserve every isolation check, raw-identity re-check, lock target, and fail-closed path.

Non-goals:

- `ma_storage.alias_key` and `ma_storage_owner.storage_key` stay. Replacing them with raw columns belongs to the identity de-hash.
- Whether the physical identity itself stays a digest is a de-hash question, not answered here.
- No rename of `ma_storage_owner.storage_key` to `physical_key`.
- No public API or serialized payload change.

## Proposed change

### A. `ma_storage`

1. DDL: drop `tenant_key`, `storage_key`, and `uk_ma_storage_alias`.
2. `storageFence` reads `WHERE alias_key = ?`, bound to `storageAliasKey(tenantId, storageId)`. It keeps the raw `tenant_id` / `storage_id` re-check and the collision exception.
3. The materialization `COUNT(*)` replaces `tenant_key = ? AND storage_key = ?` with `tenant_id = ? AND storage_id = ?`, so the predicate set stays the same without hashes.
4. The five inserts stop writing the two columns. `ON DUPLICATE KEY UPDATE` behaviour is unchanged: a duplicate always hit both unique keys at once, and now hits only `alias_key`.
5. Delete `storageFenceKey()` and drop the two columns from `ManagedSchemaProjection.STORAGE`.

### B. `ma_storage_owner`

1. DDL: drop `physical_key` and `uk_ma_storage_owner_physical`.
2. SQL filters: drop `AND physical_key = ?` where `storage_key = ?` is already bound to the same value; the registration pre-check becomes `WHERE storage_key = ?`; `SELECT physical_key` becomes `SELECT storage_key`.
3. Java equality checks compare with `storage_key` instead of being deleted. The column is `CHAR(64)` under `utf8mb4_bin` (PAD SPACE), so `WHERE storage_key = ?` folds trailing spaces. The Java `equals` is what makes the match byte-exact, so it stays.
4. The reattestation update sets only `storage_key`.
5. Remove `physical_key` from `ManagedSchemaProjection.STORAGE_OWNER` and from `WorkspaceMaintenanceRecovery.MOUNT_FIELDS`. Both sides of the recovery `mount` comparison are built from that list, so they stay consistent; `storage_key` is still in the snapshot.

### Tests

- About 20 test files (61 lines) stop writing `tenant_key` / `storage_key` or calling `storageFenceKey`. About 14 files stop writing `ma_storage_owner.physical_key`.
- The two drift tests move to the drift that is still possible: the alias mapping. They set `ma_storage.physical_key` on the alias to a value with no owner row. That still reaches the fail-closed branches: `WorkspaceStorageGuard.verify` returns `unverified` when `row(physical)` is `null`, and `LocalStorageOwners.requireOwner` finds no owner.
- `SshWorkspaceStoreTest` (which replaces the owner key) and `ExternalWorkspaceOwnershipTest` (which reads `physical_key`) switch to `storage_key`.
- The `StorageRowLockOrderMySqlIT` comment that names `uk_ma_storage_alias` is updated; its plan assertion on `uk_ma_storage_business_key` is unchanged.

## Design decisions

- **Keep `ma_storage_owner.storage_key`, drop `physical_key`.** `storage_key` is `NOT NULL`, is the business key pinned by `ManagedSchemaTest`, is referenced by `ma_runtime_session.execution_storage_key`, and is the column every owner `FOR UPDATE` filters on. Dropping it instead would rewrite the owner lock path. The naming mismatch with other tables' `physical_key` is cosmetic, and the existing join `o.storage_key = s.physical_key` already expresses it.
- **Keep `alias_key`, drop `(tenant_key, storage_key)`.** `alias_key` is the business key, is referenced from `ma_runtime_binding`, and defines the alias lock order. The pair has two readers and no structural role.
- **Keep the re-checks.** Raw-identity re-checks after a hashed lookup and byte-exact Java comparisons after a PAD SPACE lookup stay. They are retargeted, not removed.
- **One PR, two commits, based on `main`.** A and B share fixtures (`WorkspaceTestStorage`, the lock-order ITs) but are independent changes. The PR does not depend on #17927. Overlap is limited to different hunks of V1 and `ManagedSchemaProjection`.

## Lock and concurrency impact

- Lock targets do not change; the same rows are locked.
- A: `INSERT … ON DUPLICATE KEY UPDATE` checks one secondary unique index instead of two, which takes fewer index-record and gap locks on a fresh insert. `storageFence` is a non-locking read. The materialization count runs while the transaction already holds the row lock through the alias index. No row can be locked through a second unique index any more.
- B: one read in `ExternalWorkspaceMaterializationStore` and one in `WorkspaceIdentityReattestationStore` currently lock owners with `storage_key = ? AND physical_key = ? … FOR UPDATE`, which lets the optimizer choose either unique index. After the change they always go through `uk_ma_storage_owner_business_key`, like every other owner lock.
- No new lock order and no new lock domain. Per the [lock inventory](2026-11-12-managed-agent-lock-inventory.md), the changed statements still need MySQL evidence (see validation).

## Risks

- About 30 test files change mechanically. Re-targeting the two drift tests is the one semantic test change, and it must keep the fail-closed assertions.
- Recovery evidence recorded before the change includes `physical_key` and would not compare equal after it. Pre-release policy recreates catalogs, so this is accepted.
- `packages/sdk-java/managed-kubernetes-archive` still names the old columns. It is outside the Maven reactor and CI and is not changed.

## Validation

- H2, focused on the changed classes and their consumers: `ManagedSchemaTest`, `ManagedSchemaCatalogTest`, `LocalStorageAliasTest`, `WorkspaceMigrationAdmissionTest`, `WorkspaceMigrationStoreTest`, `ExternalStorageRegistrationTest`, `ExternalWorkspaceMaterializationTest`, `ExternalWorkspaceOwnershipTest`, `WorkspaceIdentityReattestationStoreTest`, `SshWorkspaceStoreTest`, `SessionWorktreeStoreTest`, `ManagedSessionPhysicalFenceTest`, `JdbcPhysicalStorageReleaseTest`, `ChildWorkspaceStoreTest`, `JournalLockContractTest`, `WorkspaceLifecycleStoreTest`, `ManagedWorkspaceAdmissionTest`, `RuntimeMaintenanceRecoveryTest`, `WorkspaceSchemaConsolidationTest`, plus Checkstyle on all modules.
- Mutation check: bind a wrong alias in `storageFence`, and a wrong key in one retargeted owner check; the fence and owner tests must fail.
- MySQL 8.4 (CI full tier or a disposable instance): `StorageRowLockOrderMySqlIT`, `ManagedLockScopeConcurrencyMySqlIT`, `WorkspaceMigrationMySqlIT`, `ToolPublicationStorageMySqlIT`, `WorkspaceQueryScaleMySqlIT`, `ManagedSchemaMySqlIT`. Record `EXPLAIN` evidence that `storageFence` uses `uk_ma_storage_business_key` and that the two owner `FOR UPDATE` reads use `uk_ma_storage_owner_business_key`.
- `HostedMonitorRunFaultGatesIT` runs in the Hosted fault profile in CI.

## Acceptance criteria

- V1 contains none of `ma_storage.tenant_key`, `ma_storage.storage_key`, `uk_ma_storage_alias`, `ma_storage_owner.physical_key`, `uk_ma_storage_owner_physical`; catalog validation passes on H2 and MySQL.
- No production source references the removed columns or `storageFenceKey`.
- Every former `physical_key` Java comparison now compares with `storage_key`; every raw-identity re-check is kept.
- The two drift tests assert fail-closed behaviour on alias-mapping drift.
- The focused H2 suites pass locally, and the listed MySQL ITs pass on MySQL 8.4 before acceptance.

## Open questions

- Should the `EXPLAIN` checks become permanent assertions in `StorageRowLockOrderMySqlIT`, or stay as one-off PR evidence? Proposal: add one assertion for the owner `FOR UPDATE` path, because it changes which index can be chosen; keep the rest as PR evidence.
