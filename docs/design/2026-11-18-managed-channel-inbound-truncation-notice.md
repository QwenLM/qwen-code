# Managed channel inbound truncation notice

- **Status:** proposed
- **Date:** 2026-11-18
- **Scope:** `packages/channels/base`, `packages/channels/{wecom,dingtalk,github,email}`
- **Related:** PR #17441 review finding R1-20 (deferred cross-provider follow-up); [Chinese version](2026-11-18-managed-channel-inbound-truncation-notice.zh-CN.md)

## Problem

The managed adapters clamp an over-long inbound message so it is admitted
truncated instead of meeting a deterministic server refusal and being dropped
whole. The clamp (`fitInboundText`) cuts to a **bare prefix with no elision
marker**. A message whose operative constraints sit past the cut — the opening
describes a refactor, the tail says "only touch `src/`, do not run migrations" —
is admitted as its prefix, and the agent performs the half the tail forbade.
Neither the agent nor the operator can tell the input was clipped. The byte path
has the same shape for a CJK message cut mid-thought.

Every other truncation in this runtime signals itself: the outbound reply clamp
appends `CHANNEL_TRUNCATION_NOTICE`, and compaction appends
`SLIM_TEXT_TRUNCATION_MARKER`. The inbound clamp is the one truncation that does
not mark itself.

## Current state

`fitInboundText` is duplicated across the four managed adapters:

- `wecom`, `dingtalk`, `github` carry a **verbatim-identical** copy: slice to
  `MAX_WIRE_TEXT_CHARS` (32,000 UTF-16 units) with a trailing-high-surrogate
  backoff, then, if the JSON-escaped length overflows
  `ENVELOPE_BYTE_LIMIT − TEXT_ENVELOPE_OVERHEAD_BYTES` (64 KiB − 4 KiB), binary
  search code points for the largest fitting prefix. The constants are mirrored
  locally to keep the channel packages free of `core` imports.
- `email` carries a **variant**: `boundedText(text, min(maxTextLength,
MAX_WIRE_TEXT_CHARS))` then a raw-UTF-8-byte code-point cut (not JSON-escaped).

The clamp is a local copy by an earlier deliberate decision: lifting it into
`channel-base` "would touch the published package and the DingTalk adapter for
no behavior gain". Adding a self-marking notice **is** a behavior gain, and a
shared implementation is what keeps the marker consistent across providers
rather than forking one adapter ahead of the others.

`CHANNEL_TRUNCATION_NOTICE` lives in `core` (`managed-channel-operations.ts`);
`channel-base` does not import `core` (the dependency direction is
`core → channel-base`), and the outbound notice's wording ("Reply truncated …
segment size limit") is reply-specific. The inbound clamp therefore needs its
own notice constant in `channel-base`, not a reuse of the outbound one.

## Proposed change

### Shared helper and notice in `channel-base`

Add to `packages/channels/base/src/managed-channel.ts` (beside the existing
shared managed-channel constants):

- `CHANNEL_INBOUND_TRUNCATION_NOTICE` — an inbound-specific notice:
  `"\n\n[Message truncated because it exceeded the channel input size limit.]"`.
- `fitInboundText(text)` — the JSON-escaped clamp currently duplicated in
  `wecom`/`dingtalk`/`github`, moved here verbatim and extended to reserve room
  for the notice and append it whenever the clamp actually shortens the text.

The constants `MAX_WIRE_TEXT_CHARS`, `ENVELOPE_BYTE_LIMIT`,
`TEXT_ENVELOPE_OVERHEAD_BYTES` move into the helper's module (they are the wire
and envelope bounds the helper enforces); the adapters stop mirroring them.

### Notice-reserving algorithm

The notice must fit inside **both** server bounds, so its characters and its
escaped bytes are deducted from the budgets before the core is cut:

1. If the whole text fits both bounds unchanged (length ≤ char cap and
   JSON-escaped length ≤ byte budget, no surrogate backoff needed), return it
   unchanged — **no notice** when nothing was clipped.
2. Otherwise reserve `notice.length` UTF-16 units from the char cap and the
   notice's JSON-escaped byte length from the byte budget; cut the core to the
   reduced char cap (with the same trailing-high-surrogate backoff) and, if it
   still overflows the reduced byte budget, binary-search code points for the
   largest fitting core; append the notice.

The result ends with the notice and still satisfies both server bounds. The
notice is ASCII apart from its leading newlines, so its escaped length is
computed with the same `encodedBytes` function the clamp already uses — no
separate raw-byte accounting.

### Adapter migration

- `wecom`, `dingtalk`, `github`: import `fitInboundText` (and the notice for
  tests) from `@qwen-code/channel-base`; delete the local copy and the mirrored
  constants. Behavior is identical except that a shortened frame now ends with
  the notice.
- `email` is **out of scope** (see Scope boundaries): its `boundedText` helper
  conflates size clamping with quoted-reply/signature stripping, so a notice
  there needs a separate design that distinguishes the two.

### Tests

- A new collocated `channel-base` suite pins the helper: no notice for a fitting
  frame; notice appended for a char-cap cut, a CJK byte cut, an astral mid-pair
  cut, and an escape-heavy cut; the marked result fits both bounds; the core is
  maximal (one more code point would overflow the reduced budget); removing the
  notice reservation reds the bound assertions.
- The existing clamp tests in `wecom`/`dingtalk`/`github` gain an assertion that
  the submitted text **ends with the notice** for a shortened frame, and their
  exact-prefix expectations are recomputed for the notice reservation (the core
  is now shorter by the notice's budget). Removing the notice reds the ends-with
  assertion while the recomputed exact-length assertions stay green. A fitting
  frame still submits unchanged (no notice).

## Files affected

- `packages/channels/base/src/managed-channel.ts` — add the notice constant and
  the shared `fitInboundText`; export both.
- `packages/channels/base/src/managed-channel.test.ts` (new or extended) — helper
  witnesses.
- `packages/channels/wecom/src/managed-wecom-adapter.ts` (+ test) — import the
  helper, drop the local copy/constants, update clamp tests.
- `packages/channels/dingtalk/src/managed-dingtalk-adapter.ts` (+ test) — same.
- `packages/channels/github/src/managed-github-adapter.ts` (+ test) — same.
- This design doc and its Chinese version.

## Scope boundaries

- The GitHub **subject** clamp (`fitSubject`, 200-unit bound) is unchanged: it
  is a separate field bound, not the inbound text clamp R1-20 names.
- The outbound notices (`CHANNEL_TRUNCATION_NOTICE`, `CHANNEL_CAPACITY_NOTICE`)
  and `truncateChannelTextUtf8` are unchanged.
- The **email** clamp is unchanged in this change. Its `boundedText` helper
  strips quoted replies and signatures (`>`, "On … wrote:", `-- `, "Original
  Message") and normalizes newlines as well as cutting to the char bound, so it
  conflates content processing with size clamping. Appending a truncation notice
  there requires distinguishing a size cut from quote stripping — a separate
  design, deferred. The three adapters migrated here share the identical
  pure-size JSON-escaped clamp.
- No control-plane (Java) change: the notice rides inside the existing text
  field, within the existing bounds.
- No change to the clamp's budgets themselves (32,000 units / 64 KiB − 4 KiB);
  the notice is reserved inside them.

## Open questions

- Exact notice wording: settled on the inbound-specific sentence above; it
  parallels the outbound notice's shape without claiming to be a reply.
