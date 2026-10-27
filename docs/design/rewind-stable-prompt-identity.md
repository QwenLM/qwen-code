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

### ACP and daemon delivery

The shared record-backed association and Ink behavior are delivered by #13737.
This dependent change delivers ACP producers, strict rewind selection, JSON
rollback, bridge transport and SDK/Web Shell/VS Code consumers together. The
common transport lookup excludes recovered `legacy-record:` keys. The separate
VS Code fix that exits edit mode after a refused submission is already in the
merge base (#15439); it is no longer an outstanding shipping prerequisite. Acceptance for #9437 spans the
shared/Ink and ACP deliveries; landing #13737 alone does not complete it.

This delivery remains a draft pending independent runtime verification. Before
native rewind, the owning prompt queue resolves a unique checkpoint-to-daemon
identity and freezes the existing complete bounded UI replay. Its ordinary user
chunk group determines the surviving prefix; multipart text and attachments
belong to one group, while background and injected rows are excluded. Missing,
ambiguous, degraded, truncated or partial history refuses recoverably before
conversation, files or recording change. A paged restore first recovers native
transcript pages from the oldest record within the existing replay byte budget;
partial/error pages, non-advancing cursors or concurrent events refuse before
native mutation. Server proof loss therefore differs from eviction in a client's
smaller retained window.

After native conversation rewind, the daemon resets replay even for an empty
prefix, reseeds surviving events with new monotonic IDs, clears obsolete restore
metadata and publishes that same prefix in an optional `session_rewound.replay`
field. File restore failures still install the prefix because the conversation
has already changed. The rewind notification stays transient in compaction,
preventing nested prefixes in later snapshots. Recording-disabled live sessions
use the same bounded authority without a new Session journal.

The SDK normalizes the prefix through its existing event normalizer, including
formerly optimistic own-user rows, and installs it atomically with its existing
block and byte budgets. Indexes, accounting and active references follow the
replacement; truncation callbacks observe the final window and report oldest
anchor eviction only when that source record changes. Web Shell re-anchors an
older restored prefix without adding the discarded tail to a rejected page's
footprint, so available history capacity reopens. Persisted workspace approval
broadcasts retain their origin session in replay; foreign session-local events
remain invalid. The outer rewind cursor remains latest. Older producers without
`replay` retain the legacy-index behavior. Acceptance requires ROOT+A+B+C with A evicted only in the
client to rewind A and restore ROOT in the original client, server cache and
unbounded observer. Reconnect, fresh/paged loads, a second rewind after reseeding
and the next actual model request must not resurrect A/B/C. Both recording modes,
empty prefixes, file restore failures and refusal without native mutation require
independent evidence; a mocked fresh reload does not establish this acceptance.

ACP selects targets by their snapshot identity, not a second classification of
model text. It resolves the recorder's complete-branch boundary by that same
prompt ID: retries can add snapshots without adding recorded user turns, so a
snapshot index is not a recorder index. The derived association survives full
and selective cold restore; missing or duplicated recorded identities refuse.
When chat recording is disabled, no recorded boundary is required; the unique
snapshot/model association still permits rewind without a recording write.
Without snapshots, the model's retained turn ordinals cannot safely
identify the recorder's complete-branch ordinals, so ACP conversation rewind
refuses rather than guessing. Only the initial ordinary
prompt send acquires its prompt identity; retry and interrupted-prompt resend
reuse the sole identity of the entries actually stripped from history, while a
tool/automatic continuation never acquires an identity of its own.
Unavailable or ambiguous associations refuse before changing conversation,
files, or recording. Snapshot-list eligibility follows the same resolver.
ACP history rollback carries each entry's `rewindId` through JSON and removes
that transport metadata before restoring model content. Existing clients
already echo the history array, so no new option or client-side counter is needed.

Daemon-backed surfaces carry the existing admitted `daemonPromptId` on the
checkpoint catalog and the rewind notification; `turnIndex` remains the raw
snapshot position, including retry gaps and compressed prefixes. Recorder
projections recover the association from existing records, and with recording
disabled ACP retains it only for live file-history snapshots. Web Shell and
VS Code select a uniquely associated user block and checkpoint by this ID;
the SDK installs authoritative replay when present. Older producers without replay
retain the legacy ordinal behavior. Missing or ambiguous UI associations disable
the target rather than guessing.
Admission binds the existing optimistic block, including a failed submission
reused by retry; no new transcript event or identity counter is needed.

Acceptance requires the same legacy fixture to cut at its source record,
identified turns to keep resolving, unlinked/ambiguous targets to refuse, and
resume/compression plus both live Ink and ACP entrances to obey these rules.
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
