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
- Restore both the UI item and API metadata from the persisted record,
  attaching the id to a resumed UI item only when exactly one user record
  carries it — a headless `--resume` re-mints `sessionId########0`, and a
  shared id would hand the file-rewind consumer a key that resolves the wrong
  turn's snapshot.
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
2. the target carried a model-facing text (`promptHasModelText !== false`) —
   an attachment-only resumed turn has no text for the proof to match and the
   walk cannot place it (its entry has no text part), so it refuses loudly
   rather than landing on the next turn's boundary;
3. exactly one post-`startIndex` entry carries the id;
4. that entry's prompt text equals the target's model-facing text (the
   ownership proof) — compared against `promptOwnerText ?? text`, because a
   resumed UI item's `text` is a display projection and can be a synthetic
   string such as `'[User message with attachments]'` that no API entry ever
   carries. The entry's prompt text is its first non-empty, non-reminder
   text part (mirroring the record-side `modelFacingText` rule), so an
   unrelated turn whose cleared media part happens to equal the target's
   text is not mistaken for it;
5. if the target's own text is itself a cleared-media placeholder, the match's
   ordinal also agrees — the entry has exactly as many prompt entries with a
   model-facing text before it as the target has preceding real UI turns that
   carried one (the resume builder records `promptHasModelText` so the two
   sides count the same population; see below) — AND at least
   `uiUserTurnCount` user-role, non-tool-result entries precede the match:
   the aligned counts can drop together when both sides skip an
   attachment-only turn, so the absolute-position term keeps the proof from
   agreeing trivially at an entry that is not the target's own;
6. the proof is unique — no other real, non-file-key-only UI turn claims the
   same id with the same text, and at most one post-`startIndex` entry carries
   the target's text. The census skips entries marked with a different id
   (provably another turn's own — the user simply sent the same text twice),
   and for a placeholder-texted target it counts only the walk's own
   population (a same-mime cleared media-only sibling never had a UI turn;
   placeholder-vs-placeholder ambiguity is the ordinal check's job);
7. the positional walk does not land earlier than the match for a reason the
   UI cannot account for: the counted entries before the match exceed the UI
   items that own a counted entry. That owning population is real user turns
   with a model-facing text plus drained notification items — a
   background-agent/cron completion displays as a notification but submits a
   real user-role entry, while a mid-turn steer message owns no counted entry
   and displays as a `sentToModel: false` user item.

Anything else falls through to the positional walk, whose loud -1 is the safe
refusal. So the change can only make rewind more accurate than it was, never
less: it never introduces a refusal on a session that previously rewound.

### Why condition 5 is scoped the way it is

A cleared media-only entry and a genuine prompt whose entire text equals the
generated placeholder are byte-identical once serialized, so the text proof
cannot separate them. Their ordinal can: the target's own entry is the n-th
entry whose prompt carried a model-facing text, where n is the number of
preceding real UI turns that carried one, while a cleared entry wearing a
re-minted mark sits elsewhere. The two sides must count the SAME population:
an unfiltered API count also counts cleared placeholders (which never had a
UI turn) and a raw UI count also counts resumed attachment-only turns (whose
API entry has no text part), so the two divergence directions can cancel and
admit an impostor. The API side therefore uses the walk's own filtered
binding and the UI side counts only turns the resume builder did not flag
`promptHasModelText: false`.

Ordinal agreement is a positional proof, so it stops holding exactly where
positions desync: a turn absorbed by compression. That is the case identity
exists to resolve, so the check must not apply to it — and it does not, because
those targets carry ordinary text and never reach condition 5. Scoping is what
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
