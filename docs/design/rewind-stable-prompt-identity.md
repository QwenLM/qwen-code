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
an invariant this design may rely on. The mapping therefore falls back to the
pre-existing positional walk whenever identity does not resolve:

- the target UI turn carries no `promptId` (legacy sessions, restored
  checkpoints, retries);
- its `promptId` matches no API entry;
- its `promptId` matches more than one API entry.

The consequence is that this change can only make rewind more accurate than it
was, never less: where an identity resolves uniquely it replaces a guess with a
lookup, and everywhere else the behavior is byte-for-byte the one that shipped.
In particular it never introduces a refusal on a session that previously
rewound, which is what a fail-closed-on-ambiguity rule would do.

`/restore` loads a JSON checkpoint, so its `clientHistory` cannot carry Symbol
marks. The restore path drops `promptId` from the restored UI items to keep
both sides of that history consistently unidentified.

## Scope

This change does not redesign ACP rewind, edit rollback, recording checkpoints,
file-history snapshot alignment, retry/continuation handling, automatic turns,
token-limit cleanup, or fork identity remapping. Those are independent state
machines and require separate issues if their current behavior is incorrect.
