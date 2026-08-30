# Web Shell workspace overview

Issue: https://github.com/QwenLM/qwen-code/issues/10399

## Goal

Make a workspace a first-class object in the Web Shell sidebar: show what it
contains and whether it is healthy without opening a session, and put every
workspace-level action behind its own menu. This is layer A of the plan in the
issue — a frontend-only change on top of daemon routes that already exist.

## Behavior

### Folder header

- The header keeps its name, badges and git chip. It gains session counts at
  its right edge: sessions waiting on the user (warning tone), sessions with a
  prompt in flight (success tone), and the total. A total from a truncated
  catalog page shows as `N+`. Collapsing a row disables its catalog query, so
  the row keeps the last counts it computed: they stay visible while collapsed
  and refresh on the next expand. While the query is active and a page is
  missing (a session-source switch), no counts are shown rather than stale
  ones above an empty list.
- The name carries the full path as a tooltip. While the section is expanded
  the path is printed under the header.
- The Projects label shows the number of registered workspaces once there is
  more than one.

### Facet chips

While a trusted workspace is expanded, a chip row summarizes MCP servers
(`connected/enabled`), skills (enabled), extensions (active, or
`active/total` when they differ), channels (`connected/configured`) and
context files (count). Hooks are available but off by default.

- MCP, skills and hooks are discovered by the workspace's ACP child. Until it
  reports `initialized`, the chip shows `—` and the tooltip says the runtime
  is not initialized yet. A placeholder is never rendered as `0`.
- Context files are read from disk by the daemon itself, so its answer is
  always definitive: a workspace without a QWEN.md shows `0`.
- The MCP chip takes the warning tone when a server errored or discovery
  finished with an enabled server still not connected; the channels chip when
  an instance is in the error state.
- Below the sidebar's tight width the chips drop their text labels.
- Extensions, channels and context files are daemon-side facets. When they
  are unknown the daemon lacks the route or the fetch failed, so their tooltip
  says "unavailable on this daemon" rather than "not initialized yet". The
  chip row itself appears only once the first fetch round has landed, so a
  round still in flight never reads as a missing route.
- Chips are read-only. Opening a management page is a menu action, so the
  chips never take the button role and their accessible names cannot collide
  with the navigation buttons that share the same words.

### Workspace menu

The hover `⋮` on a workspace row replaces the single-item removal menu:

- Rename… (dynamic registration daemons, on registration-backed rows only —
  the daemon's bound workspace has no registration to persist a name in;
  opens a dialog; an empty name falls back to the folder name and control
  characters are refused before the request is sent), Copy path, New task,
  New worktree task (only when
  the git poll reports a branch — a worktree needs a repository, and the
  composer would otherwise have no chip to show or undo the armed intent).
- Manage: MCP servers, Skills, Extensions, Channels, Settings, with the chip
  counts next to the first four (part of the item's accessible name). The
  menu keeps the row's last snapshot while the row is collapsed, so the
  counts do not vanish on collapse; the action area stays visible while its
  menu is open so Escape returns focus to the trigger.
- Reload runtime (`POST /workspaces/:w/reload`), then Remove workspace.

Each entry appears only when the workspace's state allows it: untrusted rows
that cannot be removed still show nothing, locked-workspace renderers still
suppress the whole action area.

The Manage group is offered on the daemon's primary workspace only. The
management pages read the connection's bound workspace, so a secondary row
cannot open its own view yet; that is layer B1 of the issue.

## Data flow

`useWorkspaceOverview(client, cwd, { enabled, items })` fans out over
`client.workspaceByCwd(cwd)` to `/mcp`, `/skills`, `/extensions`,
`/channels`, `/memory` and `/hooks`, one request per requested facet. Each
call fails independently — an older daemon without a route, a transient
error, or a malformed body — leaves that facet `undefined` and keeps the
others. A facet keeps its last known value across up to three consecutive
unanswered rounds, then reads as unavailable, so a route that stays gone
after a rollback cannot freeze a stale count on the chip. Rounds that time
out after the next tick has already replaced them still count: the SDK's
request deadline equals the poll cadence, so during a daemon hang every
round is superseded before it lands, and only their observed misses can
expire the facet.

Fetching is gated on the section being expanded, the workspace trusted and the
default header rendered (a locked sidebar's custom header has no chip or menu
to feed), and polls every 30 s only while the document is visible, plus a
refetch on window focus and on the sidebar's reload token. Collapsed rows cost
nothing, and a synthetic fallback workspace without a real cwd is never asked.

Measured against the mock daemon (`npm run dev`, React StrictMode, 5 trusted
workspaces all expanded, tab visible): after the initial round the sidebar
issued 25 facet requests per 30 s tick — 50 over 60 s — next to the 33
session-catalog and git-status requests the same rows already made in that
window. Without StrictMode the initial round is 25 requests, not 50. That is
the cost the layer-C overview endpoint collapses to 5 per tick.

Session counts come from the catalog page the row already lists; the primary
workspace, whose sessions the sidebar lists itself, gets its counts passed in.

## Embedding

- `sidebar.workspaceOverview: false` keeps the plain folder headers;
  `{ items: [...] }` selects the chips.
- `onOpenWorkspaceManagement(target, workspaceCwd)` and
  `onNewWorktreeSession(workspaceCwd)` are new sidebar callbacks; the app
  wires them to `openPanel` and to `createNewSession` with a worktree git
  intent. The intent is set in the same synchronous step that clears the
  previous one, so it belongs to that draft from the start: a prompt
  submitted while the clear is still in flight gets the worktree, and any
  later session start or draft workspace switch resets it like any other
  intent. An armed intent survives a transient git-status gap — only a
  session, an untrusted workspace, a no-branch answer or a draft workspace
  switch clears it, and an intent set while a session already exists is
  cleared immediately.

## Follow-ups (layers B and C in the issue)

- A Trust… menu entry. `POST /workspaces/:w/trust/request` only records a
  request that needs operator action and a daemon restart
  (`accepted: false, requiresOperatorAction: true`), so an entry today would
  promise a change it cannot make; it needs an "operator action required"
  feedback surface first.
- Bind the management pages to a chosen workspace so every row can open its
  own MCP / Skills / Extensions view.
- A Workspaces overview page with a table across workspaces.
- `GET /workspaces/:w/overview` on the daemon to collapse the fan-out into one
  request, advertised as `workspace_overview`, once the workspace-runtime
  stack has landed.
