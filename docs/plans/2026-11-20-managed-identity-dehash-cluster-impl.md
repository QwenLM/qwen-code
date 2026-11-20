# Implementation plan: atomic identity de-hash cluster (managed-agent-server)

[English](2026-11-20-managed-identity-dehash-cluster-impl.md) | [简体中文](2026-11-20-managed-identity-dehash-cluster-impl.zh-CN.md)

Companion to the design: [design EN](../design/2026-11-20-managed-identity-varchar-dehash.md) · [design ZH](../design/2026-11-20-managed-identity-varchar-dehash.zh-CN.md).
Status: execution spec. Increment 1 (tenant guard) merged in #17927. This plan covers the
remaining join-connected cluster, which must be converted atomically. Revision
(2026-11-20): updated with the
[duplicate business key survey](../design/2026-11-20-managed-identity-varchar-dehash.md#duplicate-business-keys).

## Why the cluster is atomic (no green sub-step)

- Identity columns are join-connected through hash keys and through raw actor/scope
  columns (e.g. `ma_memory_store.owner_actor_key = COALESCE(ma_session.owner_actor_key,
ma_session.creator_actor_key)`), so converting one table breaks joins until all convert.
- Budget shrink and fixture alignment are coupled: `VARCHAR(64)` rejects existing long
  fixtures (`ws-<cwd>` workspace ids, 43-char `"tenant-"+UUID`), so DDL budgets and fixture
  changes must land together.
- No duplicate-key hash can be removed ahead of the conversion. At current VARBINARY widths
  the raw replacements exceed 3072 bytes (storage alias 4096, Session head 4096, resource
  4608, `idx_ma_work_pending` ≈3200), and `receipt_key` is minted into public workspace and
  storage ids.
- Cross-table hash references (`ma_message.body_resource_key`,
  `ma_event_stream.artifact_refs_resource_key`, `ma_resource_ref.resource_key`, …) cannot be
  expanded to local raw columns that do not exist in the referencing table; they need added
  raw scope+resource columns (or a canonical readable key), i.e. schema expansion in the same batch.
- Probes (H2 2.4.240, MySQL mode): `utf8mb4_0900_bin` parses, but a per-column plain
  `CHARACTER SET … COLLATE …` clause breaks when followed by `NOT NULL DEFAULT` or on generated
  columns; wrap charset+collate in a MySQL executable comment `/*!80000 … */` so H2 ignores it.
  VARCHAR equality/PK are NO PAD; `setBytes`→VARCHAR round-trips UTF-8 and trailing spaces on
  INSERT/`getBytes`, **but H2 rejects byte[] binds in WHERE against VARCHAR** (`CHARACTER VARYING`
  vs `BINARY VARYING` not comparable). A type-only DDL migration is therefore red: the DDL type
  change and the Java `byte[]`→`String` bind change must land together, on top of the
  budget/fixture/hash coupling above. A bind-only migration (String binds against still-VARBINARY
  columns) is equally red: H2 comparison requires the bind type family to match the column type
  family (`BINARY VARYING` vs `CHARACTER VARYING` not comparable), so neither half lands alone.

Therefore: one branch, temporarily red during conversion, commit+push only when fully green.

Execution attempt log (2026-11-20, hard push authorized): the trio (DDL raw→VARCHAR on 278 columns
plus helper/`actorKey` bind→String) was attempted with targeted scripts. Compilation exposed a
~40-site ripple across contracts records/interfaces (`StoreModels`, `ManagedToolResultStore`),
persistence stores and control-plane; a broad `getBytes(`→`getString(` regex additionally corrupted
digest computations (`String.getBytes(UTF_8)`), proving the bind migration must be done per-site
compiler-guided, never by broad regex. The attempt was reverted to the green increment-1 baseline;
no red code was pushed. The remaining batch is therefore a single compiler-guided manual pass over
the ripple plus the hash-drop/rebuild/cursor/generated/CHECK/meta-test work below.

### Safe bind-migration recipe (compiler-guided, no broad regex)

- Variable-name whitelist for `byte[]`→`String`: `actorKey`, `ownerActorKey`, `owner`, `creator`,
  `actor`. **Never bare `key`** (crypto signing/bracket keys are `byte[]`, e.g.
  `RuntimeBrokerBracketKeyBindingTest` `Arrays.fill`); never rewrite `getBytes` used for
  digests/signatures. A second in-session attempt confirmed main code compiles after the whitelist
  pass but verification test sources (~56 files) still need migration, and bare-`key` replacement
  corrupts crypto keys.
- **`List<byte[]>`, `byte[].class`, `Arrays.equals` are NOT safe global replacements**: binary
  payload columns (`inline_bytes`, `record_bytes`) legitimately use `List<byte[]>`,
  `byte[].class` and `Arrays.equals(byte[],byte[])`. A third in-session attempt showed global
  replacement of these corrupts binary-payload reads (e.g. `SELECT inline_bytes … byte[].class`
  became `String.class`). Convert them only at identity-read sites, manually;
  `Arrays.equals`→`Objects.equals` on binary payloads silently breaks content equality. Only the
  var-name whitelist, `setBytes(x.getBytes(…))`→`setString(x, …)`, and helper signatures are safe
  globally; everything else is per-site compiler-guided.
- Central helpers: `JdbcRepositorySupport.setIdentity`→`setString`;
  `ManagedSchemaRows.identity`→`getString`; `ManagedWorkspaceRegistry.actorKey`→return String;
  `ManagedReceipts.actorScope(String)`→`Base64(actor.getBytes(UTF_8))`; `UNATTRIBUTED`→`""`;
  `ManagedRuntimeRetentionGuard.identity`→`return value`.
- Semantic fixes driven by compile errors: identity row reads `getBytes`→`getString`;
  `return x.getBytes(UTF_8)`→`return x`; `actor.length==0`→`isEmpty()`; byte[]/String conditionals;
  **identity-site only** `Arrays.equals`→`Objects.equals`, `List<byte[]>`→`List<String>`,
  `queryForObject byte[].class`→`String.class`; test `containsExactly`/`fill` on identity
  values→String.
- Loop: whitelist type script (main + verification tests) → `test-compile` → manually fix the listed
  semantic sites → repeat until compile green → broad H2 → double Checkstyle → commit.

## Execution order

1. **DDL (V1 in place).** Convert text-identity `VARBINARY` to `VARCHAR` budgets with per-column
   NO PAD collation expressed as a MySQL executable comment
   `/*!80000 CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin */` (H2 ignores it; a plain clause
   breaks on `NOT NULL DEFAULT` / generated columns); keep binary payloads (`record_bytes`, `object_key`,
   `capture_object_key`) as `VARBINARY`. Drop the 60 "Hashed" columns plus same-family derived
   identity keys (`physical_key`, `storage_key`, `holder_key`, `*_resource_key`, `import_key`,
   `runtime_binding_key`, `execution_storage_key`, `source_record_key`, `delivery_key`,
   `result_operation_key`, `deletion_operation_key`). Keep the 32 content-digest columns and
   git-sha `VARCHAR(64)` columns. Rebuild every unique/index that used a dropped key on raw
   columns; drop `ma_session.uk_ma_session_scope` (redundant with PK). Redefine the two generated
   columns (`ma_request_receipt.decision_scope_key`, `ma_side_query.active_slot`) over raw scope
   columns; rewrite the three CHECKs (`ck_ma_resource_capture`, `ck_ma_ref_binding`,
   `ck_ma_storage_registered`) over raw columns. Keep the registered-Session restriction
   explicit when joins move off the `ma_session` hash columns, and add raw `tenant_id` /
   `session_id` to `ma_read_lease`. Do not drop `operation_key` until the SSH and child
   workspace derivations are unified or `operation_id` is shown unique per tenant and kind,
   and keep a unique key that preserves today's constraint. Do not drop `receipt_key` until
   the design's open question on receipt-minted workspace and storage ids is decided.
2. **Cross-table references.** For each referencing table add the raw scope+resource columns it
   lacks (`tenant_id`, `workspace_id`, `session_id`, `resource_id` as applicable) and populate them
   on write; replace the hash reference column with those raw columns in joins/uniques. Where a
   table cannot carry the full scope, use a canonical **readable** resource key `VARCHAR(256)`
   (explicitly not a hash) and re-check index width.
3. **Java binds + derivations.** Move `byte[]`→`String` across persistence/runtime-broker/
   control-plane/contracts/verification; delete `ManagedSchemaKeys.key()` identity derivations
   (410 sites) but keep digest helpers and the derivations that mint public ids and paths
   (`receiptKey` for workspace and storage ids, `key(tenant)` for the workspace root);
   rewrite the ~1613 column references by category:
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
   keep multi-byte and trailing-space semantics tests; bind a real receipt-minted
   `workspace_id` (74 characters) and `storage_id` (73 characters) and a 128-character
   registration-chosen workspace id in regression tests.
6. **Meta-tests.** Update schema-shape pins, catalog validation, and any surface fixture
   (`managed-surface.txt`) with the DDL; add per-key width assertion (<3072) and per-store
   cursor/lock-order equivalence tests (same rows, same order, no deadlock under concurrency).

## Budgets (index bytes = 4×chars, utf8mb4)

| Class                                                                        | Budget         | Bytes |
| ---------------------------------------------------------------------------- | -------------- | ----- |
| tenant / actor (numeric ≤20 upstream)                                        | VARCHAR(36)    | 144   |
| UUID-class ids                                                               | VARCHAR(64)    | 256   |
| workspace_id, storage_id (contract allows 128 chars; receipt-minted 74 / 73) | VARCHAR(128)   | 512   |
| external channel account/sender/chat/thread                                  | VARCHAR(512)   | 2048  |
| canonical readable resource key (fallback)                                   | VARCHAR(256)   | 1024  |
| binary payloads / OSS object keys                                            | keep VARBINARY | n/a   |

Guard exception (already landed): `ma_tenant_guard.tenant_id VARCHAR(96)` readable scope carries
sentinels (`local-storage-host/<64-hex>` = 83 chars); PK `(tenant_id, guard_domain)`. A regression
test binds a real 64-hex host sentinel; `ManagedSchemaMySqlIT` pins the column width and the
`utf8mb4_0900_bin` collation.

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
- Receipt-minted workspace and storage ids round-trip at their real length; joins moved off the
  `ma_session` hash columns keep the registered-Session restriction; `operation_key`
  uniqueness for SSH and child workspace operations is preserved.
