# Web Shell commit history: lane graph and search

[English](2026-09-18-web-shell-git-history-graph.md) | [简体中文](2026-09-18-web-shell-git-history-graph.zh-CN.md)

Status: implemented. Part of [#11941](https://github.com/QwenLM/qwen-code/issues/11941); the worktree manager from the same issue is a separate design.

## Problem

The Web Shell history tab lists the commits reachable from `HEAD` as a flat list. Merge commits carry a marker but the branch structure is invisible, commits on other branches are unreachable without a checkout, and there is no way to find a commit by message, author, or hash beyond scrolling.

## Current state

- `GET /workspaces/:workspace/git/log` accepts `limit`, `skip`, and a single `range`; `fetchGitLog` in `packages/core/src/utils/gitDiff.ts` rejects a `range` that starts with `-` or `..`, so multi-ref flags cannot be smuggled through it.
- The response already carries `parents` and `refs` for each entry.
- `GitLogContent` in `packages/web-shell/client/components/dialogs/GitLogDialog.tsx` renders the list and is embedded as the `log` tab of `GitDialog`.

## Goals

- Show the commit history as a lane graph: one column per concurrent line of development, curves where branches fork and merge.
- Let the user widen the walk from `HEAD` to every local branch, remote branch, and tag.
- Filter the history by message, author, or hash from the same tab.
- Open the history from the branch chip, next to the existing Changes and Commit actions.

## Non-goals

- No rendering of commits that the daemon walk does not return (no client-side graph reconstruction beyond the loaded pages).
- No new daemon route; the existing log route grows two optional query parameters.
- No changes to the commit detail endpoint or the diff tab.

## Design

### Daemon and core

`fetchGitLog` takes two new options:

- `all`: the walk covers `HEAD --branches --tags --remotes` instead of `HEAD`. Stash, notes, and replace refs stay excluded.
- `search`: a case-insensitive fixed-string filter. git ANDs `--grep` with `--author`, so message and author matches are two walks whose union is paged; a query of four to forty hex characters additionally resolves as a commit hash prefix through `git rev-parse --verify <query>^{commit}`. The union is ordered by author date, so a page boundary can shift by one entry when author and commit dates disagree; the client de-duplicates by sha.

Every walk now passes `--date-order`, so a parent never precedes one of its children and the lane layout needs nothing beyond `parents`. The route reads `all=1` and `search=<text>` (trimmed, capped at 200 characters). The SDK exposes them as a trailing `options` argument on `workspaceGitLog` in both the bound-workspace and workspace-qualified clients.

### Lane layout

`layoutCommitGraph` in `packages/web-shell/client/utils/commitGraph.ts` is a pure function over `{ sha, parents }[]` in walk order. Each lane waits for one commit:

- A commit takes the lowest lane waiting for it, or a fresh lane when none does. Every other lane waiting for the same commit merges into that node.
- Its first parent continues the lane, unless another lane already waits for that parent, in which case the line joins that lane instead of running in parallel.
- Each further parent takes the lane already waiting for it or opens a new one.

The layout is recomputed over the whole accumulated list after every page, so pagination never breaks a lane. Search results are not contiguous history, so the graph is hidden while a query is active.

### Rendering

Each row draws its own SVG stretched to the row height (`preserveAspectRatio="none"`): pass-through lanes as vertical lines, incoming and outgoing lane changes as S-curves, and the node as a positioned dot (hollow for merges). An expanded row draws the still-open lanes straight through its detail block so lines never break. Lane colours cycle through a fixed eight-colour palette; lanes beyond twenty share the last column so a busy all-branches view cannot crowd the subject out.

### Toolbar and entry points

The history tab gains a toolbar with a search field (debounced 300 ms) and an `All branches` toggle. Both re-fetch from offset zero. `BranchPickerPopover` gains an `onOpenLog` action rendered as `History` next to `View Changes`; `ChatEditor` and `EnvironmentPanel` thread it from `App`, which opens `GitDialog` on the `log` view with the session's worktree cwd when there is one.

## Constraints

- `range`, `all`, and `search` compose: `all` wins over `range`; `search` filters whatever walk the other two select.
- A hash-prefix hit is returned even when the commit is not reachable from the selected walk; the user asked for that commit explicitly.
- The graph column has a hard cap of twenty lanes. Repositories with hundreds of unmerged branch tips render the overflow in the last lane rather than widening the dialog.

## Validation

- `packages/core/src/utils/gitDiff.test.ts`: `all` walks a side branch and tag, an unsafe `range` is ignored, search unions message, author, and hash with fixed-string matching, and search pages with `hasMore`.
- `packages/cli/src/serve/routes/workspace-git-log.test.ts`: the route forwards `all` and `search`.
- `packages/web-shell/client/utils/commitGraph.test.ts`: linear history, merge lanes, lane reuse, and fresh lanes for unseen parents.
- `packages/web-shell/client/components/dialogs/GitLogDialog.test.tsx`: the toggle and search re-fetch with the right options, matches hide the graph, and a merge lays out in two columns with lanes continuing through an expanded row.
- `packages/web-shell/client/components/BranchPickerPopover.test.tsx`: the `History` entry calls back and closes.

## Acceptance criteria

- The history tab shows a node per commit and curves at every fork and merge, on the current branch by default.
- `All branches` lists commits from every branch and tag with their ref chips.
- Typing in the search field narrows the list to matching message, author, or hash and clears back to the full history when emptied.
- The branch chip offers `History` and opens the tab.
