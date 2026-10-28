# Managed main Session worktrees

[English](2026-10-28-managed-session-worktrees.md) | [简体中文](2026-10-28-managed-session-worktrees.zh-CN.md)

## Status and scope

Implementation of the local first version, based on `32f6713ce6`. New main
Sessions may opt into a separate Git worktree. The default remains the current
directory. Supported storage is LOCAL on macOS/Linux, with a durable,
Session-isolated local-process Runtime. SSH, CSI, reopening closed Sessions,
automatic merging and switching a running Session between worktrees are outside
this change. Worktrees isolate edits, not host permissions or shared Git refs.

## Ownership and persistence

The existing ROOT Workspace continues to own grants and storage. A one-to-one
`ma_session_worktree` records the Session, actor, storage identity, repository
common directory, source offset, target root/cwd, initial branch, frozen commit,
state and revision. Preparation and cleanup use durable `ma_operation` commands.
The identity outlives closing, archiving and deleting the chat.

The server allocates `.qwen-managed-worktrees/<id>` below the storage root and
`worktree-managed-<id>` as the initial branch. Ownership metadata lives outside
the checkout. The actual cwd preserves the source's repository-relative offset;
that directory must exist in the selected commit. Repository and Git metadata
must stay within the authorized storage. A linked source whose common directory
escapes that root is refused; mounts are never enlarged automatically.

## Creation and execution

1. Replay the actor-scoped create receipt before checking availability or
   resolving HEAD. The digest includes the requested mode/ref; the first
   admission separately freezes the resolved commit.
2. Read-only preflight validates source access, storage identity, Git layout and
   ref. It does not create branches or directories.
3. One transaction revalidates source identity and inserts the Session with its
   final target binding, worktree identity, preparation command, optional first
   Turn and create receipt. Context revision starts at one.
4. A claimed worker obtains the physical storage maintenance hold, creates from
   the frozen commit and validates the resulting identity before marking ready.
   Storage busy defers without consuming the failure budget.
5. Only ready worktrees admit warm, attach, dispatch, new input or file access.
   Cancellation and lifecycle draining remain possible before readiness.

Worktree state is orthogonal to Session status: `preparing`, `ready`, `failed`,
`blocked`, `removing`, `removed`. Closing during preparation never starts the
Runtime afterwards, even if Git completed. Known preparation failure fails the
initial Turn. Retry answers the same identity rather than allocating a new one.

Ordinary Sessions retain the existing shared execution model. Preparation and
cleanup exclusively maintain the whole physical storage and may wait for other
executions. Reuse the existing safe Git runner and layout checks, but not child
worktree recreation, forced discard or merge semantics.

## Recovery and cleanup

Ready Sessions validate the original checkout, registration, common directory
and ownership on use. Normal edits, commits and branch renames do not trigger a
reset. The source checkout need not survive. Missing or replaced targets block
execution and never fall back to the source. Cwd changes stay within the target.

Claim expiry is not physical stop evidence. Unknown Git execution retains the
maintenance hold and enters blocked until existing stop evidence permits
reconciliation. macOS automatic recovery from a JVM killed during Git is not
introduced. A recheck cannot force-release that hold.

Close/archive/delete preserve the checkout. Cleanup requires the recorded owner,
current Workspace write permission, a terminal Session and drained Runtime,
children, uploads and preparation. Under the maintenance hold it rechecks
ownership, tracked/untracked/ignored files, unfinished Git operations and nested
repositories/submodules. Current HEAD must remain reachable from a retained
normal branch/tag/remote ref. Cleanup uses non-force removal and never deletes
branches. Refusal preserves the checkout. Retained worktrees block physical
storage migration/deletion; completed historical children do not block forever.

## API, files and WebShell

Session creation accepts optional `worktree: {baseRef?}` (`base_ref` publicly).
Omission selects the current directory; an empty object selects HEAD. The
server chooses paths and branch names. Session GET/list includes a descriptor.
Session pages join the durable worktree rows in the existing page query, then
verify only the selected rows after closing the result set. The ordinary list
query budget stays unchanged, and invalid ready identities are durably blocked.
Workspace-scoped options, query, inspect and cleanup operations expose support,
retained checkouts, progress and idempotent cleanup, including deleted chats.
Read access follows Workspace grants; deletion additionally checks ownership
and write access.

File requests accept exactly one locator: Session ID, or Workspace ID plus cwd.
The former resolves the durable binding and includes worktree revision in the
scope revision. The latter remains for pre-creation browsing and cannot enter
private worktree paths. Only server-resolved Session bases may bypass the
private-base restriction; user-relative paths keep their existing validation.

WebShell offers current directory/worktree and an optional starting ref, shows
the resolved commit and exclusion of dirty files, freezes pending submissions
and reports preparing, waiting, failed or blocked states. Directory references
and uploads pause before a selected worktree exists; ordinary input attachments
remain available. Ready Sessions restore file capabilities against their target.
Stale directory references require reselection while retaining the text draft.

Target cwd supplies project instructions. Models, approval policy, Skills, MCP
and Extensions retain existing Session pinning. No ignored configuration,
environment files, dependencies or symlinks are copied. Child agents may still
derive and merge into this main worktree. Workspace management lists retained
worktrees with inspect and cleanup actions.

## Rollout and validation

`session-worktrees-enabled` defaults off for deployments. The controlled local
launcher enables supported hosts. Missing/unsupported Git disables this option,
not current-directory Sessions. Disabling new worktrees does not disable
execution, inspection or cleanup of existing identities.

Update canonical V1 SQL, strict schema validation, OpenAPI, surface contracts and
generated WebShell types together; no V2 migration or schema version bump.

Acceptance covers independent concurrent edits, create replay after HEAD moves,
dirty source preservation, preparation interruption and stop evidence, close
races, target loss, authorization revocation, file/upload scope, safe cleanup
after branch changes and child merge routing. Use focused unit/contract tests,
real MySQL 8.4 and real Git/Runtime/browser checks on supported platforms. Record
unavailable platform/fault coverage explicitly. Java local validation shares the
module's ten-minute budget; full matrices remain in CI.
