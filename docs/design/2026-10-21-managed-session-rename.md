# Managed Session Rename

[English](2026-10-21-managed-session-rename.md) | [简体中文](2026-10-21-managed-session-rename.zh-CN.md)

## Problem and current behavior

Managed WebShell displays a Session title but cannot change it. New empty
Sessions therefore keep their generated ID as their visible name. The Java
service already implements authorized, idempotent, fenced Session renaming and
persists the confirmed Harness title. Daemon WebShell already offers manual
renaming, including a small dialog for standalone Sessions.

## Proposed changes

Extract the existing standalone Session rename form into a shared
`SessionRenameDialog`. Both daemon standalone recents and Managed use this
dialog: Enter saves, Escape or Cancel dismisses, blank names cannot be saved,
and the input accepts at most 256 UTF-16 code units. Managed exposes Rename
beside the current title and opens the same editor when the title is
double-clicked. A busy request cannot be submitted twice.

Add the optional provider method `renameSession(sessionId, displayName,
options)`. The Java provider maps `displayName` to the backend's `title` field
and returns the server-confirmed name. This matches daemon's action name and
manual rename semantics without coupling the Managed provider to daemon
transport or Session ownership.

Add the selected-Session WebShell route
`POST /api/agent/web-shell/v1/sessions/rename`. It accepts `sessionId`, `title`,
and an `idempotencyKey`, and delegates directly to the existing
`ManagedAgentService.renameSession`. Its small result contains `sessionId`,
`title`, and `replayed`; it is projected from the mutation result without a
second visibility query. Update the canonical OpenAPI document, generated
client types, surface registry, and contract tests together. The local front
door continues to expose only its existing WebShell surface.

Advertise a separate rename capability in Session summaries, using the same
authorization and runtime support requirements as the existing service. Missing
capability means that the Managed editor is unavailable. Do not infer rename
permission from `canSend`: an active Turn does not itself prevent renaming.

## State and failure handling

Update the selected summary and navigation title only after a confirmed
success. Refresh the list after success, and invalidate title reads that began
before the confirmation so that a late snapshot cannot restore the old name.
Retain the confirmation even while a manual reload temporarily has no summary.
Project `session.updated` as a summary-refresh event so changes made by another
client also become visible.

Bind each edit and request to its provider and Session. Switching Sessions or
providers dismisses that editor; an old reply cannot rename the new selection,
close a new editor, or display an error against it. Keep one idempotency key
for retries of the same submitted name. Editing the name creates a new intent.
Errors remain visible in the editor and do not claim that a rename succeeded.
Closing an editor after submission dismisses the UI; it does not cancel an
admitted rename. Its late result is applied only while the original Session
remains selected.

The existing Java mutation confirms Harness persistence and SQL settlement
before returning HTTP 200. HTTP 503 or a lost connection can leave the outcome
unknown; retrying the same name reuses its key. No new optimistic success,
background operation, database update path, or recovery repair is introduced.
Existing authorization and tombstone replay behavior remain authoritative.

## Affected areas and scope

Changes are limited to the shared dialog and its daemon standalone caller,
Managed UI/provider/client and summary/event synchronization, the Java
WebShell adapter and capability projection, API contracts, and focused tests.

Automatic naming and daemon's `/rename --auto` command delegation are outside
this change. Session IDs, Workspace names, prompt drafts, active Turns,
credentials, and Workspace project files are not changed by renaming. No database
migration or new dependency is needed.

## Validation and acceptance criteria

The E2E plan is `.qwen/e2e-tests/managed-session-rename.md`. Baseline checks use
the globally installed CLI and an isolated previous lightweight distribution.
Post-change checks use a matching new CLI and Java runtime against isolated
local storage, including the real browser UI.

- Rename a new empty Session and a Session with an active Turn; the confirmed
  name appears in the header, navigation, and subsequent API reads.
- Enter saves; Escape and Cancel before submission preserve the stored name; blank names do not
  submit. The shared daemon dialog retains these interactions.
- Reload and restart preserve the new name.
- Invalid names, unauthorized callers, unsupported runtimes, and unknown
  outcomes do not produce a false success. Same-intent retries reuse the key.
- Late summary/list/request replies cannot revert a confirmed name or affect
  a different selected Session or provider.
- The new route satisfies the canonical API, surface admission, and existing
  rename authorization/idempotency contracts.

## Open questions

None. Implementation and validation results are recorded separately from this
design and do not imply acceptance of untested runtime or operating-system
paths.
