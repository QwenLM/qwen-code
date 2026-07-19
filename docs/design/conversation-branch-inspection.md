# Conversation Branch Inspection

## Motivation

Session JSONL files already form a tree through `uuid` and `parentUuid`, but
resume currently reconstructs only one physically selected tail. A restart can
therefore hide valid sibling histories when more than one writer appended to
the same session or when a rewind created a second branch.

This change adds a read-only topology inspector. It identifies every semantic
leaf, describes its relationship to explicit rewind records, and produces a
small deterministic summary. It does not decide which branch is active.

## Boundary

The inspector accepts in-memory `ChatRecord` values and has no filesystem,
session service, model, or writer dependency. Existing resume, fork, transcript
pagination, daemon, ACP, and CLI behavior remains unchanged.

Selected-branch reconstruction continues to use `buildOrderedUuidChain` with
an explicit `leafUuid`. A later write-side change must obtain an exclusive,
stable transcript snapshot, ask the user or durable policy to select one of the
reported leaves, persist that selection, and seed the resumed writer. None of
those ownership operations belong in the inspector.

Claude Code has an all-leaves transcript reader for analysis while its normal
resume path still selects a latest non-sidechain leaf. Qwen cannot safely use
that selection rule: an explicit rewind proves a structural relationship, but
in a multi-writer transcript it does not prove that every sibling was
intentionally abandoned.

## Semantic leaves

The first physical record for a UUID defines its parent, matching the existing
chain walker. Conflicting duplicate parents are diagnosed rather than guessed.

Raw terminal records are normalized using a deliberately small neutral-tail
allowlist: `custom_title`, `session_artifact_event`, and
`session_artifact_snapshot`. These records may be appended beside or after a
conversation tail without creating a distinct recoverable conversation. A
terminal run of them collapses to its nearest known non-neutral ancestor.
Collapsed candidates are deduplicated, then any candidate that is a strict
ancestor of another candidate is removed. The result is an antichain of
semantic leaves.

All other system records remain significant. In particular, rewind,
compression, attribution, and file-history records can carry recovery state
and must not be discarded just because they have no user-visible text.

Missing parents stop a chain at the reachable tail island. Parent cycles are
reported and bounded. The read side never reconnects missing history or labels
a branch active or abandoned.

## Summaries and rewind relationships

Summaries are local and deterministic. They include the closest branch point,
message counts, timestamps, the first real user text after the branch point,
and the latest real user and non-thought assistant text. Notification, cron,
and mid-turn user records are not treated as user prompts. Text is whitespace
normalized and truncated; tool arguments and non-text parts are ignored.
`updatedAt` uses the timestamp of the last physical terminal normalized into
the semantic leaf so neutral metadata activity is not lost.

A branch is a rewind descendant when its path contains a rewind record. It is
a rewind sibling when its path diverges from the path to a rewind record. These
are structural labels only and never imply that the sibling is obsolete.
