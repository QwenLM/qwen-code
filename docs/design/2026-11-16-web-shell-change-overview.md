# Web Shell change overview (delivery-unit scoped)

Language: English | [中文](./2026-11-16-web-shell-change-overview.zh-CN.md)

> **Superseded boundary mechanism.** This document describes the design as
> shipped in #17378. Its commit-fallback boundary — the files route's
> `git merge-base --is-ancestor` probe (`headIsAncestor`) and the hook's
> newest-ancestor-head window — was **retired** by the follow-up
> [change overview boundary fix](./2026-11-17-change-overview-boundary-fix.md),
> which scopes the window to the session's immutable start commit and excludes
> every commit reachable from any bound PR head (and the base branch's
> remote-tracking refs, `origin/<base>` / `upstream/<base>`, not the local base
> name) in one native `git log <range> --not <refs>`. The Files route, UI assembly,
> Degradation, and Files affected sections below describe the original
> ancestry-probe mechanism in the present tense for historical accuracy; read
> them as superseded by the follow-up, not as the current behavior.

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

Session attribution is available on the session summary — no baseline discovery
is needed — with one durability caveat this design relies on:

- `DaemonSessionSummary` carries `worktree?: DaemonWorktreeInfo`
  (`{ slug, path, branch }`), `branch?: DaemonBranchInfo` (`{ name, baseBranch }`),
  and `prs?: DaemonSessionPrInfo[]` (bound PRs,
  `{ number, url, state, source, issues }`, last = latest). `source` records the
  binding provenance (`create` / `worktree` / `review`) and is forwarded by the
  wire projection (`toSessionPrInfo`). See
  `packages/sdk-typescript/src/daemon/types.ts`.
- PRs are bound to the session by the PR service
  (`packages/core/src/services/session-pr-service.ts`) when created from the Git
  dialog, and surfaced on the session summary.
- Bridge entries are re-created **without** `prs` on a daemon restart/reload, so
  `GET /session/:id/status` (`packages/cli/src/serve/routes/session.ts`) hydrates
  the persisted sidecar (`readSessionPrs` + `bridge.seedSessionPrs`, a no-op when
  the live entry already carries bindings) **before** reading the summary. This
  unconditional sidecar read on the most-consumed session route is what makes
  bound PRs durable across restarts; without it a reopened session would drop
  every PR scope and re-list PR-covered commits as loose work.

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

Add `fetchGitHubPullRequestFiles(cwd, number, env?, repo?)` in
`packages/core/src/utils/github-prs.ts`, backed by
`gh pr view <number> --json files,additions,deletions,headRefOid,changedFiles`
(plus `--repo [host/]owner/repo` when the bound PR lives in another repository
or on an Enterprise host). The host is carried through in `gh`'s documented
`[HOST/]OWNER/REPO` form: a bare `owner/repo` would resolve on github.com (or
`GH_HOST`) and could answer with a foreign same-numbered PR. The slug validator
accepts a plain `owner/repo` or a bare dotted hostname (optionally `:port`)
prefix — never a URL, whitespace, or a leading `-`; the host must be dotted or
carry a port so `owner/repo/extra` cannot pass as host-qualified.
It returns a discriminated result mirroring the existing PR helpers
(`ok` / `not_a_repo` / `cli_unavailable` / `failed`), with a parsed, capped file
list:

- `files: { path, additions, deletions }[]` (capped, with a `hiddenCount`),
- `additions`, `deletions` totals,
- `headSha` (`headRefOid`) to scope the commit fallback.

`gh` output is untrusted; reuse the existing redaction / timeout / cwd-guard
patterns from `fetchGitHubPullRequestView`. The per-file list is capped at
`GITHUB_PR_FILES_MAX`, but `gh` itself truncates the `files` array well below
that cap (100 rows on the current CLI), so `hiddenCount` is derived from the
PR-wide `changedFiles` total rather than the parsed row count — that keeps the
file count and the "…and N more" note accurate for large PRs. This is a different
bound from the git diff routes' `MAX_FILES`; the two are not the same mechanism.

### Route layer (serve)

Add `GET /workspaces/:workspace/github/prs/:number/files` in
`packages/cli/src/serve/routes/workspace-github-prs.ts`, following the existing
qualified-route pattern: resolve a trusted runtime, resolve the session-managed
git cwd, call the core helper, apply read headers, and return the file list.
The route is advertised under a **new** `workspace_github_pr_files` capability
tag, per the registry's rule that new behaviour gets a new tag so a client that
preflighted `workspace_github_prs` can tell whether the files route exists
instead of probing it optimistically. The pinned capability baselines
(server.test.ts, capability-parity.ts, the integration capabilities envelope)
are updated for the new tag. The client gates PR-file fetching behind
`workspace_github_pr_files`; a daemon without the tag shows no PR scopes, and a
daemon that advertises the tag but fails the fetch degrades to "file list
unavailable" with the actual cause. A supplied-but-unusable `repo` (a repeated
query key, an empty value, or a slug the core validator refuses) is a caller
error answered `400`, classified by the machine-readable `reason: 'invalid_repo'`
rather than the human-readable message, so a reword cannot turn it into a
retryable `502`. An absent `repo` resolves the number in the session's own repo.
On an `ok` result the route also probes `git merge-base --is-ancestor <headSha>
HEAD` (`isGitAncestorOfHead` in `packages/core/src/utils/gitDiff.ts`) and returns
`headIsAncestor`: the client only trusts `<head>..HEAD` as a commit-fallback
boundary when the head is an ancestor of HEAD — a merged or rewritten PR's head
still resolves locally but is not one, and that window would re-list the base
branch's history as the session's loose work. A failed probe refuses the
boundary (`false`).

The overview itself is **composed client-side** from existing routes plus this
one new route, rather than adding a large aggregation endpoint. This keeps each
piece small and reusable and matches how the Git dialog already composes
`git/diff`, `git/log`, and `github/prs`.

### SDK

Add `DaemonGitHubPullRequestFile` / `DaemonGitHubPullRequestFiles` types (re-exported
from the `daemon` barrel beside the sibling PR types) and a
`workspaceGitHubPullRequestFiles(number, cwd?, sessionId?, repo?)` client method in
`packages/sdk-typescript/src/daemon/DaemonClient.ts`, mirroring the existing PR
methods.

### UI (web-shell)

Add a **Change overview** tab to the right `ArtifactPanel`, opened from the `+`
menu (next to the existing "Changes" entry). It renders:

- A **scope selector** listing the delivery units:
  - `Uncommitted` (always present when the workspace is a git repo),
  - one entry per bound PR (`summary.prs`, excluding `source === 'review'`
    bindings — a merely-reviewed PR is not this session's delivery), labelled
    `#number` (the summary's bound-PR entries carry no title), with a link to
    the PR,
  - commit-fallback entries for commits not covered by a bound PR.
- The selected unit's **file list with per-file `+/-` and a total scale header**,
  reusing the existing `LineStats` rendering. Per-line diffs stay in the Git
  dialog / review tab; the overview is the file-list + scale roll-up.

Assembly logic lives in a testable hook `useChangeOverview`:

- Uncommitted unit ← `workspaceGitDiff(cwd, sessionId)`.
- PR units ← `summary.prs`, each fetching `workspaceGitHubPullRequestFiles`.
- Commit-fallback units ← `workspaceGitLog` of commits after the latest bound
  PR head, used as the boundary only when **every** bound PR head is an
  **ancestor of HEAD** (`headIsAncestor`). If any bound PR head is not an
  ancestor (merged or rewritten), even an older ancestor head's window would
  straddle the base history that absorbed the merged work, so the boundary
  falls back to the session's base branch — or, when no baseline is known and
  no PR is bound, HEAD's recent history (the daemon's detached-HEAD `'HEAD'`
  sentinel counts as no baseline; `HEAD..HEAD` would be always-empty). The
  no-trustworthy-boundary suppression keys on the session's bound PRs, not on
  the produced PR units, so it also holds when the files capability is absent.
  Each entry is rendered from
  `workspaceGitCommitDetail`. Commits at or before the boundary are treated as
  covered by PRs and not duplicated. Merge commits are skipped; a failed
  commit-detail fetch fails the whole overview (see Degradation). A base branch
  outside the daemon's range whitelist skips the fallback entirely (a distinct
  "refuse" sentinel) rather than falling through to an unscoped walk that would
  re-list pre-session history; with bound PRs but no trustworthy boundary and
  no known base branch the fallback is suppressed as well. When a head-boundary
  log comes back unavailable, the hook retries once with the base-branch window
  — only when that window is a real range string, never the "no baseline"
  sentinel, whose omitted range would walk HEAD unscoped.

Degradation:

- Non-git workspace: the tab is offered for any workspace, and the panel shows
  a "not a git repository" message. The entry is deliberately not gated on the
  branch chip's git status, which is only fetched while that chip (or the
  environment panel) is visible.
- `gh` unavailable / PR files fetch fails: the PR unit still appears (number,
  link) with a "file list unavailable" state, never a blank panel.
- Transient git-diff fetch failure (timeout / 5xx): a distinct retryable
  "couldn't load" state, not mislabelled as "not a git repository".
- Any produced PR unit fails to resolve its head: the commit fallback is
  suppressed entirely, so that PR's commits cannot be re-listed as loose work
  inside a window an older PR's head defines. With the files capability absent
  no PR unit is produced, so the fallback still runs.
- A commit log the daemon reports unavailable, a commit-log fetch that throws
  (timeout / 5xx), or a failed commit-detail fetch: a retryable "couldn't load"
  state, not an empty session or a partial list presented as complete. A
  rejected base-window retry keeps the first response's unavailable verdict
  instead of erasing it into "no loose commits".
- A merged or rewritten PR among the bindings (any head not an ancestor of
  HEAD): no head is used as the fallback boundary — an older ancestor head's
  window would straddle the base history that absorbed the merged work; the
  base-branch window is used instead, or the fallback is suppressed when no
  base branch is known.
- A bound PR in another repository (or on an Enterprise host) is resolved there
  via `gh --repo [host/]owner/repo` derived from its URL — host included — not
  by number in the session's checkout.
- Shared (non-worktree) workspace: units are workspace-scoped rather than
  session-attributed.

## Files affected

- `packages/core/src/utils/github-prs.ts` (+ collocated test): PR file stats and
  the host-qualified `[host/]owner/repo` slug validation.
- `packages/core/src/utils/gitDiff.ts` (+ collocated test): `isGitAncestorOfHead`
  ancestry probe for the commit-fallback boundary.
- `packages/core/src/services/session-pr-service.ts` (+ test): forward the
  binding `source` on the wire projection.
- `packages/cli/src/serve/routes/workspace-github-prs.ts` (+ test): files route,
  including the `headIsAncestor` probe on `ok` results.
- `packages/cli/src/serve/routes/session.ts` (+ server.test.ts): status-route
  binding hydration (sidecar read + `seedSessionPrs` before the summary read).
- `packages/cli/src/serve/capabilities.ts`, `capability-parity.ts`,
  `server.test.ts`, `integration-tests/cli/qwen-serve-routes.test.ts`: new
  `workspace_github_pr_files` tag and its pinned baselines.
- `packages/sdk-typescript/src/daemon/types.ts`, `DaemonClient.ts`, `index.ts`
  (+ test): types, client method, and barrel re-export.
- `packages/web-shell/client/components/artifacts/`: overview tab + hook (+ tests).
- `packages/web-shell/client/customization.tsx`: `changeOverview` right-panel item.
- `packages/web-shell/client/App.tsx`: open/persist/restore the overview tab and
  reconcile its session id; pass the session summary.
- `packages/web-shell/client/main.tsx` (+ test): list `changeOverview` in the
  standalone right-panel items so the feature is reachable in the shipped shell.
- `packages/web-shell/client/i18n.tsx` (+ parity test): EN/ZH strings.

## Scope boundaries

- Read-only. No stage / commit / push / PR-create behavior is added.
- Does not replace the per-turn tool-call cards or the existing review tab; those
  remain the turn-level detail. The overview is the delivery-unit roll-up.
- No real-time file-tree watching and no subscription to git-status-change
  events; the overview refetches on open and on an explicit refresh only.

## Phasing

1. Core PR file stats + route + SDK (the only new data capability).
2. Web Shell overview tab with uncommitted + PR + commit-fallback scopes.
3. Verification (build, typecheck, focused unit tests, E2E) and self-audit.

## Known limitations

Both display residuals accepted at merge are **resolved** by the follow-up
[change overview boundary fix](./2026-11-17-change-overview-boundary-fix.md),
which replaces the newest-ancestor-head heuristic with a single
`<start>..HEAD --not <bound heads>` window:

- **Commit-fallback with no bound PR and no recorded base branch** (was R7-1).
  The shipped default walked HEAD's recent history because the "worktree
  sessions start fresh" premise was false. The follow-up records the session
  start commit and composes `<startCommit>..HEAD`; with no start commit it
  falls back to `<baseBranch>..HEAD` when a base branch is recorded, and
  suppresses when neither exists or when the recorded boundary fails the
  single-ref whitelist (fail-closed) — a range-less walk is never issued. (A
  legacy worktree sidecar with `originalBranch` but an empty
  `originalHeadCommit` therefore still gets a window bounded by the moving
  local branch name.) The start commit is **durable for worktree sessions**
  (the sidecar's `worktreeBase`, else `originalHeadCommit`) but **live-only
  for branch and plain sessions**: branch metadata is not restored across a
  daemon restart, and a plain session has no branch metadata at all — its
  start commit is the spawn-time `getHeadCommit` read held only in the live
  bridge entry, never persisted — so a restored branch/plain session
  suppresses the fallback rather than walking HEAD.
- **Binding recency is not commit-graph order** (was R7-2). Two incomparable
  ancestor heads made the last-bound head's window re-list a sibling PR's
  commits. The follow-up excludes every commit reachable from _any_ bound PR
  head via one native `git log <range> --not <heads>`, so merged, parallel,
  and incomparable heads are handled uniformly.

## Open questions

- Whether to also offer a "whole session" net diff (baseline..working tree) as an
  extra scope. Deferred; not required by the confirmed model.
