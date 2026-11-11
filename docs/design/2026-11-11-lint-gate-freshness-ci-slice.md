# Compare the lint gate ci.yml defines, not the whole file

[English](2026-11-11-lint-gate-freshness-ci-slice.md) | [简体中文](2026-11-11-lint-gate-freshness-ci-slice.zh-CN.md)

Status: implemented, verified locally and against the live API; not yet landed

## Problem statement

`Check lint gate freshness` fails a PR when the base branch changed a
gate-defining file after the branch last incorporated it. Nine files are on that
list, and one of them — `.github/workflows/ci.yml` — is not like the others: it
carries the entire CI definition, while the other eight define the lint gate and
nothing else.

That difference turns whole-file containment into a treadmill for the busiest
file in the repository. `ci.yml` took ten commits in the week of 2026-11-04, and
most of them changed nothing about what the lint lane checks:

| Commit                  | Change                                      | Lint gate affected |
| ----------------------- | ------------------------------------------- | ------------------ |
| `e8061d493793` (#16764) | all sharded lanes reduced to two shards     | no                 |
| `2aac39a17b6f` (#16617) | web-shell visuals routed to the pool        | no                 |
| `65e1f1aeaaa8` (#16551) | external-PR CI routed to disposable runners | no                 |
| `8660f754305b` (#16476) | host assets refreshed on older checkouts    | no                 |
| `1a20792cfa93` (#16132) | no-AK integration gate routed to ECS        | no                 |
| `2b9c4a98f474` (#16328) | `COREPACK_HOME` pinned for Linux shards     | no                 |

Every one of those asked every in-flight PR to merge `main` and push, restarting
the whole matrix, before its `Lint & Static` lane could go green again. The lane
checks out the branch head alone, so a rerun can never turn it green.

This is the same treadmill the check's own header says it avoids by excluding
`package.json` and the lockfile: _"at 50-100 merges a day a dependency bump lands
almost daily, and forcing every in-flight PR to rebase behind one recreates the
'require up-to-date branch' treadmill."_ The exclusion was applied per file, and
one file's traffic reintroduced it.

### Relationship to the earlier rejection

[2026-11-09-lint-gate-freshness-ignores-subset.md](2026-11-09-lint-gate-freshness-ignores-subset.md)
listed a `ci.yml` lint slice as out of scope, on the evidence that for the two
branches it was measured against, the entire base-to-head delta fell inside the
slice — the `HELPER_TESTS` lines — so the verdict stayed stale and it fixed 0 of
the 9 reds in that sample.

That measurement stands, and this design does not contradict it. The
`HELPER_TESTS` lists **are** gate-defining: they name the suites the lane runs, so
a branch missing a new entry really is validating a smaller gate. This slice
keeps them, and still fails those two branches.

What the earlier sample did not cover is the plumbing class, which is what this
change addresses. Measured over the thirteen most recent `ci.yml` commits rather
than two branches, six are plumbing-only and now pass. One of them, #16551, was
also among the nine reds in that sample — so "0 of 9" was a property of the two
branches chosen, not of the approach. The dominant trigger in that sample,
#16200's global ignore addition, remains the other design's subject.

## Current state

`findStaleGateFiles()` spends two API calls per gate file — the newest base-side
commit touching it, then the swapped three-dot compare `S...head`, whose
`ahead`/`identical` status means the branch contains that commit. `diverged` or
`behind` means stale.

A `NARROWINGS` dispatch table already post-filters stale verdicts for
`eslint.config.js` and `.prettierignore`, where a purely subtractive scope change
cannot invalidate a branch. A file absent from the table keeps whole-file
containment, which is where `ci.yml` sits today. The narrowing path is
fail-closed: a fetch or extraction failure keeps the verdict and emits a
`::warning::`, because propagating would reach `main()`'s fail-open and discard
every other gate file's verdict too.

## Goals

- Stop failing a branch when the base-side `ci.yml` change left the lint gate
  this file defines byte-identical.
- Keep failing every base-side change that could make the branch's green
  insufficient, including a lane flag, a profile classifier change, a linter
  version, and a `HELPER_TESTS` list change.
- Never manufacture a green that whole-file containment would have denied: any
  shape the extractor cannot classify falls back to today's verdict.

## Scope boundaries

In scope: `.github/scripts/check-lint-gate-freshness.mjs`, its collocated suite,
and this document pair.

Explicitly out of scope:

- `ci.yml` itself is **not edited**. The slice is computed from the file's
  existing structure, so this change adds no workflow bytes, touches no
  `.size-baseline`, and needs no workflow meta-test update.
- `GATE_FILES` is unchanged; `ci.yml` stays on the list, and its containment
  verdict is still computed first.
- The other eight gate files keep their existing behavior, including the two
  scope narrowings.
- The `HELPER_TESTS` treadmill is not addressed, and unlike the plumbing it is
  not a false positive. Appending a suite adds work the lane must do; a branch
  that lacks the entry never ran that suite, so its green really is weaker.
  Moving the lists to their own file would only relocate the same verdict and
  would not remove the rebase, so that is explicitly **not** proposed as a
  follow-up.
- The fail-open policy of `main()` is unchanged.

## Proposed solution

Add a third `NARROWINGS` entry, `narrowsToUnchangedLintSlice`, which compares an
extracted slice instead of an ordering of ignore entries.

### The slice

`extractLintGateSlice(text)` keeps:

1. Every line above `jobs:` — triggers, `concurrency`, `permissions`,
   `defaults`, and the workflow `env`, which is where `ACTIONLINT_VERSION`,
   `SHELLCHECK_VERSION`, `YAMLLINT_VERSION` and both `HELPER_TESTS` lists live.
2. All of `classify_pr`. It selects the CI profile, and the profile selects which
   linters run, so it is gate-defining even though it is a different job.
3. `lint_and_static`, minus the plumbing below.

Everything else — every test, build and E2E job — is dropped.

Plumbing is a whitelist of **step names**, not a guess about content:

```
Create isolated HOME                            Configure persistent npm cache (self-hosted)
Restore workspace ownership                     Configure npm for rate limiting
Clean stale .qwen before checkout                Report npm cache usage (self-hosted)
Recreate runner Git metadata                     Clean isolated HOME
Checkout                                         Dump disk state on failure
Verify checkout includes expected head commit    Upload disk-pressure samples
Select Linux runner                              Disk floor gate (self-hosted)
Verify trusted classifier checkout is clean
Checkout trusted CI classifier
```

At the job level only `runs-on` and `timeout-minutes` are dropped, with their
continuation lines. `env`, `if`, `needs`, `outputs`, `permissions` and `steps`
stay: they decide what runs, not where.

Whole-line comments and blank lines are dropped from the compared text, because
`ci.yml` is comment-dense and much of its churn is prose. Only a line whose first
non-space character is `#` is dropped, so a `#` inside a shell body is content
and survives — the extractor never removes a line the runner would read.

Measured on the current file, the slice is 372 lines of 3514, and the lint job's
42 steps contribute 29 (13 are plumbing).

### Why the default is "keep"

The whitelist names what may be **ignored**, not what matters. Forgetting to
classify a new gate step leaves it in the slice and costs at most today's
over-rejection; a wrong entry in the list would hide a real gate change. The
asymmetry is deliberate, and two guards back it:

- A step in the plumbing list whose body invokes a linter refuses the narrowing
  outright. The label is not trusted on its own — a step moved into the list
  while still running `scripts/lint.js` is a contradiction, not a pass.
- The suite reads the real workflow and requires every plumbing name to exist in
  it, so a renamed step cannot leave a stale entry silently excluding nothing.

Node provisioning (`setup-node`, the pnpm store action, the self-hosted Node
action) deliberately stays **in** the slice: those decide the toolchain the
linters run under, so a version bump there can change lint semantics. Only the
cache's location and the npm retry settings are excluded.

The install prelude also stays in. #16900 and #16920 widened exactly that prelude
to close a post-merge lint gap: an install a profile skips is a linter that
profile never runs.

### Fail-closed extraction

`extractLintGateSlice` returns `null` — and the caller keeps the whole-file
verdict — for any shape it does not model:

- a step that is not `      - name: '<single-quoted name>'`, including an unnamed
  `- uses:` step. This check runs **before** the step body is appended to the
  current step, so an unnamed step following a plumbing step cannot be absorbed
  as that step's content and vanish from the slice;
- a duplicated job key, where YAML would take the last copy and a `Map` would
  silently keep whichever the parser reached;
- a missing `jobs:`, `classify_pr`, or `lint_and_static`, so renaming the lint job
  cannot read as "no gate to compare";
- content before the first job key that is neither a comment nor blank.

`null` throws rather than returning `false`, so the existing fail-closed catch
emits its `::warning::`. A silent `false` would disable the narrowing for every
PR and leave no trace beyond a stale verdict nobody can explain.

This is line-anchored, with no YAML parser: the suite runs in
`HELPER_TESTS_DEP_FREE`, whose import closure must stay `node:` builtins, and the
step runs before any dependency install.

### The comparison baseline is the merge base

The two sides are the **base tip** and the **merge base**, not the head.
Comparing the head's slice would flag a branch for its own gate edit and keep
flagging it after the rebase it asks for, because `main` will not carry that edit
until the branch merges. The question is whether the gate moved _under_ this
branch, so the branch's own version never enters the comparison. A branch that
weakens the gate is caught by the whole-file rule on the gate file it edits, and
by review.

The merge base is taken from the containment compare the check **already made**,
so the narrowing costs no additional compare. This was forced by measurement: a
fresh `GET /compare/main...head` on this repository returns ~4 MB of commits and
files and timed out at curl's 30-second ceiling against a real week-old branch.
That failure would have reached `main()`'s fail-open and discarded every other
gate file's verdict — turning an optional refinement into a blanket pass.

Reusing the existing compare is also sound, not just cheap. It compares the
base-side gate commit `S` against the head; `S` is on `main` and is not contained
(the verdict is stale), so its merge base is the branch's fork point from `main`.
Should it ever resolve older than the true fork point, the slice comparison
over-rejects, which is the safe direction.

## Constraints

- Node builtins only; no YAML parser, and no evaluation of branch-controlled
  text.
- No new API call per PR beyond the two content reads, and those only on a
  verdict that already came back stale.
- The verdict object's shape is unchanged, so the report and the existing
  assertions still hold; the comparison is carried beside the verdicts, not on
  them.

## Risks

- **Misclassification is the real risk.** A gate-defining step wrongly listed as
  plumbing would hide a base-side gate change. Mitigated by the keep-by-default
  rule, the linter-invocation refusal, and the suite's anchor-drift guards. It is
  not eliminated: a reviewer must check the list on any PR that edits it.
- **Landing this PR asks every in-flight PR to rebase once.** The check watches
  its own file with whole-file containment, so this edit is itself a base-side
  gate change — the same one-time wave its introduction caused.
- **Anchor drift.** A reformat that defeats the line anchors disables the
  narrowing. It fails closed and annotates, and the suite reads the real file so
  the drift reddens here first.
- The slice covers the `Lint & Static` lane's gate only. `test_build` carries two
  static checks of its own (`check-serve-fast-path-bundle.js`,
  `check:core-subpath-exports`). Whole-file containment covered a base-side change
  to them; this narrowing no longer does, and that is an accepted net reduction:
  they do not belong to the `Lint & Static` lane, so a branch's green on that lane
  never depended on them.
- **Accepted residual risk:** `Checkout` and `Verify checkout includes expected
head commit` stay outside the slice. A base-side `ref:` or `fetch-depth:` edit,
  or an edit to that verification step's body, is invisible here. A wrong tree
  still reddens the lane at the verification step; going silent takes two
  coordinated edits.
- **Accepted residual risk:** `classify_pr`'s `Checkout trusted CI classifier` is
  in the same class — the checkout is excluded while the step that actually
  selects the profile is kept.
- **Accepted residual risk:** the job-level `runs-on` and `timeout-minutes` are
  dropped. Routing can change the linter's runtime indirectly through the
  self-hosted Node action, and a tightened timeout reddens `main` after merge
  rather than the branch.
- **Accepted residual risk:** `.github/actions/**` is not in `GATE_FILES`. Where a
  kept step references a local action, the reference is in the slice but the
  action's implementation is not, so a base-side change to that implementation is
  invisible to this check — a gap that predates this PR, left to a follow-up.
- **Accepted residual over-rejection:** everything above `jobs:` is kept
  wholesale, so a base-side `on:` or `concurrency:` edit still stales every
  in-flight PR even though it cannot change what lint checks. Narrowing that
  prelude to `env` alone would remove those reds too, but the prelude also carries
  `permissions` and `defaults.run.shell`, which do change how every step behaves.
  Left in the safe direction deliberately.

## Validation plan

1. `node --test .github/scripts/check-lint-gate-freshness.test.mjs` — 62 cases,
   including the 16 added here. CI corroborates this on Linux through
   `Run .github/scripts helper tests`, which collects the suite from
   `HELPER_TESTS_DEP_FREE`.
2. Mutation witnesses: each of eight deliberate defects must redden the suite —
   dropping `ci.yml` from `NARROWINGS`, returning the whole file as the slice,
   keeping headers only, comparing the head instead of the merge base, absorbing
   an unnamed step, treating a missing merge base as fresh, trusting the plumbing
   label without the linter check, and dropping the job `env` from the slice.
3. Slice completeness against the real workflow: every `scripts/lint.js` lane
   flag must survive in the slice.
4. Live API, ten historical base tips with a fork point one commit behind each,
   content read at real refs: six plumbing-only commits must pass and four
   gate-changing commits must stay stale.
5. Live API on the branch that motivated the report (#16939 at `07d89196bd21`):
   it must stay stale, because #16920 really did change the Prettier lane.

## Acceptance criteria

- The suite passes, and all eight mutations redden it.
- Six of the thirteen most recent `ci.yml` commits no longer ask for a rebase;
  the other seven still do.
- #16939's red is preserved.
- No `ci.yml` edit, no `.size-baseline` change, no workflow meta-test change.

## Open questions

- The remaining `ci.yml` reds are the `HELPER_TESTS` additions, and they are
  true positives: the branch really did skip a suite the base gate now runs.
  The only honest remedies are to run the base's list rather than the branch's
  (which means executing base-controlled code against a branch tree, a trust
  decision this lane deliberately avoids), or to accept the rebase. Neither is
  attempted here, and relocating the lists is not a remedy.
- Should this lane become a required status check? The narrowing reduces false
  reds, which is a precondition for that, but the decision is separate and the
  step remains advisory today.
