# Workspace-Qualified Session Export

## Summary

Issue #6378 requires clients to export a persisted session from an explicitly
selected registered workspace. The existing `GET /session/:id/export` route is
intentionally bound to the primary workspace, so reusing it for a secondary
session either returns `404` or can select the wrong transcript when the same
session id exists in more than one workspace.

This change adds
`GET /workspaces/:workspace/session/:id/export?format=html|md|json|jsonl`, the
`workspace_session_export` capability, a matching `WorkspaceDaemonClient`
method, and supporting documentation. The legacy route remains primary-bound.

## Contract

The workspace selector follows the existing plural-route rule: exact registered
workspace id first, then a URL-encoded absolute cwd after canonicalization. The
selected runtime must be trusted. Resolution and trust checks happen before
session or format validation.

The route reads only the selected workspace's active persisted JSONL. It does
not search another workspace, fall back to primary, resolve a live owner, start
ACP, attach a client, or load workspace settings. Archived sessions remain
unavailable. Success uses the same formatter, filename sanitization, MIME type,
cache policy, and attachment headers as the legacy export route.

Errors preserve the existing export/storage shapes, with
`400 workspace_mismatch`, `403 untrusted_workspace`,
`400 invalid_export_format`, `404 session_not_found`, and the existing
`409 session_archived`, `session_archiving`, and `session_conflict` contracts.

## Capability and Compatibility

`workspace_session_export` is an unconditional v1 capability because the plural
route is useful for a trusted single-workspace primary selected by id or cwd.
Trust is still evaluated per request. The new tag is independent of
`multi_workspace_sessions` and cannot be inferred from `session_export` or
`workspace_qualified_rest_core`; released daemons advertise both older tags but
do not implement this route.

Direct SDK callers receive the normal HTTP error when they call the new method
against an older daemon. Web Shell integration is outside this change, so its
existing primary-only export behavior remains unchanged.

## Concurrency and Security

Export retains the existing shared archive-coordinator lock keyed by session
id, so archive and delete cannot move or remove the file during replay. The
coordinator remains conservatively global: identical ids in different
workspaces may serialize even though their files are independent. Renaming all
archive/delete lock keys is outside this change.

Unlike the bounded persisted transcript pager, full export materializes the
complete transcript and is not available to an untrusted secondary workspace.
The existing trusted export has no new response-size budget; adding a
workspace-specific limit would make the plural and legacy format contracts
diverge. Daemon bearer authentication, the default GET read-rate tier, and
per-request workspace trust checks continue to apply.

Runtime removal races use the runtime selected at request resolution. Removal
does not delete transcript storage, so export needs no runtime lease and does
not keep an ACP child alive.

## SDK and Observability

`WorkspaceDaemonClient.exportSession` reuses the existing export result and
format types and always uses native REST, including when the parent client has
an ACP transport. The shared request helper preserves token, client identity,
timeout, error parsing, content type, and attachment filename behavior.

Daemon telemetry normalizes the new path as
`GET /workspaces/:workspace/session/:id/export`, decodes the session id, and
uses middleware workspace resolution for the selected workspace hash.

## Alternatives Rejected

- Routing the singular export by live owner fails for inactive persisted
  sessions and makes ownership ambiguous after restart.
- Adding a `cwd` query to the legacy route changes a primary-only compatibility
  contract and is less consistent than existing plural workspace routes.
- Falling back to primary on a miss can export a different workspace's session
  when ids collide.
- Allowing untrusted full export would bypass the bounded read policy designed
  for the persisted transcript pager.

## Verification

Tests cover capability advertisement, id/cwd selectors, same-id isolation,
every format, response headers, trust and archive boundaries, missing/unknown
targets, absence of bridge activity, telemetry attribution, SDK transport and
encoding, and archive/delete coordination. End-to-end verification uses
isolated runtime and workspace directories with deterministic persisted
transcripts.
