# Managed identity Tier B convergence

[English](2026-11-22-managed-identity-tier-b-convergence.md) | [简体中文](2026-11-22-managed-identity-tier-b-convergence.zh-CN.md)

- Status: **approved, implementing**. Maintainer approved the converged budgets
  (2026-11-22) and the "write design doc + implement in batches" path. Builds on
  the [Tier A dehash](2026-11-20-managed-identity-varchar-dehash.md) and the
  uniform trailing-space-rejection policy.
- Date: 2026-11-22.

## Problem

Tier A converted the simple, server-minted identities to bounded `VARCHAR`. The
remaining Tier B columns still use `VARBINARY` with a lazy 512-byte (or 2048-byte)
contract cap. That cap is an upper bound, not the real value domain: tracing the
actual external producers shows most values are far shorter. Keeping 512 everywhere
inflates indexes and forced several columns to stay binary or require index
redesign. Converging each budget from its real producer eliminates those blockers.

## Current state

- Table default `utf8mb4` / `utf8mb4_bin` (PAD SPACE). Uniform policy: every identity
  admission rejects trailing spaces, so PAD SPACE folding cannot occur for a legal
  identity. Case sensitivity is preserved by `utf8mb4_bin`.
- Index byte rule: utf8mb4 `VARCHAR(N)`/`CHAR(N)` = 4N bytes; `VARBINARY(N)` = N;
  `BIGINT` = 8; `TINYINT` = 1. InnoDB key limit **3072**. Prefix lengths are bytes
  for `VARBINARY`, characters for `VARCHAR`.
- H2 2.3.232 `VARCHAR(n)` counts UTF-16 units; MySQL counts code points. Every budget
  below keeps N ≥ the existing UTF-16-unit admission cap so both engines fit.
- Canonical references (`owner_ref`, `scope_ref`, `operation_ref`, `command_ref`,
  `request_id`, `physical_id`, `deletion_operation_ref`, …) are exact ASCII
  percent-encoded `ManagedIdentityRef` tuples with fail-closed byte budgets. They
  stay `VARBINARY`; 4× expansion buys nothing and breaks budgets.

## Goals

- Converge Tier B identity columns to budgets derived from real producers.
- Eliminate the index-width blockers that forced binary retention / index redesign.
- Keep admission fail-closed (bounded, well-formed, no trailing spaces).

## Non-goals

- Converting canonical `*_ref` coordination keys, digests, ciphertext, object keys.
- Tightening the opaque model `callId` below its converged bound or bounding
  third-party platform ids beyond their spec-based bound.
- Dehashing main's new `ma_runtime_stage` hash-key design (kept verbatim from
  #17953; a separate follow-up).

## Converged budgets

| Class | Columns | Budget |
|---|---|---|
| Our-code minted | `item_id`, `content_part_id`, `transaction_id`, `command_id`, `activation_id`, `writer_id`, `ma_session_head.operation_id`, `source_scope_id`, `parent_child_run_id`, ma_channel_segment `delivery_id`/`segment_id`, PR `binding_id`, `idempotency_key` (most namespaces) | `VARCHAR(128)` |
| Composite resource mints | `resource_id` (ma_resource **and** ma_resource_ref) | `VARCHAR(256)` |
| childRunId union | `record_id`, `child_run_id`, `execution_call_id`, `delivery_id` (CHILD_RESULT) | `VARCHAR(256)` |
| Delivery segment | ma_delivery `segment_id` (= `delivery_id` + ":" + ordinal 0..63, ≤256+1+2) | `VARCHAR(320)` |
| Short bounded | `isolation_key` | `VARCHAR(64)` |
| Composite contract-safe | `provision_request_id` / `loss_evidence_id` | `VARCHAR(160)` / `VARCHAR(192)` |
| GitHub spec-based | PR `owner` / `repo` | `VARCHAR(64)` / `VARCHAR(128)` |
| Platform spec-based | `account_id`, `sender_id`, `chat_id`, `thread_id` | `VARCHAR(256)` |
| Maintainer-chosen 128 | `model_id`, `tool_call_id`, `runtime_instance_id`, `runtime_lease_id` | `VARCHAR(128)` |
| Keep binary | all canonical `*_ref`, digests, ciphertext, object keys | `VARBINARY` |

### childRunId union rationale

`childRunId = hostedPromptKey(≤64) + ":" + callId`. With `tool_call_id` admission
bounded to 128, `childRunId ≤ 64 + 1 + 128 = 193`, so `VARCHAR(256)` covers it with
headroom. Reconcile the existing gate inconsistency: the child-result relay gated
`childRunId ≤ 128` (`requireOperationId`) while the child-operation route allowed 320.
The converged identity gate is `requireChildRunId ≤ 256` and the TS child-operation
route converges 320→256. The relay ledger additionally mirrors `childRunId` into
`ma_operation.operation_id` (`VARCHAR(128)`) under `INSERT IGNORE`, so its row write
keeps the tighter `requireOperationId ≤ 128` bound rather than letting MySQL silently
truncate a longer id; real provider call ids keep `childRunId ≤ 127`, so this never
binds in practice. Widening that ledger column (or deriving a bounded ledger id) to
admit the full 256 end-to-end is a separate follow-up.

## Producer evidence and admission tightening

- `item_id`/`content_part_id`: `EventIdentity` mints `item_<turnId>_assistant` (≤52),
  `item_tool_<UUID>` (46, callId digested), `part_<turnId>_<type>_<seq` (≤74). Add an
  explicit ≤128 no-trailing-space check for harness-supplied `data.itemId`/
  `contentPartId` at event ingestion (currently unvalidated).
- `resource_id`: UUID(36) / sha256hex(64) / snapshot-page(101), but composite mints
  exceed 128: message-body `message:`+64hex+`:rev:`+64hex (139+, `AgentMessageProjection`)
  and workspace-proof `workspace-proof:`+ownerKey+`:`+64hex (~170,
  `WorkspaceEvidenceResources`). Converge to **256**, not 128. Tighten
  `JournalStoreRows.validateStableId` (shared, also covers
  transaction/command/writer/activation/head.operation_id).
- `record_id`/`child_run_id`/`delivery_id`: domain ids via `ManagedExtensionRecords.id`
  (≤512 bytes NFC); add the trailing-space ban there (shared, covers delivery records).
- `model_id`: catalog text; realistic ids ≤30 (registry max `qwen3-coder-480b-a35b-instruct`),
  custom names ≤~80. Converge to 128 **characters** (switch the byte-based check to a
  character bound). Move together: `ManagedSessionModelConfigs.catalog()`,
  `ApiModels @Size`, the easily-missed child-snapshot check
  (`AgentSessionAdmissions` ~:383, bypasses catalog membership), `SessionModelConfig`,
  and bilingual configuration-reference docs.
- `tool_call_id`: raw model function-call id; known providers ≤~45, worst derivable
  shape ~90. Converge to 128 with `requireToolCallId` (Java `ToolExecutionRecord`),
  TS `managed-tool-protocol` `boundedId(...,512)→128`, and a dedicated callId bound in
  the tool-result manifest parse (do not move the shared `maxIdBytes`). Cross-language
  fixture contract pinned by `managed-tool-result-v1.fixtures.json`.
- `runtime_instance_id`/`runtime_lease_id`: dynamic = bindingId(≤128)/UUID(36) proven
  via seed + recovery equality; static operator slugs ≤~64. Converge to 128 via
  `RuntimeLease` validator; static config >128 fails fast at startup. Sync docs 512→128.
- `isolation_key` = harnessSessionId (UUID36); converge to 64 via `RuntimeProvisionRequest`.
- PR `owner`/`repo`: GitHub login ≤39 / repo ≤100 (spec external, flagged); align
  `@Size` to 64/128. `binding_id` = `prb-`+sha256(68), not indexed.
- Platform `account/sender/chat/thread`: spec-based 256 (covers RFC-5321 email 254);
  tighten channel API `@Size`/TS 512→256. Platform specs are not in the repo — flagged.

## Index arithmetic (converged; canonical refs kept VARBINARY)

| Index | Converged bytes | Was | Result |
|---|---:|---:|---|
| `uk_ma_resource_ref_business_key` (resource_id@256) | 2072 | 3096 | resolved; ma_resource_ref.resource_id converts |
| `idx_ma_message_execution` (item_id@128) | 1792 | 4096 | resolved |
| `uk_ma_channel_segment_identity` (@128) | 1680 | 4752 | resolved |
| `uk_ma_pr_watch_binding_business_key` (owner@64/repo@128) | 1432 | 4760 | resolved |
| `idx_runtime_binding_scope` (isolation@64) | 2432 | 4224 | resolved |
| `idx_ma_resource_delete_intent` (resource_id@256) | 2576 | 3600 | resolved |
| `uk_ma_delivery_identity` (delivery@256/scope@128) | ≤2064 | 4368 | fits |

All seven problem indexes fit ≤3072 with converged budgets.

## P0 — independent MySQL bug fix

Drop `idx_ma_record_identity` entirely. Its `record_id /*!50000 (1024) */` prefix is a
1024-byte prefix on a 512-byte column → MySQL error 1089 (H2 ignores the version-gated
comment, so H2 suites pass). Without the prefix it duplicates
`uk_ma_session_record_business_key`. VARCHAR conversion does not fix it (VARCHAR
prefixes count characters). This is required regardless of convergence.

## Dead columns

Main's dead-object removal already dropped `ma_delivery.provider_id`,
`ma_session_record.prompt_id`/`turn_id`, `ma_message.tool_call_key`,
`public_session_id`, `manifest_sha256`, `decision_scope`, `payload_version`,
`source_record_key`. No further dead-column removal is needed for Tier B; do not
re-add these.

## Cross-cutting migration mechanics (every batch)

1. Hex literals `X'6C6174657374'` ('latest') → `'latest'` text.
2. `ManagedSchemaKeys.identity(value)` byte bindings → plain `String` for VARCHAR columns.
3. Rewrite CAST exactness guards only where type alignment makes them redundant;
   keep permissive-collation guards (validated by tests).
4. Keep N ≥ the UTF-16-unit admission cap (H2 vs MySQL length semantics).
5. Real-MySQL DDL initialization check in CI (H2 misses prefix/length errors).

## Constraints

- PAD SPACE + uniform trailing-space rejection at admission is load-bearing; never
  reintroduce trailing-space acceptance in any identity helper.
- Canonical refs stay VARBINARY (exact ASCII budgets).
- No local MySQL; MySQL DDL/race/perf gates run in CI.

## Risks

- Contract narrowing rejects values above the converged bound (fail-closed). For
  our-code mints there is no real outlier; for model `callId` and platform ids the
  bound is a deliberate contract change.
- Third-party platform/GitHub specs are not in the repo; 256/64/128 are spec-based
  with flagged uncertainty.
- `model_id` char-vs-byte bound must be decided explicitly (chosen: characters).
- Cross-language tool-result manifest callId fixture contract must stay pinned.

## Validation plan

- Per batch: focused H2 suites + dual Checkstyle (`checkstyle:check` +
  `checkstyle:check@runtime-broker-checkstyle`).
- `ManagedSchemaTest`/`ManagedSchemaCatalogTest`/`ManagedSchemaProjectionTest` enforce
  catalog/projection alignment after each DDL change.
- Real-MySQL DDL initialization + index-budget gate (`ManagedSchemaIdentityColumnsMySqlIT`)
  in CI; race/perf ITs in CI.

## Acceptance criteria

- All converged columns are `VARCHAR` at the budgets above; admission rejects
  over-bound / trailing-space / malformed values.
- All affected indexes ≤3072 bytes; `idx_ma_record_identity` dropped.
- Canonical refs / digests / ciphertext / object keys unchanged.
- Focused H2 + dual Checkstyle green per batch; MySQL gates green in CI.

## Batching plan

1. P0: drop `idx_ma_record_identity`.
2. Our-code 128 batch (item/content_part/resource/tx/command/activation/writer/
   head.operation_id/source_scope/parent_child_run/channel-segment/PR binding_id/
   idempotency_key) + shared `validateStableId`/`ManagedExtensionRecords.id` bans.
3. childRunId union 256 + gate reconciliation; isolation_key 64; provision 160 / loss 192.
4. model_id 128 (char bound, all admission points + docs); tool_call_id 128 (Java+TS+
   manifest); runtime_instance/lease 128 (+ static config docs).
5. PR owner 64 / repo 128; platform account/sender/chat/thread 256.

## Open questions

- Third-party platform id specs (DingTalk/WeCom/GitHub/email) confirmed only by
  external knowledge; revisit if a platform emits longer ids.
- `ma_runtime_stage` (main #17953) keeps a hash-key design and `observation_owner`
  stays VARBINARY(2048); dehashing these is a separate follow-up.
