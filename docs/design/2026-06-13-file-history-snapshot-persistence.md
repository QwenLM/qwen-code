# File History Snapshot Persistence

## Summary

This change closes the A+C persistence gaps for `/rewind` file history without
changing the persisted JSONL schema.

`file_history_snapshot` records remain append-only system records. Resume
reconstructs file history by reading all snapshot records in linear history and
deduplicating by `promptId` with last-wins semantics. That means an updated
snapshot for the same prompt can be appended later without rewriting old logs.

## Snapshot Update Recording

`makeSnapshot(promptId)` still creates the turn-boundary snapshot and the caller
still records it explicitly. The missing last-turn case is handled by giving
`FileHistoryService` an optional recorder callback. When `trackEdit(filePath)`
successfully adds a new backup to the latest snapshot, or heals a failed backup
entry in that snapshot, it invokes the recorder with the updated snapshot.

Duplicate `trackEdit` calls for an already captured non-failed file do not
record again because the snapshot did not change.

Recorder errors are swallowed and logged. File editing must remain best-effort:
file-history persistence must not make edit or write tools fail.

## Persistence Shape

No schema version is added. The existing payload already has enough structure
for backward-compatible reconstruction:

```json
{
  "type": "system",
  "subtype": "file_history_snapshot",
  "systemPayload": {
    "snapshots": []
  }
}
```

Old logs without these records still resume with no file-history state. Malformed
snapshot records are skipped with a warning, and valid later records remain
usable.

No explicit `isSnapshotUpdate` flag is added. Appending another
`file_history_snapshot` record with the same `promptId` has the same practical
behavior because `SessionService.loadSession()` already applies last-wins
deduplication by `promptId`.

## Scope

This is A+C only.

B1 simulated `sed -i` coverage is left for a separate PR. Generic shell edit
tracking, `getDiffStats` concurrency limiting, and per-file failure reasons are
also deferred. Claude Code does not support those behaviors today, so qwen-code
should not add them as part of this compatibility pass.

No migration is required because the persisted record shape is unchanged.
