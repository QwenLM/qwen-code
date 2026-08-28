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
  catalog page shows as `N+`.
- The name carries the full path as a tooltip. While the section is expanded
  the path is printed under the header.
- The Projects label shows the number of registered workspaces once there is
  more than one.

### Facet chips

While a trusted workspace is expanded, a chip row summarizes MCP servers
(`connected/enabled`), skills (enabled), extensions (active, or
`active/total` when they differ), channels (`connected/configured`) and
context files (count). Hooks are available but off by default.

- MCP, skills, context and hooks are discovered by the workspace's ACP child.
  Until it reports `initialized`, the chip shows `—` and the tooltip says the
  runtime is not initialized yet. A placeholder is never rendered as `0`.
- The MCP chip takes the warning tone when a server errored or discovery
  finished with an enabled server still not connected; the channels chip when
  an instance is in the error state.
- Below the sidebar's tight width the chips drop their text labels.
- Chips are read-only. Opening a management page is a menu action, so the
  chips never take the button role and their accessible names cannot collide
  with the navigation buttons that share the same words.

### Workspace menu

The hover `⋮` on a workspace row replaces the single-item removal menu:

- Rename… (dynamic registration daemons; opens a dialog; an empty name falls
  back to the folder name), Copy path, New task, New worktree task.
- Manage: MCP servers, Skills, Extensions, Channels, Settings, with the chip
  counts next to the first four.
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
call fails independently — an older daemon without a route, or a transient
error, leaves that facet `undefined` and keeps the others. A facet keeps its
last known value across a failed round.

Fetching is gated on the section being expanded and the workspace trusted, and
polls every 30 s only while the document is visible, plus a refetch on window
focus and on the sidebar's reload token. Collapsed rows cost nothing.

Session counts come from the catalog page the row already lists; the primary
workspace, whose sessions the sidebar lists itself, gets its counts passed in.

## Embedding

- `sidebar.workspaceOverview: false` keeps the plain folder headers;
  `{ items: [...] }` selects the chips.
- `onOpenWorkspaceManagement(target, workspaceCwd)` and
  `onNewWorktreeSession(workspaceCwd)` are new sidebar callbacks; the app
  wires them to `openPanel` and to a new session armed with worktree intent.

## Follow-ups (layers B and C in the issue)

- Bind the management pages to a chosen workspace so every row can open its
  own MCP / Skills / Extensions view.
- A Workspaces overview page with a table across workspaces.
- `GET /workspaces/:w/overview` on the daemon to collapse the fan-out into one
  request, advertised as `workspace_overview`, once the workspace-runtime
  stack has landed.
