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
than two branches, seven are plumbing-only and now pass. One of them, #16551, was
also among the nine reds in that sample — so "0 of 9" was a property of the two
branches chosen, not of the approach. The dominant trigger in that sample,
`#16200`'s global ignore addition, remains the other design's subject.

That count is a measurement at a named revision, not a constant: the window
slides as `main` moves. Two revisions of this document reported six and then
seven plumbing-only passes for exactly that reason, without any change to the
comparison — the corpus was re-taken at a later `main` tip, losing a
gate-changing commit and gaining a plumbing-only one. The corpus behind every
number below is re-taken at `main` `2a9c4f8732` and reported with that anchor,
rather than carried forward from an earlier revision.

## Revision note: the line model has been replaced

Earlier revisions of this change compared a **line slice** of `ci.yml`: an
exact-match table for four structural anchors (`jobs:`, the two-space job key,
`steps:`, `- name: '<name>'`), then a walk over the job that appended or dropped
each line, with `[[dropped …]]` markers standing in for the regions it excluded.

Review found the class that model cannot close. YAML's legal spellings are not a
finite list — a block-scalar indicator on the line **after** its key, under a tag
(`run: !!str |`), or in the `|2-` order rather than `|-2`; a sequence item whose
scalar is a block (`- |`); a multi-line flow scalar; a comment after any
structural token; an anchor cited across the file. Each review round named one
more spelling, and every one had the same consequence: content the runner reads
fell through to the "prose" branch and was **deleted from the compared text**, so
a real gate change compared equal, the stale verdict was dropped, and the branch
was certified fresh — the `#11117 → #11216` shape this check exists to prevent,
reached through a different spelling.

Adding a refusal per spelling does not converge, because the input is a grammar
and the model was a line scanner. This revision parses the file instead and
compares the parsed gate, so the comparison is over **meaning** rather than
spelling. What the model refuses is now a short list of structural facts about
the gate (a missing job, an unnamed step, a dependency edge outside the gate),
not a list of ways to spell YAML.

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
  this file defines structurally identical.
- Keep failing every base-side change that could make the branch's green
  insufficient, including a lane flag, a profile classifier change, a linter
  version, and a `HELPER_TESTS` list change.
- Never manufacture a green that whole-file containment would have denied: any
  document the parser rejects, or that is not shaped like the gate this model
  describes, falls back to today's verdict.

## Scope boundaries

In scope: `.github/scripts/check-lint-gate-freshness.mjs`, its collocated suite,
two steps in `.github/workflows/ci.yml`, the two workflow meta-tests that pin
where those steps sit (`scripts/tests/sdk-java-workflow.test.js`,
`scripts/tests/ci-platform-lanes.test.js`), and this document pair.

Also in scope, and folded in rather than landed separately: the wiring pins on
the `Report test growth` step in the same job
(`.github/scripts/check-test-growth.test.mjs`), which closes #16991 and
supersedes #16993. It edits assertions about a gate this document already
describes, so keeping it in its own PR meant two PRs racing on the same
literals. Three more follow-ups are folded in for the same reason: the freshness
step's exit-status pin (was #17007), ESLint on the `github_ci_only` profile
(was #17004), and the corrected rationale for the no-AK typecheck heap cap
(was #17008). The PR description carries the detail; the validation plan below
carries the evidence.

`ci.yml` **is** edited, unlike earlier revisions of this change. Two edits, both
forced by the parser, neither changing what the gate checks:

- `Check lint gate freshness` moves from before `Install dependencies` to after
  it. It parses the file with the `yaml` package, which only exists once
  dependencies are installed. Its `if:` expression, its profile gating and its
  `::warning::` text are unchanged — **position only**.
- A new `Run lint gate freshness tests` step runs the collocated suite on the
  `github_ci_only` profile, whose pre-install helper battery can no longer carry
  it (see "Where the suite runs").

Explicitly out of scope:

- `GATE_FILES` is unchanged; `ci.yml` stays on the list, and its containment
  verdict is still computed first.
- The other eight gate files keep their existing behavior, including the two
  scope narrowings. Their tests are not touched by this revision.
- The `HELPER_TESTS` treadmill is not addressed, and unlike the plumbing it is
  not a false positive. Appending a suite adds work the lane must do; a branch
  that lacks the entry never ran that suite, so its green really is weaker.
  Moving the lists to their own file would only relocate the same verdict and
  would not remove the rebase, so that is explicitly **not** proposed as a
  follow-up.
- The fail-open policy of `main()` is unchanged.

## Proposed solution

Add a third `NARROWINGS` entry, `narrowsToUnchangedLintSlice`, which compares a
parsed gate document instead of an ordering of ignore entries.

### The gate document

`lintGateDocument(text)` parses with
`parseDocument(text, { uniqueKeys: true })` and returns a plain object holding:

1. Every top-level key except `jobs:` — triggers, `concurrency`, `permissions`,
   `defaults`, and the workflow `env`, which is where `ACTIONLINT_VERSION`,
   `SHELLCHECK_VERSION`, `YAMLLINT_VERSION` and both `HELPER_TESTS` lists live.
2. All of `classify_pr`. It selects the CI profile, and the profile selects which
   linters run, so it is gate-defining even though it is a different job. Four of
   its steps are kept (its checkouts are plumbing).
3. `lint_and_static`, minus the plumbing below: 32 of its 43 steps survive.

Everything else — 11 of the workflow's 13 jobs, every test, build and E2E lane —
is dropped.

Plumbing is a whitelist of **step names**, not a guess about content:

```
Create isolated HOME                            Configure persistent npm cache (self-hosted)
Recreate runner Git metadata                     Configure npm for rate limiting
Checkout                                         Report npm cache usage (self-hosted)
Verify checkout includes expected head commit    Clean isolated HOME
Select Linux runner                              Dump disk state on failure
Verify trusted classifier checkout is clean      Upload disk-pressure samples
Checkout trusted CI classifier                   Disk floor gate (self-hosted)
```

Two steps that harden the tree the linters read are deliberately **not** on that
list: `Restore workspace ownership` and `Clean stale .qwen before checkout`
sanitise the workspace before checkout, and untrusted fork code runs in this job.
A base-side hardening of either is a security fix that has to reach in-flight
branches, and both are edited on incidents rather than on routing churn, so they
stay in the slice and stale the branch like any other gate change.

At the job level only `runs-on` and `timeout-minutes` are dropped. `env`, `if`,
`needs`, `outputs`, `permissions` and `steps` stay: they decide what runs, not
where. `needs` in particular stays, so a base-side change to which jobs the lane
waits for is compared — and an edge to a job outside the gate-job list refuses
the narrowing rather than being followed, since the model does not walk the
dependency graph.

### What is refused

`lintGateDocument` returns `null` — and the caller keeps the whole-file verdict —
when the document is not a gate it will stand behind:

- the parser reports an error, including a duplicate key (`uniqueKeys`);
- there is no `jobs:` mapping, or either gate job is missing or not a mapping, so
  renaming the lint job cannot read as "no gate to compare";
- a step is not a mapping, or has no `name` — an unnamed step cannot be matched
  against the whitelist, so what it does cannot be stated;
- two steps in one job share a name, so the dropped/kept distinction is
  ambiguous;
- a plumbing step's own content invokes a linter: the label contradicts the body,
  which is a refusal rather than a pass (see below);
- a gate job's `needs:` names anything outside the gate-job list.

`null` throws rather than returning `false`, so the existing fail-closed catch
emits its `::warning::`. A silent `false` would disable the narrowing for every
PR and leave no trace beyond a stale verdict nobody can explain.

The two sides are compared as text: `extractLintGateSlice` renders the gate with
a `canonical()` serializer that sorts object keys and writes no whitespace, so
two documents compare equal exactly when their gates are structurally equal. For
the current file the compared payload is 34,534 bytes.

### Why the default is "keep"

The whitelist names what may be **ignored**, not what matters. Forgetting to
classify a new gate step leaves it in the slice and costs at most today's
over-rejection; a wrong entry in the list would hide a real gate change. The
asymmetry is deliberate, and three guards back it:

- A step in the plumbing list whose content invokes a linter refuses the
  narrowing outright. The label is not trusted on its own — a step moved into the
  list while still running `scripts/lint.js` is a contradiction, not a pass. The
  pattern covers the way the lanes are actually reached: `npm run`, `pnpm run`,
  `corepack pnpm run`, a bare `pnpm lint`, `npx`/`pnpx`, and `node --test`, which
  is itself a gate. Anchoring on `npm run` alone missed every `pnpm` spelling,
  since `pnpm` has no word boundary before `npm`. Flags between the manager and
  its subcommand are skipped for the same reason: `pnpm -w run lint` and
  `pnpm --filter ./packages/core run lint` reach the same lane. A manager followed
  by `config`/`set` is configuration and still passes — `npm config set
fetch-retries 5` is a real plumbing step, so refusing it would disable the
  narrowing for every PR. The test is over the step's **canonical form**, so it
  sees the content however it is spelled or laid out.
- The suite reads the real workflow and requires every plumbing name to exist in
  the two gate jobs, so a renamed step cannot leave a stale entry silently
  excluding nothing. Scoping matters: a whole-file inventory can be kept alive by
  a same-named step in a test lane after the gate job's copy is renamed.
- Dropping a non-gate job removes it from the compared text, so this model no
  longer needs the roster markers the line model used. The protection they
  carried is now the pipeline itself: reclassifying a job as non-gate is a
  one-line change to `CI_GATE_JOBS` that a review sees, and the `needs:` refusal
  catches the case the markers were introduced for — the install prelude split
  into a new job that the gate job then depends on.

Node provisioning (`setup-node`, the pnpm store action, the self-hosted Node
action) deliberately stays **in** the slice: those decide the toolchain the
linters run under, so a version bump there can change lint semantics. Only the
cache's location and the npm retry settings are excluded.

The install prelude also stays in. #16900 and #16920 widened exactly that prelude
to close a post-merge lint gap: an install a profile skips is a linter that
profile never runs.

### Why a parser, and what it costs

The claim this narrowing makes is an **equality** claim about a YAML document.
Any line-based model has to enumerate the document's spellings to make it, and
that enumeration is open-ended — which is how four review rounds produced four
different spellings that all compared equal. A parser removes the class rather
than the instances: anchors resolve, flow scalars join, block scalars carry their
content, and comments and layout stop existing at the point of comparison. Two
documents then compare equal exactly when a runner would see the same gate.

Three costs, all accepted:

- **The suite needs `yaml`.** It leaves `HELPER_TESTS_DEP_FREE`, whose import
  closure must stay `node:` builtins, and joins `HELPER_TESTS`. On the `full`
  profile that is the same battery it ran in before, only after the install.
- **The check runs after `Install dependencies`.** A stale branch now pays one
  install before being told to rebase. That is a latency cost, not a correctness
  one: the install runs on every profile anyway, so no profile gains or loses
  coverage, and the check still precedes the lint lanes it can make pointless.
- **`docs_only` still does not run the suite.** That is unchanged — the pre-install
  battery it used to sit in was already `github_ci_only`-only.

### Where the suite runs

| Profile          | Before                                                    | After                                          |
| ---------------- | --------------------------------------------------------- | ---------------------------------------------- |
| `full`           | `Run .github/scripts helper tests` (post-install)         | same step, `HELPER_TESTS` (post-install)       |
| `github_ci_only` | `GitHub CI helper checks` (pre-install, dep-free battery) | `Run lint gate freshness tests` (post-install) |
| `docs_only`      | never                                                     | never                                          |

The middle row is the point of the new step: a PR that edits this script is most
often classified `github_ci_only`, and the pre-install battery can no longer
carry a suite that imports `yaml`. Without the dedicated step the most relevant
profile would have stopped executing the suite.

### The comparison baseline is the merge base

The two sides are the **base tip** and the **merge base**, not the head.
Comparing the head's gate would flag a branch for its own gate edit and keep
flagging it after the rebase it asks for, because `main` will not carry that edit
until the branch merges. The question is whether the gate moved _under_ this
branch, so the branch's own version never enters the comparison.

The branch's own edits are therefore outside this check, and **not** because
another mechanism covers them: containment reads only a compare's status, never
its file list, so a branch that deletes a lint step from its own copy passes even
the whole-file rule. The division of labour is deliberate — a branch weakening
the gate is a product decision, reviewed by humans on the diff and reddened by
the post-merge lint on `main` — rather than a mechanical backstop.

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

- Node builtins plus the `yaml` package, which is already a root dependency
  (`^2.8.1`, resolving to `2.9.0` in the lockfile); no evaluation of
  branch-controlled text, and no new dependency.
- No new API call per PR beyond the two content reads, and those only on a
  verdict that already came back stale.
- The verdict object's shape is unchanged, so the report and the existing
  assertions still hold; the comparison is carried beside the verdicts, not on
  them.

## Risks

- **Misclassification is the real risk.** A gate-defining step wrongly listed as
  plumbing would hide a base-side gate change. Mitigated by the keep-by-default
  rule, the linter-invocation refusal, the `needs:` refusal and the suite's
  anchor-drift guards. It is not eliminated: a reviewer must check the list on
  any PR that edits it.
- **The gate-job roster is a single constant.** `CI_GATE_JOBS` names the two jobs
  compared. Adding a job that also defines the gate — a second lint job, a
  profile classifier split in two — is invisible until that list is updated.
  Accepted: the list is one line next to the plumbing whitelist, and a base-side
  edit to it is itself a `GATE_FILES` change.
- **A parser dependency enters a required check.** A `yaml` regression, or a
  lockfile state where the module is absent, makes `extractLintGateSlice` throw
  and the catch emit its `::warning::` — the narrowing stops applying and every
  base-side `ci.yml` commit asks for a rebase again. Fail-safe, not a false
  green, and the lane reddens on the import itself rather than passing silently.
- **Comparing parsed values drops layout from the claim.** A base-side commit
  that only reformats `ci.yml`, or reorders keys or `HELPER_TESTS` entries,
  compares equal and passes. That is the intent: the runner reads none of it.
  The cost is that a reviewer cannot use this check to learn that the file was
  touched, only that its gate was.
- **YAML merge keys (`<<`) are compared as written, not expanded.** No such
  spelling exists in `ci.yml`; if one appeared, the anchored map would still be
  part of the compared text (through the key's value), so a base-side edit inside
  it is seen, but the merge itself is not modelled. Left as stated rather than
  handled.
- **Landing this PR asks every in-flight PR to rebase once.** The check watches
  its own file with whole-file containment, so this edit is itself a base-side
  gate change — the same one-time wave its introduction caused.
- The slice covers the `Lint & Static` lane's gate only. `test_build` carries two
  static checks of its own (`check-serve-fast-path-bundle.js`,
  `check:core-subpath-exports`). Whole-file containment covered a base-side change
  to them; this narrowing no longer does, and that is an accepted net reduction:
  they do not belong to the `Lint & Static` lane, so a branch's green on that lane
  never depended on them.
- **Accepted residual risk:** `Checkout` and `Verify checkout includes expected
head commit` stay outside the slice. A `ref:` edit on its own is caught: the
  checkout is `fetch-depth: 1`, so a ref that is not the expected head leaves that
  commit out of the shallow clone and the verification step fails closed. What is
  invisible here is the pair — `ref:` pointed at a merge ref _and_ a `fetch-depth:`
  deep enough to contain the expected head: the guard then passes while lint runs
  on the merge tree. That tree contains the branch, so bad code cannot escape; the
  cost is attribution, and `Lint & Static` is a required check, so the lane is not
  advisory. A `fetch-depth:` edit on `Checkout` does not move the linted tree: the
  incremental scope's depth is owned by `Fetch incremental lint history`, which
  stays in the slice, and `lint-scope.js` falls back to `full: true` — a wider
  run — only when that step cannot resolve the merge base within its depth
  ceiling. Editing the verification step's body removes the guard without touching
  the tree.
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
- **Accepted residual risk:** the cache plumbing is outside the slice.
  `Create isolated HOME` in this lane exports `COREPACK_HOME` and
  `XDG_CACHE_HOME`, and `Configure persistent npm cache (self-hosted)` elsewhere
  exports `NPM_CONFIG_CACHE`. A base-side edit that points corepack's home at a
  shared directory is exactly the cache-poisoning channel the per-run home
  prevents, and this check cannot see it.
- **Accepted residual over-rejection:** everything above `jobs:` is kept
  wholesale, so a base-side `on:` or `concurrency:` edit still stales every
  in-flight PR even though it cannot change what lint checks. Narrowing that
  prelude to `env` alone would remove those reds too, but the prelude also carries
  `permissions` and `defaults.run.shell`, which do change how every step behaves.
  Left in the safe direction deliberately.
- **Accepted over-rejection: dependency closure.** `needs:` is compared, so a
  base-side change to WHICH jobs the lane depends on is seen. The model still does
  not walk that dependency graph, so instead of following the edge it refuses it:
  a gate job that `needs:` anything outside the gate-job list returns null and
  keeps whole-file containment. Without that refusal the hole was silent and
  permanent — splitting the install prelude into a new job stales everyone once,
  correctly, and every later edit inside that job then compares equal, because the
  job is dropped while its name and its `needs:` entry stay identical. No such
  edge exists today (the lint job needs only `classify_pr`, which is itself in the
  slice), so the refusal costs nothing now and fires exactly when the slice would
  stop being the whole gate. All three YAML spellings of the list are covered —
  inline, single-quoted and block — because the parse normalises them to the same
  value. Extending the gate-job list and reading the lane's `needs:` still have to
  happen together; the difference is that forgetting now over-rejects instead of
  certifying falsely.

## Test-suite accounting

The suite is 1,489 lines and 69 cases. Review asked for a rewrite that removes the
line model's spelling fixtures without touching behaviour coverage; this is the
account of where it stopped, and why it is not smaller.

| Revision                                                    | Lines | Cases |
| ----------------------------------------------------------- | ----- | ----- |
| `main`, before this PR                                      | 962   | 47    |
| Earlier revision of this PR (line model, spelling fixtures) | 2,009 | 83    |
| **This revision**                                           | 1,489 | 69    |

Of the 69 cases, 22 exercise the `ci.yml` gate document, its wiring and the
shared verdict pins; the other 47 are the `eslint.config.js` and
`.prettierignore` narrowing behaviour earlier review rounds required, which this
rewrite does not touch. The two groups are interleaved in one file, so the
removed lines cannot be attributed to one group — the case split is the part
that is separable.

The spelling fixtures are gone: the 17-row block-scalar modifier table, the six
shape witnesses for the line-absorbing model (a bare `-` step, a comment between
steps, a `#` line inside a run block, a job key after `steps:`, a lone CR hiding a
changed flag, an anchor/alias pair), and the `[[dropped …]]` marker assertions
went with the mechanism they tested. The script itself went from 975 lines to
751, which is the parsed-document model plus the header explaining why a parser
replaced the line scanner.

**The total is −26%, not −50%**, because the remainder is not spelling: 47 of the
69 cases are narrowing behaviour that earlier review rounds required, and
deleting or merging them to reach a number would trade a model change for
unrelated coverage loss. That cut needs its own review, so it is not made here.
Against `main` the suite is +527 lines and +22 cases, all of it the `ci.yml`
model, which `main` does not have.

## Validation plan

1. `node --test .github/scripts/check-lint-gate-freshness.test.mjs` — **69 cases,
   all green** on this revision (`main` runs 47; the PR adds 22). CI corroborates
   it on Linux through `Run .github/scripts helper tests` (`full`) and
   `Run lint gate freshness tests` (`github_ci_only`). Counts here are the runtime
   count at a named revision, not a tally carried across review rounds.
2. Mutation witnesses: each of eight deliberate defects must redden the suite.
   Measured on this revision, each mutation applied alone:

   | Mutation                                          | Result          |
   | ------------------------------------------------- | --------------- |
   | drop `ci.yml` from `NARROWINGS`                   | red, 5 failures |
   | return the whole file as the slice                | red, 12         |
   | keep step headers only                            | red, 7          |
   | compare the head instead of the merge base        | red, 5          |
   | absorb an unnamed step instead of refusing        | red, 2          |
   | treat a missing merge base as fresh               | red, 1          |
   | trust the plumbing label without the linter check | red, 1          |
   | drop the workflow `env` from the slice            | red, 2          |

   Five further witnesses cover the suite step this revision adds. Each was
   applied to the real `ci.yml` alone, confirmed red here and green on the
   previous revision, then reverted:

   | Mutation on `Run lint gate freshness tests`      | Result         |
   | ------------------------------------------------ | -------------- |
   | drop the `github_ci_only` profile arm            | red, 1 failure |
   | point the run line at another suite              | red, 1         |
   | add `continue-on-error: true`                    | red, 1         |
   | move it back before `Install dependencies`       | red, 1         |
   | append `\|\| true` (or `\|\| :`) to its run line | red, 1         |

3. Equivalence against the line model this replaces, on thirteen historical
   `ci.yml` commits with their parents as fork points, content read at real refs.
   Both models run on the same pair; `old`/`new` are the stale-or-fresh decision,
   and the two refusal columns show whether either side returned `null` for that
   pair:

   | tip          | parent       | line model | parser | old refused | new refused |
   | ------------ | ------------ | ---------- | ------ | ----------- | ----------- |
   | `4a03945f9a` | `441bd9abe1` | fresh      | fresh  | no          | no          |
   | `51c8b617c0` | `e58bf09add` | fresh      | fresh  | no          | no          |
   | `e58bf09add` | `92b9f6df3b` | fresh      | fresh  | no          | no          |
   | `71193fe367` | `6a999b20b7` | stale      | stale  | no          | no          |
   | `4a69cf2eb5` | `031c6e80af` | stale      | stale  | no          | no          |
   | `e8061d4937` | `138185d781` | fresh      | fresh  | no          | no          |
   | `2aac39a17b` | `2a191acfce` | fresh      | fresh  | no          | no          |
   | `0dd106d42f` | `c73a98951f` | stale      | stale  | no          | no          |
   | `65e1f1aeaa` | `1feab51dd7` | fresh      | fresh  | no          | no          |
   | `708ba347d3` | `d85e911c78` | stale      | stale  | no          | no          |
   | `8660f75430` | `ad83860092` | fresh      | fresh  | no          | no          |
   | `7cb46d9fed` | `e61ad3959e` | stale      | stale  | no          | no          |
   | `1b1f4455d9` | `1d64177286` | stale      | stale  | no          | no          |

   Summary: **13/13 decisions match, seven fresh and six stale, neither side
   refused a pair.** The corpus is re-taken at `main` `2a9c4f8732` rather than
   reused from an earlier revision of this document, which is why the seven/six
   split differs from the six/seven reported there: the window gained #16945's
   plumbing-only retry commit and lost a gate-changing one. The decisions agree
   point-for-point on the same tips, so the difference is corpus drift, not a
   disagreement between the models.

4. Model-completeness witnesses, one per refusal: a duplicated step name, a
   duplicated job key, a missing gate job, a `needs:` edge outside the gate jobs,
   unparsable YAML, an unnamed step, and a plumbing step that invokes a linter.
   Removing the corresponding guard reddens the case.
5. Slice completeness against the real workflow: every `scripts/lint.js` lane flag
   and both `HELPER_TESTS` lists survive in the slice, and every plumbing name
   exists in the two gate jobs.
6. Live API on the branch that motivated the report (#16939 at `07d89196bd21`):
   it must stay stale, because #16920 really did change the Prettier lane.

7. The folded test-growth pins (#16991):
   `node --test .github/scripts/check-test-growth.test.mjs` — **7 cases, all
   green**, unchanged in count. This suite stays in `HELPER_TESTS_DEP_FREE`, so
   it imports `node:` builtins only and reads the workflow as text rather than
   parsing it. Thirteen mutations were applied one at a time to the real
   `ci.yml` at `42254a95`, each run and reverted; every one leaves 6 pass / 1
   fail with the message named below, and the restored file is 7/7:

   | Mutation on `Report test growth`                             | Failing assertion                      |
   | ------------------------------------------------------------ | -------------------------------------- |
   | append `&& … != 'docs_only'` to its gate                     | `test growth gate drifted`             |
   | drop the `skip_ci != 'true'` arm                             | `test growth gate drifted`             |
   | exclude `github_ci_only` instead of having no profile arm    | `test growth gate drifted`             |
   | comment the gate out                                         | `test growth gate drifted`             |
   | remove `continue-on-error: true`                             | `test growth step must stay advisory`  |
   | replace it with a same-indent comment saying the same thing  | `test growth step must stay advisory`  |
   | rename the script it runs                                    | `step must run the test growth script` |
   | empty `GITHUB_TOKEN`, `BASE_SHA` or `HEAD_SHA` (three runs)  | `test growth step must pass …`         |
   | rename those three keys with a `TEST_GROWTH_` prefix (three) | `test growth step must pass …`         |

   The env rows are pinned as whole lines rather than as keys or values because
   the script returns early — one warning, exit 0, no summary — when any of the
   names it reads is absent. It reads four, not three: `GITHUB_REPOSITORY` as
   well, which is a default environment variable the runner injects, so the
   workflow never spells it and there is no fourth line to pin.
   A key-only pin accepts an empty value and a value-only
   pin accepts a renamed key; either leaves the report a permanent no-op behind
   a green check, since the step is `continue-on-error`. The commented-out gate
   is caught even though the identical literal survives in the step's trailing
   prose, because the regex anchors on the field's indent rather than the text.

   Severity here is deliberately lower than the freshness gate's: this step is
   advisory by contract and publishes no output any other step or job consumes,
   and the report only counts paths inside `packages/{core,cli,web-shell}/`. The
   case for pinning it is that the gate is intentionally profile-free, so an
   appended profile clause could only narrow it, and the day the step stops
   being advisory or grows an output that narrowing starts to matter with no
   test having gone red.

## Acceptance criteria

- The freshness suite passes, and all thirteen mutations redden it — the eight
  on the model and the five on the suite step's wiring.
- The folded test-growth suite passes at 7 cases, and its thirteen mutations each
  redden it with the assertion named in item 7 of the validation plan.
- Thirteen of thirteen historical `ci.yml` commits receive the same stale-or-fresh
  decision from the parser as from the line model it replaces, with neither side
  refusing a pair.
- Seven of the thirteen no longer ask for a rebase at `main` `2a9c4f8732`; the
  other six still do. Every one of the seven is plumbing-only and every one of the
  six changes the gate.
- #16939's red is preserved.
- `ci.yml` gains one step and one relocation, and neither changes the gate — the
  compared document. Its freshness step keeps its `if:`, its profile gating and
  its `::warning::` text.
- The folded ESLint change (#17004) **does** change the gate, deliberately and in
  the widening direction: `Run ESLint` gains the `github_ci_only` profile arm.
  `Run ESLint`'s `if:` is inside the compared slice, so a base-side edit of this
  kind stales in-flight branches — the correct direction, and the reason this is
  listed apart from the two gate-neutral edits above rather than counted among
  them. The `HELPER_TESTS_DEP_FREE` entry for the freshness suite is removed for
  the same mechanical reason (it imports `yaml` now); the full list keeps it.

## Rollback

The pre-rewrite head is `fc5d814aca`: the line model, its spelling fixtures, the
`[[dropped …]]` markers, and a `ci.yml` with the freshness step before the
install. This revision is a single commit on top of it, so the rollback is a
revert rather than a rebase:

```
git revert <the rewrite commit>
git push
```

That restores the line model exactly, including the `ci.yml` wiring this
revision moved, and the branch's checks are computed against the reverted tree.
No tag or branch is created for the rollback, so nothing repo-wide points at a
superseded model; the SHA above and this paragraph are the record.

## Open questions

- The remaining `ci.yml` reds are the `HELPER_TESTS` additions, and they are
  true positives: the branch really did skip a suite the base gate now runs.
  The only honest remedies are to run the base's list rather than the branch's
  (which means executing base-controlled code against a branch tree, a trust
  decision this lane deliberately avoids), or to accept the rebase. Neither is
  attempted here, and relocating the lists is not a remedy.
- This lane is already a required status check on `main`: the `main` ruleset's
  required contexts include `Lint & Static (ubuntu-latest, Node 22.x)`. A false
  red therefore blocks merges rather than merely annotating them, which is why
  the narrowing matters.
