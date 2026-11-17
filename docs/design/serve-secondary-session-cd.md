# Session cd in secondary workspaces

[English](serve-secondary-session-cd.md) | [简体中文](serve-secondary-session-cd.zh-CN.md)

## Problem and scope

Issue #15316 requests ordinary session directories without registering another
workspace or requiring Git. The existing `POST /session/:id/cd` already changes
one session's execution directory, but its legacy-primary routing rejects
sessions owned by dynamically registered workspaces.

The selected approach reuses this operation. It adds no session-root setting,
create/load field, workspace registration, directory creation, or file migration.
Existing instruction/skill refresh semantics are unchanged; this change does not
introduce a separately pinned configuration root.

## Routing and containment

Classify cd as **live-session-owner** scoped. Resolve the owning runtime through
the existing owner/trust/generation gates, then call only that runtime's bridge.
Unknown, ambiguous, untrusted, or unavailable owners must never fall back to the
primary bridge. Keep the existing archive and generation guards.

For a secondary workspace, supply the server-controlled `allowedRoots` containing
only its canonical workspace directory. The existing ACP handler verifies that
the absolute target exists, is a directory, and resolves inside this root before
changing the session. Client-supplied containment roots must be ignored. Ordinary
subdirectories and returning to the workspace root are allowed; symlink escapes,
other workspaces, and sibling directories are not. Existing folder-trust and
sandbox checks remain in force.

Keep primary-workspace cd behavior compatible, including its existing directory
selection policy. Do not expose cd for internal Conversations workspaces or SSH
workspaces, and do not broaden branch/fork support. Managed execution continues
to reject relocation in the existing agent handler.

Internal Conversations cd rejection retains the structured routing warning with
route, session, and owner context, without exposing internal workspace identity
in its HTTP response. SSH cd is rejected before bridge dispatch with HTTP 501
and `code: ssh_workspace_operation_unsupported`.

## Lifecycle and compatibility

The bridge's existing prompt queue orders cd against session prompts. ACP changes
only the session Config, not process cwd; session ownership and history storage
stay associated with the original workspace.

Callers create independent sessions with `sessionScope: 'thread'`, await cd, and
then submit prompts. After a restart they load the desired session under its
original workspace, await cd, and only then submit prompts; loading another
session is unnecessary. The caller owns backup and directory restoration.

This is not an atomic load-and-relocate API. Embedders using load followed by cd
must not enable automatic execution before relocation, including the optional
`restoreAskUserQuestion` behavior. The operation does not introduce filesystem
sandbox isolation between sessions or change existing skill discovery rules.

## Verification and rollback

Route tests cover secondary dispatch, server-owned roots, client identity,
independent sessions, load followed by cd, malformed paths, generation closure,
and owner failure states. ACP tests use real ordinary directories and symlinks
to verify containment without Git. Existing primary cd and internal-workspace
rejection tests remain applicable. Run focused CLI tests, build, typecheck, and
the headless daemon regression in
`integration-tests/cli/qwen-serve-session-cd.test.ts`. Containment failures return
HTTP 400 with `code: containment_violation` rather than an internal error only
for `POST /session/:id/cd`. Other routes and calls without route context retain
their existing HTTP 500 payload and daemon error reporting for that error kind;
this does not change worktree create/restore or managed relocation error signals.
Regression tests pin both the cd mapping and non-cd status/logging behavior.

Rollback consists of reverting this route change. No persisted schema, workspace
registrations, or files are migrated. Upstream maintainer review must approve the
new live-session-owner contract and secondary containment policy before merge.
