# Workspace sidebar controls

[English](workspace-sidebar-controls.md) | [简体中文](workspace-sidebar-controls.zh-CN.md)

## Problem and scope

The workspace header can hide the entire list, and workspace menus can move a
workspace up or down. Users also need a bulk expansion control and direct drag
sorting. This change covers the connected daemon's project workspaces; other
hosts, managed workspace content, Live, Pinned and Recent retain their existing
behavior. Workspace ordering is shared by browsers connected to the same daemon
and survives daemon restarts. Expansion remains a browser-local preference.

## Design

Add an accessible expand/collapse icon beside the workspace heading. If any
workspace is expanded, collapse all; otherwise expand all and reveal the outer
list. Expansion shows the existing five-session preview, resetting Show more.
Individual workspace controls and persisted expansion preferences remain usable.
Expansion preferences follow a workspace across primary/secondary role changes.
The primary row writes the workspace id as well as the `primary:<cwd>` slot key,
which only bridges the period before the registered workspace list names that
id.

Allow dragging a workspace header onto another header, inserting before or
after its midpoint. Keep menu-based Move up/down as the keyboard-accessible alternative.
Do not accept external drags or drag starts from workspace action buttons.

Persist the cwd order as optional `workspaceOrder` metadata in the existing
workspace registration snapshot. Reuse its file lock, atomic write, size bound
and primary-workspace-scoped file under the Qwen home. Do not reorder the
registration array or runtime registry: their order has startup semantics.
Missing workspaces are ignored for display; GET returns that currently
managed subset so a read is a valid write body; newly added workspaces append.

Expose authenticated `GET /workspace-order` and strictly guarded
`POST /workspace-order` with `{ cwds: string[] }`. POST follows the daemon's
existing cross-origin method policy without widening the shared auth surface.
These routes own process-global
presentation metadata persisted under the primary workspace, and never select
or execute a workspace runtime. Validate bounded, absolute, unique cwd paths;
writes only accept currently visible project workspaces. They do not grant
trust, register paths or access the requested directories. Writes participate
in shutdown draining and fail explicitly when storage is unavailable or fails.

Advertise `workspace_order` when persistent workspace registration storage is
available. The SDK supplies the two REST methods. The sidebar loads the server
order before allowing changes; browser values cannot overwrite it. Both drag
and menu actions use one save path. Show changes immediately, prevent overlapping
saves, and restore the previous order with an error on failure. Discard stale
responses after switching daemon or primary workspace. Changing the primary
workspace at the same origin reloads its server order before allowing sorting;
legacy local storage remains scoped only by origin.
A failed initial load blocks sorting until a
subsequent load succeeds. Older daemons without the capability retain local
storage behavior. Do not automatically migrate browser preferences: opening an
old browser must not overwrite another browser's shared order. Cross-browser
sharing is verified on load; live synchronization of already-open tabs is out
of scope.

During a drag, temporarily hide mounted session bodies and show closed folder
icons without changing expansion preferences or preview state. A completed or
cancelled drag restores each workspace's original display, including Show more,
group expansion, search results and the sidebar scroll position. Persist only
a valid drop. Locked single workspace views do not offer sorting.

Defer temporary collapse until the native drag has started: synchronously
moving a lower source header during `dragstart` cancels Chromium's drag.
Cancel this deferred update if the drag ends or the sidebar changes host or
primary workspace. Clear cached expansion observations when either scope changes.
If the source workspace disappears or sorting becomes unavailable, cancel the
pending or active drag and restore the remaining workspaces' original display.

## Affected files and risks

Update `WebShellSidebar.tsx`, its CSS module, `WorkspaceSection.tsx`,
`workspaceOrder.ts`, the registration store and management routes, daemon
capabilities/protocol documentation, the SDK, translations and focused tests. Keep primary
sessions (rendered by the sidebar) and secondary sessions (rendered by their
sections) in sync. Stable workspace keys preserve component state on reorder.
Native HTML drag sorting targets mouse/trackpad browsers; touch users retain the
existing move menu. There are no new dependencies.

## Validation and acceptance

- Bulk collapse leaves workspace headers visible; expand shows five sessions.
- Individual expansion and bulk actions persist using existing storage keys.
- Dragging collapses every connected workspace, including search results.
- Drop above/below a row changes and persists order; reload restores it.
- Clear browser storage or use a fresh browser context: server order remains.
- Restart the daemon with the same primary workspace: server order remains.
- Restart at the same origin with a different primary: the existing page loads
  that primary's saved order, discarding pending results from the old primary.
- Invalid writes, storage failures and unavailable persistence fail explicitly;
  stale responses cannot cross daemon boundaries. Saves are serialized.
- Registration membership, startup order and expansion preferences stay intact.
- Cancellation, an outside drop and self-drop preserve order and display state.
- Removing the source before or after temporary collapse restores the remaining
  workspaces without persisting a new order or expansion preferences.
- Show more and mixed expansion states survive sorting.
- Unit tests, Chromium E2E with a mock daemon, visual screenshot inspection,
  repository build and typecheck pass. Mock evidence does not validate real Git
  backend operations. The global CLI baseline is checked before implementation;
  its older version may not expose this browser surface.

## Open questions

None.
