# Web Shell change overview (delivery-unit scoped)

Language: English | [中文](./2026-11-16-web-shell-change-overview.zh-CN.md)

## Problem

As a session runs, the agent edits many files. The user loses track of how large
the change has grown. Today Web Shell shows change information in three places,
none of which answers "how big is the change, organized the way I deliver it":

- Per-turn file-change cards and the right-panel review tab
  (`TurnOutputs.tsx`, `ArtifactPanel.tsx`) are built from **tool-call edits**
  (`edit` / `write_file`). They are turn-scoped, session-attributed, and work
  without git, but they do not know about commit or PR boundaries: committed work
  keeps counting, and there is no whole-session roll-up.
- The Git dialog diff tab (`GitDialog.tsx` / `GitDiffDialog.tsx`) shows the
  workspace's **uncommitted** changes with per-file `+/-`, but it is
  workspace-scoped and does not segment by commit or PR.
- The Git dialog log / PRs tabs list commits and PRs but do not show a PR's
  changed-file list and scale together.

The user wants a single overview of changed files and their scale, segmented the
way work is delivered:

- While nothing is committed: the session's change overview (the pending /
  uncommitted batch).
- Once the session has produced commits and PRs: one overview per PR, with
  commits that are not yet in a PR shown per-commit, plus the still-uncommitted
  batch.

## Confirmed scope model

Decided with the requester:

1. **Source of truth is git delivery units**, not tool-call edits. "Uncommitted"
   and "per-PR" are git concepts; the tool-call view cannot express them.
2. **Segmentation is PR-first, commit-fallback**: bound PRs become PR units;
   commits not covered by a bound PR become commit units; the working tree's
   uncommitted changes are always a unit.

## Current state (verified at the commit this doc is written on)

Session attribution is already available — no baseline discovery is needed:

- `DaemonSessionSummary` carries `worktree?: DaemonWorktreeInfo`
  (`{ slug, path, branch }`), `branch?: DaemonBranchInfo` (`{ name, baseBranch }`),
  and `prs?: DaemonSessionPrInfo[]` (bound PRs, `{ number, url, state, issues }`,
  last = latest). See `packages/sdk-typescript/src/daemon/types.ts`.
- PRs are bound to the session by the PR service
  (`packages/core/src/services/session-pr-service.ts`) when created from the Git
  dialog, and surfaced on the session summary.

Existing read capabilities that can be reused as-is:

- Uncommitted diff: `fetchGitDiff` (`packages/core/src/utils/gitDiff.ts`) →
  per-file `added/removed/isBinary/isUntracked/isDeleted`, exposed as
  `GET /workspaces/:workspace/git/diff` and `workspaceGitDiff(cwd, sessionId)`.
  The qualified route resolves the session's worktree cwd, so in a worktree
  session it is already session-scoped.
- Per-commit stats: `fetchGitCommitDetail` → `files[]` numstat + totals, exposed
  as `GET /workspaces/:workspace/git/log/commit` and
  `workspaceGitCommitDetail(sha, cwd, sessionId)`.
- Commit log with range: `fetchGitLog` (accepts a safe `range`), exposed as
  `GET /workspaces/:workspace/git/log` and `workspaceGitLog(...)`.
- PR list: `fetchGitHubPullRequests` (`gh pr list`), exposed as
  `GET /workspaces/:workspace/github/prs`.

The one missing capability: **a bound PR's changed-file list and scale**.
`GitHubPullRequestView` (`parseGhPrView`) returns `headRefOid`, state, checks, but
no file stats. There is no route that returns a PR's files.

## Proposed design

### Data layer (core)

Add `fetchGitHubPullRequestFiles(cwd, number, env?)` in
`packages/core/src/utils/github-prs.ts`, backed by
`gh pr view <number> --json files,additions,deletions,headRefOid,baseRefName`.
It returns a discriminated result mirroring the existing PR helpers
(`ok` / `cli_unavailable` / `failed`), with a parsed, capped file list:

- `files: { path, additions, deletions }[]` (capped, with a `hiddenCount`),
- `additions`, `deletions` totals,
- `headSha` (`headRefOid`) and `baseRefName` for attribution and links.

`gh` output is untrusted; reuse the existing redaction / timeout / cwd-guard
patterns from `fetchGitHubPullRequestView`. File paths and counts are bounded the
same way the diff routes bound theirs.

### Route layer (serve)

Add `GET /workspaces/:workspace/github/prs/:number/files` in
`packages/cli/src/serve/routes/workspace-github-prs.ts`, following the existing
qualified-route pattern: resolve a trusted runtime, resolve the session-managed
git cwd, call the core helper, apply read headers, and return the file list.
The route is advertised under the **existing** `workspace_github_prs` capability
tag (its comment is extended to cover the files route) rather than a new tag:
the files route is a read-only extension of the PRs surface, and a new tag would
require synchronizing several order-sensitive pinned capability baselines. The
client gates PR-file fetching behind `workspace_github_prs`; a daemon predating
the files route answers 404, which the overview renders as "file list
unavailable".

The overview itself is **composed client-side** from existing routes plus this
one new route, rather than adding a large aggregation endpoint. This keeps each
piece small and reusable and matches how the Git dialog already composes
`git/diff`, `git/log`, and `github/prs`.

### SDK

Add `DaemonGitHubPullRequestFiles` types and a
`workspaceGitHubPullRequestFiles(number, cwd?, sessionId?)` client method in
`packages/sdk-typescript/src/daemon/DaemonClient.ts`, mirroring the existing PR
methods.

### UI (web-shell)

Add a **Change overview** tab to the right `ArtifactPanel`, opened from the `+`
menu (next to the existing "Changes" entry). It renders:

- A **scope selector** listing the delivery units:
  - `Uncommitted` (always present when the workspace is a git repo),
  - one entry per bound PR (`summary.prs`), labelled `#number` (the summary's
    bound-PR entries carry no title), with a link to the PR,
  - commit-fallback entries for commits not covered by a bound PR.
- The selected unit's **file list with per-file `+/-` and a total scale header**,
  reusing the existing `LineStats` rendering. Per-line diffs stay in the Git
  dialog / review tab; the overview is the file-list + scale roll-up.

Assembly logic lives in a testable hook `useChangeOverview`:

- Uncommitted unit ← `workspaceGitDiff(cwd, sessionId)`.
- PR units ← `summary.prs`, each fetching `workspaceGitHubPullRequestFiles`.
- Commit-fallback units ← `workspaceGitLog` of commits after the latest bound
  PR's `headSha` (or, when there is no bound PR, the session's recent commits),
  each rendered from `workspaceGitCommitDetail`. Commits at or before the latest
  bound PR head are treated as covered by PRs and not duplicated.

Degradation:

- Non-git workspace: the tab is offered for any workspace, and the panel shows
  a "not a git repository" message. The entry is deliberately not gated on the
  branch chip's git status, which is only fetched while that chip (or the
  environment panel) is visible.
- `gh` unavailable / PR files fetch fails: the PR unit still appears (number,
  title, link) with a "file list unavailable" state, never a blank panel.
- Shared (non-worktree) workspace: units are workspace-scoped; the header labels
  the scope so it is not mistaken for session-only attribution.

## Files affected

- `packages/core/src/utils/github-prs.ts` (+ collocated test): PR file stats.
- `packages/cli/src/serve/routes/workspace-github-prs.ts` (+ test): files route.
- `packages/cli/src/serve/capabilities.ts`: extend the `workspace_github_prs`
  tag comment (no new tag, no baseline changes).
- `packages/sdk-typescript/src/daemon/types.ts`, `DaemonClient.ts` (+ test).
- `packages/web-shell/client/components/artifacts/`: overview tab + hook (+ tests).
- `packages/web-shell/client/App.tsx`: open the overview tab, pass session summary.
- `packages/web-shell/client/i18n.tsx`: EN/ZH strings.

## Scope boundaries

- Read-only. No stage / commit / push / PR-create behavior is added.
- Does not replace the per-turn tool-call cards or the existing review tab; those
  remain the turn-level detail. The overview is the delivery-unit roll-up.
- No real-time file-tree watching; the overview refetches on open and on an
  explicit refresh, and after git-status-change events already emitted.

## Phasing

1. Core PR file stats + route + SDK (the only new data capability).
2. Web Shell overview tab with uncommitted + PR + commit-fallback scopes.
3. Verification (build, typecheck, focused unit tests, E2E) and self-audit.

## Open questions

- Commit-fallback when there is no bound PR and no `baseBranch`: show the
  worktree's recent commits (worktree sessions start fresh) vs. requiring a
  baseline. Default: recent commits, capped, labelled by scope.
- Whether to also offer a "whole session" net diff (baseline..working tree) as an
  extra scope. Deferred; not required by the confirmed model.
