# Untrusted Workspace Read-only Session Catalog

## Summary

Multi-workspace daemons expose a narrow read-only catalog for registered,
non-primary workspaces whose boot-time trust state is `false`. The catalog
contains persisted session summaries and the session-organization sidecar. It
does not attach to a session, start an ACP child, merge live runtime state, or
interpret workspace-controlled capability definitions.

This is a route allowlist, not a workspace ACL. A client that holds the daemon
bearer token can read the allowed data for every registered workspace. Trust
continues to gate execution and mutation; it does not create a separate
authentication principal.

## Security Invariants

Every newly allowed untrusted-workspace read path must satisfy all of these
conditions:

- Do not call `loadSettings()` or any settings migration/repair path.
- Do not create, repair, rewrite, or otherwise modify storage.
- Suppress file-backed debug logging while the catalog reader is active so a
  malformed record cannot create or append a debug log as a read side effect.
- Do not call `ensureChannel()` or any other ACP child startup path.
- Do not query or merge the untrusted runtime's live bridge state.
- Do not execute external commands.
- Do not discover or parse workspace agents, skills, hooks, MCP configuration,
  or other project-controlled capability definitions.

The implementation enforces the live-state boundary with an internal
`mergeLive: false` read policy on all session-list shapes: default, organized,
and `parentSessionId` filtered. The same async read boundary suppresses only
file-backed debug logging for untrusted catalog reads; trusted requests and
logging outside that boundary are unchanged. Missing storage produces an empty
catalog, and malformed entries follow the existing best-effort read behavior
without repairing files.

## Route Matrix

The table describes an untrusted secondary workspace unless noted otherwise.

| Surface                                     | Result            | Data source and constraints                                                           |
| ------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------- |
| `GET /workspace/:id/sessions`               | 200               | Persisted session files only; id or encoded canonical cwd selector                    |
| `GET /workspaces/:workspace/sessions`       | 200               | Same persisted-only catalog                                                           |
| `GET /workspace/:id/session-groups`         | 200               | Organization sidecar only; any registered id or encoded cwd                           |
| `GET /workspaces/:workspace/session-groups` | 200               | Organization sidecar only                                                             |
| File read, bytes, stat, list, glob          | Existing behavior | Existing filesystem read policy is unchanged                                          |
| Workspace trust GET/request                 | Existing behavior | Existing trust configuration semantics are unchanged                                  |
| `/capabilities`, `/daemon/status`           | Existing behavior | Existing daemon diagnostics are unchanged                                             |
| Plural session/group mutations              | 403               | Mutation trust gate remains unchanged                                                 |
| Singular group mutations                    | Existing behavior | Remain primary-only; secondary selectors fail closed                                  |
| Settings, permissions, providers            | 403               | Settings loading may migrate, back up, or repair files                                |
| Memory                                      | 403               | Current response includes global-memory paths rather than a workspace-only projection |
| Env                                         | 403               | Exposes credential presence and proxy/host diagnostics                                |
| Preflight                                   | 403               | May execute git, npm, ripgrep, or other probes                                        |
| MCP, tools, hooks                           | 403               | Coupled to live bridge state or project configuration                                 |
| Skills, agents                              | 403               | Discovers and parses project-controlled definitions                                   |
| Transcript                                  | 403               | Current path can start ACP and cursor initialization can write an HMAC key            |
| Export, session status/context/tasks        | 403               | No workspace-qualified persisted-only implementation                                  |
| ACP HTTP/WebSocket, voice, channels         | Rejected          | Execution, process, or long-lived runtime capabilities                                |

Unknown absolute, nested, or unregistered workspace selectors continue to fail
closed with the existing `400 workspace_mismatch` response. A malformed legacy
singular selector retains its existing `400` validation message. Neither case
falls back to the primary workspace. Plural routes keep returning
`403 untrusted_workspace` for an untrusted primary workspace. Singular primary
routes retain their existing compatibility behavior.

## Session Catalog Semantics

The persisted-only mode retains the existing `archiveState`, `view=organized`,
`group`, `parentSessionId`, cursor, and page-size behavior. It never populates
pending interactions, turn errors, or client state from the live runtime;
existing persisted-summary defaults such as `clientCount: 0` and
`hasActivePrompt: false` remain wire-compatible. It never calls
`bridge.listWorkspaceSessions()`.

Trusted secondary and primary workspaces keep the existing persisted/live
merge. No route, wire field, schema, or capability tag is added: older clients
continue to handle `403`, while the bundled Web Shell consumes the new `200`
response when shipped with the daemon.

## Web Shell Behavior

An untrusted secondary workspace remains expandable and is labeled both
`untrusted` and `read-only`. Expanding it performs one catalog read. A
`reloadToken` change performs another read, but the usual ten-second poll is
disabled because this daemon cannot create sessions in that workspace.

Expanding does not select or activate the workspace. Persisted sessions are
rendered as non-interactive rows with `role="note"` and an accessible name that
includes the session name, date, and an explanation that the workspace must be
trusted before a session can be opened. The row does not bind mouse or keyboard
activation or receive active-session styling. Trusted workspace behavior is
unchanged. An untrusted primary remains disabled pending a separate primary
safe-mode design.

## Failure and Compatibility Behavior

- Missing session or organization storage returns an empty catalog.
- Unparseable and non-object JSONL records are skipped by the existing session
  reader. This change does not add schema validation for structurally invalid
  object records.
- An unreadable organization sidecar returns the existing empty read view and
  warning; reads do not repair it.
- Web Shell request failures retain the existing empty state and console
  warning.
- Trust GET continues to observe the current on-disk trust configuration and
  tells callers that runtime changes require restart. It is not converted to a
  boot snapshot in this change.

## Deferred Work

- A side-effect-free settings and trust snapshot loader.
- A workspace-only memory projection.
- Redacted environment and configuration inspection.
- Skills and agents inventory that does not parse project definitions.
- A daemon-local transcript reader that neither starts ACP nor initializes a
  cursor HMAC key, plus a truly read-only session viewer.
- Dynamic trust application, runtime rebuild, and workspace removal/draining.
