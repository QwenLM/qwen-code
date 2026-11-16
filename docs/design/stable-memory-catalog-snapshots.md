# Stable legacy memory catalog snapshots

[English](stable-memory-catalog-snapshots.md) | [简体中文](stable-memory-catalog-snapshots.zh-CN.md)

## Problem and scope

The existing legacy catalog is request-only data appended at the request tail.
#15020 protects cache anchors by skipping the entire catalog-bearing volatile
message when choosing a breakpoint. The unchanged catalog still moves on every
request, so it cannot remain in the reusable conversation prefix. This follow-up
to #15027 retains full snapshots in chat history while keeping mutable catalogs
out of the system prefix (#11550). It adds no delta engine, configuration, or
changes to structured memory retrieval.

## Design

`LlmChat` prepares a snapshot after the pending user message and any compaction,
before image payload replacement and reattachment. It compares the current rendered
catalog with the latest surviving part marked
`qwen-code:memory-catalog-snapshot`. An unchanged catalog adds nothing, including
on retries. A changed catalog appends a new full snapshot; A → B → A therefore
produces three snapshots. Earlier snapshots and their positions remain unchanged.
The snapshot explicitly supersedes all earlier catalogs, including deleted entries.
The existing catalog renderer still escapes and bounds its data; the added heading
is fixed application text, not interpolated index instructions.

The last user content receives a copied parts array, preserving the original parts
and image identity. Empty history or a model tail receives a new user-role content.
The snapshot is durable and never carries the request-only image reattachment
boundary marker. No mutable catalog is prepended to history or the system prompt.
The one-shot `GeminiClient.generateContent` path keeps its scoped request-only tail.
Snapshot preparation uses a candidate history and commits it only after image and
modality preparation succeeds, as the last initial setup step after output clamping.
A failed setup therefore creates no durable snapshot. Temporary output-recovery
control prompts and their estimation calls cannot own a retained snapshot: when a
snapshot is missing or changed they receive a request-only full snapshot with the
volatile boundary marker. The next durable request retains it; unchanged recovery
requests reuse the existing snapshot. Catalog updates follow the existing config
refresh timing rather than introducing filesystem polling.

Pending-input token estimates include a missing or changed snapshot before the
compression gate, after hard-rescue compaction, and before final output clamping.
Estimation does not mutate history or record a snapshot, and rereads the current
catalog at each boundary so a snapshot removed by compaction is budgeted again.

`ChatRecordingService` writes a `system` record with subtype
`memory_catalog_snapshot` and the exact marked part in `message.parts`. Ordinary
user records remain unchanged. API-history replay applies the same append layout;
the subtype is registered with transcript parsing and the managed-session sink.
Retry can leave repeated unchanged snapshot records in the append-only journal.
Replay compares each snapshot only with the latest marked snapshot in current API
history and skips it when the text matches. It leaves the journal and parent lineage
unchanged, preserves A → B → A, and does not deduplicate all historical versions.
Compression checkpoints already preserve part metadata. If compaction removes the
last marked snapshot, replay accepts a later record of that same snapshot, and the
next request appends the current full snapshot if it is still missing.

An empty `getAutoMemoryContext()` means legacy catalog access is suppressed (memory
off, structured mode, or a scoped maintenance configuration). Request history and
curated `getHistoryShallow(true)`, including the compression input reader, filter only marked
parts without modifying retained history or ordinary user text. Curated full and
tail projections also filter them before advisor serializes the transcript or
non-cache follow-up sends it to the model. Raw full/tail readers and default or false shallow reads retain their
serialization, writeback, and index contracts. `/summary` removes resident snapshots
from its request projection, then appends only the current catalog when enabled.
Recap and title side queries remove marked catalog snapshots from raw shallow history before their existing dialog filters, regardless of whether legacy memory is enabled. This preserves message boundaries and title hook-context stripping without adding catalog headings to cosmetic metadata input. Recorded title display text remains authoritative; retained history and ordinary user-authored text are unchanged. Child chats already filter cached/forked
requests, so those paths need no additional filtering. Re-enabling memory compares
against the latest retained snapshot again.

When retained snapshots become visible after suppression, prior usage may exclude
them (for example, `/cd` from structured memory to a legacy workspace). Before
adopting counts for any route, discard current and retained route usage and use
the existing full-history estimate for this transition. The opposite flip,
visible to suppressed, deliberately keeps the authoritative count: it then
over-states by the retained snapshots the next request strips, which errs toward
a smaller output grant and an earlier compaction rather than an overflow, and the
next usage report replaces it. Discarding the count there instead would fall back
to a history walk that omits the whole system and tool overhead. The estimate's
overhead pad and reactive overflow recovery therefore remain the safety net for
the under-count direction only. Resume counts adopt the
current catalog visibility: a session saved with legacy memory enabled already
counted its visible snapshots, so the resumed authoritative count stays usable.
The rarer save-while-suppressed resume relies on the overhead pad and reactive
overflow recovery instead of discarding every resumed count. Explicit
current-projection count seeds remain usable; ordinary history writeback does not
invalidate counts. This bounded fallback loses the prior authoritative prefix
anchor; the existing estimate overhead pad and reactive overflow recovery still
apply. Normal enabled sends keep their authoritative running count.

The AUTO permission classifier always excludes marked snapshots before projecting
user text, even when memory is enabled. Identical unmarked user text is preserved.
The trusted marker also identifies a snapshot-only entry as structural context,
including one reseeded after reactive overflow compression ends with a model
acknowledgement. Such an entry does not create a user prompt or a fork-window turn;
a mixed real user prompt plus snapshot still counts as a user turn. Delivered
notification classification also ignores marked snapshots while still requiring a
notification envelope and no real user text, preserving ACP rewind ordinals.

A snapshot record belongs to the turn whose durable request appended it. Deleting
that turn through message-group deletion removes the record with it, so a restore
cannot reattach a deleted turn's catalog to an earlier turn; the next durable
request appends the current catalog again when the surviving history no longer
matches it. Snapshots embedded in a compaction payload stay part of that
compressed history and are pruned only by the compression-aware deletion path.

Context usage attributes all supplied marked snapshots to memory tokens once,
excluding them from conversation tokens. Request-only one-shot attribution remains
supported. UI user-message projections do not gain fabricated user records.

## Constraints and risks

Each snapshot remains bounded by the existing renderer. The total of historical
snapshots grows with catalog changes until normal compaction; this is not a global
memory budget or an automatic pruning mechanism. Unchanged catalogs improve prefix
reuse but still occupy context and must still be transmitted to stateless providers.
Provider cache hits and latency require actual request-level validation and are not
guaranteed by the history representation alone. Recorder writes retain the existing
best-effort error behavior.

## Validation and acceptance

Focused regressions cover stable prefixes across unchanged requests, A → B → A,
retry deduplication, copied image part identity, marked-only suppression, reseeding
after snapshot removal, real recorder/JSONL/full and selective restore, compression
metadata survival, managed projection, and memory token attribution. They also
cover pending-snapshot budgeting, AUTO classifier input, actual advisor and
non-cache follow-up input, and snapshot-only reactive overflow reseeding with
user/fork turn classification, raw shallow indexes/writeback, and actual summary,
recap, and title requests. Existing one-shot helper tests remain applicable.
Tests must use the active project path
`.qwen/memory`, not `.qwen/memories`, when seeding real runtime catalogs.

Run from `packages/core`:

```sh
npx vitest run src/memory/request-context.test.ts src/memory/prompt.test.ts src/core/llm-chat.test.ts src/core/client.test.ts src/permissions/classifier-transcript.test.ts src/services/session-transcript-reader.test.ts src/managed-runtime/managed-session-record-sink.test.ts src/core/loggingContentGenerator/context-usage-snapshot.test.ts src/services/sessionRecap.test.ts src/services/sessionTitle.test.ts
```

Then run from `packages/cli`:

```sh
npx vitest run src/ui/commands/summaryCommand.test.ts src/ui/commands/contextCommand.test.ts
```

Build, typecheck, formatting, and independent real-runtime request/replay validation
are coordinated separately. Implementation handoff does not claim those checks
passed. Acceptance requires unchanged history prefixes, no duplicate retry snapshot,
exact replay layout, no marked snapshot in suppressed requests or compression input,
no UI user-message pollution, and current-catalog reseeding after compaction.

## Open questions

No product decision is outstanding. Independent validation must confirm the wire
prefix and UI behavior across the supported providers before publishing performance
claims. No numerical catalog-size gains from earlier fixtures using the inactive
plural project directory are accepted as evidence.
