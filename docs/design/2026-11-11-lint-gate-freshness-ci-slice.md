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
slides as `main` moves. At `22ed7e77ca385` it is seven pass / six stale, where the
earlier revision measured six / seven — #16945's RPC-retry commit entered the
window and is plumbing-only, while #16351's corepack-cache commit left it. Both
totals are reported with the revision they were taken at rather than carried
forward.

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

At the job level only `runs-on` and `timeout-minutes` are dropped, with their
region. `env`, `if`, `needs`, `outputs`, `permissions` and `steps` stay: they
decide what runs, not where. `needs` in particular stays, so a base-side change
to which jobs the lane waits for is compared — and an edge to a job outside the
gate-job list refuses the narrowing rather than being followed, since the
extractor does not walk the dependency graph.

Nothing is dropped silently. Each excluded region — every non-gate job, every
plumbing step, every dropped job key — leaves a `[[dropped ...]]` marker in the
compared text, carrying the kind and the name at the position the region
occupied. `[[...]]` is not a YAML comment, so a marker can never be mistaken for
prose or collide with a real line. This is what makes the comparison complete
rather than a survey of the parts someone remembered to model: a base-side edit
that moves content into a dropped region — the install prelude relocated into a
new job, a step renamed into the plumbing list — changes the markers and refuses
the narrowing.

The one class left out of the comparison is prose: blank lines and whole-line
comments outside a block scalar. That is this narrowing's premise — most of
`ci.yml`'s traffic is commentary — and prose can carry no gate semantics, because
the runner never reads it. It is removed in a single up-front pass, before any
structure is read, so it cannot open a step, be absorbed into one, or truncate a
job.

Block-scalar content is the opposite case: `run: |` bodies are what the runner
executes, so they are compared verbatim — blank lines excepted — including lines
that begin with `#`, which are shell comments rather than YAML comments. The
earlier model dropped them while the header claimed it "never removes a line the
runner would read"; the claim was false and the line is now kept.

Line breaks are `\r\n`, `\n`, a lone `\r`, and the Unicode separators
`\u2028`/`\u2029`. Splitting on `\n` alone read a CR-terminated file as one line
and dropped whatever followed a `#` on the far side of the CR — the
`#11117 → #11216` shape, with the flag flipped on the base and the branch
certified fresh.

Measured on the current file, the slice is 624 lines of 3560, 28 of them markers
for the jobs and plumbing steps it excludes.

### Why the default is "keep"

The whitelist names what may be **ignored**, not what matters. Forgetting to
classify a new gate step leaves it in the slice and costs at most today's
over-rejection; a wrong entry in the list would hide a real gate change. The
asymmetry is deliberate, and two guards back it:

- A step in the plumbing list whose body invokes a linter refuses the narrowing
  outright. The label is not trusted on its own — a step moved into the list
  while still running `scripts/lint.js` is a contradiction, not a pass. The
  pattern covers the way the lanes are actually reached: `npm run`, `pnpm run`,
  `corepack pnpm run`, a bare `pnpm lint`, `npx`/`pnpx`. Anchoring on `npm run`
  alone missed every `pnpm` spelling, since `pnpm` has no word boundary before
  `npm`. Flags between the manager and its subcommand are skipped for the same
  reason: `pnpm -w run lint` and `pnpm --filter ./packages/core run lint` reach
  the same lane, and anchoring the subcommand directly after the manager let
  both through. A manager followed by `config`/`set` is configuration and still
  passes — `npm config set fetch-retries 5` is a real plumbing step, so refusing
  it would disable the narrowing for every PR.
- The suite reads the real workflow and requires every plumbing name to exist in
  the two gate jobs, so a renamed step cannot leave a stale entry silently
  excluding nothing. Scoping matters: a whole-file inventory can be kept alive
  by a same-named step in a test lane after the gate job's copy is renamed.

Node provisioning (`setup-node`, the pnpm store action, the self-hosted Node
action) deliberately stays **in** the slice: those decide the toolchain the
linters run under, so a version bump there can change lint semantics. Only the
cache's location and the npm retry settings are excluded.

The install prelude also stays in. #16900 and #16920 widened exactly that prelude
to close a post-merge lint gap: an install a profile skips is a linter that
profile never runs.

### Fail-closed extraction

The model is a whitelist: a line is either enumerated (and compared, or replaced
by a marker) or the extraction refuses. "Not recognised, so delete it" does not
exist here. `extractLintGateSlice` returns `null` — and the caller keeps the
whole-file verdict — for any shape it does not model:

- a sequence item that is not `      - name: '<single-quoted name>'`, including
  an unnamed `- uses:` step and a bare `      -` whose name sits on the next
  line. The item is refused before any body is appended, so it cannot be
  absorbed as the previous step's content and vanish from the slice;
- a duplicated job key, where YAML would take the last copy and a `Map` would
  silently keep whichever the parser reached;
- a missing `jobs:`, `classify_pr`, or `lint_and_static`, so renaming the lint job
  cannot read as "no gate to compare";
- a job key off indent 2, a job body line outside a key's region, or content
  after `jobs:` at column zero — shapes this line model cannot place;
- a tab in the indent;
- a value that opens with `|` or `>` but whose modifier is not one of the
  enumerated forms. Both orders are legal YAML and both are accepted — `|`, `|-`,
  `|+`, `|2`, `|2-`, `|+2` and the `>` family. Anything else (`|2+-`) refuses
  rather than letting the body fall into the structural path, where its `#` lines
  would be dropped as prose;
- a quoted scalar that does not close on its own line. The continuation of a
  multi-line flow scalar is data the runner reads, and a one-line model cannot
  tell a `#` there from a comment, so it refuses;
- an anchor (`&name`) or an alias (`*name`) anywhere on a structural line. The
  model is one line at a time and cannot follow a cross-reference: with the
  anchor on a dropped step, `&lintcmd 'node scripts/lint.js --prettier'` and the
  `--write` value render the same slice wherever `*lintcmd` is cited.

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

- **Accepted over-rejection: the job roster.** Every non-gate job is named in the
  compared text, so a base-side job added, removed or renamed refuses the
  narrowing even when its content cannot touch the lint gate. The alternative —
  dropping those jobs without a trace — is exactly the exposure the marker
  removes: relocating the install prelude into a new job left the two gate jobs
  identical. Job-list churn is rarer than step churn, so the cost is an
  occasional rebase rather than the weekly treadmill this narrowing removes.
- **Accepted over-rejection: dependency closure.** `needs:` is compared, so a
  base-side change to WHICH jobs the lane depends on is seen. The extractor still
  does not walk that dependency graph, so instead of following the edge it
  refuses it: a gate job that `needs:` anything outside the gate-job list returns
  null and keeps whole-file containment. Without that refusal the hole was
  silent and permanent — splitting the install prelude into a new job stales
  everyone once, correctly, and every later edit inside that job then compares
  equal, because the job is dropped while its name and its `needs:` entry stay
  identical. No such edge exists today (the lint job needs only `classify_pr`,
  which is itself in the slice), so the refusal costs nothing now and fires
  exactly when the slice would stop being the whole gate. All three YAML
  spellings of the list are covered — inline, single-quoted and block — because a
  guard that read only one would leave the others open. Extending the gate-job
  list and reading the lane's `needs:` still have to happen together; the
  difference is that forgetting now over-rejects instead of certifying falsely.

- **Accepted residual: legal YAML the model refuses, and the narrowing then
  stops firing.** Four structural anchors are exact-match — `jobs:`, the
  two-space job key, `steps:`, and `- name: '<name>'` — and prose removal only
  drops whole-line comments. A trailing comment on any of them (`steps: # lane`,
  `- name: 'Checkout' # pinned`) therefore returns null, and so does a plain
  scalar carrying an unmatched quote (`run: echo it's fine`). Both are legal
  YAML the runner loads. On a base-side commit that makes
  `narrowsToUnchangedLintSlice` throw for every stale `ci.yml` verdict, the catch
  emits one `::warning::`, and the narrowing stops applying: every base-side
  `ci.yml` commit — including the plumbing-only churn this change exists to
  absorb — asks in-flight PRs to rebase again. The direction is fail-safe, not a
  false green: the stale verdict is kept and the cost is over-rejection. But the
  feature does revert silently for that shape, and the suite cannot see it
  because the suite reads the branch's copy while these lines are main's.
  **Not handled**: accepting a `#`-introduced comment on those four anchors (and
  opening a quote only in value position) is a follow-up, not something this
  revision does.

## Validation plan

1. `node --test .github/scripts/check-lint-gate-freshness.test.mjs` — 83 cases,
   all green, as reported by `node --test` on this revision (`main` runs 47; the
   PR adds 36). CI corroborates this on Linux through
   `Run .github/scripts helper tests`, which collects the suite from
   `${{ env.HELPER_TESTS }}`. Counts here are the runtime count at a named
   revision, not a tally carried across review rounds.
2. Mutation witnesses: each of eight deliberate defects must redden the suite —
   dropping `ci.yml` from `NARROWINGS`, returning the whole file as the slice,
   keeping headers only, comparing the head instead of the merge base, absorbing
   an unnamed step, treating a missing merge base as fresh, trusting the plumbing
   label without the linter check, and dropping the job `env` from the slice.
3. Model-completeness witnesses, one per shape the line-absorbing model used to
   compare as identical: a bare `-` step, a comment at the head of the step list
   and between steps, a `#` line inside a `run: |` body, a job-level key placed
   after `steps:`, a lone-CR line break hiding a changed flag, and an anchor
   defined in a dropped job with its alias cited in a kept step. Each returns
   `null` or a different slice, and removing the corresponding guard reddens it.
4. The job roster is part of the compared text: adding a job on the base side
   changes the slice, so the `needs:`-relocation shape (install prelude split
   into a new job the gate job then depends on) refuses the narrowing.
   Reading the edge itself is pinned too, in all three YAML spellings of the
   list — inline, single-quoted and block — because the roster marker alone
   only catches the commit that ADDS the job, not the later edits inside it.
   Removing that refusal reddens the case; so does removing the flag skip in
   `LINTER_INVOCATION`, which is what let `pnpm -w run lint` through a
   whitelisted step.
5. Slice completeness against the real workflow: every `scripts/lint.js` lane
   flag must survive in the slice.
6. Live API, thirteen historical base tips with a fork point one commit behind
   each, content read at real refs. At `22ed7e77ca385`: seven plumbing-only
   commits pass and six gate-changing commits stay stale. The split moves with
   the window — an earlier revision measured six / seven — so the check is that
   every plumbing-only commit passes and every gate-changing one stays stale,
   not that the totals match a number written down earlier.
7. Live API on the branch that motivated the report (#16939 at `07d89196bd21`):
   it must stay stale, because #16920 really did change the Prettier lane.

## Acceptance criteria

- The suite passes, and all eight mutations redden it.
- Seven of the thirteen most recent `ci.yml` commits no longer ask for a rebase
  at `22ed7e77ca385`; the other six still do. Every one of the seven is
  plumbing-only and every one of the six changes the gate.
- #16939's red is preserved.
- No `ci.yml` edit, no `.size-baseline` change, no workflow meta-test change.

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
