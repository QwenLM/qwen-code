# Web Shell workspace overview (sidebar)

Issue: https://github.com/QwenLM/qwen-code/issues/10399
Design: `docs/design/web-shell/web-shell-workspace-overview.md`

## Baseline

- `main` @ d853f09f: a workspace row shows the folder name, untrusted /
  read-only badges and a git chip. The `⋮` menu has one entry, Remove
  workspace, and only on removable secondary workspaces.
- The daemon already answers `GET /workspaces/:w/{mcp,skills,extensions,channels,memory,hooks}`
  and `PATCH /workspaces/:w` (rename) and `POST /workspaces/:w/reload`.

## Local setup

1. `npm run build` from the repository root so `dist/cli.js` bundles the
   Web Shell from this branch.
2. Isolated `QWEN_HOME` with a settings.json that registers one stdio MCP
   server that cannot start (for example `command: /nonexistent`) plus one
   that can, and at least one project skill under `.qwen/skills`.
3. `node dist/cli.js serve --workspace <primary> --workspace <secondary>`
   on loopback; open the served Web Shell.

## Scenarios

### Header counts and chips

Expand the primary workspace with one session running a prompt.

Expected:

- The folder header shows `●1` (success tone) and the total session count; a
  session waiting for permission adds a warning-tone count.
- Under the header: the full path, then chips `MCP a/b · Skills n ·
  Extensions n · Channels n · Context n`. The MCP chip is warning-toned and
  its tooltip names the failed server count.
- Before the ACP child has initialized (fresh daemon, no session yet) the
  MCP / Skills / Context chips show `—` with tooltip "not initialized yet",
  never `0`.

### Request gating

With the Network panel filtered to `/workspaces/`:

- A collapsed workspace issues no facet requests.
- An expanded one issues one request per facet on expand, on window focus and
  every 30 s while the tab is visible; nothing while the tab is hidden.

### Workspace menu

Hover a trusted secondary workspace and open `⋮`.

Expected:

- Rename… (only when the daemon advertises `dynamic_workspace_registration`),
  Copy path, New task, New worktree task, Reload runtime, Remove workspace.
- Rename opens a dialog prefilled with the current display name; saving
  updates the row label without a reload; clearing the name restores the
  folder name.
- Copy path puts the absolute path on the clipboard.
- Reload runtime issues `POST /workspaces/<cwd>/reload` and refreshes the
  chips.
- New worktree task opens a new draft with the composer's git mode set to
  worktree.

On the primary workspace the menu additionally shows a Manage group (MCP
servers, Skills, Extensions, Channels, Settings) with the chip counts; each
opens the corresponding page. Secondary workspaces do not get the group.

### Embedding switch

Mount `<WebShell sidebar={{ workspaceOverview: false }} />`.

Expected: folder headers, path line, chips and Projects count are gone; the
`⋮` menu still offers the non-overview actions.

## Automated coverage

- `packages/web-shell/client/components/sidebar/{workspaceOverviewModel,useWorkspaceOverview,WorkspaceOverview,WorkspaceMenu,WorkspaceRenameDialog}.test.*`
- `packages/web-shell/client/components/sidebar/WebShellSidebar.workspace-removal.test.tsx`
  (menu gating, rename, reload, management targets)
- `packages/web-shell/client/e2e/web-shell.workspace-overview.spec.ts`
  (chips, counts, request gating, menu contents against the mock daemon)
