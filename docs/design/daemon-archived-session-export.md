# Workspace-Qualified Archived Session Export

## Summary

The daemon can export active persisted sessions from a selected registered
workspace, but archived transcripts remain inaccessible until they are moved
back to active storage. This change adds a read-only archived export without
changing active export behavior or the archive state machine.

The protocol adds
`GET /workspaces/:workspace/session/:id/archive/export?format=html|md|json|jsonl`,
the unconditional `workspace_archived_session_export` capability, and
`WorkspaceDaemonClient.exportArchivedSession`. The route and capability are
distinct from active export so an older daemon cannot ignore archive intent
and return an active transcript with the same id.

## Contract

The selector resolves as an exact registered workspace id and then as a
URL-encoded canonical absolute cwd. The selected runtime must be trusted;
selector and trust checks precede session and format validation.

Only the selected workspace's `chats/archive/<id>.jsonl` is eligible. The route
does not scan active storage or another workspace, fall back to primary,
resolve a live owner, call a bridge, start ACP, attach a client, or load
settings. Active-only sessions return `409 session_not_archived`, missing
sessions return `404 session_not_found`, simultaneous active and archived files
return `409 session_conflict`, and transitions return `409 session_archiving`.

## Reuse and Concurrency

`SessionService.loadArchivedSession` is the only new core consumer surface. It
delegates to the same private reconstruction logic as `loadSession` while
reading the archived path; existing load/resume callers remain active-only.
The daemon reuses the existing export collectors, formatters, response headers,
and SDK attachment parser, so archived and active exports have identical format
behavior. Before reconstruction, the archived-only loader enforces the existing
256 MiB transcript indexing limit and returns `413 transcript_too_large` above
it. Active export retains its shipped no-cap contract.

Export holds the existing shared `SessionArchiveCoordinator` lease for the
complete location check, transcript reconstruction, and formatting operation.
Archive, unarchive, and delete retain exclusive leases, so a transition either
starts before export and rejects it or starts after the shared lease releases.
The coordinator remains conservatively keyed by session id across workspaces.

## Compatibility and Verification

The active workspace export route, `workspace_session_export` capability,
legacy primary export, archive mutations, and persistence layout are unchanged.
Direct SDK callers receive the normal HTTP error when the new method targets an
older daemon.

Tests cover capability advertisement, id and cwd selectors, all formats,
attachment metadata, active/missing/conflict/transition states, trust
precedence, same-id workspace isolation, absence of bridge activity, both lock
directions, core archived reconstruction, telemetry attribution, and native
REST SDK transport. Size tests accept the exact archived limit and reject a
sparse file one byte above it before transcript materialization.
