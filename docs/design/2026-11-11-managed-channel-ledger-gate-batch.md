# Managed Channel ledger reconcile gate and batched segment plan

[English](2026-11-11-managed-channel-ledger-gate-batch.md) | [简体中文](2026-11-11-managed-channel-ledger-gate-batch.zh-CN.md)

Status: proposed. These are the robustness/performance follow-ups (items A and
B) of [#16818](https://github.com/QwenLM/qwen-code/issues/16818), deferred while
landing the [multi-segment delivery ledger](2026-11-10-managed-channel-multi-segment-ledger.md)
(#16797) and its [public segments projection](2026-11-10-managed-channel-segments-projection.md)
(#16807). They refine the reconcile read path and the segment ledger's
statement count without changing the journal record contract, the delivery
state line, or the public read shape.

## Problem

Two costs the groundwork left behind:

- **A — the reconciler re-reads completed deliveries.** `reconcileClaim` reads
  and parses the whole delivery record (a LONGTEXT resource body) and re-plans
  its segments for every expired claim, including claims it cannot advance. A
  lagging `partial` (or `sending`) line whose claim lease lapsed is returned on
  every 30s sweep — including the crash-window line whose ledger already holds
  the whole receipted plan but whose final step to `delivered` failed — paying
  a LONGTEXT read + JSON parse + per-segment statements for zero useful work
  (#16797 R3-1).
- **B — the segment plan is statement-per-segment.** `plan` writes one
  `INSERT IGNORE` per segment plus one backfill `UPDATE` per already-receipted
  segment, and `claimOne` re-plans on every claim poll of a `partial` delivery.
  At the 64-segment contract bound a re-claimed partial pays ~127 statements
  (#16797 R3-2). The delivery-list read is likewise an N+1: one segment query
  per delivery row.

## Decision

### A. Gate the record read on a provably complete, fully-receipted ledger

Before reading the record body, `reconcileClaim` checks whether the segment
ledger already holds the **entire immutable plan** with every segment receipted.
The plan's size is persisted with the delivery (`ma_delivery.segment_count`, set
when the delivery row is created), so the gate can prove completeness from the
ledger alone: it skips the LONGTEXT read only when the ledger holds exactly
`segment_count` rows and every one carries a non-null receipt. The completeness
proof is load-bearing: the plan write is not transactional (the batched `INSERT
IGNORE` commits per statement) and every row it commits is seeded with the
record's receipt, so an interrupted write can leave a receipted _prefix_ — under
a record of any state, including `delivered`. The rows the ledger happens to hold
are not proof the plan is whole; a short ledger must fall through to the
record-read block, whose `planSegments` re-creates the missing tail instead of
closing the line on a truncated chain. When the ledger is provably complete and
fully receipted, the gate closes a lagging line from the ledger's own receipts
(`stepLedger` to `delivered` with the last segment's receipt) and skips the read +
parse + re-plan entirely. The read is kept for:

- a ledger shorter than the persisted plan count (a truncated plan still needs
  its missing rows re-planned, whatever the record's state);
- a missing ledger row or missing segment rows (a pre-ledger claim still needs
  the record to backfill the plan);
- any null receipt (a lost-answer receipt still needs converging).

A terminal refusal keeps the read even when the ledger is complete and fully
receipted: the gate looks up the record's `delivery_state` (a point query, not
its LONGTEXT body) and falls through when it is `rejected` or `cancelled`, so
the ledger mirrors the record instead of overriding a committed refusal from
the receipts. This is the one added point lookup on the skip path.

The case this matters for is the crash window where the final segment receipt
landed but the ledger's `stepLedger` to `delivered` failed: the ledger holds the
whole plan with every segment receipted but lags at `partial`, and the sweep
keeps selecting that `partial` line. Converging from the ledger closes the line
**without** the record read; gating on the receipts alone and merely skipping the
read would strand it at `partial`. Convergence stays ahead of the settle path:
the gate runs before the existing record-read block, and the settle path that
follows is unchanged. The delivery row is loaded once and threaded through the
gate and the record-read block; whenever a step occurs its returned row is
adopted, so the gate adds no extra delivery-row SELECT on the common sweep path.

### B. Batch the plan inserts and the list read

`plan` validates the whole plan, then issues one `jdbc.batchUpdate`
`INSERT IGNORE` for all segments (the pattern `AgentEventJournal` uses), and
drives the write-once backfill from the per-row counts: a row the insert just
created (count 1) already carries its receipt, so only a pre-existing row
(count 0, insert ignored) needs the guarded `UPDATE`. A driver that reports no
per-row count (`SUCCESS_NO_INFO`, -2) falls back to the guarded update, which is
a no-op on a row already receipted. The backfill is batched like the insert —
one guarded `UPDATE` batch for the rows that need it. Both batches collapse the
plan to a single `PreparedStatement` and `executeBatch` per statement kind,
removing the per-segment Java statement construction. Wire-level round-trip
reduction additionally requires Connector/J `rewriteBatchedStatements`, which
this module does not enable, so the server still executes one statement per
segment; enabling that flag is a separate config decision (see open questions).
The `provider_receipt_json IS NULL` guard is unchanged, so a replay or a racing
second receipt never overwrites a stored receipt.

The delivery-list N+1 is batched too: a new
`ChannelSegmentRepository.listByDelivery` reads the whole page's segments in one
`WHERE delivery_key IN (...)` query, grouped by deliveryId (each ordered by
ordinal, every requested id keeping an entry — empty when it holds no segments).
It maps rows through the same `RowMapper` that `list` uses, so the two read paths
cannot publish different `segments` for one delivery. `listDeliveries` reads the
page once instead of a segment query per row. `getDelivery` keeps the
single-delivery `list` read.

## Files affected

- `control-plane/.../channel/ManagedChannelService.java` — the reconcile gate
  (`convergeFullyReceiptedFromLedger`, gated on the persisted plan count) and the
  batched `listDeliveries` read; the claim/resend paths persist the plan size.
- `persistence/.../db/managed-schema/V1__managed_schema.sql` — the
  `ma_delivery.segment_count` column holding the immutable plan size.
- `contracts/.../persistence/ChannelDeliveryRepository.java` — the
  `segmentCount` field on `ChannelDelivery`.
- `persistence/.../JdbcChannelDeliveryRepository.java` — reads and writes
  `segment_count` with the delivery row.
- `persistence/.../JdbcChannelSegmentRepository.java` — the batched `plan` and
  the new `listByDelivery`.
- `contracts/.../persistence/ChannelSegmentRepository.java` — the
  `listByDelivery` boundary method.
- `verification/.../channel/ManagedChannelServiceTest.java` — the gate's
  skip witness (a spied instance store verifies the record read never runs for a
  fully-receipted ledger, while the lagging crash-window line still converges to
  delivered) and the keep-read case when a segment lacks a receipt; the
  `FailingSegments` wrapper implements the new boundary method.
- `verification/.../persistence/JdbcChannelSegmentRepositoryTest.java` — the
  64-segment batch, the mixed insert/backfill batch, and the grouped list read;
  the MySQL gate reruns them on a real database.
- This design doc and its Chinese version.

## Scope boundaries

- No change to the journal record contract, the Harness funnel, the trusted
  adapter surface, the segment ledger schema, the delivery state line, or the
  public read shape (`segments` array unchanged).
- No contract version bump: the public API document is untouched.
- The gate preserves the convergence outcome for non-refused records: a
  fully-receipted line ends `delivered` whether converged from the record or
  from the ledger's own receipts; it only removes the redundant read.
- A terminal refusal (`rejected` or `cancelled`) stays the record's decision:
  the gate keeps the record read for it, and the ledger mirrors that state
  instead of being closed `delivered` from the receipts.

## Verification plan

- The gate's skip is pinned by a Mockito spy on a plain instance store: a
  fully-receipted ledger whose line is forced back to `partial` and whose
  delivery receipt is cleared (the crash window) converges to `delivered` with
  the last segment's receipt while `readResource` is verified never called;
  removing the gate reds it (the read would run), and forwarding a null receipt
  reds the receipt assertion (the fixture clears the column so the gate's write
  is load-bearing, not a preset value surviving `COALESCE`). A companion case
  with a null receipt verifies the read is kept. Two truncated-prefix cases (three
  segments planned, the tail ledger row deleted so only a receipted prefix
  remains — one with the record still `partial`, one with the record already
  `delivered`) verify the read is kept and `planSegments` re-creates the missing
  row, closing on the plan's last receipt rather than the prefix's; removing the
  gate's plan-count completeness check reds both.
- The terminal-refusal path is pinned by forcing the record's `delivery_state`
  to `rejected` while the ledger holds the complete receipted plan and lags at
  `partial`: the record read runs, the ledger ends `rejected`, and the segment
  receipts remain. Removing the record-state check would close it `delivered`
  without the read and red the case.
- The batched plan is pinned by the existing backfill/idempotence cases plus a
  64-segment batch and a mixed batch whose pre-existing null-receipt row sits at
  a batch position different from its ordinal, so skipping count-0 rows or
  indexing the counts by ordinal both red. A stubbed insert batch returning
  `SUCCESS_NO_INFO` pins the no-per-row-count fallback. The backfill is batched,
  so a re-claim issues one guarded `UPDATE` batch rather than a statement per
  receipted segment. The resend path's persisted plan count is pinned by
  asserting the resent row's `segmentCount` equals the carried plan size (three
  for a full resend, two after a partial receipt); writing zero reds both. The
  MySQL gate reruns these on a real database.
- The grouped list read is pinned by a multi-delivery page (one delivery empty)
  asserting per-delivery grouping and ordinal order over a twelve-segment plan
  inserted in reverse ordinal order (the id and segment-id index orders both
  differ from ordinal order), and maps through the same `RowMapper` as `list`.
- Checkstyle passes on the changed modules; the real-MySQL concurrency leg and
  full CI suites remain the verification baseline.

## Open questions

1. The common null-receipt `partial` still pays a delivery-row lookup plus a
   segment query to decide the gate does not apply, and a complete ledger adds
   the record-state point lookup; if that sweep path grows, a cheaper pre-check
   (e.g. a receipt count on the delivery row) could short-circuit the segment
   query.
2. Whether to enable Connector/J `rewriteBatchedStatements` (via the module's
   centralised driver properties, behind the existing operator-override gate)
   so the batched plan also cuts wire round trips, not just Java-side statement
   construction. That is a module-wide driver behavior change and needs a
   real-MySQL before/after measurement, so it is deliberately out of this slice.
