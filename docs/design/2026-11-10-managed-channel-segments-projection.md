# Managed Channel public segments projection

[English](2026-11-10-managed-channel-segments-projection.md) | [简体中文](2026-11-10-managed-channel-segments-projection.zh-CN.md)

Status: proposed. This is the API slice that follows the
[multi-segment delivery ledger](2026-11-10-managed-channel-multi-segment-ledger.md)
under the H5 channel domains of [#12827](https://github.com/QwenLM/qwen-code/issues/12827)
(Managed Agent proposal [#12380](https://github.com/QwenLM/qwen-code/issues/12380)).
It builds on the landed ledger slice (#16797): the public projection reads
the `ma_channel_segment` table that the ledger slice introduced.

## Problem

The ledger slice made the control plane's per-segment identities and
write-once receipts durable, but the public delivery read model still exposes
only the singular `segment_id`, `ordinal`, and `provider_receipt` fields. A
reader of `GET /v1/agent-channels/{channelId}/deliveries` cannot see the
individual segments of a multi-segment delivery or which segment carries
which receipt. The per-segment detail exists in the ledger; nothing public
reads it.

## Decision

Expose the per-segment detail as an additive `segments` array on
`PublicChannelDelivery`, keeping the existing singular fields. Each entry is
a `PublicChannelDeliverySegment` with `segment_id`, `ordinal`, and an optional
`provider_receipt`. The array is the authoritative per-segment view, ordered
by ordinal; the singular `segment_id` and `ordinal` keep naming the first
segment and `provider_receipt` keeps the delivery's representative receipt,
so existing consumers do not break.

Additive rather than replacing the singular fields: the resource is still
`partial`, but keeping the singular fields avoids a breaking shape change and
lets a consumer migrate to `segments` at its own pace. The array is required
and non-empty (`minItems: 1`, `maxItems: 64`), matching the record contract's
1–64 segment plan; a delivery row always has its segments planned before the
row is visible. A resend whose minted id already names a stored delivery with
a different first segment (id or ordinal) is rejected before any segment is
planned, so a refused resend leaves no orphan segment rows; a replayed resend
under a matching id converges instead of conflicting. The first-segment check
is backed by a full-chain comparison: when the stored chain under the resent
id is non-empty, its (segmentId, ordinal) pairs must equal the resent plan's,
so a divergence after segment 0 is refused too — otherwise INSERT IGNORE
(unique on segment_id, not ordinal) would splice the two chains into one
delivery with two rows at a single ordinal.

The contract version bumps from 1.108.0 to 1.109.0. The Java record and the
OpenAPI schema change together, enforced by the record-to-schema contract
gate; the channel route gate keeps the three routes and the schemas
`partial`.

### Service read path

`publicDelivery` builds the array from the segment ledger
(`ChannelSegmentRepository.list`) for each delivery row. `listDeliveries` and
`getDelivery` read the ledger per delivery. This is a bounded per-row read
(the delivery page is at most 100 rows); batching the segment reads is a
later optimization if the read path needs it.

### WebShell

The channel routes are tagged `Public Resources`, not `WebShell`, so the
WebShell type generator does not emit channel types. Regenerating the
WebShell types produces no channel change; no WebShell consumer is affected.

## Files affected

- `contracts/.../model/ApiModels.java` — `segments` on
  `PublicChannelDelivery` and the new `PublicChannelDeliverySegment` record.
- `contracts/.../openapi/managed-agent-public-api.openapi.json` — the
  `segments` property, the `PublicChannelDeliverySegment` schema, and the
  version bump.
- `control-plane/.../channel/ManagedChannelService.java` — the public read
  path builds the array from the segment ledger; `resend` refuses a resent id
  whose stored chain diverges from the answer (first-segment check plus a
  full-chain comparison that tolerates a partly materialized prefix).
- `verification/.../ManagedAgentApiContractTest.java` — the new record's
  schema mapping and the channel fixture's segment rows.
- `verification/.../ChannelContractTest.java` — the new schema in the
  partial-schema gate.
- `verification/.../channel/ManagedChannelServiceTest.java` — public read
  assertions over a multi-segment delivery, and the resend chain-guard cases
  (head/ordinal/later-segment divergence refused, prefix and receipted replay
  converge).
- This design doc and its Chinese version.

## Scope boundaries

- No change to the journal record contract, the Harness funnel, the trusted
  adapter surface, the segment ledger schema, or the delivery state line.
- No WebShell consumer change (channels are not WebShell-tagged).
- The singular fields stay; removing them is a later breaking-change decision
  if consumers migrate fully to `segments`.

## Verification plan

- The record-to-schema contract gate and the route-response contract gate
  pass with the synchronized record and schema; the channel fixture seeds
  segment rows so the served `segments` array satisfies `minItems: 1`.
- A multi-segment service case asserts `getDelivery` and `listDeliveries`
  expose every segment with its own receipt.
- The resend chain guard is pinned by service cases: a stored chain diverging
  at the head, the ordinal, or a later segment is refused with
  `409 channel_delivery_conflict` (the WARN names the diverging position and
  both segment identities); a stored chain that is only a prefix of the plan,
  and a replay of a partly receipted chain, both converge. Each refusal and
  convergence case reds when the corresponding guard behaviour is removed.
- Checkstyle passes on the changed modules; the WebShell type regeneration
  produces no drift.

## Open questions

1. Batching the per-delivery segment reads on the list path, if the read
   volume warrants it.
2. Whether a later slice removes the singular fields once consumers use
   `segments`.
