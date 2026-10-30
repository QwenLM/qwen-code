# /autofix-pr: stale-base hint and base merge

[English](2026-10-30-autofix-pr-stale-base.md) | [简体中文](2026-10-30-autofix-pr-stale-base.zh-CN.md)

Status: proposed (2026-10-30)

## Problem statement

A PR branch can fail CI purely because its base is stale: `main` already
carries a fix (a dependency bump, a corrected test, a renamed symbol) that
the branch has not merged. The `/autofix-pr` skill today cannot recognize
this case and never merges the base for it:

- The brief template classifies a failed check two ways only: a defect in
  the PR's code or tests → fix it; a failure outside the PR (network,
  runner, an unrelated flaky test) → change nothing and report `rerun`.
- A stale-base failure falls into the second bucket. `rerun` re-runs the
  same red run once per (check, head, attempt); it fails again, and the
  round answers `needs_human`. The branch stays behind, and the watch
  spends its re-run budget on a failure no re-run can fix.

The CI-side fleet workflow (`.github/workflows/qwen-autofix.yml`, rationale
`af-109`/`af-110`) already handles this case: when a red check is green on
current `main` and the PR is behind, it merges `main` in via
`PUT /pulls/<n>/update-branch`. The local skill is not aligned with it.

## Current state

Verified against `origin/main` at `38337f7257` (2026-10-30):

- `packages/cli/src/commands/autofix-pr/snapshot.ts`: `PR_QUERY` fetches
  `mergeable` (`MERGEABLE | CONFLICTING | UNKNOWN`) but not
  `mergeStateStatus`. Neither the gate nor the round snapshot carries any
  "branch is behind its base" signal.
- The brief template in
  `packages/core/src/skills/bundled/autofix-pr/SKILL.md` already contains
  the base-merge recipe (`git fetch <remote> <baseRefName>` then
  `git merge --no-edit FETCH_HEAD`, never rebase), but only the `conflict`
  event triggers it.
- No helper calls `PUT /pulls/<n>/update-branch`, and rule 1 of the skill
  forbids the model from making GitHub writes outside the helpers.
- `rerun.ts` allows one re-run per (check, head, attempt); a second failure
  on the same attempt is treated as real (`needs_human`).

## Goals

- A round snapshot tells the fix agent when the branch is behind its base
  while checks are failing.
- The brief instructs the fix agent to merge the base first in that case,
  reusing the existing conflict recipe and the existing `push` path.
- No new GitHub write surface; the gate probe is unchanged.

## Scope boundaries (non-goals)

- No "red on the PR, green on current main" attribution (the workflow's
  strong criterion). It costs three extra REST reads per decision and is
  left as a possible follow-up.
- No `update-branch` API helper. All writes keep going through `push`.
- No change to the re-run budget, the push budget (`MAX_PUSHES`), the trust
  rules, or the gate cursor.
- No `mergeStateStatus`/`BEHIND` detection: GitHub reports `BEHIND` only
  when the repository requires branches to be up to date before merging,
  so it is blind on repositories without that protection.

## Proposed changes

### 1. `snapshot.ts` — a lazy compare in prepared mode only

- New exported function `baseIsBehind(state, headSha)`: reads
  `gh api repos/<owner>/<repo>/compare/<baseRefName>...<headSha> --jq .status`
  and answers `true` only for `behind` or `diverged`. Any error (network,
  404 on a cross-fork head the base repository cannot resolve, malformed
  output) answers `false`: the round goes on without the hint.
- `runSnapshot` (the prepared, non-gate path), after `buildSnapshot`: when
  the snapshot's action is `fix` and its events hold at least one
  `ci_failed` that is not a `startupFailure`, call `baseIsBehind`; when it
  answers `true`, add `baseBehind: true` to the snapshot written to the
  snapshot file and to the one-line stdout summary.
- `Snapshot` gains `baseBehind?: true`, documented as prepared-mode only:
  the branch is behind its base, so a failed check may be the base's fault.
- The gate path (`runGate`, `buildGateSnapshot`) is untouched: it already
  wakes a round on every new failed attempt, and the round recomputes the
  hint. A quiet PR pays nothing.

### 2. `SKILL.md` — the hint and the base-merge instruction

- Round step 2 documents `baseBehind: true` next to `lagging` and
  `truncated`.
- The brief template's "What to do" gains one bullet, before "Failed
  check": when the snapshot says `baseBehind: true`, merge the base first
  (`git fetch <remote> <baseRefName>` then `git merge --no-edit FETCH_HEAD`,
  never rebase), and resolve any conflict. A failed check the merge
  already fixed needs no code change; the rest are handled as failed
  checks below.
- The summary guidance says the base merge is reported like any other
  pushed fix.
- The brief's Events scoping sentence exempts "the fields these
  instructions name", so the brief does not forbid the base merge it
  commands; a consistency pin in `SKILL.test.ts` keeps the two in
  agreement.
- The user guide's round description
  (`docs/users/features/autofix-pr.md`) gains the same behavior in one
  sentence: checks failing on a behind branch merge the base first.

### 3. Tests

- `snapshot.test.ts` (or a collocated suite following the existing mock
  pattern of `snapshot.gate.test.ts`): `baseIsBehind` over mocked `gh`
  (`behind`, `diverged`, `ahead`, `identical`, thrown error); the
  `runSnapshot` flag conditions (failed check present → compare asked;
  no failures / only `startupFailure` / `lagging` → compare not asked).
- `SKILL.test.ts`: pins for the new sentences, following the existing
  flattened-text assertion style.

## Design decisions and rationale

- **REST compare over `mergeStateStatus`.** `BEHIND` depends on branch
  protection settings; `compare` is authoritative on every repository.
  The call is lazy — one REST read per round that already has a new failed
  attempt — and degrades to "no hint" on any error, so gh-link jitter
  cannot fail a round.
- **Weak criterion (behind + red → try a merge) over strong attribution.**
  The hint is advisory: the fix agent still reads every log. A false
  positive costs one base merge, which a behind branch usually needs
  anyway. Three properties bound the repetition without any new state
  field:
  1. failures are reported once per (check, head, attempt), so the hint
     only rides on rounds that already have something new to handle;
  2. a successful merge makes the branch contain its base, so `compare`
     answers `ahead` and the hint self-extinguishes;
  3. an attempt that fails verification or push ends `needs_human`, and
     `handledChecks` suppresses those failures on the same head.
     An explicit `baseHintSha` guard was considered and rejected as redundant
     with these three.
- **Merge through the worktree and `push` over an `update-branch` helper.**
  Keeps the skill's invariant that every write goes through the existing
  helpers; no `allowedTools` or tool-schema change; the merge goes through
  local verification and, when it conflicts, through the existing conflict
  resolution flow; compatible with the background fix mode.
- **A hint, not an event.** `baseBehind` adds no `SnapshotEvent`, changes
  no `action`, and touches no cursor. Action selection stays exactly as
  event-driven as before.
- **Compare direction `<base>...<headSha>`.** The compare status describes
  the head relative to the base (`behind` = the head lacks base commits),
  matching the fleet workflow's usage. A cross-fork head SHA resolves
  within the repository network; when it does not, the error degrades to
  "no hint".

## Constraints and risks

- One extra REST read per failing round; on gh-link jitter the hint is
  silently absent (documented degradation, same as today's behavior).
  The read shares the gh transport's transient-error retry (3 s + 6 s
  backoff), so on a transient 5xx the degradation costs about nine
  seconds before the round goes on without the hint (measured by the
  verification round). The round path has no read budget to exceed; the
  gate's 15 s budget is untouched.
- A false positive adds one merge commit and consumes one of the watch's
  `MAX_PUSHES` (10). Accepted: the merge is what a behind branch needs to
  become mergeable anyway.
- The merge commit moves the head, so every `synchronize`-triggered
  workflow re-runs — the same cost profile as any fix push.
- Autofix worktrees may lack `node_modules`, which limits local
  verification. This is an existing constraint of the worktree setup,
  unchanged by this design.

## Validation plan

- Unit tests with mocked `gh` for `baseIsBehind` and the `runSnapshot`
  flag conditions (see Tests above).
- `SKILL.test.ts` pins for the new brief and round text.
- A live read-only probe of the compare endpoint on a real behind PR
  (dry-run baseline in the E2E test plan).
- E2E test plan: `.qwen/e2e-tests/2026-10-30-autofix-pr-stale-base.md`.
- `npm run build`, `npm run typecheck`, and the focused unit tests of the
  changed files.

## Acceptance criteria

- A prepared watch whose PR has a failed check and a behind branch gets
  `baseBehind: true` in its round snapshot; an up-to-date branch does not;
  a compare failure neither fails the round nor sets the flag.
- The gate output is unchanged: no new fields, events, or cursor keys.
- The brief instructs the base merge, and the skill pins cover the new
  sentences.
- Build, typecheck, and the focused tests pass.

## Open questions

- Whether to upgrade to the strong attribution ("red here, green on
  main") and a dedicated `update-branch` helper later, based on the
  false-positive rate observed in real watches.
