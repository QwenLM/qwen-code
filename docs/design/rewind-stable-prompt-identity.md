# Stable prompt identity for TUI rewind mapping

[English](rewind-stable-prompt-identity.md) | [简体中文](rewind-stable-prompt-identity.zh-CN.md)

## Problem

TUI rewind aligned visible user turns with model-facing history by counting
two independent representations. Cleared media and other non-visible entries
can make those counts disagree and select the wrong truncation boundary.

## Decision

Use `promptId` as the authoritative identity shared by a visible user turn and
its model-facing prompt.

- Persist the id on the user `ChatRecord`.
- Attach it to the corresponding in-memory API `Content` as Symbol metadata,
  so it is not sent to providers.
- Preserve the metadata through recording, compression, resume, branch, and
  checkpoint-restore paths.
- Resolve an identified rewind target only by an exact id lookup that is unique
  in both histories.
- Scope both that lookup and the duplicate census to the retained region after
  the last successful compression marker, so an id whose twin was already
  absorbed does not refuse the turn that still resolves uniquely.
- Return `-1` when the id is missing or duplicated on either side rather than
  guessing with positional alignment.
- Treat the turn's prompt entry as its anchor. A tool-loop continuation carries
  the same id so the turn stays discoverable, but it does not start the turn and
  is not a second candidate.
- Offer only turns that carry an identity in the Ink selector, so a row that
  could never resolve is not picked and refused afterwards.
- Name the cause of that refusal. An identified turn in the retained region
  that does not resolve reports that it no longer matches the model history,
  not that it was compressed.
- Recover a legacy turn's rewind identity from its source record, or refuse it;
  do not align independently counted histories.

An absorbed turn has no matching identity after the compressed prefix and is
rejected. A uniquely identified retained turn can still resolve without a UI
compression marker.

## Identity lifecycle

Interactive, headless, and ACP entry points mint ids in the form
`sessionId########<counter>`. Resume and fork paths seed the counter past the
identities the transcript's records claim, so a new turn does not reuse an
existing key. Every seeded entrance uses `computeResumedPromptCountSeed`, so
the rule stays consistent across startup, resume, and branch.

Duplicate ids remain possible: transcripts written before this change carry no
record-level id, and a file-history snapshot key can outlive the turn that
claimed it when a conversation-only rewind drops that turn from the
transcript. Both halves therefore fail loud rather than guess — conversation
truncation requires exactly one matching API entry, and
`FileHistoryService.rewind` refuses a key that more than one snapshot wears,
because it would otherwise resolve the shared key to the last occurrence and
then prune the newer backups.

Compression records persist prompt ids in an array parallel to their history
snapshot. Restoring a compression checkpoint reattaches each id to the same
entry.

JSON checkpoints created by `/restore` cannot carry Symbol metadata through the
file itself, so the writer persists the ids in an array parallel to
`clientHistory` and restore reattaches each id before installing that history.
A checkpoint written before this change has no such array: its file keys remain
usable for file-only restore, but conversation rewind fails closed instead of
applying positional alignment to identified turns.

## Legacy compatibility (#9437)

For an ordinary persisted user record without `promptId`, derive the rewind key
`legacy-record:<uuid>` from its existing record UUID. Both resume projections
use the same core routine. The visible item carries this key as `rewindId`,
separate from `promptId`: a record UUID is not a file-checkpoint identity and
must never authorize file restore. No transcript schema or new ID counter is
needed. Persisted prompt IDs remain preferred.

Resolve only a unique key in both retained representations. Missing source
UUIDs, missing model metadata, and duplicated keys refuse before mutation.
This also covers raw old compression/checkpoint snapshots that have no identity
sidecar: do not infer which source record produced an entry from its text or
position. Records appended after such a snapshot can still resolve. Existing
compression/checkpoint sidecars preserve recovered keys when newly written.

Hidden notifications, tool results, and synthetic continuations do not acquire
an ordinary user record's key. Their text cannot move a linked target's cut.
The compatibility check must include the genuine placeholder-text prompt that
previously stayed in model history after the visible turn was removed.

Ink resolves the recorded boundary independently by the same source key, not
the visible turn count. An ordinary image-only record may have no visible user
row but must not shift the retained recording branch. Missing or duplicated
recorded associations refuse before mutation when recording is enabled.

The surviving checkpoint batch is also resolved before mutation. A unique
checkpoint matching the target's real prompt ID retains its chronological
prefix, including hidden turns and any prefix left after snapshot eviction.
Without a target checkpoint, every checkpoint must map uniquely to a recorded
turn; retain those at or before the recorded cut. An empty checkpoint set is
valid. Ambiguous checkpoint ownership refuses instead of losing or reviving
checkpoints through a visible-row count.

### Delivery boundary

The legacy compatibility change covers the shared record-backed association and
live Ink rewind. ACP keeps its existing rewind implementation in this slice.
The common transport-id lookup excludes `legacy-record:` keys, so recovering an
old record does not turn its conversation-only key into a new ACP prompt id.

ACP identity-based rewind is a separate dependent change. Its strict resolver,
fresh/retry/cancel identity producers, JSON rollback, checkpoint catalog and
notification transport, and SDK/Web Shell/VS Code consumers must move together.
Raw snapshot positions can contain retry gaps and cannot identify visible user
rows. The dependent change must carry the existing admitted daemon identity
through that entire chain rather than reverting only its client consumers.

Acceptance for this slice requires the same legacy fixture to cut at its source
record in Ink, identified turns to keep resolving, unlinked/ambiguous targets to
refuse before mutation, and recovered record keys never to authorize file
restore. Resume and compression must preserve these associations. ACP acceptance
remains with the dependent change; this slice alone does not complete #9437.
OpenTUI's currently unconnected rewind selector is not wired by this change;
its dormant positional helper is separate follow-up cleanup, not an authority
for a live rewind operation.

## Scope

This change supplies stable turn identity to TUI rewind and the persistence
paths needed to keep that identity stable. It does not add text ownership,
notification provenance, ordinal reconciliation, or other alignment
heuristics; those would recreate the dual-authority problem this design is
intended to remove.

OpenTUI seeds its prompt counter past identities claimed by a resumed
transcript before minting a new id. Although OpenTUI has no rewind surface of
its own, those ids are persisted and may later be consumed by Ink rewind.

Seeding past retained file-history snapshot keys is handled separately by
#13729 for #11408. That merged companion prevents a resumed turn from reusing
a snapshot key left behind by conversation-only rewind; it is not duplicated
in this change.
