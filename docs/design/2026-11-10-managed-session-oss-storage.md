# Managed Session OSS storage: resource externalization (D2) and journal compaction

[English](2026-11-10-managed-session-oss-storage.md) | [简体中文](2026-11-10-managed-session-oss-storage.zh-CN.md)

Status: proposed, design-only. No code, schema, or wire change is implemented by this document.
Baseline: `main @ 488845a4a8` (2026-11-10). Every `file:line` citation was read at that baseline; re-verify before implementation because parallel work moves `main`.

## 1. Problem and scope

Private Hosted Managed Sessions keep resource bodies and journal transaction bytes inline in MySQL. Resources larger than their per-kind inline cap are rejected with HTTP 501 `managed_session_oss_disabled` (`JournalCommit.java:762-772`); the README states OSS-backed resources remain pending "until the immutable OSS path is implemented" (README §655-657). Inline journal bytes accumulate without bound (up to 8 MiB per transaction), which is why large-object tests require `max_allowed_packet >= 128MB` (module AGENTS.md) and why readers carry `OCTET_LENGTH` guards (`CancelEvidence.java:75`) and an 8 MiB inventory cap (`WorkspaceCsiApplicationInventory.java:1257`).

This design completes the already-decided path in two decoupled parts plus two small ride-along schema additions:

- **S1a — D2 resource externalization.** Implements the `OSS_OBJECT` path named by `docs/design/2026-09-21-managed-session-durable-store.md` §12: allocate/upload/finalize/read, scoped signed URLs, digest verification, encryption, orphan inventory. Target placement per `2026-09-25-managed-session-typescript-foundation.md:15`: bodies up to the per-kind cap stay MySQL inline; larger bodies become immutable OSS objects.
- **S1b — journal compaction.** Packs a contiguous committed prefix of `ma_session_journal_tx.record_bytes` into immutable compressed OSS objects, publishes a manifest and watermark atomically, and deletes covered SQL blobs only after a grace window. This is the "later measured optimization" sketched in durable-store §9; it is the part that actually shrinks MySQL.
- **Appendix A — A3/A4.** Session-list preview denormalization and a queue revision counter, small independent schema additions that ride the same pre-release V1 window.

Non-goals: moving the source of truth out of SQL (the digest chain and head CAS remain authoritative); changing per-kind inline caps; changing the retirement tombstone semantics; any public API or wire change; implementing S3-style table splits of fused tables.

## 2. Locked decisions

| #     | Decision                       | Choice                                                                                                                                                                                                                                                                                                              |
| ----- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1    | finalize verification          | Full object GET + SHA-256 + byte-length check. OSS ETag is not SHA-256 for multipart uploads; provider-neutral verification requires reading the bytes.                                                                                                                                                             |
| D2    | allocate idempotency receipt   | Reuse `ma_request_receipt` with a new closed-namespace value `RESOURCE_ALLOCATE` (one-line CHECK edit). `result_json LONGTEXT` already stores the durable replay result; `uk_ma_request` and `request_digest` give retry/conflict semantics for free.                                                               |
| D3    | resource read/write path       | Server-proxied reads through the existing `GET resources/{resourceId}` route and a server-proxied `resources/{id}:upload` route for the first release. `ToolPublicationObjectStore` exposes no presign operation; adding one would ripple every implementor, so scoped signed direct URLs are a later optimization. |
| D4    | bucket isolation               | One bucket shared with tool publication, separate key prefix per concern; independent bucket remains a deployment option.                                                                                                                                                                                           |
| D5    | encryption                     | Bucket-level server-side encryption as a deployment gate; per-resource client-side encryption later (`encryption_key_id` column already reserved).                                                                                                                                                                  |
| D6    | per-kind inline caps           | Unchanged by S1a, including the 32 MiB `hosted-model-request` cap. Changing placement boundaries requires a storage-versioned compatibility decision and production measurement (durable-store §10).                                                                                                                |
| E1    | compaction watermark           | New head column `packed_through_revision`. `compacted_through_revision` keeps its current retirement-tombstone meaning with zero change (§3.2).                                                                                                                                                                     |
| E2    | compression                    | JDK `Deflater`/GZIP first; no new dependency. zstd only if measured ratios justify a declared dependency.                                                                                                                                                                                                           |
| E3    | pack bounds                    | Configurable; proposed defaults 16 MiB compressed target and 4096 transactions per pack, finalized after measurement.                                                                                                                                                                                               |
| E4    | deletion grace                 | Configurable, default 72h. Hard constraint: grace >= backup replication lag SLA. No SLA is currently defined, so P3 qualification adds a manual operator confirmation gate before deletion is enabled.                                                                                                              |
| E5    | range reads                    | Extend `ToolPublicationObjectStore` with `openRange(key, offset, length, guard)`. Required by S1b P2 only; S1a uses full-object reads. Full-stream skip is rejected.                                                                                                                                                |
| E6    | pack boundaries                | Prefer ending packs at checkpoint revisions when convenient; not required.                                                                                                                                                                                                                                          |
| E7    | existing full-journal scanners | `AgentExecutionOperations.backfillCompactionProjection` and friends read through the unified record reader first; incremental maintenance is a later optimization.                                                                                                                                                  |
| F1    | sequencing                     | S1a P1 first (unblocks the 501 rejection); S1b P1 may run in parallel (no dependency); A3/A4 ship as independent small changes.                                                                                                                                                                                     |
| G1/G3 | deliverable and boundary       | This unified bilingual document; design-only this round, implementation separately authorized.                                                                                                                                                                                                                      |

**Correction to older design text.** durable-store §11 says "Enable OSS versioning". The implemented storage contract supersedes that: `AliyunToolPublicationObjectStore` is a "private OSS profile: immutable keys in a bucket that has never enabled versioning" and `validateConfiguration()` refuses buckets whose versioning is ENABLED or SUSPENDED (`AliyunToolPublicationObjectStore.java:72-84`). Immutability is enforced by the `x-oss-forbid-overwrite: true` header on every create (`:86-90`) plus the never-versioned private-bucket check. This design follows the implemented profile; SSE remains a deployment requirement.

## 3. Current state (verified)

### 3.1 Placement gates and limits

`ManagedSessionStoreModels.java:17-28`: default inline cap 64 KiB; `managed-checkpoint` 1 MiB; `managed-input` 8 MiB; `hosted-model-request` 32 MiB; `managed-agent-skills` 2 MiB; `MAX_TRANSACTION_BYTES` 8 MiB per journal transaction; `MAX_INLINE_TRANSACTION_BYTES` 40 MiB aggregate inline resources per transaction; 1024 resources and 256 events per transaction.

`JournalCommit.java:762-772` rejects over-cap resources with 501 `managed_session_oss_disabled` (`ManagedSessionStoreModels.java:53-54`). The single existing exception is `managed-tool-outcome` with `bytesBase64 == null`, i.e. an already-externalized tool publication reference. S1a generalizes exactly this exception.

### 3.2 Journal reads and the tombstone semantics of `compacted_through_revision`

The schema comment calls `compacted_through_revision` "highest journal revision covered by completed compaction", but current code uses it as a **retirement tombstone**: `ManagedSessionRetirementStore:117-135` physically deletes `ma_session_journal_tx` rows and their JOURNAL references, then sets `compacted_through_revision = GREATEST(current, lastDeletedRevision)` on the DELETED head. Readers treat any non-zero value as "journal incomplete/unverifiable" and fail closed:

- `JdbcWakeRecoveryStore:112-114` throws corrupt; `:133-139` pages `record_bytes` for wake proofs.
- `JdbcWorkspaceLifecycleStore.requireIdleJournal:120-131` blocks with `workspace_lifecycle_journal_unverified` (head row lock is the per-session fence; #13800 snapshot-read retry).
- `WorkspaceCsiCheckpointSnapshotStore:148` requires zero.
- `AgentExecutionOperations:225-245` (`backfillCompactionProjection`, 16-row pages) and `:805` (sealed predicate).
- `ManagedRuntimeRetentionGuard:72` (`state <> 'DELETED' OR compacted_through_revision < journal_revision`).
- `JdbcChildResultRelayStore:505` reads the watermark; `:513` reads `record_bytes`.
- `WorkspaceCsiApplicationInventory:2874` verification requires zero.

Therefore S1b must NOT reuse this column for live coverage (decision E1). Reusing it would fuse tombstone and coverage semantics — the same fused-table anti-pattern this program rejects elsewhere.

Read protocol: `ManagedSessionStoreController:214 /restore`, `:234 /transactions`, `:246 /transactions:recent`, `:258 /transactions:lookup`; `JdbcManagedSessionStore:250/:256-259` delegates to `JournalHistoryQueries:36-44` (restore head) and `:46-127` (two-phase paging: candidate stage selects `journal_revision, byte_length` only and enforces contiguity plus the 8 MiB page budget; full-row stage selects `ManagedSchemaProjection.SESSION_JOURNAL_TX.columns()` through `storeRows.transactionMapper` and `storeRows::storedTransaction`). `ManagedSideQueryStore:231` has its own transactions read. The wire returns `recordBytesBase64 + recordDigest` per transaction; the TypeScript client verifies SHA-256 per transaction (`packages/core/src/managed-runtime/http-managed-session-store.ts:363-369, :1321-1326, :1399`). **Server-side pack resolution behind these routes keeps the wire byte-identical, so the TS client needs zero changes for S1b.**

Other direct `record_bytes` readers that must route through the unified reader: `JdbcWorkspaceLifecycleStore:169/:482`, `JdbcWakeRecoveryStore:133-139`, `JdbcChildResultRelayStore:513`, `SideQueryConversation:82`, `AgentExecutionOperations:239-245`, `WorkspaceCsiApplicationInventory:1257/:2598/:2880-2882`.

### 3.3 Object store contract and OSS profile

`contracts/artifact/ToolPublicationObjectStore`: private, durable, immutable objects; `putIfAbsent` never overwrites and never recreates a deleted key; `open(key, guard)` checks the authorization/lease guard before each new storage request including retries; `deleteIfPresent` deletes the exact owned key; `validateConfiguration` validates backend guarantees. Production implementation: `adapters/artifact/AliyunToolPublicationObjectStore` (private bucket, never-versioned check, forbid-overwrite header, guarded read loop owning retries via `TransientReadException` on GET 500/502/503, `:33-52`). Wiring: `AliyunToolPublicationStorageAutoConfiguration` gated by `qwen.managed-agent.tool-publication.enabled` with `@ConditionalOnMissingBean` so an application `@Bean` replaces OSS (README §232). One authoritative store per deployment; SQL rows hold object keys, not provider identities; missing objects block reads and never fall back (storage-interface design).

Implementors that an `openRange` addition touches: 1 production (`AliyunToolPublicationObjectStore:25`), 6 test fixtures (`PublicationProbeWiring:94` InMemoryObjectStore, `O4OssGate:157` OssFixture, `ToolPublicationAsyncVerificationTest:1078` Bucket, `ToolPublicationRetentionStoreTest:527` MemoryObjects, `O4FileObjects:13`, `ManagedSchemaPublicationStoreTest:115` Bucket), and 1 anonymous maintenance implementation (`WorkspaceCsiWorkerAckMain:102`).

### 3.4 Schema and configuration precedents

`ma_resource` (V1:438-478) already carries `storage_kind`, `object_key`, `object_version_id`, `encryption_key_id`, `quarantine_reason`, `deletion_operation_key`, `retention_until`, `last_verified_at`, `sha256`, `byte_length`; neither `storage_kind` nor `state` has an enum CHECK. `ma_resource_ref.owner_kind` already enumerates `JOURNAL`. `ma_session_head` (V1:185-233) already carries `compacted_through_revision` and `latest_checkpoint_resource_id`. `ma_request_receipt` (V1:619-666) carries `result_json LONGTEXT` and a closed-namespace CHECK. Configuration precedent: `ManagedAgentProperties.ToolPublication:738-763` includes capacities, verification rate limits, `gcEnabled`, and `deletionGrace` default 24h; new sections mirror this shape and extend the `ManagedAgentSettings` contract interface.

## 4. S1a — D2 resource externalization

### 4.1 Protocol

1. **allocate** — `POST /internal/managed-session-store/v1/sessions/{id}/resources:allocate` with writer token, `{resourceId, kind, schemaVersion, byteLength, digest}`. Server validates writer credential/generation/lease, kind cap, and quotas; inserts `ma_resource` with `state='ALLOCATED'`, `storage_kind='OSS_OBJECT'`, and a server-generated attempt-owned `object_key` (`<prefix>/<session_scope_key>/<resource_id>/<attempt_key>`, attempt bound to writer generation); records an idempotency receipt in namespace `RESOURCE_ALLOCATE` whose `result_json` holds `{objectKey, byteLength, digest, attemptKey}`. Returns the allocated `objectKey` and the server-proxied upload route (D3); the store itself performs `putIfAbsent` with the forbid-overwrite header. Replay with the same idempotency key returns the stored allocation; a conflicting digest is rejected by `request_digest`.
2. **upload** — Harness POSTs the exact bytes to `resources/{resourceId}:upload`; the server calls `putIfAbsent` on the allocated key. Retries reuse the same key and are safe because a completed create is never overwritten, including after later deletion (interface contract). Digest/length verification happens at finalize, not upload.
3. **finalize** — `POST .../resources/{resourceId}:finalize`. Server reads the whole object through `open(key, guard)`, verifies SHA-256 and byte length against the request and the row, then CAS `ALLOCATED -> PUBLISHED` with `last_verified_at`. Failure records `quarantine_reason` and leaves the row unusable (fail-closed). Session resources do not occupy capture slots: `scope_key/publication_id/slot_key` stay NULL, satisfying `ck_ma_resource_capture`; `capture_state` is not reused.
4. **commit reference** — `transactions:commit` / `commit-v2` (`ManagedSessionStoreController:199`) accepts `resources:[{resourceId, kind, digest, byteLength, bytesBase64:null}]` for any kind whose row is `OSS_OBJECT` and `PUBLISHED`. Validation generalizes `ToolPublicationAdmissionStore.referenceCapturedResource:492-521`: `FOR UPDATE` row lock, kind/scope/length/digest match, `PUBLISHED -> REFERENCED` CAS, same-`commandId` idempotent re-reference. In the same MySQL transaction as the journal row and head advance, insert `ma_resource_ref` with `owner_kind='JOURNAL'`, `owner_key=<scope>`, `owner_revision=<journal_revision>`. A committed head never references an unfinalized object.

Crash windows: PUT succeeded but commit failed leaves an unreferenced immutable object, invisible to recovery, collectable only after the publisher is fenced and a safety window passes (durable-store §8). Finalize succeeded but commit failed leaves a PUBLISHED unreferenced row, handled by the same orphan collector.

### 4.2 Schema

Zero new columns or tables. One V1 in-place edit: extend `ck_ma_request_namespace` with `WHEN 'RESOURCE_ALLOCATE' THEN 16`. Application-level enum extensions: `storage_kind='OSS_OBJECT'`, `state='ALLOCATED'`. Verify Java row validators (`JournalStoreRows` resource mapper, `WorkspaceCsiApplicationInventory` column maps) accept the new values; the Broker projection carries column lists only and has no value whitelist (verified: no `MYSQL_INLINE`/`TOOL_PUBLICATION` strings in `runtimebroker/managedschema`).

### 4.3 Reads, GC, configuration, clients

- Unified resource body resolution: `MYSQL_INLINE` returns `inline_bytes`; `OSS_OBJECT` opens through the store with the guard, verifies digest/length, streams. Missing or corrupt objects fail closed (`managed_session_resource_missing` / TS `BLOCKED_RESOURCE`, `managed-session-authority.ts:658`); never fall back. Touchpoints: `ManagedSessionStoreController:294`, restore bundle, `JournalStoreRows:477` gate, `SideQueryConversation:82`, `JdbcChildResultRelayStore:651`, `WorkspaceRecoveryReader:88-123`, `ManagedNativeJournalSnapshots:515-560`. Harness may cache immutable bodies by digest on its Pod (durable-store §9).
- Orphan collector: a new small collector class (pattern of `ToolPublicationRetentionStore`, not an extension of `ManagedProjectionResourceCollector:67`'s inline-only filter) scans ALLOCATED/PUBLISHED rows without references whose publisher is fenced, writes a durable deletion intent (`deletion_operation_key`), drives `deleteIfPresent` through `ma_operation`, and marks COLLECTED. Referenced resources are never auto-deleted in the first release (safe leak, durable-store §11); session retirement uses the existing tombstone flow.
- Configuration: reuse the single store bean; new section `qwen.managed-agent.session-resources` with `oss.enabled` default false (keeps the 501 fail-closed behavior), key prefix, and capacities mirroring `ToolPublication`. Startup `validateConfiguration()`.
- TS client: `http-managed-session-store.ts` gains allocate/upload/finalize with same-key retry and digest caching; extend the D1b Java/TS shared fixture to pin the new routes' headers, limits, digests, and error classes.
- Maintenance tools `WorkspaceRecoveryMain` / `WorkspaceCsiWorkerAckMain` construct the same store (README §236). Broker: zero code change.

## 5. S1b — journal compaction

### 5.1 Pack object, manifest, catalog

Pack object (immutable, single object, three segments):

```
[ compressed payload ][ index JSON ][ 8-byte index length ][ magic "QJPK" ]
```

Payload is the concatenation of `record_bytes` for revisions `[from, through]` in order, compressed with JDK Deflater/GZIP. Index JSON holds `{revision, offset, length}` per transaction and no digests: per-transaction `record_digest` stays in the SQL row, which keeps the manifest small. Reads use range GETs: trailer, then index, then the transaction slice.

Manifest: pack-level metadata `{packId, fromRevision, throughRevision, txCount, uncompressedBytes, compressedBytes, packSha256, indexSha256, prevPackId}` stored as `ma_resource` kind `managed-journal-pack-manifest`, `MYSQL_INLINE`, always <= 64 KiB. **S1b therefore does not depend on S1a's OSS_OBJECT path.**

Catalog: new small table (S3 principle):

```sql
CREATE TABLE ma_journal_pack (
    pack_id VARBINARY(144) NOT NULL COMMENT 'Stable pack identity.',
    session_scope_key CHAR(64) NOT NULL COMMENT 'Hashed tenant and Session identity.',
    tenant_id VARBINARY(512) NOT NULL COMMENT 'Tenant identity used for isolation.',
    workspace_id VARBINARY(2048) NOT NULL COMMENT 'Workspace identity within the tenant.',
    session_id VARBINARY(2048) NOT NULL COMMENT 'Managed Session identity.',
    from_revision BIGINT UNSIGNED NOT NULL COMMENT 'First journal revision covered by the pack.',
    through_revision BIGINT UNSIGNED NOT NULL COMMENT 'Last journal revision covered by the pack.',
    manifest_resource_key CHAR(64) NOT NULL COMMENT 'Hashed identity of the pack manifest resource.',
    object_key VARBINARY(8192) NOT NULL COMMENT 'Object-store key of the immutable pack.',
    state VARCHAR(16) NOT NULL COMMENT 'BUILDING, VERIFIED, PUBLISHED, or RETIRED.',
    byte_length BIGINT UNSIGNED NOT NULL COMMENT 'Compressed pack length in bytes.',
    sha256 CHAR(64) NOT NULL COMMENT 'SHA-256 of the complete pack object.',
    gmt_create BIGINT UNSIGNED NOT NULL COMMENT 'Record creation time in Unix epoch milliseconds.',
    gmt_modified BIGINT UNSIGNED NOT NULL COMMENT 'Record update time in Unix epoch milliseconds.',
    CONSTRAINT uk_ma_journal_pack_scope_from UNIQUE (session_scope_key, from_revision),
    CONSTRAINT uk_ma_journal_pack_id UNIQUE (pack_id),
    CONSTRAINT ck_ma_journal_pack_range CHECK (from_revision >= 1 AND through_revision >= from_revision),
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Database-generated identity of this row.',
    CONSTRAINT pk_ma_journal_pack PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT='Immutable journal pack catalog and lifecycle.';
CREATE INDEX ix_ma_journal_pack_through ON ma_journal_pack (session_scope_key, through_revision);
CREATE INDEX ix_ma_journal_pack_state ON ma_journal_pack (state, gmt_modified);
```

### 5.2 V1 schema diff

1. `ma_session_journal_tx.record_bytes`: `MEDIUMBLOB NOT NULL` -> `MEDIUMBLOB NULL`, plus `CHECK (record_bytes IS NULL OR OCTET_LENGTH(record_bytes) = byte_length)`.
2. `ma_session_head`: add `packed_through_revision BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Highest journal revision covered by published live packs.'`.
3. Add `ma_journal_pack` above.
4. `compacted_through_revision` unchanged (retirement tombstone).
5. Manifest reference: `ma_resource_ref` `owner_kind='JOURNAL'`, `owner_key=pack_id`, `owner_revision=1`.

### 5.3 Build, verify, publish

Background job with its own claim/lease. Prefix selection: `from = packed_through_revision + 1`; `through` bounded by E3 limits and `head.journal_revision` minus a safety margin; prefer checkpoint-aligned ends (E6). Committed transaction rows are immutable, so packing a prefix needs no writer lease; watermark advance and deletion take the head row lock (the same fence writers use, #13800).

Steps: insert pack row BUILDING with attempt-owned key -> read SQL bytes, concatenate, compress -> `putIfAbsent` -> full read-back verifying `packSha256`, `indexSha256`, and every transaction digest against its SQL row -> VERIFIED. **Atomic publish in one MySQL transaction**: head lock, verify head state is not DELETED, CAS `packed_through_revision` from `from-1` to `through`, pack -> PUBLISHED, insert manifest resource and reference. A committed head never references an unverified pack.

Crash windows: PUT before publish leaves a BUILDING orphan (GC after fence + safety window); publish before deletion leaves a safe dual-copy period in which the pack is authoritative; deletion interrupted resumes idempotently; a lost or corrupt pack after deletion fails closed (backup-consistency constraint is the operational guard).

### 5.4 Read resolution

New unified `JournalRecordReader`: for `revision <= packed_through_revision` with `compacted_through_revision == 0`, locate the pack by `(session_scope_key, through_revision >= revision)`, load the manifest, `openRange` the slice, verify SHA-256 against the SQL row's `record_digest`, return the original bytes; otherwise read SQL inline. Insert at the full-row stage of `JournalHistoryQueries:46-127` (`storeRows.transactionMapper` / `storeRows::storedTransaction`, `JournalStoreRows:690` `TransactionRow.recordBytes`), `JournalHistoryQueries:129` recentTransactions, `ManagedSideQueryStore:231`, and every scanner listed in §3.2. The candidate paging stage reads only `byte_length`, which stays in SQL, so paging and budget logic are unchanged. Restore = latest checkpoint resource + tail; covered tail revisions resolve through the same reader. Digest-chain verification semantics are unchanged: chain metadata never leaves SQL; packs supply bytes only. OSS object listing is never the authority for order or completeness (durable-store §9).

Wire compatibility: routes return identical `recordBytesBase64`/`recordDigest`; the TS client is unchanged and its existing per-transaction SHA-256 verification doubles as the pack integrity check.

### 5.5 Grace deletion and retirement

Deletion requires PUBLISHED + verified + `now - publish >= grace` (E4) + head-lock recheck, then batched idempotent `UPDATE ma_session_journal_tx SET record_bytes = NULL WHERE ... journal_revision BETWEEN from AND through AND record_bytes IS NOT NULL`. NULL means "resolve from pack"; the published watermark makes authority unambiguous.

Retirement keeps its current physical-delete + tombstone behavior and additionally marks the session's packs RETIRED in the same transaction, writes durable deletion intents, and lets GC delete pack objects and collect manifests. Compaction publish CAS checks head state != DELETED; both flows serialize on the head row lock.

## 6. Shared contract change: openRange

Add to `ToolPublicationObjectStore`:

```java
/** Range read with the same guard-before-each-request contract as open. */
InputStream openRange(String key, long offset, long length, Runnable guard);
```

OSS implementation uses Range GET inside the existing guarded read loop (same `TransientReadException` retry ownership, `AliyunToolPublicationObjectStore:33-52`); fixtures implement slicing over their stored bytes. All implementors listed in §3.3 recompile; this follows the precedent of the `requireUnversioned -> validateConfiguration` rename in the storage-interface change. S1a does not need this method; land it with S1b P2 (or bundle once if both proceed together).

## 7. Appendix A — ride-along schema additions

**A3 session-list preview.** Add `preview VARCHAR(1024)` (bounded, nullable) to `ma_session` with a revision guard analogous to `title_revision` (stale writers cannot overwrite a newer preview). The first slice settles preview at user-input admission (last user input, bounded to 1024 characters, guarded by `preview_revision < sequence`); agent-terminal preview settlement is a follow-up slice of the same program. `last_activity` needs **no new column**: the list query `AgentStoreRows:99` (`SESSION_WITH_STREAM`) already LEFT JOINs `ma_event_stream`; select `es.gmt_modified AS list_last_activity` and extend `StreamCounters`/`SessionRecord` and both mappers (`AgentStoreRows:104-127`). Update `ManagedSchemaProjection.SESSION` column list. List ordering/index changes only if measurement justifies them (module design culture).

**A4 queue revision.** Add `queue_revision BIGINT UNSIGNED NOT NULL DEFAULT 0` to `ma_user_message_queue` (V1:114-127). Maintain it in the same transaction at every content/state mutation in `JdbcManagedUserMessageStore`: submit (`:92-99`), edit/withdraw (`:103-121`), resume (`:131`), claim (`:168`) and startNext (`:235`), reconcile-driven `recovery_blocked` transitions; exclude `attempted()` (`:186-190`, scheduling timestamp only). One private helper bumps `queue_revision = queue_revision + 1`; WebShell polling/ETag becomes a single-row read. Update `ManagedSchemaProjection` queue column list and the queue insert (`:259-261`).

Both are independent small changes in the pre-release V1 window; neither touches the journal or resource paths.

## 8. Schema-validation ripple list

Any V1 edit must update, in the same change: `ManagedSchemaProjection` column enums (`SESSION_HEAD:137`, `SESSION_JOURNAL_TX:147`, `SESSION`, queue enum), `WorkspaceCsiApplicationInventory` column-type maps (`:254` head, `:267` journal, `:882` resource keys) and its verification predicates (`:2874`), `JournalStoreRows` mappers and records (`headMapper:40-66`, `HeadRow:677`, `TransactionRow:690`, `ResourceRow:703`, `restoreHead:119`), and the Java/TS shared fixture where wire-visible. S1a's zero-DDL claim holds because no column list changes; only the namespace CHECK and application enums move.

## 9. Invariants (review gate)

1. SQL remains the only authority: digest chain, head CAS, writer lease/generation fencing unchanged; OSS holds bytes only.
2. `putIfAbsent` never overwrites; a deleted key is never recreated.
3. A committed head never references an unfinalized resource or an unverified pack.
4. Guard before every storage request including retries; signed URLs short-TTL and scope-bound; private responses `Cache-Control: no-store`.
5. Fail-closed on missing/corrupt bodies or packs; no fallback, no partial authority.
6. Idempotent retries: same command/idempotency key returns the original receipt; allocate/finalize same-key retries safe.
7. Hot path at or below per-kind caps has zero OSS dependency; placement-boundary changes require a storage-versioned decision.
8. Private bytes never enter public events or ordinary logs.
9. First release never auto-deletes referenced resources; deletion flows through tombstone/intent + grace + idempotent physical delete.
10. MySQL and OSS backups remain consistent: a database point newer than the available object replica is not a valid recovery point; grace >= replication lag.
11. One authoritative store per deployment; SQL rows store keys, not provider identities; backend replacement is not data migration.
12. `compacted_through_revision` tombstone semantics and every non-zero fail-closed reader behave exactly as today.
13. Packs are contiguous, non-overlapping, and cover `[1, packed_through_revision]`; watermark advances monotonically under the head lock.
14. Server/Broker shared-schema validation stays consistent.

## 10. Verification plan

- **H2 unit**: inline paths byte-unchanged (regression); S1a state machine and S1b pack lifecycle through `InMemoryObjectStore` / `O4FileObjects` fixtures including `openRange`.
- **mysql-integration (real MySQL 8.4, disposable)**: allocate/finalize/commit/read/GC transactionality; concurrent writer + compaction + restore + lifecycle settle (#13800 snapshot window); crash matrix: PUT-before-publish, publish-before-delete, half-delete, pack-lost-after-delete (fail-closed), retirement race.
- **Wire compatibility**: TS fixture asserts `/transactions` and `/restore` bytes and digests are byte-identical with and without packs; TS unchanged passes D1b close/reopen tests.
- **Process-level**: extend the managed-continuation-failover multi-process pattern: settle closure containing >64 KiB OSS resources and checkpoints (S1a, D2 exit condition) and packed history (S1b); kill Java/Harness, delete local homes, replacement owners restore and complete a second Turn.
- **Real OSS qualification (separate gate)**: Range GET, private + never-versioned bucket, forbid-overwrite, SSE, slow-reader and large-object limits; InMemory evidence is not deployment evidence.
- **Metrics**: first-token latency, commit p50/p95/p99, restore latency, MySQL bytes per Turn and reclaimed bytes, compression ratio, pack count/size, OSS requests/bytes per Turn, cache hit rate (durable-store §10 list).

## 11. Phasing and exits

| Phase  | Content                                                                                          | Exit                                                                           |
| ------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| S1a P1 | Java protocol + write/read paths; zero DDL beyond namespace CHECK; opt-in; inline unchanged      | H2 + mysql-integration crash matrix green                                      |
| S1a P2 | TS client + shared fixture + D2 process proof                                                    | Settle closure with OSS resources + checkpoints fails over (D2 exit condition) |
| S1a P3 | Orphan GC + maintenance tools + real OSS qualification + metrics                                 | Production qualification gate                                                  |
| S1b P1 | Pack build/verify/publish + catalog + watermark; no deletion, no reader change (dual copy)       | Concurrent-writer mysql-integration green                                      |
| S1b P2 | JournalRecordReader + openRange contract + all insertion points + maintenance tools + wire proof | Process-level packed-closure failover                                          |
| S1b P3 | Grace deletion + orphan GC + retirement pack cleanup + metrics + qualification                   | Production gate + measured reclaimed bytes                                     |
| A3/A4  | Independent small schema changes                                                                 | Focused store tests + list/queue fixture updates                               |

Dependencies: S1a and S1b are parallelizable; both share the store bean; `openRange` lands with S1b P2. Precondition for S1b: baseline measurement of MySQL bytes per Turn and table size (measurement-first, durable-store §10).

## 12. Deployment gates

- Operator confirms actual backup replication lag < configured grace before S1b deletion is enabled (E4; no SLA defined today).
- Bucket: private, never-versioned, SSE enabled, forbid-overwrite honored; `validateConfiguration()` at startup.
- Separate database role for private journal/resource tables versus public readers (durable-store §11).
- Backup/restore exercise covering MySQL and OSS consistently before advertising cross-Pod recovery (D3).

## 13. Evidence index

Gates/limits: `JournalCommit.java:762-772`, `ManagedSessionStoreModels.java:17-28,53-54`. Writes: `JournalCommit.java:338,451`, `JournalResourceWrites.java:82-84,174-176,291-294`. External-reference template: `ToolPublicationAdmissionStore.java:492-521`. Read gate: `JournalStoreRows.java:477`; mappers/records `:40-66,119,677,690,703`. Routes: `ManagedSessionStoreController.java:199,214,234,246,258,294`; `JdbcManagedSessionStore.java:250,256-259`; `JournalHistoryQueries.java:36-44,46-127,129`; `ManagedSideQueryStore.java:231`. Tombstone: `ManagedSessionRetirementStore.java:117-135`; readers `JdbcWakeRecoveryStore.java:112-114,133-139`, `JdbcWorkspaceLifecycleStore.java:120-131,169,482`, `WorkspaceCsiCheckpointSnapshotStore.java:148`, `AgentExecutionOperations.java:225-245,805`, `ManagedRuntimeRetentionGuard.java:72`, `JdbcChildResultRelayStore.java:505,513`, `WorkspaceCsiApplicationInventory.java:2874`. Other readers: `SideQueryConversation.java:82`, `WorkspaceCsiApplicationInventory.java:1257,2598,2880-2882`, `WorkspaceRecoveryReader.java:88-123`, `ManagedNativeJournalSnapshots.java:515-560`. GC: `ManagedProjectionResourceCollector.java:67,118`. Store: `ToolPublicationObjectStore.java`, `AliyunToolPublicationObjectStore.java:25,33-52,72-84,86-90`, `AliyunToolPublicationStorageAutoConfiguration.java`, implementors per §3.3. Config: `ManagedAgentProperties.java:738-763`. Schema: V1 `ma_session:8-95`, `ma_user_message_queue:114-127`, `ma_session_head:185-233`, `ma_session_journal_tx:235-274`, `ma_resource:438-478`, `ma_resource_ref:484-508`, `ma_request_receipt:619-666`. Projection/validation: `ManagedSchemaProjection.java:137,147`, `WorkspaceCsiApplicationInventory.java:254,267,882`. List/queue: `AgentStoreRows.java:99,104-127`, `JdbcManagedUserMessageStore.java:92-99,103-121,131,168,186-190,235,259-261`. TS: `http-managed-session-store.ts:363-369,1321-1326,1399,3237`, `managed-session-authority.ts:658`. Designs: `2026-09-21-managed-session-durable-store.md` §7-§12, `2026-09-25-managed-session-typescript-foundation.md:15`, `2026-10-16-managed-tool-storage-interface.md`, `2026-09-20-managed-agent-storage-event-architecture.md:303`; README §232/§236/§655-657.
