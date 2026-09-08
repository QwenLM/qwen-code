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
3. that entry's text equals the target's text (the ownership proof);
4. if the target's own text is itself a cleared-media placeholder, the match's
   ordinal also agrees — it has exactly `uiUserTurnCount` user prompt entries
   before it, counted with the unfiltered classifier;
5. the proof is unique — no other real, non-file-key-only UI turn claims the
   same id with the same text, and at most one post-`startIndex` entry carries
   the target's text;
6. the positional walk does not land earlier than the match.

Anything else falls through to the positional walk, whose loud -1 is the safe
refusal. So the change can only make rewind more accurate than it was, never
less: it never introduces a refusal on a session that previously rewound.

### Why condition 4 is scoped the way it is

A cleared media-only entry and a genuine prompt whose entire text equals the
generated placeholder are byte-identical once serialized, so the text proof
cannot separate them. Their ordinal can: the target has `uiUserTurnCount` real
UI turns before it, so its own entry carries exactly that many user prompt
entries ahead of it, while a cleared entry wearing a re-minted mark sits
elsewhere. The count uses the unfiltered classifier deliberately — a cleared
entry still occupies the ordinal that the rewind walk skips.

Ordinal agreement is a positional proof, so it stops holding exactly where
positions desync: a turn absorbed by compression. That is the case identity
exists to resolve, so the check must not apply to it — and it does not, because
those targets carry ordinary text and never reach condition 4. Scoping is what
lets both hold at once; an unconditional ordinal proof resolves the collision
but breaks absorbed-turn exactness, and an unconditional placeholder refusal
does the reverse. Both directions are pinned: removing the scope reds the
round-30 same-text impostor probe, and removing the ordinal clause reds the
headline reproduction.

The durable close remains per-entry provenance — ids that cannot be re-minted,
issued at the mint sites — which would remove the need for any ownership proof.
Conditions 3-5 are the interim.

## Scope

This change does not redesign ACP rewind, edit rollback, recording checkpoints,
file-history snapshot alignment, retry/continuation handling, automatic turns,
token-limit cleanup, or fork identity remapping. Those are independent state
machines and require separate issues if their current behavior is incorrect.
