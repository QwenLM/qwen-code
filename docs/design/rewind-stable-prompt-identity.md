# Stable prompt identity for TUI rewind mapping

## Problem

TUI rewind currently aligns visible user turns with model-facing history by
counting and classifying two independent representations. Content changes such
as cleared-media placeholders can make those classifiers disagree and select
the wrong truncation boundary.

## Decision

Use the existing `promptId` as the shared identity of a visible user turn and
its model-facing prompt.

- Persist `promptId` on the user `ChatRecord`.
- Attach it to the corresponding in-memory API `Content` as Symbol metadata so
  it is not sent to providers.
- Restore both the UI item and API metadata from the persisted record.
- Resolve identified TUI rewind targets by identity.
- Keep the current positional mapping for everything else.

Fast-compression checkpoints preserve the Symbol values in parallel metadata
so resume does not discard identities that remain in model history.

## Fallback contract

Identity is an accelerator, never a new failure mode. `promptId` is minted as
`sessionId########<counter>` by several entrances (ink, OpenTUI, `-p`,
`stream-json`, ACP) whose counters restart independently, so uniqueness is not
an invariant this design may rely on. The mapping falls back to the
pre-existing positional walk whenever identity does not resolve.

As shipped, the gate demands more than a unique match before it accepts one.
The conditions accumulated over review rounds 24-30, each closing a way a
`promptId` can be worn by an entry that does not belong to the rewind target
(an absorbed turn's re-minted mark, a claimant-less re-send, a twin from
another entrance). A match is accepted only when **all** hold:

1. the target is a real user turn carrying a `promptId`, and is not
   `promptIdFileKeyOnly` (a `/restore`d item, whose id is a file-snapshot key
   only — the checkpoint's `clientHistory` is JSON and carries no marks);
2. exactly one post-`startIndex` entry carries the id;
3. that entry's text equals the target's text (the ownership proof), and the
   target's text is not itself a cleared-media placeholder;
4. the proof is unique — no other real, non-file-key-only UI turn claims the
   same id with the same text, and at most one post-`startIndex` entry carries
   the target's text;
5. the positional walk does not land earlier than the match.

Anything else falls through to the positional walk, whose loud -1 is the safe
refusal. So the change can only make rewind more accurate than it was, never
less: it never introduces a refusal on a session that previously rewound.

### Known open case

Condition 3's placeholder clause re-opens the collision this work was filed
for. When a user types a prompt whose entire text equals a generated
`[Old inline media cleared: …]` placeholder, the ownership proof refuses, the
unique identity match is discarded, and the positional walk runs — and that
walk excludes placeholders from its count, so it lands one turn late and
leaves the selected turn's prompt and response in model context.

The clause is not gratuitous: a cleared-media entry and a genuine
placeholder-texted prompt are byte-identical once serialized, so no text
comparison can separate them. A positional (ordinal-agreement) proof separates
those two, but then fails exactly where identity is most needed — a turn
absorbed by compression desyncs positions, which is the case identity exists to
resolve. The two requirements are in direct tension under any proof derived
from content or from position.

The durable close is per-entry provenance: ids that cannot be re-minted, issued
at the mint sites, so a match needs no proof beyond itself. Until then this case
is pinned red by `historyMapping.test.ts` →
_this PR's own headline reproduction (#9437)_.

## Scope

This change does not redesign ACP rewind, edit rollback, recording checkpoints,
file-history snapshot alignment, retry/continuation handling, automatic turns,
token-limit cleanup, or fork identity remapping. Those are independent state
machines and require separate issues if their current behavior is incorrect.
