# Change overview: trustworthy commit-fallback boundary + hardening

Language: English | [中文](./2026-11-17-change-overview-boundary-fix.zh-CN.md)

Follow-up to #17378 (merged `6db070d787`). Retires the two maintainer-accepted
display residuals recorded in that PR's Known limitations, and clears the
deferred hardening ledger. One PR, ordered commits.

## Problem

The change overview's commit fallback lists commits "no bound PR covers yet".
#17378 shipped two display-only defects, accepted as residual risk:

- **R7-1 — no boundary at all.** A session with no bound PR and no recorded
  `baseBranch` (the default `POST /session` shape, and worktree sessions, which
  record no `baseBranch`) falls through to a range-less `git log` over HEAD.
  A worktree branch is created at the base tip, so its HEAD carries the base
  branch's history; up to `COMMIT_FALLBACK_LIMIT` (20) pre-session commits
  render as this session's loose `commit:` units. The original justification
  ("worktree sessions start fresh") is false.
- **R7-2 — binding recency is not commit-graph order.** The boundary is the
  last-_bound_ PR head. With two bound heads that are both ancestors of HEAD
  but not of each other (the binding list is "stacked or unrelated", ordered by
  `createdAt`), `<lastBound>..HEAD` re-lists the sibling PR's own commits as
  loose work — the same commits already shown under that PR's unit.

Both are read-only display defects (no write path, no data loss). Every
neighbouring state already refuses the unscoped walk; these two are the
inconsistent exceptions.

## Current state (verified at `6db070d787`)

- `useChangeOverview.ts` composes the window via `commitFallbackRange`:
  newest ancestor PR head → `<head>..HEAD`; else `baseBranch` (the `'HEAD'`
  detached sentinel maps to no-baseline); else a range-less walk when no PR is
  bound. Suppression keys on `boundPrs.length` and on every produced PR unit
  resolving a head.
- The files route probes `isGitAncestorOfHead` and returns `headIsAncestor`;
  the hook uses it to pick the newest ancestor head. This heuristic is what
  R7-2 defeats (incomparable ancestors).
- `session.ts` resolves `baseCommit = getHeadCommit(workspaceCwd)` for branch
  sessions (`:3269`) but only uses it for rollback; `DaemonBranchInfo` is
  `{ name, baseBranch }` — the start commit is **not persisted or projected**.
  Worktree sessions record `{ slug, path, branch }`, no base commit.
- `fetchGitLog` (`core/utils/gitDiff.ts`) accepts `{ limit, skip, range, all,
search }`; the log route (`workspace-git-log.ts`) forwards `range`/`search`.
  There is no way to exclude commits reachable from a set of refs.

## Proposed design

### Unified boundary model

Replace the "newest ancestor head" heuristic with a single rule:

> The fallback window is `<start>..HEAD`, where `start` is the session's
> recorded start commit (else its base branch), minus every commit reachable
> from any bound PR head. With no trustworthy `start`, suppress the fallback.

This fixes both residuals at once: R7-1 because a range-less walk is never
issued (no start → suppress), R7-2 because exclusion is by reachability from
_every_ bound head, not intersection against one arbitrarily-ordered head.

### Layer 1 — persist the session start commit (cli + SDK)

- `DaemonBranchInfo` gains `baseCommit?: string`; `DaemonWorktreeInfo` gains
  `baseCommit?: string`.
- Branch sessions: persist the already-resolved `baseCommit` alongside
  `branchMeta` and project it on the summary.
- Worktree sessions: resolve `getHeadCommit(workspaceCwd)` before
  `createUserWorktree` (the base tip the worktree is created from) and persist
  it on `worktreeMeta`.
- Plain sessions: no start commit recorded (none exists).
- The status-route hydration and summary projection forward the new fields;
  legacy sessions without them stay `undefined`.

### Layer 2 — reachability exclusion on the log route (core + cli + SDK)

- `fetchGitLog` gains `excludeRefs?: string[]`. When present, the revision
  list appends `--not <ref…>` after the range, so git natively returns the
  window minus commits reachable from any excluded ref. One git invocation;
  no per-entry ancestry calls.
- Each excluded ref is validated against the single-ref whitelist
  (`isSafeLogRange` charset, no leading `-`/`..`); an unsafe ref drops the
  whole exclusion set into a refused (`available:false`) result rather than
  silently running unscoped — same fail-closed posture as the range guard.
- The log route gains an additive `exclude` query parameter (comma-separated
  refs). Absent → unchanged behavior. A new capability tag
  `workspace_git_log_exclude_refs` advertises it; pinned baselines
  (server.test.ts, capability-parity.ts, integration envelope) updated.
- SDK `workspaceGitLog` gains an optional `excludeRefs` argument forwarded as
  `exclude`.

### Layer 3 — hook rewrite (web-shell)

- Boundary priority: `branch.baseCommit ?? worktree.baseCommit` →
  `<start>..HEAD`; else `baseBranch` (non-`'HEAD'`, whitelist-safe) →
  `<base>..HEAD`; else **suppress** (no range-less walk ever).
- When the exclude capability is present and PR heads resolved, pass every
  bound PR `headSha` as `excludeRefs`. Reachability exclusion handles merged,
  parallel, and incomparable heads uniformly.
- Keep the guard: if any produced PR unit failed to resolve a head, suppress
  the fallback (its commits cannot be excluded, so they must not be re-listed).
- Retire the now-redundant ancestry heuristic: remove the `headIsAncestor`
  probe from the files route, the SDK field, and the hook's ancestor-head
  selection. Remove `isGitAncestorOfHead` and its tests if no consumer remains
  (the exclusion model subsumes it; keeping both is redundant surface).
- `commitFallbackRange` is replaced by a start-commit composer with the same
  three-valued contract (string / `null` refuse / `undefined` suppress).

### Layer 4 — hardening ledger (tests + small fixes, no behavior change)

Clear the deferred items that are cheap and witness-bearing:

- Status route: test the hydration `catch` (unreadable sidecar still serves the
  summary); test positive `?cwd=` resolution on the files route.
- Core: assert the spawned fallback gh binary; SDK empty-slug suppression test.
- Panel: pin control-character sanitization, unavailable-cause precision,
  empty-message presence, totals omission on unavailable PRs, Refresh enabled
  on failure, badge suppression arms; implement the ARIA tab contract
  (`role=tablist/tab`, `aria-selected`, Arrow/Home/End keyboard) for the scope
  selector (standing D4-1).
- `changeOverviewAvailable` JSDoc wording; README right-panel enumeration;
  bridge PR entry `source` typing.

Each behavioral guard gets a killing mutation witness (byte-level restore).

## Key design decisions

- **Reachability exclusion over pairwise ancestry.** `git log <range> --not
<heads>` is one native invocation and exactly expresses "not covered by any
  bound PR"; pairwise `is-ancestor` probes would be N×M calls and still need a
  boundary. Exclusion also makes the ancestry probe redundant, so it is removed
  rather than kept as dead surface.
- **Suppress, never walk unscoped.** The no-start case suppresses instead of
  walking HEAD. This is the consistent extension of every neighbouring refusal
  and removes R7-1's falsified premise entirely.
- **New capability tag for the exclude param.** A daemon advertising
  `workspace_github_pr_files` but predating `exclude` would ignore the param
  and return unfiltered entries (duplication regress in the skew window); a
  distinct tag lets the hook gate exclusion on actual support.
- **Start commit is immutable.** Recorded once at creation; never recomputed
  from current HEAD (which moves). Legacy sessions without it suppress.

## Files affected

- `packages/sdk-typescript/src/daemon/types.ts`, `DaemonClient.ts`, `index.ts`
  (+ test): `baseCommit` fields, `excludeRefs` arg, tag type.
- `packages/core/src/utils/gitDiff.ts` (+ test): `excludeRefs`; remove
  `isGitAncestorOfHead` if unused.
- `packages/cli/src/serve/routes/session.ts` (+ server.test.ts): persist/projec
  start commit; hydration catch test.
- `packages/cli/src/serve/routes/workspace-git-log.ts` (+ test): `exclude`.
- `packages/cli/src/serve/routes/workspace-github-prs.ts` (+ test): remove
  probe; `?cwd=` positive test.
- `packages/cli/src/serve/capabilities.ts`, `capability-parity.ts`,
  `server.test.ts`, `integration-tests/cli/qwen-serve-routes.test.ts`: new tag.
- `packages/web-shell/client/components/artifacts/`: hook rewrite, panel ARIA +
  hardening tests, `change-overview.ts` composer.
- `packages/web-shell/client/App.tsx`, `main.tsx`, `customization.tsx`,
  `README.md`: JSDoc/enumeration/typing.
- `packages/acp-bridge/src/bridgeTypes.ts`: PR entry `source` typing.
- `docs/design/2026-11-16-web-shell-change-overview*.md`: Known limitations →
  resolved.

## Scope boundaries

- Read-only. No stage/commit/push/PR-create behavior.
- The exclude param is additive; existing log consumers unaffected.
- Hardening items are test pins + the ARIA contract; no unrelated refactors.

## Open questions

- Whether to also offer a "whole session" net diff scope. Still deferred; not
  required by the confirmed model.
