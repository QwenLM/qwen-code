# Managed Channel multi-segment delivery ledger

[English](2026-11-10-managed-channel-multi-segment-ledger.md) | [简体中文](2026-11-10-managed-channel-multi-segment-ledger.zh-CN.md)

Status: proposed. This is the storage groundwork slice for the H5 channel
domains ([H5 design](2026-10-04-managed-channels.md),
[runtime design](2026-10-07-managed-channel-runtime.md)) under the Managed
Agent proposal [#12380](https://github.com/QwenLM/qwen-code/issues/12380). It
makes the control plane's delivery ledger segment-faithful so a later
adapter (H5d) or card interface (H5e) can land on it. It does not change the
journal record contract, the Harness funnel, the trusted wire surface, or
the public API shape.

## Problem

Every layer above the Java control-plane ledger already supports a delivery
of 1–64 segments:

- The H5a record contract (`managed-channel-record.ts`, mirrored by
  `ManagedChannelRecords`) carries a stable `segmentId`/`ordinal` plan with a
  write-once receipt per segment.
- The Harness funnel (`hosted-channel-session.ts`) answers a claim with
  **the leading unreceipted segments that fit the claim text budget**
  (`maxClaimTextBytes`), accepts a receipt **per ordinal**
  (`partial` while segments remain, `delivered` with the last), re-claims the
  remainder after each receipt, and a resend carries only the segments proven
  unsent.
- The trusted adapter surface (`ChannelAdapterModels`) already exposes
  `ClaimedDelivery.segments[]` and `ReceiptRequest.ordinal`.
- The email adapter (`managed-email-adapter.ts`) already loops over every
  claimed segment, sends each, and receipts each by ordinal.

The single-segment bottleneck is the control-plane ledger. `ma_delivery`
(delivery kind `CHANNEL`) keeps **one row per `deliveryId`** with a single
`segment_id`, `segment_ordinal`, and `provider_receipt_json`. For a delivery
of more than one segment this misrepresents the truth:

- `ManagedChannelService.claimOne` pins the ledger row to the **first unsent
  segment** only.
- `receipt` overwrites `provider_receipt_json` with the latest receipt while
  the row's segment identity stays stale: earlier receipts are lost and the
  latest receipt is attributed to the wrong segment.
- `resend` names only `segments.getFirst()` of the new chain.
- `reconcileClaim` / `committedProviderReceipt` picks the **last** receipt
  across all segments.

A correction to the earlier roadmap wording: the **delivery-level** state
line (`planned → sending → partial → delivered`, plus `unknown` / `rejected`
/ `cancelled`) already follows the committed record correctly through
`stepLedger`; `partial` already works at the delivery level. The gap is
**per-segment identity and receipt fidelity**, not the delivery state line.

## Why not one row per segment in `ma_delivery`

`ma_delivery` is shared by the `CHANNEL`, `SESSION_MESSAGE`, and
`CHILD_RESULT` delivery kinds. Its uniqueness
(`uk_ma_delivery_identity (delivery_kind, source_scope_key, delivery_id)`)
and its claim machinery — the `claim_generation`, `claimed_at`, and
`reconcile_operation_id` columns, the pending-delivery discovery query, and
public pagination — are all **delivery-level**. The
delivery state line includes `partial`, which is a property of the delivery,
not of a segment. Splitting `ma_delivery` into per-segment rows would
duplicate or strand that machinery and break the shared table. The
delivery-level row therefore stays the state-and-claim anchor.

## Decision

Add a child segment ledger: one row per `(delivery_key, segment_id)` in a
new `ma_channel_segment` table, holding the segment's ordinal and its
write-once provider receipt. The delivery row is unchanged — its state line,
claim fencing, and singular representative fields keep serving the existing
public read model. The segment table is the durable per-segment detail that
recovery converges and a later public projection reads.

A receipt is written once per segment and never rewritten, so the write is a
single idempotent `UPDATE ... WHERE provider_receipt_json IS NULL`: no
read-modify-write merge, no lost-update race between two concurrent receipts,
and a replayed receipt is a no-op. This is why a child table is preferred over
packing the segment plan into the delivery row's `payload_json` (which would
require an atomic JSON merge inside the fenced state transition and a
recompute-on-replay path).

### Schema (V1 baseline, edited in place)

Per the module's pre-release schema policy, the table is added to
`V1__managed_schema.sql`; no V2+ migration is introduced.

| Column                        | Type              | Meaning                                            |
| ----------------------------- | ----------------- | -------------------------------------------------- |
| `delivery_key`                | `CHAR(64)`        | The parent `ma_delivery.delivery_key` (CHANNEL).   |
| `tenant_id`                   | `VARBINARY(512)`  | Tenant isolation, matching the parent row.         |
| `channel_id`                  | `VARBINARY(512)`  | Channel instance identity within the tenant.       |
| `segment_id`                  | `VARBINARY(512)`  | Stable segment identity from the record plan.      |
| `segment_ordinal`             | `BIGINT UNSIGNED` | Position within the delivery, contiguous from 0.   |
| `provider_receipt_json`       | `LONGTEXT`        | Write-once provider receipt; null until receipted. |
| `gmt_create` / `gmt_modified` | `BIGINT UNSIGNED` | Database-clock epoch milliseconds.                 |

Uniqueness `uk_ma_channel_segment_identity (delivery_key, segment_id)`; an
index `(delivery_key, segment_ordinal)` serves ordered reads. The table is
registered in `ManagedSchemaContract.TABLES` and the
`WorkspaceCsiApplicationInventory` catalogue, following `ma_delivery` into the
whole-tenant sweep bucket (`new Query("1 = 1", ...)`).

### Repository

A new `ChannelSegmentRepository` (contracts) with a
`JdbcChannelSegmentRepository` (persistence), beside the existing channel
repositories:

- `plan(tenantId, channelId, deliveryId, segments)` — idempotently inserts the
  segment plan (`INSERT IGNORE`) and backfills a receipt an existing row is
  still missing, carrying any receipt the record already holds (a resumed
  `partial`). A stored receipt is never overwritten.
- `receipt(tenantId, channelId, deliveryId, ordinal, providerReceipt)` — the
  write-once `UPDATE`; returns whether it wrote. A replayed or conflicting
  receipt leaves the stored one intact.
- `list(tenantId, channelId, deliveryId)` — the segments ordered by ordinal.

`delivery_key` is derived exactly as `JdbcChannelDeliveryRepository.deliveryKey`
derives it, so a segment row is reachable only through its tenant, channel,
and delivery identity.

### Service wiring (`ManagedChannelService`)

- `claimOne` plans **all** of the record's segments (with their current
  receipts), not just the first unsent one. The delivery-level
  `findOrCreate` is keyed on the record's **first** segment, stable across a
  resumed partial: naming the first unsent segment would make it reject the
  row the first claim wrote once a segment is receipted.
- `receipt` records the per-ordinal receipt into the segment ledger after the
  Harness commits and **before** `stepLedger` can move the delivery to a
  terminal state. The reconciler skips terminal deliveries, so the receipt
  must be durable before the delivery line closes; a failed receipt write
  leaves the delivery open and recoverable.
- `resend` plans the new chain's carried (unsent) segments.
- `reconcileClaim` converges **each** segment receipt from the committed
  record into the segment ledger, instead of only the last receipt. The
  delivery-level representative receipt is unchanged.

### Read models

Unchanged this slice. `PublicChannelDelivery` and the trusted `DeliveryView`
keep their singular fields (the first segment's identity and the delivery's
representative receipt). Exposing the per-segment detail as a public
`segments` array is the immediate follow-up (the API slice), which owns the
OpenAPI change, the contract version, and the WebShell type regeneration.

## Files affected

- `persistence/.../db/managed-schema/V1__managed_schema.sql` — the new table.
- `contracts/.../persistence/ChannelSegmentRepository.java` — new interface.
- `persistence/.../JdbcChannelSegmentRepository.java` — new implementation.
- `persistence/.../WorkspaceCsiApplicationInventory.java` — catalogue + sweep
  bucket registration.
- `contracts/.../runtimebroker/schema/ManagedSchemaContract.java` and
  `verification/.../managedschema/ManagedSchemaTest.java` — the table, its
  business key (`delivery_key, segment_id`), and the original-entity
  exclusion.
- `verification/.../persistence/WorkspaceCsiApplicationInventoryTest.java` —
  the declared-column count ratchet grows by the new table's eight columns.
- `server/.../config/ManagedAgentConfiguration.java` — the repository bean.
- `control-plane/.../channel/ManagedChannelService.java` — claim / receipt /
  resend / reconcile wiring.
- `verification/.../channel/ManagedChannelServiceTest.java` — multi-segment
  service cases against the recording Harness.
- `verification/.../persistence/JdbcChannelSegmentRepositoryTest.java` (H2)
  and `JdbcChannelSegmentRepositoryMySqlIT.java` — segment plan / write-once
  receipt / listing / isolation contract, plus a concurrent-receipt MySQL
  case.
- This design doc and its Chinese version.

## Scope boundaries

- No change to the journal record contract, the Harness funnel, the trusted
  wire surface, the email adapter, or the public API shape.
- No second adapter; the multi-segment producer was out of scope for this
  ledger slice and has since landed (multi-segment producer design,
  2026-11-12), so the email plan now splits long replies into ordered
  segments. Multi-segment behavior is exercised through the recording Harness
  and the repository contract, not a live provider.
- No public `segments` projection, no OpenAPI / WebShell change.

## Verification plan

- H2 service cases: a multi-segment delivery claimed, receipted per ordinal
  (`partial` between segments, `delivered` with the last), each segment's
  receipt durable and correctly attributed; a resend plans only the unsent
  segments; the reconciler converges every segment receipt after a lost
  answer. Each rule disabled in turn fails a test (mutation witness).
- Repository contract (H2, rerun on MySQL): plan idempotency, write-once
  receipt (a second receipt for the same segment does not overwrite), ordered
  listing, tenant/channel isolation.
- The existing single-segment suites stay green unchanged at this slice; the
  later multi-segment producer slice (2026-11-12) retargets the long-reply
  pins to ordered segments.
- Real MySQL evidence for the new table's write-once and concurrency behavior
  through a repository-level MySQL IT that extends the H2 repository test
  (the `ManagedSideQueryStoreMySqlIT` pattern), including two concurrent
  receipts for one segment leaving exactly one durable receipt; the full
  Hosted/fault profiles remain CI's. No new `Hosted*IT` class is added, so the
  shared failsafe fork budget is not remeasured.

## Open questions

1. The public `segments` projection (shape, contract version, WebShell
   regeneration) is the next slice; this one only makes the ledger faithful.
2. Retention of segment rows follows the delivery row's retention, which is
   itself deferred with Session archive/delete (H5 runtime open question 2).
