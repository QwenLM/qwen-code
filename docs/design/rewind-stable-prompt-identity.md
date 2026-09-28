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
- Name the cause of that refusal. An identified turn in the retained region
  that does not resolve — for example after a retry, which re-sends the prompt
  unmarked — reports that it no longer matches the model history, not that it
  was compressed.
- Retain the existing positional mapping only for legacy turns without an id.

The existing compression guard continues to reject turns that were absorbed
by a marker-less compressed prefix.

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
then prune the newer backups. That refusal is the single guard on the file
side; the TUI surfaces it through the existing restore-error path instead of
running its own census first.

Compression records persist prompt ids in an array parallel to their history
snapshot. Restoring a compression checkpoint reattaches each id to the same
entry.

JSON checkpoints created by `/restore` cannot carry Symbol metadata through the
file itself, so the writer persists the ids in an array parallel to
`clientHistory` and restore reattaches each id before installing that history.
A checkpoint written before this change has no such array: its file keys remain
usable for file-only restore, but conversation rewind fails closed instead of
applying positional alignment to identified turns.

## Scope

This change supplies stable turn identity to TUI rewind and the persistence
paths needed to keep that identity stable. It does not add text ownership,
notification provenance, ordinal reconciliation, or other alignment
heuristics; those would recreate the dual-authority problem this design is
intended to remove.

OpenTUI seeds its prompt counter past identities claimed by a resumed
transcript before minting a new id. Although OpenTUI has no rewind surface of
its own, those ids are persisted and may later be consumed by Ink rewind.

The change deliberately leaves out widening the seed past retained file-history
snapshot keys. The refusal
above fires only when two snapshots share a key. If a turn minted after
resume re-wears the key of a snapshot that a conversation-only rewind left
behind, and writes no files itself, a code restore of that turn resolves to
the older snapshot. The seed that preceded this change counted user records
only, so live turns already had this exposure; it is accepted as a residual
risk and tracked in #11408.
