# Web Shell worktree manager

[English](2026-09-18-web-shell-git-worktree-manager.md) | [简体中文](2026-09-18-web-shell-git-worktree-manager.zh-CN.md)

Status: implemented. Part of [#11941](https://github.com/QwenLM/qwen-code/issues/11941); the commit history lane graph and search from the same issue are described in [2026-09-18-web-shell-git-history-graph.md](2026-09-18-web-shell-git-history-graph.md).

## Problem

A Web Shell user can start a session in a worktree, but nothing in the Web Shell lists the repository's worktrees, shows which of them are dirty or stale, or shows which sessions run inside each. Stale worktrees accumulate unnoticed and cleaning them up means a terminal.

## Current state

- `GitWorktreeService` in `packages/core/src/services/gitWorktreeService.ts` creates and removes the managed worktrees under `<workspace>/.qwen/worktrees/<slug>` for sessions, and the daemon's `POST /session` creates one per request. No daemon route lists worktrees.
- Session summaries carry `worktree: { slug, path, branch }` for sessions that live in a managed worktree, both live and persisted.
- `GitDialog` in `packages/web-shell/client/components/dialogs/GitDialog.tsx` hosts the Changes, History, and Pull requests tabs; the Pull requests tab is gated on a daemon capability feature.
- `exit_worktree` refuses to remove a worktree with uncommitted changes unless the caller opts into discarding them.

## Goals

- List every worktree of the workspace's repository with its path, branch, HEAD, lock and prune state, working-tree counters, and the sessions that run inside it.
- Remove a worktree from the list, refusing destructive cases unless the user explicitly confirms them.
- Resume a session that lives in a worktree, and start a new worktree session, from the same surface.
- Reach the surface from the branch chip.

## Non-goals

- No new worktree-creation plumbing: "New worktree session" arms the existing worktree intent of the composer, which creates the worktree through the existing session route.
- No branch deletion on removal; the branch stays and the branch picker remains the place to delete it.
- No listing of worktrees from other repositories or other workspaces.

## Design

### Core

`packages/core/src/utils/git-worktrees.ts` wraps `git worktree list --porcelain -z` into `GitWorktreeEntry` records (path, head, branch, detached, bare, locked, prunable, isMain; the main worktree is the first entry), `git worktree remove [--force --force] -- <path>`, and `git worktree prune`. It shares `runGit` with the branch helpers, so the same environment scrubbing applies.

### Daemon routes

Three workspace-qualified routes, all **selected-runtime scoped**: they resolve the trusted runtime for `:workspace`, assert its generation is open, and act on that runtime's `workspaceCwd` only. None falls back to the primary runtime.

- `GET /workspaces/:workspace/git/worktrees` lists the entries plus two derived marks: `isWorkspace` (the runtime's own checkout, compared by real path) and `slug` (the directory name for entries under the runtime's `.qwen/worktrees/`). A non-repository answers `available: false`.
- `GET /workspaces/:workspace/git/worktrees/status?path=` returns the working-tree counters of one listed worktree. The path must match a listed entry exactly; anything else is 404, so the route can never probe an arbitrary directory.
- `POST /workspaces/:workspace/git/worktrees/remove` with `{ path, force? }` runs behind the strict mutation gate. It refuses the main worktree and any registered workspace (409 `worktree_is_main` / `worktree_is_workspace`) regardless of `force`. Without `force` it also refuses when live sessions run in the worktree (409 `worktree_in_use` with `sessions`) or when the working tree has staged, unstaged, untracked, or conflicted entries (409 `worktree_dirty` with `changes`), or when the working tree cannot be read (409 `worktree_status_unknown`). A prunable entry (directory gone) is pruned instead of removed. git failures pass through the shared redacted git error path.

The capability feature `workspace_git_worktrees` advertises the routes; older daemons keep the tab and the chip entry hidden.

### SDK

`WorkspaceDaemonClient` gains `workspaceGitWorktrees()`, `workspaceGitWorktreeStatus(path)`, and `workspaceGitRemoveWorktree(path, { force })` with the matching `DaemonGitWorktree*` types.

### Web Shell

`GitWorktreesContent` in `packages/web-shell/client/components/dialogs/GitWorktreesDialog.tsx` is the fourth `GitDialog` tab, "Worktrees", shown when the daemon advertises the feature. On open it fetches the worktree list and the workspace's session list together, joins sessions to worktrees by `worktree.path`, and renders one row per worktree: slug or directory name, badges (main, this workspace, locked, directory missing), branch or detached HEAD, short HEAD, working-tree state, the sessions inside it as chips, and a remove button for removable entries. Working-tree state is fetched lazily after the list renders, three requests at a time, so a repository with hundreds of worktrees lists instantly. A filter box narrows by path, branch, or slug.

Removal is a two-step inline confirmation. The first request never forces. A 409 from the daemon turns the confirmation into an explanation of what would be lost (uncommitted change count or running session count) with a "Remove anyway" button that repeats the request with `force: true`. Other failures show the daemon's message and only offer Cancel. A successful removal re-fetches the list.

Clicking a session chip closes the dialog and switches to that session; "New worktree session…" closes the dialog and starts a draft with the worktree intent armed, the same path as the sidebar's entry. `BranchPickerPopover` gains a "Worktrees…" action after "Manage Remotes…"; `ChatEditor` and `EnvironmentPanel` thread it from `App`, which passes it only when the daemon advertises the feature.

## Constraints

- The worktree list is repository-wide, so it includes worktrees created outside Qwen Code. They can be removed like any other, subject to the same refusals.
- Removal deletes the directory. Force removal discards uncommitted work and leaves live sessions with a missing cwd; the confirmation says so before the second click.
- Sessions are joined on the client from one page of the session list (100 entries); a worktree whose sessions fall outside that page shows none.

## Validation

- `packages/core/src/utils/git-worktrees.test.ts`: porcelain parsing, real-repo listing with lock and detached state, removal refusing a dirty or locked worktree until forced, pruning.
- `packages/cli/src/serve/routes/workspace-git-worktrees.test.ts`: list marks, unavailable repository, untrusted workspace, status of a listed path only, removal of an idle worktree, refusals for main, registered workspace, dirty, and in-use, prune for missing directories, invalid input.
- `packages/web-shell/client/components/dialogs/GitWorktreesDialog.test.tsx`: rows with badges, lazy status, session join and open, no removal for main or current, confirm and refresh, dirty and in-use refusals with force, verbatim failures, filter, new-session entry, unavailable placeholder.
- `packages/web-shell/client/components/dialogs/GitDialog.test.tsx`: the tab appears only with the capability.
- `packages/web-shell/client/components/BranchPickerPopover.test.tsx`: the "Worktrees…" entry.

## Acceptance criteria

- The Worktrees tab lists every worktree of the repository with path, branch, state, and sessions, and loads instantly even with hundreds of entries.
- A clean, idle linked worktree can be removed after one confirmation; a dirty or session-hosting one needs a second, explicit "Remove anyway".
- The main worktree and registered workspaces can never be removed from the tab.
- A session listed under a worktree opens on click; "New worktree session…" starts a worktree draft.
