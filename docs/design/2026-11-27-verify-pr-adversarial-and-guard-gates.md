# Verify-PR Adversarial Verification, Top-Level Blocking Comments, and Hardened Publish Guard

[English](2026-11-27-verify-pr-adversarial-and-guard-gates.md) | [简体中文](2026-11-27-verify-pr-adversarial-and-guard-gates.zh-CN.md)

- **Status**: Implemented (PR #18549, merged 2026-11-28, `940e9b7925`)
- **Date**: 2026-11-27

## Problem Statement

Across five rounds of `/verify-pr` on PR #18494 (`3363f8a5` through `aa4677734f`),
the skill reliably caught build failures, vacuous assertions, and regression
narratives, yet repeatedly missed silent data-loss, steady-state duplication,
and quadratic I/O regressions that a parallel manual review surfaced on the
exact same commits (`7210889200`, `7214891441`, `7215477398`, `7215982054`,
`7218091603`, `7219372287`, `7220037991`). Specifically:

1. **Methodological blind spot on destructive/exclusion diffs**: Rounds treated
   the author's exclusion claim as the oracle, locked central A/B fixtures to
   one `.gitignore` spelling (`.qwen/tmp/`), relied on low-level helper calls
   and mutation testing (which cannot detect uncoded paths such as symlink
   indirection or reverse `objects/` pointers), skipped multi-round cleanup
   sweeps and `git worktree prune --expire=now`, and did not adversarially test
   their own suggested fixes or check for over-refusal liveness regressions.
2. **Blind spot to maintainer top-level blocking comments**:
   `REVIEW_STATE_QUERY` in `scripts/verify-pr-prepare.mjs` and
   `.github/workflows/qwen-triage.yml` only fetched `latestOpinionatedReviews`
   and inline `reviewThreads`. Maintainer reviews posted as top-level PR issue
   comments with `[P1]` findings were invisible in `review-threads.json`.
3. **Soft publish guard**: `scripts/verify-pr-guard.mjs` printed `clean`/`dirty`
   to stdout without emitting a structured, hash-bound verdict, and
   `scripts/verify-pr-check.mjs` never checked whether the guard had run. Round
   4 posted 8 minutes after a new top-level P1 on the same head; Round 5 posted
   `merge-ready` 23 minutes after two new P1s and 18 minutes after a new push.

## Goals and Scope Boundaries

### Goals

- Add a diff-triggered adversarial verification protocol and independent
  post-destruction recovery oracle to `.qwen/skills/verify-pr/SKILL.md` for
  destructive, exclusion, ignore, cleanup, snapshot, and migration diffs,
  including adversarial self-attack on suggested fixes.
- Extend `REVIEW_STATE_QUERY`, `reviewState()`, and `.github/workflows/qwen-triage.yml`
  in exact parity to include non-minimized top-level comments from `OWNER`,
  `MEMBER`, and `COLLABORATOR` authors (`comments(last: 100)`) and bind them to
  the same blocking bar as open blocking review threads.
- Turn `verify-pr-guard.mjs` + `verify-pr-check.mjs` into a mechanical,
  fail-closed pre-publish gate with host-held verdict storage, SHA-256 content
  binding, coordinate/head/OPEN-state verification, and capture freshness checks.

### Non-Goals

- Do not expose untrusted (`NONE` / `FIRST_TIME_CONTRIBUTOR`) top-level issue
  comment prose to the token-free verification sandbox.
- Do not break existing `verify-pr-check.mjs` CI publish-lane invocations or
  sparse-checkout boundaries (the CI publish job checks out
  `scripts/verify-pr-check.mjs` without `scripts/verify-pr-guard.mjs`).
- Do not introduce a separate `gh pr comment` wrapper script; keep the check
  composed cleanly through `verify-pr-guard.mjs` and `verify-pr-check.mjs`.

## Proposed Solution

### 1. Diff-Triggered Adversarial Protocol & Recovery Oracle (`SKILL.md`)

- **Scope selection**: Triggered whenever the diff modifies exclusion, ignore,
  skip, prune, delete, snapshot, or migration paths (not gated on the central
  claim). Requires naming the core safety invariant, reserving an adversarial
  slot even in follow-up rounds, `grep`-ing in-repo writers into excluded paths,
  and sweeping six explicit axes:
  1. Path indirection and reverse dependencies (intermediate symlink hops inside
     deleted dirs, external `objects/`/`refs/`/`objects/info/alternates`
     pointing back into deleted dirs).
  2. Placement and nesting depth (non-default dirs, container root itself,
     nested descendants, ignored subtrees inside preserved/excluded children).
  3. Rule-spelling variants (`dir/` vs `dir/*` vs no rule), complexity ladders
     on new scans, and mixed fixtures (cache + clean nested checkout) in the
     central A/B.
  4. Real upper caller entry point and at least two consecutive sweeps for
     steady-state convergence.
  5. Combinatorial control-flow fixtures targeting `continue` / `handled*` /
     `visited*` early-mark interactions.
  6. Anti-over-refusal (liveness) controls pairing each new `refuse` guard with
     a structurally similar benign neighbor that must still succeed.
- **Artifact-type method**: Add **Snapshot, backup, cleanup, and pruning PRs**
  requiring real destruction + external maintenance
  (`git worktree prune --expire=now`) + in-place restore + independent
  verification of history that cannot be reconstructed from the working tree
  (e.g. a file deleted by a later commit), forbidding reliance on the SUT's own
  `verify() === true`.
- **Findings (`A suggested fix is measured, not eyeballed`)**: Require
  adversarially testing at least one counterexample against any new
  discriminator introduced by a suggested fix.

### 2. Top-Level Maintainer Blocking Comments (`review-threads.json`)

- Extend `REVIEW_STATE_QUERY` (keeping `pageInfo` solely on `reviewThreads` so
  `gh api graphql --paginate --slurp` continues to paginate threads cleanly)
  with:
  ```graphql
  comments(last: 100) { totalCount nodes { createdAt updatedAt url body author { login } authorAssociation isMinimized } }
  ```
- Both `reviewState(pages)` in `scripts/verify-pr-prepare.mjs` and the `jq`
  filter in `.github/workflows/qwen-triage.yml` validate `pullRequest`,
  `comments.nodes`, `latestOpinionatedReviews.nodes`, `reviewThreads.nodes`,
  and each thread's `comments.nodes` as plain JSON objects (rejecting arrays
  such as `[[]]` and `null` elements symmetrically, failing closed to `null` /
  error when malformed) and emit:
  - `issueCommentCount`: `comments.totalCount` (so rounds disclose truncation
    under _Not covered_ when `> 100`).
  - `issueComments`: non-minimized comments whose `authorAssociation` is in
    `{OWNER, MEMBER, COLLABORATOR}`, shaped as
    `{ author, association, createdAt, updatedAt, url, body }`.
- Update `SKILL.md` Scope item 5 and report item 4 so maintainer top-level
  comments tagged Critical, Blocker, P0, or P1 (excluding `/verify-pr` reports
  and bot lifecycle/fallback notices) carry the same open-blocking budget and
  `merge-ready` prohibition as open blocking review threads.

### 3. Mechanical Pre-Publish Guard Gate (`verify-pr-guard.mjs` + `verify-pr-check.mjs`)

- **Schema ownership**: Export `GUARD_VERDICT_SCHEMA = 'verify-pr-guard-verdict-v1'`
  from `scripts/verify-pr-check.mjs` and import it in `scripts/verify-pr-guard.mjs`,
  preserving the CI publish job's sparse checkout of `verify-pr-check.mjs`
  without adding a runtime dependency on `verify-pr-guard.mjs`.
- **`verify-pr-guard.mjs`**:
  - Record `capturedAt` (UTC ISO-8601, taken before the opening metadata read)
    in `fetchSnapshot()` (keeping `isSnapshot()` backwards-compatible when
    `capturedAt` is absent), enforce strict `owner/repo` slug validation, and
    reject empty flag values or stray positional arguments.
  - Re-check `reviews` and `reviewComments` after the initial paginated pass,
    run incremental `?since=` probes on inline review comments and top-level
    comments (anchored on each list's max `updated_at`, catching edits on
    already-read REST pages as well as same-second `updatedAt` ties), then run
    a closing GraphQL probe (`GUARD_CONFIRM_QUERY`) **after** all REST fetches
    finish (paginating backward via `before` cursor whenever a PR has > 100
    formal reviews, and using explicit `{ ok, value }` call results so a JSON
    `null` response can never skip confirmation) to verify `headRefOid`,
    `state`, every formal review (`databaseId`, `state`, `submittedAt`, and
    normalized `body`), top-level comment count and latest created comment
    (`databaseId`, `updatedAt`), and the most-recently-updated top-level comment
    (`orderBy: { field: UPDATED_AT, direction: DESC }`, checking `databaseId`,
    `updatedAt`, and normalized `body`) before writing the snapshot.
  - Add `--no-clobber` (`O_EXCL` atomic create) for round-start snapshots in
    per-round host directories so concurrent rounds cannot overwrite or delete
    each other's `guard-start.json`.
  - On refresh `--snapshot <file>` (without `--no-clobber`) and
    `--compare --out <verdict-file>`, pre-check target safety and invalidate
    any stale regular file at that path on either fetch failure or write
    failure (such as `EACCES` on a read-only file in a writable directory,
    without touching symlinks, hardlinks, or non-regular files).
  - Harden same-file detection on `--compare` via `realpathSync`, parent-dir
    canonicalization, and `(dev, ino)` so symlink and hardlink aliases cannot
    compare a snapshot with itself, and flag inverted timestamps
    (`now.capturedAt < start.capturedAt`) as dirty.
  - Always write the structured verdict on both clean and dirty `--compare
--out` runs; on clean runs print `  guard-verdict  <path>` and
    `  guard-sha256  <64-hex>`.
- **`verify-pr-check.mjs`**:
  - Add `--guard <verdict>`, `--guard-sha256 <64-hex>`,
    `--guard-max-age-sec <1..86400>` (default `600`), and `--require-guard`
    (which also requires a digest-bound host `--context` snapshot with
    `--context-sha256` carrying repo, PR number, and `headRefOid` so a fresh
    verdict from another PR or head cannot be replayed).
  - Apply the same host-trust boundary used for `--context` and
    `--execution-record`: refuse in-tree paths, filesystem-root trust roots,
    hardlinks, symlinks, non-regular/FIFO/oversized files, digest mismatches,
    and any `guard-verdict.json` planted inside the PR-writable artifact dir.
  - Validate verdict schema, `clean === true` with empty `reasons`, valid
    `owner/repo` + positive `pr` matching `--context` coordinates, matching
    40-hex `startHeadRefOid`/`nowHeadRefOid`/`expectedHead`, `OPEN` PR state at
    both ends, monotonic UTC timestamps
    (`startCapturedAt <= nowCapturedAt <= comparedAt`), freshness against
    `nowCapturedAt` and `comparedAt`, and a 60 s future-skew bound.
- **`SKILL.md`**: Document the per-round host directory layout outside the
  container-mounted verify cache (`~/.cache/qwen-verify-guard/pr<n>/<round-id>/`,
  strictly separate from the `~/.cache/qwen-verify/pr<n>` directory mounted as
  `/verify-context:ro` so raw unfiltered guard snapshots stay unreadable from
  inside the verification container). Require allocating `<round-id>` and
  creating `guard-start.json` with `--no-clobber` **before** `verify-pr-prepare.mjs`
  fetches `review-threads.json` (or re-running `prepare` afterward if it ran
  first), closing the gap between material preparation and guard baseline
  creation. The local `--publish` gate clears stale per-round files, refreshes
  `guard-now.json` in the same step (exiting immediately on failure), compares
  into `guard-verdict.json` + `guard.sha256`, and requires
  `verify-pr-check.mjs` with `--require-guard` to exit 0 before posting —
  including the runner-backed VM variant (`microvm` / `provider-vm`) that keeps
  the runner's `--execution-record`, `--execution-record-sha256`, and vault
  artifact directory in the same final check.

## Design Decisions and Rationale

- **Filter `issueComments` to `OWNER`/`MEMBER`/`COLLABORATOR` at snapshot time**:
  Prevents arbitrary untrusted PR commenters from injecting prose into the
  token-free sandbox while keeping the `jq` and JS logic regex-free and
  identically deterministic.
- **Anchor freshness on `nowCapturedAt`, not only `comparedAt`**: Re-running
  `--compare` on a 30-minute-old `now.json` would otherwise refresh
  `comparedAt` and bypass mid-round push/comment detection.
- **Overwrite `--out` on dirty runs**: Ensures a failed guard attempt cannot
  leave an older `clean: true` file intact at the canonical path.
- **Keep `--require-guard` opt-in at the CLI level**: Preserves backwards
  compatibility for CI `--publish-lane` and non-publishing local checks while
  making local `--publish` strictly fail-closed.

## Constraints and Risks

- `comments(last: 100)` caps the top-level snapshot at the latest 100 comments;
  `issueCommentCount` exposes truncation so the round discloses it rather than
  claiming completeness.
- When a PR has more than 100 formal reviews and the closing GraphQL probe
  paginates backward via `before` cursors, GitHub provides per-request
  responses rather than a cross-page transaction: `seenReviewIds.size` ensures
  every review is checked, and each review's authoritative observation time is
  the response that read its page (a dismissal on an unread page is caught in
  that check, whereas a dismissal of an already-read page arriving between
  GraphQL pages is caught on the next refresh).
- `verify-pr-guard.mjs --compare --out` relies on host clock accuracy within 60 s
  between snapshot capture and check execution.
- Prompt-level adversarial rules in `SKILL.md` still depend on agent adherence;
  the six-axis reporting requirement ("list which ran and move skipped axes to
  _Not covered_") makes omissions auditable in review.

## Validation Plan and Acceptance Criteria

1. Live GraphQL query check of the updated `REVIEW_STATE_QUERY` against a real
   PR (`QwenLM/qwen-code#18494`) with `gh api graphql --paginate --slurp`.
2. Unit and parity tests pass:
   - `scripts/tests/verify-pr-prepare.test.js` (updated `REVIEW_STATE_QUERY`,
     maintainer-only non-minimized `issueComments`, `issueCommentCount`,
     malformed `comments` fail-closed).
   - `scripts/tests/qwen-triage-workflow.test.js` (exact `jq` vs `reviewState()`
     parity including `issueComments`, plus `SKILL.md` pins for the adversarial
     protocol, top-level blocking comments, and `--require-guard` gate).
   - `scripts/tests/verify-pr-guard.test.js` (`capturedAt`, symlink/hardlink
     same-file refusal, `--out` clean/dirty overwrite, `guard-sha256`, safe write
     refusals).
   - `scripts/tests/verify-pr-check.test.js` (`checkGuardVerdict()` unit cases
     plus CLI end-to-end tests chaining `verify-pr-guard --compare --out` into
     `verify-pr-check --require-guard --guard --guard-sha256`, refusal of
     in-tree/hardlink/symlink/tampered/stale/dirty/non-OPEN/planted verdicts).
   - `scripts/tests/verify-pr-model-proxy.test.js` (no regressions to existing
     `SKILL.md` pins).
3. Workflow lint (`actionlint`) on `.github/workflows/qwen-triage.yml` and
   `eslint` + `prettier --check` on all touched files pass with zero errors.
