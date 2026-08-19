# Stable prompt identity for rewind mapping

## Problem

TUI rewind currently maps a UI user item to `Content[]` by independently
counting UI turns and model-facing user entries. ACP and fork-history selection
carry related classifiers with different exclusions. Compression, resume, and
microcompaction can change either representation, so another content shape can
silently shift the computed truncation point.

## Decision

Use the existing `promptId` as the stable identity of a real user turn.

- Persist `promptId` on the user `ChatRecord`.
- Attach the same value to the corresponding in-memory API `Content` through an
  internal Symbol. Symbol properties survive the shallow copies used by live
  history mutation, but are omitted by JSON serialization and therefore never
  become provider API fields.
- Compression checkpoints persist identities in parallel metadata so fast
  compression can restore them without changing the API `Content` shape.
- Restore the Symbol from `ChatRecord.promptId` when rebuilding API history and
  restore `HistoryItemUser.promptId` from the same record.
- Resolve rewind boundaries by identity. A target with a persisted identity
  that is absent from current API history is unreachable and fails closed.
- Keep the existing shape-based classifiers only when reading legacy sessions
  that have no persisted prompt identities.

This reuses the prompt identity already shared by UI history, file-history
snapshots, telemetry, and tool continuations. It does not introduce a second
turn counter or a new provider-visible content field.

## Compatibility and trust boundary

Session JSONL is untrusted input. Readers accept only non-empty string
`promptId` values. The value is used only for equality and never as a path,
command, or authorization key.

New records carry `promptId`; old records remain readable. Legacy histories
without identities use the current counting behavior. Partially identified
histories use identities as authoritative: an identified UI target that no
longer exists in API history is treated as compressed rather than guessed.
Duplicate identities are ambiguous and fail closed.

Summarizing compression intentionally discards identities for absorbed turns.
`/compress-fast` and microcompaction preserve them because their shallow
history transformations retain the internal Symbol. New post-compression turns
receive new identities normally.

Forked sessions rewrite the session-prefixed identity on both user records and
file-history snapshots so their rewind boundaries stay aligned.

## Affected paths

- TUI `/rewind`: `HistoryItemUser.promptId` locates the matching API entry.
- ACP rewind/count: identified histories count and locate marked user prompts;
  legacy histories retain the existing ACP classifier.
- Fork turn selection: identified histories count marked prompts; legacy
  histories retain the existing content-shape classifier.
- Session resume: both UI and API projections are rebuilt from the same
  persisted `ChatRecord.promptId`.

Recording rewind and file rollback keep their current APIs. They already use
the same logical user-turn order and file snapshots already key on `promptId`;
changing those contracts is unnecessary for fixing UI/API alignment.

## Verification

- A focused mapping test proves that text shape, reminders, and cleared media
  cannot shift an identified target.
- API-history reconstruction proves persisted identity reaches the rebuilt
  `Content` while JSON serialization stays provider-safe.
- Resume-history reconstruction proves the UI item receives the same identity.
- ACP and fork tests prove identified histories bypass their legacy classifiers
  while legacy behavior remains covered.
- Existing rewind, compression, recording, and resume tests remain green.
