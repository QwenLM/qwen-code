# Local round helpers for /verify-pr

[English](verify-pr-local-round.md) | [简体中文](verify-pr-local-round.zh-CN.md)

Status: implemented; extended with the counting, guard, coverage and
attribution-footer rules below.

## Problem

`/verify-pr` has two entry paths. The sandboxed lane supplies the PR metadata
snapshot, a clone holding both OIDs, and a publication step that refuses a
verdict contradicting its own assertion counts. A maintainer's round on a
workstation supplies none of the three, and the skill answers with prose: a
hand-typed `gh pr view` field list, "do not assume `HEAD^1`/`HEAD^2`", a
directory name the collector globs, and "keep the counts honest yourself".
Each of those is a deterministic rule with no executable form, so every round
re-derives it and the mistakes fail silently: a snapshot from the wrong
repository, a parent commit mistaken for the base, a directory the publication
step never sees, or counts that contradict the verdict.

## Current state

- The local path asks the agent to fetch the snapshot and mount it as
  `$QWEN_VERIFY_CONTEXT`, resolve `baseRefOid`/`headRefOid`, and create
  `tmp/pr<n>-verify-<ts>/` before any verification work begins.
- The isolation requirement ("credential-free container or VM") and its
  fallback ("trigger the sandboxed lane") are prose. Nothing tells the agent
  which situation the current process is in.
- The publish job refuses `merge-ready` with a nonzero `fail` and rejects an
  inconsistent `assertions.json`, so the CI path is machine-checked end to end.
  A local round has no equivalent and can publish counts that contradict the
  verdict it states.

Three further gaps surfaced in a later round, all of the same kind — a rule
stated in prose with no executable form, failing silently:

- **The counting rule was taught halfway.** One paragraph explains how to
  prove a red is environmental (boot both arms, show an identical failure);
  another says expected reds are passes and a harness fault is `inconclusive`.
  Nothing joined them, so a host-environment red had no category. The round
  booked one repo test's red twice — at head and again for its base control —
  published `fail: 2` with `findings`, and wrote in its own verdict line that
  neither reason was a defect in the PR. The base cell was an assertion that
  base fails; it failed as predicted, so it passed.
- **The pre-publish guard failed open.** It asks "did anything new arrive?",
  and a re-fetch that errors returns no items, so the answer is "no". Measured:
  324 review comments at round start, 0 on the re-fetch, because the call
  failed rather than the PR going quiet. This was the one safety rule in the
  local path with no script behind it.
- **A coverage claim was asserted rather than enumerated.** "Every production
  commit since the previous round was mutated on its own" shipped while two
  commits had no row. The matrix was per-guard, a weaker claim than the prose
  made, and only a self-audit caught the difference.

## Proposal

Three standalone scripts, plus the skill pointing at them where the flow needs
them rather than at the end of the document.

- `scripts/verify-pr-prepare.mjs <pr> --repo <owner>/<repo>` resolves the
  coordinates: fetch the snapshot with the field list the lane uses, verify both
  OIDs exist in this clone, refuse a tree that is not a clean checkout of the
  PR head, create the artifact directory with its `evidence/` subdirectory,
  and report the isolation signals the process can observe. It
  does not gate on them: resolving metadata needs `gh`, and `gh` and the
  boundary are mutually exclusive, so this path always runs on the host. The
  gate is `--require-isolation`, meant to run inside the boundary before the
  round executes anything.
- `scripts/verify-pr-check.mjs <dir>` applies the publisher's rules to a local
  artifact directory: required files, the four verdict words, a positive and
  self-consistent assertion triple, and no `merge-ready` carrying a failed
  assertion. Report shape and evidence naming are warnings, because a
  documentation-only round has no capture and a checker cannot know whether a
  harness ran.
- `scripts/verify-pr-guard.mjs` owns both halves of the pre-publish guard.
  `--pr <n> --repo <owner>/<repo> --snapshot <file>` fetches the head, the PR
  state and all three comment lists with `--paginate`, and writes the file only
  when every call succeeded. `--compare --start <a> --now <b>` reports every
  reason the round is dirty and exits 1.

The checker gains three rules over the artifacts the contract asks the round
to write. The artifact contract names both, because a file no artifact list asks
for is a file no round produces, and a check over an absent file is silent:

- `assertions.json` carries `failures: [{ id, attribution }]` whenever `fail` is
  nonzero, one entry per failed assertion, attributed `pr`, `harness` or
  `environment`. A `findings`/`blocked` verdict whose ledger names no `pr`
  failure is an error, as is a ledger whose length disagrees with `fail`. A
  round with failures and no ledger is a warning, so older artifacts still
  pass.
- `mutations.json` may claim `coverageClaim: "per-commit"` with
  `productionCommits` from `git log --no-merges <previous>..<head> --not
<target>` and
  `rows[].commit`. A listed commit with no row is an error naming the commits,
  and so is an empty list: a claim over no commits is vacuously true.
- `assertions.json` may carry `gates: [{ suite, pass, fail, skipped? }]`, one
  entry per existing test suite the round ran as a targeted gate. Those counts
  stay out of `pass`/`fail`/`total`, which count only the checks the round
  wrote, and the publisher prints their totals on a line of their own. A
  malformed list is an error. Over 1000 assertions with no `gates` is a
  warning: the four such rounds among 18 recent CI artifacts had each counted
  whole workspace suites.

Each prepared artifact directory keeps `context.json` with the round's full
coordinates — `repo`, `pr`, `baseRefOid` and `headRefOid` — so a local round
reads both OIDs from one file instead of deriving them from `HEAD`. Prepare
writes it only when the current tree is a clean checkout of `headRefOid`:
the round reuses that tree as the head side of its A/B, so a wrong HEAD exits
3 naming the `git checkout` to run, and a dirty tree exits 3 asking the
maintainer to commit or stash — the script never stashes for them, and a
refusal creates no artifact directory. The checker prefers that round's
snapshot and names the source it uses. Older directories fall back to the
shared per-PR snapshot; an unreadable or invalid round snapshot warns instead
of using a later round's shared head.

## Attribution footer

A published verification comment ends with the same attribution shape
`/review` posts:

`_— <model> via Qwen Code /verify-pr (v<cli-version>; skill <skill-hash>)_`

- The model is the identity the round ran under, the CLI version is
  `qwen --version`, and the skill version is the first 12 characters of
  `git hash-object --no-filters .qwen/skills/verify-pr/SKILL.md`. A content
  hash, not a commit: the lane's tree is depth-2 and its `.qwen` arrives by
  `git archive`, so no history is reachable, and the hash names exactly the
  instructions the round loaded — including uncommitted edits on a
  workstation. `--no-filters` because prepare leaves `.git` node-owned,
  and a planted clean filter would otherwise choose what gets hashed — or
  run as root.
- In the lane, all three values are workflow-owned outputs of the run step
  — the configured model, the runner's CLI, the re-pinned skill file —
  never read from the agent-writable artifact tree. They are collected
  right after the base re-pin and BEFORE the agent starts: the workspace
  parent directory stays node-owned, so during the agent era PR code can
  replace the whole `.qwen` directory (mv + mkdir) without touching the
  root-owned files inside it, and a post-agent hash could name instructions
  the round never loaded. A meta-test pins that ordering, not just the
  strings. The publisher stamps the footer only on a body that carries a
  report and only when all three values arrived; otherwise the comment
  keeps the generic `— _Qwen Code · sandboxed verification_` signature,
  which every weak notice (cancelled / infra / skipped / results
  unavailable / downloaded artifact with no report) also keeps: they report
  the lane, not a round.
- A local round resolves the model from `$QWEN_CODE_MODEL_IDENTITY` (else
  `$QWEN_CODE_MODEL`) and omits the footer when neither is set — an empty
  identity is worse than none, and a workstation round never claims the
  lane's `sandboxed verification` signature.
- `report.md` itself carries no footer: both publish paths append it at
  comment time, so a footer written into the report would appear twice.
- A workflow meta-test pins the same template on both surfaces (publisher
  and skill), so a wording edit to one cannot leave the other posting a
  different shape.

## Design decisions

1. **`--repo` is mandatory.** A script cannot distinguish a maintainer's clone
   from a contributor's fork, and there `origin` resolves the same PR number to
   an unrelated PR. Failing closed costs one flag and removes exactly the
   failure the skill already warns about.
2. **The scripts never touch the round, and the coordinate path does not gate on
   isolation.** Prepare fetches metadata and creates directories; it does not
   checkout a worktree, build, or execute PR code. It does gate on the tree,
   because the round runs the head side of its A/B in the current tree: a HEAD
   other than the PR head, or any uncommitted change, would measure code the
   report does not name, so both are refused before anything is written. It
   also cannot decide whether
   this process may run that code: it must reach `gh`, which the boundary
   excludes by design, so it always runs on the host. A gate there would fire on
   every round and turn the override into the normal path, so the check is a
   separate mode intended to run inside the boundary.
3. **The publisher runs the local checker.** The checker started as a mirror
   of the publish job's inline rules, because the rule set was four stable
   checks and sharing it would touch the workflow and its meta-tests. The
   mirror did not hold: the failure ledger and the coverage claim were added
   here only, so the lane published shapes every local round refuses. The
   publish job now runs this script from its trusted checkout (the
   default-branch commit, never PR code) and trusts an agent verdict only when
   the script passes on the report's own directory. That directory is also
   the only place the lane reads `verdict.txt`: the verify job used to read
   its own copy from whichever round directory its search found first.
   Tightening a rule here therefore tightens CI too.
   Loosening one does not always loosen it: the publish step still validates
   the count triple itself (the checker runs only on a valid one) and still
   refuses `merge-ready` over failures on its own, so those two need the
   workflow changed as well.
4. **Warnings, not errors, for report shape.** Report structure, evidence
   naming and head-OID citation stay warnings because a legitimate round can
   lack them — a documentation-only round has no screenshot to offer — and the
   checker cannot tell whether a harness ran. Since the publish job runs this
   script, making one of them fatal would refuse those rounds in CI as well.
5. **Attribution is a ledger, not a fifth verdict word.** The tempting fix for
   an environment red is a verdict like `merge-ready-with-caveats`, which would
   have to be added to the publisher, its case labels and their pin. The
   vocabulary stays at four words: the red is re-encoded as the assertion it
   actually is — both arms fail for reason R — and the ledger records who caused
   what. The checker then reads the attribution instead of guessing from prose.
6. **The guard owns the fetch, not just the comparison.** A script that only
   compared two files would leave the hand-typed fetch in place, and an empty
   file written after a failed call compares clean. So a failed call is fatal
   and writes nothing, and the comparison independently treats a short list as
   dirty. Either half alone leaves the hole open. There is no retry flag: a
   refusal the maintainer re-runs is honest, while a silent retry budget would
   hide a host that cannot reach the API.
7. **The checker validates the coverage claim against the round's own
   enumeration.** It has no repository, so it cannot derive the commit set; an
   incomplete `productionCommits` list is the skill rule's job, and the doc says
   so. What is machine-checkable is the claim against the list supplied, which
   is exactly the gap the measured round had — plus the one incomplete list
   that would otherwise satisfy every check, the empty one. Refusing that costs
   a docs-only round nothing: it drops the claim instead of making it over an
   empty set.

## Constraints and risks

- The isolation detector counts only container-backed signals. The built-in
  macOS sandbox sets `SANDBOX=sandbox-exec` while its default profile still
  reads host files, so it is reported as a caveat rather than a boundary. A
  marker is not credential-free readiness either: the CLI's own Docker/Podman
  launcher mounts the gcloud config and ADC file and copies model keys, so the
  gate also requires an explicit attestation and refuses on a visible signal.
- The tree gate attests source identity only. `dist/` and `node_modules/` are
  gitignored, so a clean checkout of the head can still carry a build from an
  earlier commit — reproduced in review: prepare exited 0 while the ignored
  build ran old code under the new head's label. Install/build reuse is
  therefore conditional on the round establishing the artifacts were produced
  for this head (otherwise it rebuilds per the local install strategy), and
  the prepare success line says "verify or refresh its install/build first"
  instead of advertising unconditional build reuse.
- The checker is on the CI publish path. Tightening a rule refuses verdicts the
  lane used to accept, and those rounds publish as inconclusive. The
  publish-fidelity meta-tests run the real script, including from exactly the
  paths the publish job checks out, so run them with any checker change. A
  workflow meta-test still pins the checker verdict vocabulary to the
  publisher case labels, so a fifth word on one side fails the suite.
- The PR title is untrusted input reaching a maintainer terminal, so control
  characters are dropped before it is printed.
- These are local helpers: the lane pins `.qwen` from the base branch, so the
  skill text that references them takes effect only after this change merges.
- The guard normalizes each item to `id`, a stamp read as
  `updated_at ?? submitted_at`, the `body`, and — for reviews only — the
  `state`. The stamp alone cannot answer "did anything change?": measured
  against this repo's API, a review object carries `submitted_at` and no
  `updated_at`, and neither editing its body nor dismissing it moves that
  stamp. On PR 15388, review 5673309455 reports `submitted_at` 2026-10-27T19:47:16Z
  and was dismissed at 2026-10-28T01:22:57Z, five hours and thirty-six minutes later. The
  stamp still reads the earlier time, so the dismissal did not move it, and
  the review still reports a 4838-character body: nothing but `state` records
  that it was dismissed. Whether its body was edited too is unobservable,
  which is the point — and that dismissal is what unblocked the merge gate.
  All three lists return a string `body` and reviews return a string `state`,
  so both are compared alongside the stamp, and a fetch is refused rather than
  compared as though nothing had changed when an item has no body or a review
  has no state. The cost is a larger snapshot file — bodies
  are stored verbatim, which also lets the round read what arrived without a
  second fetch.
- The compared fields are the ones that change what a reviewer said or decided.
  Reaction counts and other metadata are deliberately excluded: comparing whole
  items would make a thumbs-up a dirty round and send the maintainer into a
  re-fetch loop over nothing. Naming the boundary is what keeps the field list
  from growing one audit at a time.
- A short list reports its own reason and a count of the ids it lost, not one
  line per id. Measured on a live PR: a truncated re-fetch printed the
  short-list reason and then 321 `disappeared` lines, burying the one
  actionable line under its own echoes. The ids are a consequence of the
  truncation, not independent reasons. At equal length the missing id is the
  whole signal, so it is still named — a separate pin keeps the suppression
  from swallowing a genuine deletion.
- An `environment` attribution is only as good as the A/A control behind it.
  The checker cannot see that control, so the skill still requires both arms
  and the shared cause in the report; the ledger stops the miscount, not a
  fabricated attribution.
- The enumeration is `git log --no-merges <previous>..<head> --not <target>`,
  because both obvious recipes fail in opposite directions. `--no-merges`
  drops the merge commit but keeps every commit that merge brought in: measured
  on the branch that shipped the wrong coverage claim, over its previous-round
  range, 85 production commits where 24 were its own, and the 61 extra came
  from a single `Merge branch 'main'`. `--first-parent` removes that
  over-count by discarding every second parent, and with it the PR's own work
  whenever it merged one of its own feature branches: measured on a four-commit
  graph carrying one feature merge and one `main` merge, `--no-merges` lists
  5 of which 2 belong to `main`, `--first-parent --no-merges` lists 1 and
  drops the 2 feature commits the PR did author, and `--not <target>` lists
  the right 3. The under-count is the more dangerous of the two, because the
  checker sees a complete-looking enumeration and accepts the claim while the
  omitted commits have no row. The checker cannot catch either — it has no
  repository — so the recipe and a pin on it are the only defence, and the
  first draft of this change shipped `--no-merges` alone while the second
  shipped `--first-parent`.
- `--not <target>` is a live-round recipe, and the constraint is real: it
  subtracts what the target already contains, so once the branch has landed the
  enumeration is empty. Measured on this change's own previous-round range
  `36b6d9c77f..5a86a0e352`, which has since been merged: `--no-merges` lists
  85, `--first-parent --no-merges` 24, and `--not origin/main` 0. On a live
  range all three agree — `f08535976c..HEAD` on this PR is 15 for each. So the
  skill states the precondition and the empty-enumeration refusal is what
  catches a round that runs it too late.

## Validation plan

- Unit tests for the pure helpers: repository slug, artifact directory name,
  isolation signals, snapshot shape, and argument parsing; and for the
  checker's rule set.
- End-to-end tests that drive both CLIs: a temporary clone with a `gh`
  stand-in, asserting exit codes, the written snapshot, and the artifact
  directory; and artifact fixtures for each checker outcome.
- A dry run of `prepare` against a real PR in a maintainer clone, and of
  `check` against a real artifact directory.
- For the guard, a `gh` stand-in on `PATH` drives the real CLI down both
  paths, so "writes no file when a call fails" is observed rather than inferred
  from the pure function.
- The publish step is executed with and without the three attribution
  outputs, asserting the exact last line of the posted body in each case —
  including a downloaded artifact with no report — and structural pins
  hold the collection ordering (re-pin, then collect, then agent start)
  and the skill's footer template to the publisher's.
- A vacuity matrix over every guard this change adds: revert one clause in
  place, run the suite that should catch it, restore. A row counts as killed
  only when the named assertion goes red, not merely some assertion. Measured:
  35 rows, 35 killed, including a control row on the pre-existing
  `merge-ready`/`fail` guard, so the other kills are not "the harness never
  reached the code". Each row also carries the commit that introduced its
  clause, derived rather than assigned: the first branch commit whose blob
  carries the anchor, with the parent's blob read to confirm it did not. The
  control row is the exception — its clause is on `main`, and that is verified
  too. Applying the enumeration to this change then named docs-only commits
  with no row, so the matrix is reported as per-guard and makes no per-commit
  claim; the same data claimed per-commit is refused, naming them. The rule
  caught its own author, and the answer was to narrow the claim rather than
  invent a row.
- Nineteen of those rows exist because self-audit found defects in this change
  itself. Five from the first pass: a warning-suppression branch that let a
  malformed ledger reach a null read, a refusal message that blamed the head
  for a malformed list item, a `--compare` that read clean when both sides were
  the same file, and a short-list report that named all 321 lost ids and buried
  its own actionable line — the last one a pair of rows, one proving the
  suppression happens and the other proving it does not swallow a genuine
  deletion at equal length. Four from a second pass: the enumeration recipe
  without `--first-parent`, an artifact contract that never asked for
  `mutations.json` or for the ledger (two rows, one per file the checker reads
  and nothing produced), and a coverage claim accepted over an empty commit
  list. One from a later pass: the prose told every round to claim per-commit
  coverage unconditionally, which is the same overstatement the contract had —
  the claim is earned by the enumeration, and a round with a gap reports
  per-guard instead. Three from a seventh pass, all one defect: the guard read
  only timestamps, so a review edited without its stamp moving compared clean —
  one row for the comparison, one for accepting a list with no bodies at all,
  and one for the rule text that claimed timestamps were enough. Three from an
  eighth pass, which asked what else moves without moving a timestamp: a
  dismissed review, measured on PR 15388 — one row for the state comparison,
  one for accepting a review list with no state, and one for the rule text that
  named the body but not the state. That pass also fixed the boundary in writing
  so the next one does not reopen it. A further set of findings are not guards, so they carry no row and are
  listed rather than counted — a count over a growing set is the thing this
  change is about. They are: a cross-reference to a report item that does not
  exist, a return value no caller could observe, an export no module imports, a
  contract that asked for the matrix unconditionally while the checker treats it
  as optional, a note that cited a dismissed review's body as unchanged when only
  its stamp is on the record, a rule sentence that said a fetched list missing
  either field is refused when a comment item has no state to miss, a duration
  rounded down by six minutes, and the last two corrections applied to the
  design doc but not yet to the published comment.

## Acceptance criteria

- `prepare` on a clone holding both OIDs writes a snapshot whose
  `baseRefOid`/`headRefOid` match the PR, creates the glob-matching directory
  with a `context.json` holding `repo`, `pr`, `baseRefOid` and `headRefOid`,
  and exits 0 on the host. `--require-isolation` passes only when a container
  marker is present, `QWEN_VERIFY_CREDENTIAL_FREE=1` attests to a clean
  boundary, and no known credential signal is visible; otherwise it exits 4.
- `prepare` exits 3 when HEAD is not the PR head (naming the `git checkout` to
  run), when the tree carries uncommitted changes, tracked or untracked
  (naming the entries and a stash form that clears untracked files), or when
  index flags hide tracked state (skip-worktree / assume-unchanged, as a
  sparse checkout sets). No refusal writes an artifact directory, and the
  script never stashes for the maintainer. A detached HEAD at the PR head
  passes: the identity is the OID, not a branch, and a test pins that the
  printed checkout remedy reaches exit 0.
- A missing OID fails with a fetch naming the `--repo` repository, not `origin`.
- `check` rejects `merge-ready` with a failed assertion, an inconsistent
  triple, and an unknown verdict word; it accepts `findings` with the same
  counts.
- `check` rejects `findings` and `blocked` when the failures ledger attributes
  no failure to the PR, rejects a ledger whose length disagrees with `fail`,
  accepts `inconclusive` with a `harness` failure, and only warns when an older
  artifact carries no ledger.
- `check` rejects a `per-commit` coverage claim whose listed commits are not
  all covered by a row, matching abbreviated and full OIDs in either direction,
  and rejects the claim over an empty commit list while staying silent when no
  claim is made.
- The skill's artifact contract asks for both files those rules read, and its
  enumeration recipe subtracts `<target>` rather than cutting at the first
  parent; a pin fails if either is
  dropped.
- `guard --snapshot` writes nothing and exits 1 when any call fails;
  `guard --compare` exits 1 on a malformed snapshot, a short list, a new,
  edited or vanished item, a moved head and a changed state, exits 2 when both
  sides are the same file, and exits 0 only when nothing moved. A short list
  reports its reason plus a count of lost ids; an equal-length list still names
  each vanished id.
- `guard --compare` reports dirty when an item's body changed and its timestamp
  did not, and when a review's state changed, and `guard --snapshot` refuses a
  list whose items carry no body or, for reviews, no state.
- A published report comment ends with the attribution footer when the
  model, CLI version and skill hash all resolved, and with the generic
  signature otherwise; weak notices — including a downloaded artifact with
  no report — always keep the generic signature. The lane collects the
  three values after the base re-pin and before the agent starts, and a
  meta-test pins that ordering. The skill and the publisher carry the same
  footer template, pinned by a meta-test, and `report.md` carries no footer
  of its own.
- No script executes PR code.
- A report with its own round snapshot keeps the same checked head after a
  later preparation into a different artifact directory. Publishable round
  snapshots contain no PR title or body.

## Open questions

None at this scope.
