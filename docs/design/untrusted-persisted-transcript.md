# Untrusted persisted transcript reader

## Context

The daemon already exposes persisted-only session and group catalogs for registered untrusted secondary workspaces. Transcript paging remains unavailable because the legacy `GET /session/:id/transcript` route resolves a session owner through live bridge state and delegates replay to an ACP child. That path can start a process, load workspace settings and project-defined capabilities, and create or repair a persisted cursor signing key.

This design adds a separate workspace-qualified REST contract that reads only an active persisted transcript. The legacy route and its ACP-backed behavior remain unchanged.

## Contract

The daemon advertises the unconditional `workspace_persisted_transcript` capability and serves:

`GET /workspaces/:workspace/session/:id/transcript?cursor=<opaque>&limit=<1..500>`

The workspace selector resolves an exact registered workspace id first, then a URL-decoded portable absolute cwd. Unknown or unregistered selectors fail closed with `workspace_mismatch`. Trusted primary and secondary workspaces and untrusted secondary workspaces may read. An untrusted primary remains rejected to preserve the existing plural-route safe-mode boundary.

Only active persisted JSONL is read. Archived sessions return `session_archived`; active/archive conflicts return `session_conflict`; missing sessions return 404. The response reuses `DaemonSessionTranscriptPage` and contains id-less `session_update` frames produced by the existing visible history projection. Raw JSONL and hidden system records are never returned.

## Security boundary

The route must not call a bridge method, start or preheat ACP, load settings, parse agents or skills, discover tools, run external commands, create a persisted cursor key, or write a route-specific daemon/debug log. Existing daemon-wide HTTP access logging and telemetry remain outside this route-specific no-write guarantee.

Direct persisted transcript reads run with debug session logging suppressed. The archive coordinator holds a shared session lock across location checks, index construction, record reads, session-id validation and replay. Every returned record must carry the requested session id; a mismatch fails closed as a snapshot conflict.

The direct replay context contains only a session id, an update sink, optional message rewriting, and optional cumulative usage. Tool display metadata falls back to persisted tool name and description when no full `Config` is present. No project-controlled tool registry is consulted.

## Cursor lifecycle

The core reader accepts an explicit cursor codec. Existing callers continue to use the file-backed codec. The daemon creates one random master key per process, derives a separate 32-byte HMAC key from workspace id and canonical cwd, and caches an in-memory codec per registered runtime. Cursors from the new route therefore expire on daemon restart and cannot be replayed across workspaces.

The cursor freezes file identity, byte size, active leaf, replay position and replay state. Appends after page one do not change the snapshot. Delete, archive, truncate, replacement, leaf change, or session-id mismatch returns `transcript_snapshot_unavailable`.

## Failure and race handling

For the first page, the route checks active/archive location but still attempts the active reader when location is unknown so malformed active storage is not silently reported as missing. For cursor pages it validates only the frozen active snapshot. On `ENOENT`, a cursor page returns snapshot unavailable; a first page rechecks location to detect an archive race before returning missing.

Replay is page-transactional at the protocol boundary: updates emitted before a replay conversion failure are returned with `partial: true`, a generic replay error and no next cursor. Pending tool calls and cumulative usage are carried in the signed cursor only after successful replay.

## Compatibility and limits

The old singular route, persisted cursor key and ACP error mapping remain intact. The new route keeps the existing default page size of 100, maximum of 500, 256 MiB snapshot cap, 32-entry/64 MiB index cache and five-minute cache lifetime. The first index scan remains linear in the frozen snapshot size.

The TypeScript SDK exposes the method on `WorkspaceDaemonClient`. It forces native REST transport and has no ACP route mapping. Older daemons can be detected through the new capability and continue returning 404 for the route.

## Deferred work

Archived transcript reading, reverse/tail pagination, live follow, automatic full-history loading, worker-thread indexing, cross-restart cursors, and the Web Shell viewer are separate follow-ups.
