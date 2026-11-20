# Implementation plan: atomic identity de-hash cluster (managed-agent-server)

[English](2026-11-20-managed-identity-dehash-cluster-impl.md) | [简体中文](2026-11-20-managed-identity-dehash-cluster-impl.zh-CN.md)

Companion to the design: [design EN](../design/2026-11-20-managed-identity-varchar-dehash.md) · [design ZH](../design/2026-11-20-managed-identity-varchar-dehash.zh-CN.md).
Status: execution spec. Increment 1 (tenant guard) already landed green on branch
`feat/managed-identity-varchar-dehash` (PR #17927). This plan covers the remaining
join-connected cluster, which must be converted atomically.

## Why the cluster is atomic (no green sub-step)

- Identity columns are join-connected through hash keys and through raw actor/scope
  columns (e.g. `ma_memory_store.owner_actor_key = COALESCE(ma_session.owner_actor_key,
ma_session.creator_actor_key)`), so converting one table breaks joins until all convert.
- Budget shrink and fixture alignment are coupled: `VARCHAR(64)` rejects existing long
  fixtures (`ws-<cwd>` workspace ids, 43-char `"tenant-"+UUID`), so DDL budgets and fixture
  changes must land together.
- Cross-table hash references (`ma_message.body_resource_key`,
  `ma_event_stream.artifact_refs_resource_key`, `ma_resource_ref.resource_key`, …) cannot be
  expanded to local raw columns that do not exist in the referencing table; they need added
  raw scope+resource columns (or a canonical readable key), i.e. schema expansion in the same batch.
- Probes (H2 2.4.240, MySQL mode): `utf8mb4_0900_bin` parses; VARCHAR equality/PK are NO PAD;
  `setBytes`→VARCHAR round-trips UTF-8 and trailing spaces. So byte[] binds can temporarily
  coerce, but that does not decouple the budget/fixture/hash coupling above.

Therefore: one branch, temporarily red during conversion, commit+push only when fully green.

## Execution order

1. **DDL (V1 in place).** Convert text-identity `VARBINARY` to `VARCHAR` budgets with
   per-column `COLLATE utf8mb4_0900_bin`; keep binary payloads (`record_bytes`, `object_key`,
   `capture_object_key`) as `VARBINARY`. Drop the 60 "Hashed" columns plus same-family derived
   identity keys (`physical_key`, `storage_key`, `holder_key`, `*_resource_key`, `import_key`,
   `runtime_binding_key`, `execution_storage_key`, `source_record_key`, `delivery_key`,
   `result_operation_key`, `deletion_operation_key`). Keep the 32 content-digest columns and
   git-sha `VARCHAR(64)` columns. Rebuild every unique/index that used a dropped key on raw
   columns; drop `ma_session.uk_ma_session_scope` (redundant with PK). Redefine the two generated
   columns (`ma_request_receipt.decision_scope_key`, `ma_side_query.active_slot`) over raw scope
   columns; rewrite the three CHECKs (`ck_ma_resource_capture`, `ck_ma_ref_binding`,
   `ck_ma_storage_registered`) over raw columns.
2. **Cross-table references.** For each referencing table add the raw scope+resource columns it
   lacks (`tenant_id`, `workspace_id`, `session_id`, `resource_id` as applicable) and populate them
   on write; replace the hash reference column with those raw columns in joins/uniques. Where a
   table cannot carry the full scope, use a canonical **readable** resource key `VARCHAR(256)`
   (explicitly not a hash) and re-check index width.
3. **Java binds + derivations.** Move `byte[]`→`String` across persistence/runtime-broker/
   control-plane/contracts/verification; delete `ManagedSchemaKeys.key()` identity derivations
   (410 sites) but keep digest helpers; rewrite the ~1613 column references by category:
   equality, leading prefix (`tenant_id=? AND session_id=? …`), keyset cursor, `FOR UPDATE`
   order, generated-column consumers, CHECK consumers, projection (`ManagedSchemaProjection`),
   contract table list, schema-shape (`ManagedSchemaTest` BUSINESS_KEYS) and catalog validation.
4. **Cursors + lock order.** Replace hash-total-order keyset cursors and `ORDER BY … FOR UPDATE`
   acquisition order with a composite lexicographic tuple order (e.g.
   `(tenant_id, session_id, resource_id)`), using row-value comparisons for cursors, and keep the
   SAME total order in every transaction that locks those rows (deadlock avoidance). Stores:
   `ManagedSessionRetirementStore`, `WorkspaceRecoveryStore`, `SessionResourceCollectionCollector`,
   `JdbcHostedCleanupDebtStore`, `ManagedExtensionQueries`, `JdbcAutomationLedgerStore`.
5. **Contract + admission + fixtures.** Add fail-closed identity length/format validation at the
   boundary (tenant/actor ≤36, UUID/prefixed forms, external ≤512); align verification fixtures and
   dev defaults to the budgets (replace 43-char tenants and over-long `ws-<cwd>` workspace ids);
   keep multi-byte and trailing-space semantics tests.
6. **Meta-tests.** Update schema-shape pins, catalog validation, and any surface fixture
   (`managed-surface.txt`) with the DDL; add per-key width assertion (<3072) and per-store
   cursor/lock-order equivalence tests (same rows, same order, no deadlock under concurrency).

## Budgets (index bytes = 4×chars, utf8mb4)

| Class                                       | Budget         | Bytes |
| ------------------------------------------- | -------------- | ----- |
| tenant / actor (numeric ≤20 upstream)       | VARCHAR(36)    | 144   |
| UUID-class ids, workspace_id                | VARCHAR(64)    | 256   |
| external channel account/sender/chat/thread | VARCHAR(512)   | 2048  |
| canonical readable resource key (fallback)  | VARCHAR(256)   | 1024  |
| binary payloads / OSS object keys           | keep VARBINARY | n/a   |

Guard exception (already landed): `ma_tenant_guard.tenant_id VARCHAR(64)` readable scope carries
sentinels; PK `(tenant_id, guard_domain)`.

## Verification

- Isolated Maven repo: `cp -Rc ~/.m2/repository /tmp/dehash-m2`; install sibling SDK
  `mvn -f packages/sdk-java/qwencode/pom.xml -DskipTests -Dgpg.skip=true -Dmaven.repo.local=/tmp/dehash-m2 install`.
- `cd packages/managed-agent-server && mvn -Dmaven.repo.local=/tmp/dehash-m2 test` (full H2 suite)
  after conversion; `mvn -pl verification clean` first if compile-time constants changed.
- `mvn checkstyle:check checkstyle:check@runtime-broker-checkstyle` (both executions).
- MySQL 8.4 disposable: race suites (guard/head/claim/drain/rename/retirement/receipt) and
  `ManagedSqlPerformanceMySqlIT` baseline-vs-changed fingerprints + examined rows; defer to CI if
  no local MySQL. Native/media tests need built core+cli TS dist.
- Commit+push only when compile + full H2 + double Checkstyle are green; MySQL gates recorded as
  pending CI when not run locally.

## Acceptance

- No identity-hash column remains; all 246+ rebuilt keys <3072 bytes; NO PAD byte-exact equality on
  both engines; cursors/lock-order equivalent and deadlock-free; admission rejects over-long ids;
  fixtures/dev aligned; full H2 + compile + double Checkstyle green; MySQL race + sqlperf evidence
  (local or CI).
