# Managed identity columns: VARCHAR budgets and removing the identity-hash key layer

[English](2026-11-20-managed-identity-varchar-dehash.md) | [简体中文](2026-11-20-managed-identity-varchar-dehash.zh-CN.md)

## Status and scope

- Status: **proposal**. No code or schema is changed by this document. Implementation
  requires its own change, baseline reproduction, and MySQL evidence.
- Revision (2026-11-20): a follow-up survey of the hash keys that duplicate another unique
  key in their own table corrected the `workspace_id` budget and added constraints for
  receipts, operations, Session hash columns and read leases
  (see [Duplicate business keys](#duplicate-business-keys)).
- Date: 2026-11-20. Source baseline: `origin/main` at `7ef9d6decb`. Analysis was
  executed at `f10299764e`; the three intervening commits touch no
  `packages/managed-agent-server` file, and the shared V1 schema and
  `ManagedSchemaKeys` are byte-identical between the two (verified by `git diff`), so
  all counts and widths hold at the current main tip.
- Scope: `packages/managed-agent-server` (persistence, runtime-broker, control-plane,
  contracts, verification), the shared `V1__managed_schema.sql`, and any TypeScript
  consumer that derives the same keys. Pre-release policy applies: edit the single V1
  baseline in place and recreate development catalogs; no V2+ migration.

## Problem

Identity columns are `VARBINARY(512/1024/2048)` and a parallel layer of `CHAR(64)`
SHA-256 keys (`ManagedSchemaKeys.key()`, 410 call sites) carries the indexable and
business-unique form of those identities: 60 columns are explicitly commented
"Hashed …" (`tenant_key`, `session_key`, `session_scope_key`, `harness_key`,
`scope_key`, `resource_key`, `record_key`, `operation_key`, `receipt_key`, …), plus
same-family derived keys without that comment word (`physical_key`, `storage_key`,
`holder_key`, `*_resource_key`, …). A separate 32 `CHAR(64)` columns are **content
digests** (`sha256`, commit-chain digests, `idempotency_digest`, token hashes) and are
not part of this change.

The hash layer exists to keep composite index keys under InnoDB's 3072-byte limit
when identities are declared up to 2048 bytes, and to compact multi-column tuples
(`scope_key = hash(tenant, workspace, session)`) into one referenced column. Its
costs: a SHA-256 per key per write, raw+hash double storage, extra unique indexes,
dual-predicate queries (`tenant_key = ? AND tenant_id = ?`), and a derivation scheme
woven through every store and cross-table reference.

The declared 512/2048-byte budgets are **upper bounds, not actual values**. Actual
identities are short (see evidence below), so the width justification for hashing
does not hold for them, and the layer can be removed in favour of raw columns.

## Goals and non-goals

Goals:

- Store identities as `VARCHAR` with per-class budgets sized to real values plus
  buffer, with byte-exact (NO PAD) equality.
- Remove the identity-hash key layer; key coordination, uniqueness, and cross-table
  references on raw identity columns.
- Preserve every isolation, fencing, idempotency, lock-order, and replay invariant.

Non-goals:

- No public API change; serialized payload names stay intact.
- Content digests (32 columns) are retained unchanged; the journal commit chain,
  lease fencing, idempotent receipts, and replay floor are not redesigned.
- Database row `id` stays excluded from domain identities and CSI evidence
  ([schema conventions](2026-11-02-managed-schema-conventions.md)).
- No async caching, no prefetch widening; the 8 MiB read budget is unchanged.
- OSS object keys are storage pointers, not business identities; they stay binary.

## Identity evidence and budgets

| Identity                                                           | Actual form / length                                                          | Evidence                                                                                                                                                      | Budget                            | Index bytes |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ----------- |
| `tenant_id`, `actor_id`                                            | numeric, ≤20 digits                                                           | upstream table defines `tenant_id bigint(20) unsigned`, `act_id` likewise (maintainer-supplied, 2026-11-20); arrives as decimal string via `X-Qwen-Tenant-Id` | `VARCHAR(36)`                     | 144         |
| `session_id`                                                       | UUID, 36                                                                      | transcript file is `<uuid>.jsonl` (`packages/core/src/services/sessionService.ts:1841`)                                                                       | `VARCHAR(64)`                     | 256         |
| `workspace_id`                                                     | `workspace-` + 64-hex receipt key (SHA-256 of the creation receipt tuple), 74 | `WorkspaceCreationStore` (receipt-minted ids), `WorkspaceCreationRoots`                                                                                       | `VARCHAR(128)` (current contract) | 512         |
| `storage_id` (receipt-minted)                                      | `created-` / `imported-` + the same 64-hex receipt key, 72 / 73               | `WorkspaceCreationStore`, `WorkspaceCreationRoots.IMPORTED_PREFIX`                                                                                            | `VARCHAR(128)` (current contract) | 512         |
| `resource_id`, `operation_id`, `activation_id`, other minted ids   | `randomUUID()`, 36                                                            | `http-managed-session-store.ts`, `managed-session-assembly.ts`, Java `UUID.randomUUID()`                                                                      | `VARCHAR(64)`                     | 256         |
| external channel `account_id`, `sender_id`, `chat_id`, `thread_id` | platform-opaque, variable                                                     | schema comments "External platform … identity"                                                                                                                | `VARCHAR(512)`                    | 2048        |
| `object_key`, `capture_object_key`                                 | OSS key, long, not indexed                                                    | `ma_resource`, `ma_journal_pack`                                                                                                                              | keep `VARBINARY`                  | n/a         |

`VARCHAR(N)` under utf8mb4 counts as `4×N` bytes for index-key arithmetic; on-disk
storage is the actual bytes. The class table gives defaults; implementation must
enumerate every identity column's mint format and finalize per-column budgets,
listing exceptions (e.g. composite turn/event ids) explicitly.

Correction (follow-up survey): an earlier revision listed `workspace_id` as a
UUID-derived receipt key of about 46 characters with a `VARCHAR(64)` budget. The
receipt key is the 64-hex SHA-256 of the creation receipt tuple, so the receipt-minted
`workspace_id` is 74 characters and the matching `storage_id` is 72 or 73. `VARCHAR(64)`
would fail closed on production workspace creation under strict mode, the same class
of error as the 83-character guard sentinel. The binding limit, however, is the public
contract rather than the receipt-minted form: external storage registrations accept a
`tenantWorkspaceId` of up to 128 characters (`[A-Za-z0-9._-]{1,128}`), which becomes
both `workspace_id` and `storage_id`, and workspace selection accepts workspace ids of
up to 128 characters. Under that contract both columns need `VARCHAR(128)`; a smaller
budget requires tightening the contract first, which is a public API change. Dropping
the `workspace-` / `created-` / `imported-` prefixes would not help: the registry
relies on `workspace-` plus 64 hex characters to tell receipt-minted ids from
registration-chosen ones, the storage prefixes record whether a workspace was created
or imported, and registration-chosen ids can still reach 128 characters.

Contract caveat: the code treats tenant/actor as opaque header strings and does not
enforce length. Development defaults to `local-java-demo`
(`managed-development-options.ts:16`) and verification fixtures use
`"tenant-" + UUID` = 43 chars (`Issue13181QueryBudgetTest.java:96`). Adopting
`VARCHAR(36)` therefore requires aligning those fixtures/defaults to ≤36 and adding
fail-closed admission validation (see application layer).

## Index width arithmetic

Method: parse every `PRIMARY KEY`, `UNIQUE`, and `CREATE INDEX` in V1 (246 keys);
replace each identity-hash column by its conservative raw-tuple expansion and each
raw `VARBINARY` identity by its class budget; keep enums/numerics/digests as-is.
Expansion is an estimate, not a per-key derivation; margins are large enough that
the conclusion is robust, and implementation re-checks each key exactly.

Result with the budgets above: **246/246 keys < 3072 bytes; widest 2800 bytes.**

| Key                                                   | Estimated width |
| ----------------------------------------------------- | --------------- |
| `ma_resource.idx_ma_resource_delete_intent`           | 2800            |
| `ma_operation_work.idx_ma_work_pending`               | 2784            |
| `ma_operation_work.uk_ma_operation_work_business_key` | 2400            |
| `ma_operation.uk_ma_operation_request`                | 2304            |
| `ma_operation.uk_ma_operation_identity`               | 2016            |

The previously marginal `uk_ma_operation_request` (≈3184 bytes when actor was
budgeted at `VARCHAR(256)`) drops to ≈2304 once actor is numeric `VARCHAR(36)`
(`actor_key` expands to tenant+actor = 288 bytes). No key needs a retained hash.

These estimates used `workspace_id` at `VARCHAR(64)`. With the corrected budget, every
key that contains a workspace identity, directly or through an expanded scope tuple,
grows by 256 bytes per occurrence (the receipt worst case below becomes ≈1504 bytes).
The 2800- and 2784-byte estimates must be recomputed exactly before the budgets are
fixed: a key near 2800 bytes that contains a workspace identity once keeps about 16
bytes of headroom, and one that contains it twice exceeds 3072 bytes.

## Proposed schema change

### Column types and collation

- Convert identity `VARBINARY` columns to the class budgets above.
- Pin every identity column to a **NO PAD** binary collation (`utf8mb4_0900_bin`) so
  equality remains byte-exact including trailing spaces; the table default
  `utf8mb4_bin` is PAD SPACE and would fold `'t'` with `'t '`, widening isolation
  ([consolidation](2026-10-13-managed-schema-consolidation.md) requires byte-exact
  "including trailing spaces"). Verify H2's VARCHAR trailing-space semantics and
  align them; add cross-engine equality tests.
- Keep display/enum/JSON columns as they are.

### Drop identity-hash columns, retain digests

- Remove the 60 "Hashed" columns and the same-family derived identity keys; remove
  their unique constraints and indexes; rebuild those keys on raw columns (below).
- Retain all 32 content-digest columns and the digest helpers in
  `ManagedSchemaKeys` (commit chain, `sha256`, `idempotency_digest`, token hashes).
- Remove the dual-predicate pattern; queries filter raw identities directly. Hash
  collision re-checks become unnecessary because the raw value is the key.

### Coordination protocols on raw columns

- **Tenant guard.** `ma_tenant_guard` PK `(tenant_key, guard_domain)` becomes
  `(tenant_id, guard_domain)` where `tenant_id VARCHAR(96)` is a **readable**
  scope: the tenant decimal string for tenant domains, or an explicit sentinel for
  the cross-tenant/host locks (`external-storage-registration/1`,
  `local-storage-host/<hostId>`, 19+64=83 chars because hostId is a 64-hex HMAC).
  Sentinels are not numeric tenants and must not be forced into a numeric tenant
  budget; the readable scope column preserves them without hashing
  (384+128=512 bytes). A regression test binds a real 64-hex host sentinel so the
  width cannot silently regress. Interim bound: scopes must be <=96 chars and over-long values fail closed at the guard INSERT under strict mode; full admission validation is deferred to a later phase. The
  `INSERT … ON DUPLICATE KEY UPDATE` + `SELECT … FOR UPDATE` acquisition shape and
  the two domains are unchanged
  ([lock inventory](2026-11-12-managed-agent-lock-inventory.md)).
- **Session head.** `uk_ma_session_head_business_key (tenant_key, harness_key)`
  becomes `(tenant_id, harness_session_id)` (144+256=400 bytes); the `FOR UPDATE`
  lock point moves to that raw unique. `idx_ma_head_workspace`, `idx_ma_head_wake`,
  `idx_ma_head_session` rebuild on raw columns. `head_kind` semantics unchanged.
  `ma_session.tenant_key`, `session_key` and `session_scope_key` are written only by
  the publication-retention CONTROL upsert, which also fills them on an existing row,
  so every join on these columns also restricts the match to Sessions that path has
  registered. Joins rewritten onto raw columns must carry that restriction explicitly.
  `ma_read_lease` stores only `(tenant_key, session_key)` and needs raw `tenant_id` and
  `session_id` columns before its join to `ma_session` can move.
- **Session scope prefix.** Child tables replace `session_scope_key` with the raw
  `(tenant_id, session_id)` prefix and rebuild every index that led with it
  (`idx_ma_record_identity`, `ma_journal_pack` unique, resource/ref/operation/side
  query/client-files indexes). The prefix predicate is load-bearing
  ([shared helpers](2026-10-17-hosted-gate-shared-helpers.md)); query shapes must
  keep `tenant_id = ? AND session_id = ? AND …` so scans stay bounded.
  `ma_session.uk_ma_session_scope` is dropped as redundant with the PK.
- **Idempotency and receipts.** `receipt_key`, `operation_key`, `target_key`,
  `scope_key` are replaced by typed raw scope columns
  (`scope_kind` + `tenant_id` + `workspace_id` + `session_id` + `actor_id` as
  applicable) in `ma_request_receipt` / `ma_operation`; uniques are computed over
  the applicable subset plus `idempotency_digest`. Worst case
  (namespace+tenant+scope_kind+workspace+session+actor+digest) ≈1248 bytes.
  Polymorphic single-column scopes are expanded to typed columns rather than kept
  as an encoded string; if a cross-table reference proves too wide, a canonical
  **readable** scope string (explicitly not a hash) is the fallback, re-checked for
  width. `receipt_key` is also a minted identifier, not only an index key: for
  `WORKSPACE_CREATE` it is embedded in `workspace_id` (`workspace-<receipt_key>`), in
  the created or imported `storage_id`, and in the on-disk workspace root
  `<base>/<key(tenant)>/<receipt_key>`, and the workspace registry strips the prefix
  from a workspace id to look the receipt up by `receipt_key`. That lookup cannot be
  turned back into the raw receipt tuple, so either `receipt_key` stays as a minted
  identifier, or workspace creation records the receipt's raw tuple on the workspace
  row before the column is dropped. In both cases the derivations behind these public
  ids and paths stay.
- **Operation identity.** `operation_key` derivations are not uniform. Most writers
  use `operationKey(kind, scope_key, target_key, operation_id)`, but SSH workspace
  operations use `key(OPERATION, tenant, id)` and child workspace operations use
  `hash(kind, tenant, id)`. For those two, `operation_key` is stricter than
  `uk_ma_operation_identity` because it omits the target: the same tenant and
  operation id under two targets is rejected today and would be accepted by the
  identity key alone. Before `operation_key` is dropped, unify these derivations or
  show that `operation_id` is unique per tenant and kind, and keep a unique key that
  preserves today's constraint.

### External channel identities and OSS keys

- External platform ids get `VARCHAR(512)`; they do not lead the wide composite keys,
  so they fit without hashing. If a deployment's platform ids can exceed 512, that
  column keeps a compaction key individually (the only permitted residual hash).
- `object_key` / `capture_object_key` remain `VARBINARY` (opaque storage pointers).

## Application-layer change

- Java binding moves `byte[]` → `String` across persistence, runtime-broker,
  control-plane, contracts, and verification fixtures; row mappers and binders
  change together (H2 rejects string binds to `VARBINARY`, so type and bind must
  move in one change).
- `ManagedSchemaKeys.key()` identity derivations are deleted (410 call sites);
  digest helpers remain. Cross-table references carry raw identity columns.
  Derivations that mint public identifiers or filesystem paths (`receiptKey` for
  workspace and storage ids, `key(tenant)` for the workspace root directory) are
  identifiers, not index keys, and stay.
- Admission validates identity length/format fail-closed at the boundary
  (tenant/actor ≤36, UUID/prefixed forms, external ≤512); over-long or malformed
  identities are rejected, never truncated.
- Align verification fixtures and development defaults to the new contract
  (numeric or ≤36-char tenants); keep multi-byte and trailing-space semantics tests.
- Confirm whether any TypeScript consumer derives these keys; if so it moves in the
  same change. Schema-shape meta-tests and catalog validation update with the DDL.

## Code-side index and query census

The DDL census (246 keys) is not the whole code surface. A reference census of Java
production code finds ~1613 column-reference sites on the identity-hash columns
(`session_scope_key` 314, `scope_key` 270, `tenant_key` 133, `resource_key` 126,
`operation_key` 117, `physical_key` 88, `owner_key` 83, `storage_key` 82,
`record_key` 81, `harness_key` 71, `alias_key` 57, `target_key` 54, `receipt_key` 38,
plus smaller counts), separate from the 410 key-derivation sites. Each is a query,
binder, row-mapper, or ordering dependency that must move with the DDL. Four
categories need explicit redesign beyond the index rebuild:

- **Keyset cursors and deterministic lock ordering.** Several stores page and lock
  in hash-key order: `ManagedSessionRetirementStore`
  (`ORDER BY owner_key, owner_revision, resource_key … FOR UPDATE`,
  `ORDER BY query_key / receipt_key / request_key / record_key … FOR UPDATE`),
  `WorkspaceRecoveryStore` (`target_key > ? ORDER BY target_key`),
  `SessionResourceCollectionCollector` (`resource_key > ? ORDER BY resource_key`),
  `JdbcHostedCleanupDebtStore` (`owner_key > ?`), `ManagedExtensionQueries`
  (`record_key DESC` cursor). The hash supplies a total order used both as a
  pagination cursor and as a consistent `FOR UPDATE` acquisition order (deadlock
  avoidance). Replacing it requires a composite tuple order (e.g.
  `(tenant_id, session_id, resource_id)`) with lexicographic row-value cursor
  comparisons, and the same total order must hold across every transaction that
  locks those rows.
- **Generated columns over hash keys.** `ma_request_receipt.decision_scope_key`
  (`GENERATED … RTRIM(scope_key)`, V1:681) and `ma_side_query.active_slot`
  (`GENERATED … actor_scope_key`, V1:1333) derive from hash columns; both must be
  redefined over the raw scope columns or dropped together with their consumers.
- **CHECK constraints over hash keys.** `ck_ma_resource_capture` (scope_key/slot_key
  nullability coupling, V1:508), `ck_ma_ref_binding` (runtime_binding_key, V1:536),
  and `ck_ma_storage_registered` (physical_key, V1:989) reference hash columns and
  must be rewritten over raw columns.
- **Prefix-led queries and catalog pins.** Every `session_scope_key = ?` /
  `scope_key = ?` leading predicate must keep its raw
  `(tenant_id, session_id[, workspace_id])` prefix so rebuilt indexes still bound
  scans; schema-shape meta-tests and catalog validation that pin hash columns
  update with the DDL.

Acceptance adds per-store cursor/lock-order equivalence tests (same rows, same
order, no deadlock under concurrency) and generated-column/CHECK rewrite tests on
both engines.

## Duplicate business keys

A follow-up survey checked whether the hash keys that only duplicate another unique key
in their own table could be removed ahead of the VARCHAR conversion, as
`ma_memory_store.store_key` and the extension `package_key` / `settings_key` were. #17958
proposes removing two more that qualify, `ma_storage (tenant_key, storage_key)` and
`ma_storage_owner.physical_key`. None of the remaining ones can go on its own:

| Key                                       | Equivalent unique in its table                       | Why it cannot be removed alone                                                                                                                                                                                                                                                                                               |
| ----------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ma_storage.alias_key`                    | `(tenant_id, storage_id)`                            | The raw pair is 2048+2048 = 4096 bytes at current widths; `ma_runtime_binding.storage_alias_key` references it; aliases are locked in `alias_key` order.                                                                                                                                                                     |
| `ma_session` `tenant_key` / `session_key` | Primary key `(tenant_id, session_id)`                | Join bridge to `ma_session_head (tenant_key, harness_key)`, whose raw key `(tenant_id, harness_session_id)` is 4096 bytes; also the registered-Session restriction above.                                                                                                                                                    |
| `ma_operation.operation_key`              | `uk_ma_operation_identity`                           | `ma_operation_work` has no operation identity columns, and rebuilding `idx_ma_work_pending` on them is ≈3200 bytes; also the non-uniform derivations above.                                                                                                                                                                  |
| `ma_resource.resource_key`                | `uk_ma_resource_id (session_scope_key, resource_id)` | The raw triple is 4608 bytes. `(session_scope_key, resource_id)` fits, but six referencing tables (seven columns) would need resource identity columns (only `ma_resource_ref` already has a nullable `resource_id`) and two `FOR UPDATE` cursors would change, all to be rewritten again when `session_scope_key` converts. |
| `ma_request_receipt.receipt_key`          | `uk_ma_request` (verified for all six writers)       | Minted into workspace and storage ids and the workspace root (above).                                                                                                                                                                                                                                                        |
| `ma_delivery.delivery_key`                | `uk_ma_delivery_identity`                            | Possible through `(source_scope_key, delivery_id)` on `ma_channel_segment` (2624 bytes), but it trades one hash column for a hash plus a raw column; do it with the conversion.                                                                                                                                              |

Database row `id` is not an alternative reference: business identities, tenant scoping,
idempotency and fencing keep business keys
([schema conventions](2026-11-02-managed-schema-conventions.md)). The survey therefore
confirms that the remaining work is one atomic cluster
([implementation plan](../plans/2026-11-20-managed-identity-dehash-cluster-impl.md)).

## Invariants preserved

- Tenant/actor/workspace authorization precedes LIMIT and pagination; no
  cross-request authorization cache.
- Lock order guard → session root → head; writer/claim generations, lease fences,
  repeatable-read snapshot rules, and fresh-committed checks unchanged.
- Settlement and retirement stay idempotent; reference and recovery protection
  unchanged; GC never reports completion before PUT is proven.
- Identity equality stays byte-exact including trailing spaces on both engines.
- H2/MySQL parity: parameterized SQL only; VARBINARY→VARCHAR binds move together.

## Risks and trade-offs

- The just-merged [sql-hot-paths](2026-11-19-managed-agent-server-sql-hot-paths.md)
  (#17856) built indexes on hash keys; every one must be rebuilt on raw columns and
  re-proven with the `ManagedSqlPerformanceMySqlIT` benchmark (baseline vs changed
  result fingerprints and examined-row counts), or hot reads regress to lane scans.
- Coordination-protocol redesign is a lock-protocol change: each needs MySQL race
  tests on independent connections before removal, per the lock inventory.
- 410 call-site mechanical rewrite risks dropping shared logic; verify every
  consumer, do not keyword-delete.
- H2 vs MySQL collation/trailing-space divergence could widen isolation silently;
  cross-engine equality tests are mandatory.
- Width figures are conservative estimates; a per-key exact re-check is required at
  implementation, and any key that exceeds 3072 gets an individually redesigned
  (narrower) index rather than a reintroduced hash.
- Write amplification: removing double storage and extra uniques reduces writes;
  no new ledger is introduced by this change.

## Validation and acceptance

- Recreate catalogs on fresh H2 and disposable MySQL 8.4; catalog validation rejects
  drift and leftover hash columns; the guard scope collation is pinned by the MySQL-shape gate (`ManagedSchemaMySqlIT`), not by cross-engine catalog validation; all 246 keys assert < 3072.
- Cross-engine identity equality tests: case, trailing space, multi-byte; NO PAD on
  MySQL and aligned H2 behavior.
- Admission rejection tests for over-long/malformed tenant/actor/external ids.
- Workspace creation and admission tests bind a real receipt-minted `workspace_id`
  (74 characters) and `storage_id` (73 characters), and a 128-character
  registration-chosen workspace id, as the guard regression binds a real 64-hex host
  sentinel.
- Joins moved off the `ma_session` hash columns keep the registered-Session
  restriction: a Session the retention path never registered is not matched.
- MySQL race suites: guard acquisition (tenant + sentinel domains), head claim/drain/
  renew, rename settlement, retirement/GC ordering, receipt idempotency.
- sql-hot-paths benchmark: result fingerprints equal and examined-row counts not
  worse than the merged baseline at 1k/10k/100k.
- Full Java verification plus TypeScript build/typecheck/tests for touched consumers;
  Checkstyle and formatting pass.

## Phasing

1. Contract + admission validation + fixture/dev alignment (no schema change yet).
2. V1 in-place DDL (budgets, NO PAD, drop identity hashes, rebuild keys) together
   with the Java binding/derivation rewrite and schema-shape meta-tests.
3. Rebuild and re-prove hot-path indexes; run benchmark and race suites.
4. External-channel and sentinel-guard edge cases; per-key exact width re-check.

## Open questions

- Exact mint format and final per-column budget for composite ids (turn/event/
  prompt/pack/lease) that are not plain UUIDs.
- Whether any TypeScript consumer derives identity hashes (must move together).
- Production tenant/actor injection: confirm the decimal-string contract and the
  maximum digit count across deployments before fixing `VARCHAR(36)`.
- Whether any external platform id can exceed 512 chars (residual compaction case).
- Receipt-minted workspace and storage ids: keep `receipt_key` as a minted identifier,
  or record the receipt's raw tuple on the workspace row?
- `workspace_id` and `storage_id` budget: keep the 128-character contract and budget
  `VARCHAR(128)`, or tighten the contract (a public API change) after enumerating every
  mint format?
- `operation_key` uniqueness for SSH and child workspace operations: unify the
  derivations, or prove `operation_id` unique per tenant and kind?
