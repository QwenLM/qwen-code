# WebShell Non-Primary Session Archive Hardening

## Summary

WebShell already lists active and archived sessions from registered secondary
workspaces, and the daemon already exposes workspace-qualified archive routes.
This change completes the existing UI path without changing the archive API,
SDK types, persistence format, or delete behavior.

## Capability and Trust Boundaries

Archive UI requires `session_archive`. A secondary workspace additionally
requires `workspace_qualified_rest_core` and a trusted runtime. A trusted
secondary active row exposes only Archive; its existing load-only treatment for
pin, group, rename, export, and delete remains unchanged. Archived catalogs are
not queried when the required capabilities are absent.

## Identity and Reconciliation

Merged WebShell collections and transient row state identify a session by
`(workspaceCwd, sessionId)`. This applies to deduplication, React keys, current
selection, busy state, unread completion, and export-in-flight state, so equal
session ids in different workspaces remain independent.

Workspace-qualified archive and unarchive responses may report per-session
failures in a successful HTTP response. WebShell surfaces a matching
`errors[]` entry and always reconciles the primary active and archived catalogs
plus the selected workspace catalogs after the operation settles. Idempotent
`alreadyArchived` and `alreadyActive` outcomes remain successful.

## Verification

WebShell tests cover successful and partial-failure responses, missing
capabilities, untrusted workspaces, idempotency, equal-id current and busy-state
isolation, and post-operation reconciliation. A daemon regression archives and
unarchives an equal-id secondary session while verifying that the primary file
and bridge remain untouched.
