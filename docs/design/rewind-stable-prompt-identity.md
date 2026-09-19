# Stable prompt identity for TUI rewind mapping

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
  session-switch paths.
- Resolve an identified rewind target by an exact id lookup when exactly one
  model-history entry carries it.
- Return `-1` when the id is duplicated on either side: two claimants mean the
  positional walk would be guessing between them.
- Fall back to the positional mapping when no model-history entry carries the
  id. Only a first-party user prompt is marked — retries, continuations, tool
  results and cron sends deliberately are not — so an unmarked entry is
  expected, not ambiguous.
- Retain the existing positional mapping for legacy turns without an id and
  restored checkpoint items whose id is only a file-history key.

The first visible turn still resolves to the known startup-context boundary.
The existing compression guard continues to reject turns that were absorbed
by a marker-less compressed prefix.

## Identity lifecycle

Interactive, headless, OpenTUI, and ACP entry points mint ids in the form
`sessionId########<counter>`. Resume and fork paths seed the counter after the
highest retained turn and file snapshot so a new turn does not reuse an
existing key. Duplicate ids remain possible in older transcripts, so lookup
requires exactly one matching API entry and refuses when there are two.

Compression records persist prompt ids in an array parallel to their history
snapshot. Restoring a compression checkpoint reattaches each id to the same
entry.

## Scope

This change supplies stable turn identity to TUI rewind and the persistence
paths needed to keep that identity stable. It does not add text ownership,
notification provenance, ordinal reconciliation, or other alignment
heuristics; those would recreate the dual-authority problem this design is
intended to remove.
