# Web Shell Workspaces overview panel (layer B2)

Issue: https://github.com/QwenLM/qwen-code/issues/10399
Design: `docs/design/web-shell/web-shell-workspace-overview.md`

## Baseline

- After #10407 (layer A) the sidebar shows per-workspace chips and a `⋮`
  menu, but there is no single place that lists every registered workspace
  with its health — the Projects section is the only aggregate view.

## Local setup

1. `npm run build` from the repository root.
2. `node dist/cli.js serve --workspace <primary> --workspace <secondary>`
   on loopback, with the secondary a git repository carrying local changes
   and one broken MCP server configured.

## Scenarios

### Entry points

- The Projects section ends with a "Manage workspaces…" row; clicking it
  replaces the chat view with the Workspaces panel (back arrow returns).
- Embedders can add the `workspacesOverview` footer item; it is not part of
  the default footer. A sidebar locked to one workspace shows no entry.

### The table

One row per registered workspace (daemon-owned `kind: 'live'` runtimes are
not listed):

- Name (display name or folder basename) with `primary` / `untrusted`
  badges; full path with tooltip.
- Sessions: active web-shell session count, `n running` / `n need
  attention` badges; `—` for untrusted rows. Counts refresh on a 30 s tick.
- MCP: `connected/configured` plus `n failed`; `—` until the runtime is
  initialized (never `0/0` for an idle placeholder).
- Branch: current branch plus `n changed` when the working tree is dirty
  (60 s cadence, same as the sidebar chip).
- Last activity: relative time of the newest session update, `—` when the
  workspace has no sessions.

### Actions

- New task: starts a draft in that workspace (primary row targets the
  primary) and returns to the chat view.
- Remove: only on trusted, removable, non-primary rows and only when the
  daemon advertises `workspace_runtime_removal`. Uses the same dialog and
  busy/force flow as the sidebar row (409 `workspace_busy` lists the
  activity and arms Force remove; removing the workspace the active
  session lives in stays blocked).
- Add workspace in the toolbar opens the existing registration dialog
  (only with `dynamic_workspace_registration`).

## Automated coverage

- `packages/web-shell/client/components/workspaces/useWorkspaceRemoval.test.tsx`
  (shared removal flow: busy→force, mismatch, blocked force, error path)
- `packages/web-shell/client/components/workspaces/WorkspacesOverviewPanel.test.tsx`
  (rows, badges, counts, unknown-not-zero, untrusted gating, actions)
- `packages/web-shell/client/components/sidebar/WebShellSidebar.workspace-removal.test.tsx`
  (sidebar flow on the shared hook + the Manage workspaces entry)
- `packages/web-shell/client/App.test.tsx` (panel opens from the sidebar)
- `packages/web-shell/client/e2e/web-shell.workspaces-panel.spec.ts`
