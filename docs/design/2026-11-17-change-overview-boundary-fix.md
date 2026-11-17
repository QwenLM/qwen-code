# Change overview: trustworthy commit-fallback boundary + hardening

Language: English | [中文](./2026-11-17-change-overview-boundary-fix.zh-CN.md)

Follow-up to #17378 (merged `6db070d787`). Retires the two maintainer-accepted
display residuals recorded in that PR's Known limitations, and clears the cheap
witness-bearing items of the deferred hardening ledger (the status-route perf
items and the behavior-change items — permanent-400 rendering, stale-state on
session switch, persisted workspaceId staleness — remain deferred). One PR,
ordered commits.

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
  `baseCommit?: string` and `baseBranch?: string`; `DaemonSessionSummary` gains
  a top-level `baseCommit?: string` for plain sessions.
- Branch sessions: persist the already-resolved `baseCommit` alongside
  `branchMeta` and project it on the summary. Live-only — branch metadata is
  not yet restored across a daemon restart (a restored branch session
  suppresses the fallback until durable branch metadata lands).
- Worktree sessions: resolve `getHeadCommit(workspaceCwd)` before
  `createUserWorktree` (the base tip the worktree is created from), persist it
  on `worktreeMeta` **and durably** in the worktree sidecar (`worktreeBase`,
  falling back to `originalHeadCommit` for legacy sidecars). Both
  `session-restore.ts` rebuild sites and `enrichWorktreeSidecars` read
  `worktreeBase || originalHeadCommit` (the worktree's own base, not the source
  checkout's HEAD, which differs for a worktree created from a sibling managed
  worktree); the journaled branch-worktree, worktree-reset, and "Create branch
  here" (`worktree-branch`) flows carry `baseCommit`/`baseBranch`, so a daemon
  restart still scopes the window. `baseBranch` (the branch the worktree was
  created from, sidecar `originalBranch`) is projected so the hook can exclude
  upstream integrations.
- Plain sessions: capture `getHeadCommit(workspaceCwd)` at creation (the HEAD
  the session starts from) and project it as the summary's top-level
  `baseCommit`; a failed read stays `undefined` (no boundary). Live-only (not
  restored across a daemon restart). The hook prefers
  `branch.baseCommit ?? worktree.baseCommit ?? summary.baseCommit`.
- The status-route hydration and summary projection forward the new fields;
  legacy sessions without them stay `undefined`.

### Layer 2 — reachability exclusion on the log route (core + cli + SDK)

- `fetchGitLog` gains `excludeRefs?: string[]`. When present, the revision
  list appends `--not <ref…>` after the range, so git natively returns the
  window minus commits reachable from any excluded ref. One git invocation;
  no per-entry ancestry calls.
- Each excluded ref is validated against the single-ref whitelist
  (`isSafeSingleRef`: charset, no leading `-` or `^`, no `..`); an unsafe ref
  drops the whole exclusion set into a refused (`available:false`) result
  rather than silently running unscoped. A leading `^` is refused because
  git's `--not ^ref` XORs the two negations into an inclusion (widening the
  window). The hash-prefix search arm carries the `--not <refs>` tail so
  exclusion is honoured there too.
- A safe-but-**absent** ref is dropped, not fatal. A bound PR head can be
  missing from the local object database (a refreshed `headRefOid`, a gc'd
  head), and a base branch's remote-tracking ref may not exist (a fork whose
  integration remote is `upstream`, a clone with no remote). `git log --not
<missing>` dies with `bad object`, which would refuse the entire window and
  — via the hook's no-exclusion retry — drop the _present_ exclusions too,
  re-listing the covered commits (the regression a naive `origin/<base>` guess
  introduced). Each ref is therefore probed with `rev-parse --verify --quiet
<ref>^{commit}` and only the present ones reach `--not`; the exclusion stays
  surgical (only the absent ref's commits may reappear). An unsafe ref still
  refuses the fetch — existence-dropping applies only to whitelist-safe refs.
- The core range guard is an injection guard, not a fail-closed boundary: an
  unsafe `range` is dropped (never passed to git) and the fetch falls back to a
  range-less HEAD walk rather than refusing. The change overview's no-unscoped-
  walk invariant is therefore kept by the hook's own client-side whitelist
  (`isSafeRangeRef` / `isSafeSingleRef`), which suppresses the fetch on an unsafe
  ref before it ever reaches the route. Making the core range guard itself
  fail-closed would change the contract other SDK consumers rely on (the
  existing injection-guard tests pin "ignore unsafe range, return the log"), so
  it is left as-is; the boundary guarantee lives in the hook.
- The log route gains an additive `exclude` query parameter (comma-separated
  refs). Absent → unchanged behavior. A repeated key, an empty value, or a
  separator-only value (`,,,`) is refused with 400 (fail closed) rather than
  dropping the exclusion and running unfiltered. A new capability tag
  `workspace_git_log_exclude_refs` advertises it; pinned baselines
  (server.test.ts, capability-parity.ts, integration envelope) updated.
- SDK `workspaceGitLog` gains an optional `excludeRefs` argument forwarded as
  `exclude` (both clients, tested).

### Layer 3 — hook rewrite (web-shell)

- Boundary priority: `branch.baseCommit ?? worktree.baseCommit ??
summary.baseCommit` (plain session) → `<start>..HEAD`; else `baseBranch`
  (non-`'HEAD'`, whitelist-safe) → `<base>..HEAD`; else **suppress** (no
  range-less walk ever).
- When the exclude capability is present and PR heads resolved, pass every
  bound PR `headSha` as `excludeRefs`. Reachability exclusion handles merged,
  parallel, and incomparable heads uniformly.
- The base branch's **remote-tracking refs** join the exclusion set. The
  recorded `baseBranch` (`branch.baseBranch ?? worktree.baseBranch`) is the
  LOCAL name (e.g. `main`), which integrating upstream never advances — only a
  remote-tracking ref does — so excluding the local name alone subtracts
  nothing. The hook excludes the remote-tracking ref under **both documented
  remotes**: `origin/<baseBranch>` (a standard clone) and `upstream/<baseBranch>`
  (a fork, where `origin` is the personal fork and integration comes from
  `upstream` — the layout CONTRIBUTING names). The session's own commits
  (children of the base) survive. Worktree sessions have no branch meta, so
  their base branch is carried on `worktree.baseBranch` (sidecar
  `originalBranch`). This narrows the window; the recorded start commit still
  bounds it. (An ancestry/merge-base probe alone would not fix this: after a
  linear upstream advance the start commit is still an ancestor of HEAD.) A
  remote-tracking ref that does not exist locally (the other remote, or a clone
  with no remote) is dropped by the route's existence probe rather than failing
  the walk, so the present exclusions — bound PR heads above all — still apply.
  Known residuals: a remote named other than `origin`/`upstream` is not covered
  (its integrated commits may re-list as loose work); the worktree-handoff flow
  can record `originalBranch` from a sibling checkout whose HEAD diverges from
  the recorded base commit, so in that rare case the base-branch narrowing can
  be imprecise; and plain sessions record no `baseBranch`, so they get no
  base-branch narrowing (the start-commit window still bounds their work). The
  start-commit window bounds the session's work correctly in every case.
- Keep the guard: if any produced PR unit failed to resolve a head, suppress
  the fallback (its commits cannot be excluded, so they must not be re-listed).
- Capability skew: with bound PR units but **no** exclude capability (a new
  client against an older daemon), suppress the fallback too — an unfiltered
  window would re-list those PRs' own commits as loose. Gating only the
  parameter is not enough; the fallback itself is gated on
  `boundPrs.length === 0 || !prFilesSupported || excludeRefsSupported`.
- Missing-head degradation: a bound `headSha` is a live `gh` value the files
  route never fetches, so it can be absent from the local object database
  (refreshed `headRefOid`, a gc'd head, a cross-repo binding). The route's
  existence probe now drops such an absent ref (Layer 2), so the window stays
  available and only that PR's commits may re-list — the present exclusions
  still apply. As a backstop for an excluded log that is nonetheless unavailable
  (e.g. the start commit itself missing from the object database), the hook
  retries once on the **same boundary window without `excludeRefs`** so the
  overview degrades to the loose window instead of blanking every unit. Only a
  log still unavailable after that retry surfaces `loadFailed`.
- Retire the now-redundant ancestry heuristic: remove the `headIsAncestor`
  probe from the files route, the SDK field, and the hook's ancestor-head
  selection. Remove `isGitAncestorOfHead` and its tests if no consumer remains
  (the exclusion model subsumes it; keeping both is redundant surface).
- `commitFallbackRange` is replaced by a start-commit composer with the same
  three-valued contract (string / `null` refuse / `undefined` suppress).

### Layer 4 — hardening ledger (tests + small fixes)

Clear the deferred items that are cheap and witness-bearing. Several were
already pinned during #17378's review rounds; this layer adds the missing ones
and the single behavior change (the ARIA tab contract):

- Status route: **added** a hydration `catch` test (a directory at the sidecar
  path makes `readSessionPrs` rethrow EISDIR; the summary is still served).
  Positive `?cwd=` resolution is already covered at the resolver layer
  (`workspace-route-runtime.test.ts`, real temp repos/worktrees); the files
  route forwards the resolved cwd to the core helper unchanged.
- Core: the spawned fallback gh binary is **already** asserted
  (`github-prs.test.ts`, "spawns the fallback gh when PATH cannot resolve it").
  SDK: **added** an empty-repo-slug suppression test (empty `repo` omits the
  param so the route resolves locally rather than rejecting `repo=`).
- Panel: **implemented** the ARIA tab contract (standing D4-1) — roving
  tabindex, Arrow/Home/End moving focus and selection with wrap, and a labelled
  `tabpanel`. **Added** pins for control-character sanitization, the
  badge-suppression commit arm, and external-link opener routing.
  Unavailable-cause precision, totals omission, Refresh-enabled-on-failure and
  empty-message presence were already pinned.
- `changeOverviewAvailable` JSDoc wording (gated on an active workspace, not
  git-ness); README right-panel enumeration (`changeOverview` is a
  workspace-level empty-state entry); bridge `SessionPrInfo.source` typing
  (mirrors the SDK `'create' | 'worktree' | 'review'`).

Each new behavioral guard gets a killing mutation witness (byte-level restore).

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
  and return unfiltered entries; a distinct tag lets the hook detect actual
  support. The tag alone only stops the daemon silently ignoring the parameter
  — the hook also gates the fallback itself on the tag (suppress when bound PR
  heads cannot be excluded), so the skew window does not duplicate PR commits.
- **Start commit is immutable.** Recorded once at creation; never recomputed
  from current HEAD (which moves). Legacy sessions without it suppress.

## Files affected

- `packages/sdk-typescript/src/daemon/types.ts`, `DaemonClient.ts`
  (+ `test/unit/DaemonClient.test.ts`): `baseCommit` fields, `excludeRefs` arg
  and forwarding, empty-repo-slug suppression.
- `packages/core/src/utils/gitDiff.ts` (+ test): `excludeRefs` with the
  single-ref whitelist; remove `isGitAncestorOfHead`.
- `packages/cli/src/serve/routes/session.ts` (+ server.test.ts): persist/projec
  the start commit on branch, worktree, journaled branch-worktree and
  worktree-reset paths; hydration catch test.
- `packages/cli/src/serve/server/session-restore.ts`: restore `baseCommit` from
  the sidecar's `originalHeadCommit`.
- `packages/cli/src/serve/routes/workspace-git-log.ts` (+ test): `exclude`.
- `packages/cli/src/serve/routes/workspace-github-prs.ts` (+ test): remove
  probe.
- `packages/cli/src/serve/capabilities.ts`, `capability-parity.ts`,
  `server.test.ts`, `integration-tests/cli/qwen-serve-routes.test.ts`: new tag.
- `packages/web-shell/client/components/artifacts/`: hook rewrite (boundary,
  exclusion, skew suppression, missing-head retry), panel ARIA + hardening
  tests, `change-overview.ts` composer; `ArtifactPanel.tsx` JSDoc; `README.md`
  right-panel enumeration.
- `packages/acp-bridge/src/bridgeTypes.ts`, `session-control-plane.ts`:
  `baseCommit` on worktree/branch meta; PR entry `source` typing.
- `docs/design/2026-11-16-web-shell-change-overview*.md`: Known limitations →
  resolved.

## Scope boundaries

- Read-only. No stage/commit/push/PR-create behavior.
- The exclude param is additive; existing log consumers unaffected.
- Hardening items are test pins + the ARIA contract; no unrelated refactors.

## Open questions

- Whether to also offer a "whole session" net diff scope. Still deferred; not
  required by the confirmed model.
