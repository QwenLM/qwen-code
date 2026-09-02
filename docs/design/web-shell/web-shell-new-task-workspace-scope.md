# Web Shell New task workspace scope

## Problem

The sidebar's global **New task** action currently sends an unscoped creation
intent. On daemons that support standalone sessions, that always starts a
standalone draft even when trusted workspaces are available. Creating a task in
a particular workspace is possible only from that workspace's row, which is
easy to miss and makes the primary action inconsistent with the project-first
sidebar.

## Behavior

The global action becomes a split button when more than one usable scope is
available:

- The main button starts a task in the current trusted workspace. If the
  current context is standalone or has no trusted workspace, it falls back to
  the trusted primary workspace.
- The adjacent menu starts a task in any trusted, non-Live workspace.
- **No workspace** is an explicit menu action only when the daemon advertises
  standalone sessions.
- Untrusted and Live workspaces are never creation targets.

With only one usable scope, the control remains the existing single button.
Locked-workspace embeds therefore continue to create only in their locked
workspace, and older daemons without standalone support continue to create in
the primary workspace. In the collapsed sidebar, the compact icon keeps the
default one-click action; expanding the sidebar exposes the scope menu.

The empty-state composer mirrors the same scope choice in its workspace menu.
When standalone sessions are supported, **No workspace** appears alongside the
trusted workspace choices even when only one workspace is registered. Choosing
it switches the unsubmitted draft to standalone without creating a session;
the first prompt performs the existing lazy standalone creation. The selector
stays visible on that standalone draft so the user can see the active scope and
switch back to a workspace before sending. Locked-workspace embeds and settled
standalone sessions do not expose this retargeting control.

Selecting a menu item starts the draft immediately. The menu does not introduce
a second persistent workspace-selection state: `App` remains the authority for
the effective session context, while the sidebar only forwards the selected
cwd (or the existing unscoped value for standalone).

## Failure and trust boundaries

The existing new-session re-entry guard, busy state, error reporting, and
catalog invalidation remain shared by the main button and every menu action.
Workspace catalog refreshes stay cwd-qualified. The standalone action keeps
passing no cwd, so it does not refresh the primary workspace catalog.

## Workspace management from a standalone task

Choosing **No workspace** keeps the conversation standalone, but it does not
remove the daemon's workspace administration entry points:

- **Plugins** remains visible when a trusted primary workspace exists. Opening
  it manages that primary workspace and labels the target explicitly. It does
  not change the current conversation context. Project skills can be managed,
  but cannot be inserted directly into the standalone composer.
- **Scheduled Tasks** remains visible and keeps its existing trusted-workspace
  aggregation and workspace picker. Opening the page does not change the
  current conversation context. Bound runs and history navigation carry the
  task's explicit workspace back to the session loader. A legacy unbound task
  fails closed outside its owning workspace instead of running in the
  standalone conversation.

Channels, Goals, Git, worktrees, workspace settings, and workspace-scoped slash
commands remain unavailable without an active workspace conversation. Live
contexts also keep all workspace-management entries hidden. If there is no
trusted primary workspace, the standalone management entries stay hidden
instead of silently targeting an untrusted workspace.

## Verification

- Component tests cover the trusted-current default, primary fallback,
  explicit workspace and standalone menu actions, filtering, catalog refresh,
  legacy capability behavior, locked-workspace behavior, and the composer's
  **No workspace** scope.
- Standalone Playwright coverage explicitly chooses **No workspace** from the
  empty-state composer and checks the exact standalone route.
- Workspace Playwright coverage clicks the main action and checks the exact
  workspace cwd sent to session creation.
- Manual cold-start verification switches among workspace and standalone
  conversations and confirms the sidebar remains usable after each send.
- Standalone navigation tests confirm Plugins and Scheduled Tasks stay visible,
  display their workspace scope, preserve `context=standalone`, and issue no
  session-creation request merely by opening a management page.
