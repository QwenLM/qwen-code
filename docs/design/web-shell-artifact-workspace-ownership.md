# Web Shell artifact workspace ownership

Status: implemented and verified

Issue: https://github.com/QwenLM/qwen-code/issues/8494

## Problem

The Web Shell has one app-level `DaemonWorkspaceProvider`. Its default
workspace actions target the primary workspace. Session providers can attach to
secondary workspaces, but artifact surfaces currently retain or fall back to
the app-level actions. A file preview, download, review, nested subagent
artifact, or scheduled-task mutation can therefore reach the primary runtime
even though the producing session belongs to a secondary workspace.

The unsafe fallback also survives ownership changes: action objects are stored
in right-panel tabs, so removing or distrusting a workspace does not invalidate
an already-open tab.

## Ownership contract

The producing session owns every turn output. Its `workspaceCwd`, resolved by
the session connection, is the source of the owner claim. The current daemon
capabilities are the authority that accepts or rejects that claim.

A target is usable only when one of these cases holds:

1. Exactly one advertised workspace has the same cwd and is trusted.
2. For a legacy single-workspace daemon with no workspace list, the cwd exactly
   matches `capabilities.workspaceCwd`.

Unknown, duplicate, untrusted, removed, or identity-mismatched targets fail
closed. They never fall back to the primary workspace.

## Design

### Resolve at use time

Turn-output requests and right-panel tabs carry immutable owner identity
(`workspaceCwd` and the advertised `workspaceId`) instead of long-lived action
objects. `ArtifactPanel` resolves that identity against current capabilities on
every render. This makes workspace removal, trust loss, and runtime replacement
invalidate open tabs immediately.

The resolver returns a small artifact action surface only:

- `readWorkspaceFile`
- `readFileBytes`
- `stat`
- scheduled-task list/update/delete operations

Primary targets reuse the provider's primary actions. Trusted secondary
targets use `client.workspaceByCwd(cwd)` for file operations. Scheduled-task
operations still use the Web UI REST actions, but always receive the resolved
workspace id explicitly.

### Propagation

- `TurnOutputs` derives the owner from its session `workspaceCwd`, uses the
  scoped file actions for direct downloads, and stamps owner identity onto
  review, artifact, and scheduled-task open requests.
- `ChatPane` and `SubagentDetail` preserve the request identity and add only the
  producing session id. They no longer stamp root workspace actions onto the
  request or artifact snapshot.
- `App` stores owner identity on each right-panel tab. Pane artifact snapshots
  contain artifacts only; they no longer retain workspace clients.
- `ArtifactPanel` renders the existing workspace-unavailable state when the
  owner cannot be resolved or no longer matches. It never substitutes
  `useWorkspaceActions()` for a missing owner.
- Durable scheduled-task snapshots carry `workspaceId`, and every list,
  update, toggle, and delete request passes that id.

### Async invalidation

Scoped action wrappers check that their captured owner is still current before
starting an operation and again after each response. Effects and scheduled-task
mutations also ignore results after unmount or owner replacement. A response
started for one runtime cannot populate a tab after that runtime is removed or
replaced.

## Non-goals

- No daemon route or workspace-registry semantics change.
- No primary fallback for compatibility on multi-workspace daemons.
- No redesign of artifact storage, session attachment, or scheduled-task data.
- No attempt to make arbitrary app-level workspace actions session-scoped;
  only the artifact surfaces in issue #8494 are changed.

## Verification

1. Failure-first component tests pin the current primary fallback and missing
   scheduled-task workspace id.
2. Resolver tests cover primary, trusted secondary, unknown, duplicate,
   untrusted, removed, and runtime-replaced targets.
3. Turn-output tests verify secondary downloads and open requests use the
   secondary owner.
4. Artifact-panel tests verify missing/stale ownership fails closed and all
   durable scheduled-task operations include `workspaceId`.
5. A production bundle is run against two registered local workspaces with
   distinct sentinel files/tasks. Captured requests must use the secondary
   workspace-qualified routes and leave the primary sentinels unchanged.
