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
- Keep the current positional mapping only for histories without identities.

Fast-compression checkpoints preserve the Symbol values in parallel metadata
so resume does not discard identities that remain in model history.

## Scope

This change does not redesign ACP rewind, edit rollback, recording checkpoints,
file-history snapshot alignment, retry/continuation handling, automatic turns,
token-limit cleanup, or fork identity remapping. Those are independent state
machines and require separate issues if their current behavior is incorrect.
