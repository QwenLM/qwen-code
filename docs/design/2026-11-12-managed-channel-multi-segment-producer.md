# Managed channel multi-segment delivery producer (H5d)

[English](2026-11-12-managed-channel-multi-segment-producer.md) | [简体中文](2026-11-12-managed-channel-multi-segment-producer.zh-CN.md)

Status: proposed. This is the multi-segment-plan part of slice **H5d** of
[#12827](https://github.com/QwenLM/qwen-code/issues/12827), tracked by
[#16998](https://github.com/QwenLM/qwen-code/issues/16998). It builds on the
multi-segment delivery ledger (#16797) and its hardening (#16818), which already
plan, send, receipt and recover 1–64 segments per delivery; only the producer
still plans a single segment.

## Problem

`planChannelSegments` today returns exactly one segment: it truncates the reply
to `MANAGED_CHANNEL_LIMITS.maxSegmentBytes` (48 KiB) and appends the truncation
notice. A reply longer than one segment therefore loses its tail before it is
ever planned. The outbound path (`hosted-channel-session.ts`) then hard-codes a
one-element `segments` array, so the ledger's multi-segment capability is never
exercised by a real reply. The segment plan contract, the per-segment write-once
receipts, the dispatcher and the partial/unknown recovery all already support
1–64 segments.

## Decision

Split the reply into ordered segments instead of truncating it to one, and plan
one ledger segment per piece. The split, the plan and the representative reply
are three separate concerns:

- **Split.** `planChannelSegments(text)` returns up to `maxSegments` (64)
  pieces, each at most `maxSegmentBytes` (48 KiB) of UTF-8, cut on a code-point
  boundary. A reply that fits one segment returns a single piece with no notice
  (today's short-reply behavior is byte-for-byte unchanged). A reply within the
  nominal byte capacity (`maxSegments * maxSegmentBytes`) is kept whole up to
  code-point alignment — the boundary back-off leaves at most 3 bytes of slack
  per full-width piece, so an adversarial mixed-width input sitting exactly at
  the capacity can still overflow by that slack plus the notice room, visibly
  marked; uniform-width text never drifts. A reply past that capacity keeps the
  first 64 pieces and appends the existing truncation notice to the last kept
  piece, so the overflow is visible, never silent.
- **Plan.** The outbound path publishes one segment resource per piece and
  builds the `segments` array with `segmentId` `deliveryId:i` in ordinal order,
  replacing the hard-coded single element. The dispatcher, receipts and recovery
  are unchanged: they already operate per segment.
- **Representative reply.** The delivery's `contentRef` reply resource keeps the
  existing envelope-fitting loop (the inline reply must still satisfy
  `maxEnvelopeBytes`), so the public read model's representative reply keeps the
  same bound as today. Its content for a long answer is a fitted prefix of the
  full answer: the loop now starts from the whole planned text rather than a
  pre-truncated single segment, so the first shrink lands sooner and the copy it
  carries can be shorter than before — the bound, not the content, is what is
  unchanged. The full answer is carried by the segment resources; model
  completion and external delivery remain projected separately (H5c).

The split prefers to break at the last newline within the byte budget so a
segment boundary lands on a line end when one is available, but only when the
bytes after that newline still fit the remaining segment budget; otherwise it
falls back to the code-point boundary cut at the full byte bound. Without that
guard, long lines would put every piece far below the byte bound and spend the
64-segment count at a fraction of the nominal capacity, dropping a tail that
fits. The guard keeps segments readable when lines are short and keeps the whole
byte capacity reachable when they are long.

### Concatenation invariant

Joining the planned segment texts reproduces the input exactly when the input is
at most `maxSegments * maxSegmentBytes`, up to code-point alignment: the back-off
can leave at most 3 bytes of slack per full-width piece, so an adversarial
mixed-width input at exactly the capacity can overflow by that slack plus the
notice room (visibly marked); uniform-width text at the capacity is lossless.
Past that byte capacity the join reproduces the kept prefix plus the truncation
notice (the last kept piece yields room for the notice within the byte bound). No
code-point is ever split, and no segment exceeds the byte bound. This is the
property the regression witnesses pin.

## Files affected

- `packages/core/src/managed-runtime/managed-channel-operations.ts` —
  `planChannelSegments` splits instead of truncating; the notice moves to the
  overflow case.
- `packages/cli/src/serve/hosted-channel-session.ts` — the outbound plan builds
  one segment per planned piece; the representative reply keeps the envelope
  fit.
- Collocated tests for both, plus the channel service/contract suites that
  already exercise multi-segment plans.
- This design doc and its Chinese version.

## Scope boundaries

- No change to the segment ledger schema, the receipt write-once rule, the
  dispatcher, or the partial/unknown recovery — they already handle 1–64
  segments.
- No second adapter (the other H5d item, chosen by product priority).
- No card-style surfaces (H5e) or attachment kinds beyond inline staging (Media).
- The per-segment byte bound, the 64-segment bound and the envelope bound are
  unchanged.

## Validation plan

- Unit witnesses for the split: short reply unchanged; multi-segment split
  concatenates back to the input; each piece within the byte bound and on a
  code-point boundary; a reply at the nominal byte capacity stays whole even
  when its lines are longer than half a segment (the line-end cut must not spend
  the segment count below capacity); the line-end cut is taken when the remainder
  fits the remaining segments exactly; an adversarial mixed-width input at the
  capacity loses only the alignment slack plus the notice room, visibly marked;
  overflow keeps 64 pieces and appends the notice; removing the split (back to
  truncate), the notice, or the capacity guard reds the corresponding case.
- The outbound plan witness: a long reply plans N segment resources with
  `deliveryId:i` ids in order; a short reply still plans one.
- The existing multi-segment service/contract/MySQL suites remain the baseline
  for dispatch, receipt and recovery over the now-real multi-segment plans.

## Open questions

1. Whether the representative reply should eventually reference the segment
   resources instead of carrying a fitted copy is a read-model decision for a
   later slice; this slice keeps today's envelope-fitted representative.
