# Session storage lifecycle repair

## Problem

Session lifecycle operations currently depend on loading a transcript as a usable conversation. That is too strong for delete, archive, and unarchive. A regular transcript file can still need maintenance when it is empty, has a torn or malformed head, or belongs to a legacy child whose parent no longer exists.

This leaves physical files stranded even though the selected workspace and archive state are unambiguous.

## Scope

This change makes delete, archive, and unarchive operate on exact-spelling regular transcript files owned by the selected workspace. It also adds an explicit repair option for an active/archive conflict.

The change does not alter transcript loading, listing, export, organization, Live session identity, or general case-insensitive lookup. Normal generated session UUIDs remain canonical lowercase values.

## Storage classification

The lifecycle classifier inspects the requested UUID file in the active and archived directories.

- A missing path contributes no state.
- A regular empty or damaged file contributes physical state.
- A readable first record must identify the requested session and the selected workspace.
- A readable record that identifies another workspace is treated as not found.
- A symlink, directory, or other non-regular entry fails closed.
- Active and archived files together form a conflict.

The classifier captures file identity for physical-only maintenance. Immediately before unlink or rename, Core verifies that the same regular files still occupy the same paths.

## Routing

Workspace-qualified routes mutate only the selected trusted runtime.

Workspace-less ordinary routes retain their existing primary-workspace behavior. Internal Conversations runtimes may be selected only when the requested batch has one unambiguous owner. Runtime selection is repeated while holding the lifecycle coordinator lock; a changed or unavailable generation returns the existing retryable runtime error instead of mutating stale storage.

Provenance remains authoritative for loading and listing, but it does not prevent maintenance of an otherwise owned regular transcript. This permits cleanup of legacy orphan children without making them loadable.

## Conflict repair

Archive and unarchive keep the non-destructive default behavior: an active/archive conflict is returned as a per-session error and neither persisted copy is moved, removed, or overwritten. Archive still strictly closes a live session before classifying the conflict, so queued records may be flushed to the active transcript. The batch lifecycle routes, including workspace-qualified routes, return that outcome in a `200` response instead of the earlier workspace-qualified `409 session_conflict` envelope.

Callers may send `resolveConflicts: true`:

- archive keeps the archived transcript and removes the active transcript;
- unarchive keeps the active transcript and removes the archived transcript.

The response adds `resolvedConflicts`, containing IDs repaired by that request. Delete keeps its existing compatibility behavior and removes both copies without requiring an option.

## Writer and generation safety

Daemon maintenance runs under the per-session lifecycle coordinator and writer lock. Damaged transcripts use the same writer lock with a maintenance sentinel because the normal writer proof intentionally rejects torn JSONL. The sentinel does not bypass a certified handoff: if transcript bytes change after a writer seals its lock, takeover continues to fail closed with `SessionTranscriptChangedError` and requires operator intervention. Core still snapshots and verifies the actual transcript paths before committing the mutation.

The selected runtime generation is checked after coordinator acquisition, before the filesystem commit, and after the operation. A generation replacement therefore cannot silently redirect an in-flight mutation to another runtime.

## API compatibility

The REST and ACP archive/unarchive request bodies accept the optional boolean `resolveConflicts`. Omitting it preserves the non-mutating conflict behavior, while the workspace-qualified REST transport now reports the conflict in the batch result as described above. Non-boolean values are invalid requests.

Archive and unarchive responses add `resolvedConflicts`. SDK result types keep that field optional so clients remain compatible with older daemons, while new daemons always return the array. Existing SDK client-ID call forms remain valid; options use an additional overload position.

The `session_storage_conflict_repair` capability advertises support for the option and response field.

## Verification

The regression matrix covers empty, damaged, and legacy-orphan transcripts across delete, archive, and unarchive in Core, workspace-qualified internal routes, and unqualified unique-owner routing. Each success asserts the final active/archive file state, and moves preserve the original bytes.

Compatibility tests retain default archive and unarchive conflict behavior and delete-both behavior. Additional tests cover explicit repair in both directions, foreign or ambiguous ownership rejection, invalid option types, SDK request bodies, generation fencing, and replacement detection.
