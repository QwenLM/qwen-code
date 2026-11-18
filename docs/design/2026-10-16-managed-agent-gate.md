# Managed Agent gate

[English](2026-10-16-managed-agent-gate.md) | [简体中文](2026-10-16-managed-agent-gate.zh-CN.md)

Status: proposed and implemented in `.github/workflows/managed-agent-gate.yml`;
required-check enablement is pending a maintainer decision. Tracking issues:
#14392, #14381.

## Problem

Since #14205 the SDK Java suite (`sdk-java.yml`) runs only nightly, on demand,
and before a Java release. On 2026-10-16 #13918 and #14370 were each green and
together broke compilation of the `managed-agent-server` test sources on main;
nothing reported it until the nightly run. Managed Agent is now a protected
product line: a change to it, or to the harness it drives, must pass the full
suite before it merges.

Running the full suite on every push is not affordable. One full run is 11
checks, about 330 machine minutes and 125 minutes of wall time (run
38874583246), and two days of open PRs touching Java would cost more than 44
machine hours per day.

## Goals

- Every PR that touches Managed Agent paths passes the full suite on its
  final head before it can merge.
- Feedback on a push stays fast (about 25 minutes).
- A PR that does not touch those paths pays nothing beyond a few seconds of
  path matching.
- A regression that still reaches main files an issue through the existing
  `main-ci-failure-issue.yml` route, except when main has already advanced
  past the failing head and a newer run owns the result.

## Non-goals

- Changing branch protection, the merge queue, or code-owner review. Those are
  maintainer settings; this design only makes them possible.
- Changing the nightly schedule or the release callers.
- Fixing the intermittent Hosted gate failure (#14361), which is tracked
  separately.
- Shipping a separate Java compile gate. #14385 proposed one as its own
  workflow over the same paths; this gate supersedes it. The compile coverage
  rides the fast tier's Linux Java 21 leg, which installs the SDK and then
  test-compiles and runs `managed-agent-server`, and that leg also carries the
  Managed Agent Server checkstyle step. The Java SDK checkstyle step is pinned
  to the Java 11 leg, so only the full tier runs it.

## Design

### Tiers

| Trigger                    | Condition                                                                      | Tier | Lanes                                        |
| -------------------------- | ------------------------------------------------------------------------------ | ---- | -------------------------------------------- |
| `pull_request` push        | touches Managed Agent paths                                                    | fast | flyway guard, real-daemon E2E, Linux Java 21 |
| `pull_request_review`      | first maintainer approval of the current head on an open PR, touches the paths | full | all 11 lanes                                 |
| `push` to main             | touches the paths                                                              | fast | as above                                     |
| `merge_group`              | touches the paths                                                              | fast | as above                                     |
| nightly, dispatch, release | unchanged (`sdk-java.yml` called directly)                                     | full | all 11 lanes                                 |

`managed-agent-gate.yml` selects the tier and calls `sdk-java.yml` through
`workflow_call` with a new `tier` input. `tier: fast` narrows the `test` matrix
to the Linux Java 21 leg and skips `mysql-integration`, `hosted-harness-mysql`,
`event-transport-broker` and `event-transport-multi-node`. Any other value,
including none, runs every lane, so the release and nightly paths are
unchanged.

Skipping `mysql-integration` would also skip the Managed Agent Server H2 unit
suite, which only that lane runs in full. In the fast tier, the Java 21 leg
runs the whole module suite in place of its Runtime Broker subset. Part of the
suite loads the built Core and CLI JavaScript, so the leg first runs the same
workspace install as `mysql-integration`. Together that adds about 16 minutes:
5 for the install on the ECS pool, 11 for the tests.

### Path scope

`.github/scripts/managed-agent-gate-scope.mjs` matches the changed paths:
`packages/managed-agent-server/`, `packages/sdk-java/`,
`packages/cli/src/serve/`, `packages/core/src/managed-runtime/`, the Hosted
integration helpers and config, the scripts `sdk-java.yml` runs, and the gate
files themselves. Pull request and review events diff the test merge commit
against its first parent, so the set is the PR's own change. A push diffs
`before..after` and a merge group diffs its base. Renames count both paths,
and the diff runs with git's path quoting off so a non-ASCII file name still
matches. Changes outside the scope still reach the nightly run.

### Required check

The `gate` job reports the tier result for every run the workflow starts. Its
name is computed:

| Event                 | Scope                           | Name                                 |
| --------------------- | ------------------------------- | ------------------------------------ |
| any                   | untouched                       | `Managed Agent gate` (pass)          |
| `pull_request`        | touched                         | `Managed Agent fast tier`            |
| `pull_request_review` | touched, full run               | `Managed Agent gate`                 |
| `pull_request_review` | touched, no full run            | `Managed Agent review (no full run)` |
| `pull_request_review` | not an approval, or a closed PR | all jobs skip; no gate check         |
| `push`, `merge_group` | touched                         | `Managed Agent gate`                 |
| any                   | tier selection failed           | `Managed Agent gate` (fail)          |

A review that is not an approval, or one submitted after its pull request
closed, starts no job: GitHub still creates the run, but it can never select a
tier above `none` — or the check it would report no longer gates anything —
so both `scope` and `gate` skip and it finishes in seconds without taking a
runner. The run still lists one skipped check per job, and `gate`'s name is
reported as its unevaluated expression, so no check named `Managed Agent gate`
or `Managed Agent review (no full run)` appears. It used to report
`Managed Agent review (no full run)` — a green check no rule reads.

Branch protection reads the most recently updated check of a name. A touched
PR therefore shows `Managed Agent gate` as expected until the full run on its
head reports it, and only a full run, or a failure, can report that name for
it. Check runs need no write token, so the gate works for fork PRs.

A superseded fast tier is neutral, not red: when a newer push cancels a pull
request's in-flight run, the gate reports `Managed Agent fast tier` as a
warning-level pass. Every other cancellation stays failing — a cancelled full
run, so the next approval retries the suite instead of deduping against a
green check, and a push or merge-group cancellation, because nothing there
cancels in progress, so it is a timeout or an operator stop.

### First approval of the current head

`dismiss_stale_reviews` is on for main, so the first approval of a head
always follows its last push. Only a maintainer's approval starts the full
tier: the reviewer's `author_association` must be `OWNER`, `MEMBER` or
`COLLABORATOR`, and an absent association fails closed.
`qwen-triage-finalize.yml` watches this workflow and posts a deferred
`APPROVE` once a PR's checks land green, so without that check the gate's own
fast tier would buy the most expensive run in the repository with no human
involved.

The `scope` job runs the full tier for such an approval unless an earlier
`pull_request_review` run already reported a passing or running
`Managed Agent gate` for the same head. A run's own reruns
do not count, and a pass from the PR push run (an untouched classification)
does not count. The covering run must also belong to the same pull request and
show the `SDK Java (full)` callee in its jobs: a review run of another PR on
the same head, or a run that reported the name without running the suite, ran
no Java lane and does not count. After a failed full run, the next approval or
**Re-run failed jobs** retries it.

### Concurrency

- Every event of one PR shares a single group, and `cancel-in-progress` is a
  property of the incoming run and stays true only for `pull_request`. A push
  therefore cancels the approval run it superseded, which would otherwise run
  for about 125 minutes and then report a head that branch protection no
  longer reads.
- Approvals never cancel: a second approval waits for the first full run and
  then skips it through the deduplication above.
- A group keeps one pending run, and a newcomer cancels it regardless of
  `cancel-in-progress`. A review that is not an approval therefore runs in a
  group of its own, so a comment cannot cancel an approval run that waits
  behind the PR's fast tier.
- Main pushes carry no pull request, so they get one group per commit.
- `sdk-java.yml`'s own group now includes the event name and the called
  commit, so a fast run and a full run on the same PR no longer queue behind
  each other, where a newer pending run would have replaced the older one.

### Fork trust

`sdk-java.yml` routed every event other than `pull_request` to the ECS pool.
An approval of a fork PR raises `pull_request_review`, so the trust check now
covers both events: untrusted fork code stays on hosted runners, and its full
run there needs no secrets.

The gate's own `scope` and `gate` jobs use the same routing. They report the
would-be required check, so a backed-up hosted queue (123 queued runs
repository-wide on 2026-10-16, when the first run of this workflow waited
there) must not hold them. Trusted runs take the ECS pool with the shared
pre-checkout hygiene steps; fork runs stay hosted.

### Failure reporting

`main-ci-failure-issue.yml` also watches `Managed Agent gate`, so a red
post-merge fast tier is recorded there: a run that names failing tests reuses
or files a per-signature issue deduped by the test markers in its body, and a
run without one comments on the workflow's shared aggregate issue, reopening a
matching closed issue when found. New aggregates receive `scope/ci-cd` and
`status/needs-triage` for human triage, with no automatic autofix assignment.
`qwen-triage-finalize.yml` now lists `Managed Agent gate` in place of `SDK Java`,
which has had no `pull_request` trigger since #14205.

A post-merge push failure whose head is no longer main's tip is recorded only
on the analyze run's step summary, not on the workflow issue, when a newer push
run of the same workflow exists at the new tip and has already settled: a
`success` there means the tree is green, and a `failure` reports itself through
its own completion event. A successor that ended `timed_out`, `skipped`, or
`startup_failure` is never analyzed, so the original failure is reported
instead. A `cancelled` successor owns the result only when the shared
classifier's verdict for it is one that reports: `timeout`, or the fail-open
`unknown`. A `concurrency` or `nothing-executed` successor stays silent on its
own, so the original failure is still reported; an `unreadable` successor does
not take ownership either, because a failed read certifies nothing about what
that run concluded, and this run keeps its own fail-open report (#16272,
#16280).

A successor that has not completed settles nothing, and this job cannot wait
for it — the pool the reporter runs on queued it for 20-100
minutes, so the tip's run is usually still young when the report is prepared.
The failure is reported anyway, marked provisional at the top of the body. That
is affordable because the per-signature route hands new issues to a human
rather than to autofix: a stale provisional report costs a close, while a
dropped one costs the regression (#15470).

## Cost

- A touched push: about 55 machine minutes — Java 21 leg 25 plus the ~16 the
  full module suite adds above, daemon E2E 13, flyway under 1.
- A touched head that gets a maintainer approval: one full run, about 330
  machine minutes. That figure was measured while `setup-java` still ran its
  post-job Maven cache save on the ECS pool, at 14 to 37 minutes per job;
  #14396 has since suppressed the save on self-hosted runners and is merged
  into this branch, so a full run should come in below 330. Not re-measured
  here.
- An untouched PR: two runner allocations, for the `scope` and `gate` jobs.
  Trusted runs take the ECS pool, where `scope` deletes `.git` and checks out
  again at `fetch-depth: 2`, so an event costs a cold clone plus seconds of
  work; fork runs stay on hosted runners.

Further levers, not in this change: build the CLI once and share it as an
artifact, split `hosted-harness-mysql` (97 minutes wall time) into parallel
jobs, and move Java 17 to nightly only.

## Risks

- **Flaky full suite.** `HostedShellLifecycleRecoveryIT` fails in about 41% of
  runs (#14361), and an fg8f timing assertion in
  `HostedMonitorRunFaultGatesIT` fails intermittently. Required today, the
  gate would block a large share of Java PRs on noise. Keep it advisory until
  #14361 is resolved; **Re-run failed jobs** is the escape hatch meanwhile.

  Re-measured on 2026-11-12. Two different denominators are in play and must not
  be compared directly: 41% is the failure rate of the single
  `HostedShellLifecycleRecoveryIT` class, while the figures below count runs in
  which at least one of the two Hosted lanes failed.

  Over the 97 `sdk-java.yml` runs created between 2026-10-27T14:57Z and
  2026-11-11T21:48:10Z, 70 had completed without cancellation and all 70 executed
  both Hosted lanes. Of those, 54 failed at least one lane (77%), and only 6 were
  green across every job in the run. In the newest 22 of them, 20 failed at least
  one lane (91%).

  **The failure is almost entirely one lane, not both.** Process-fault failed 54
  times and failover 8, and every one of those 8 failover failures was in a run
  where process-fault had also failed — failover never failed on its own. That
  "never" is a claim about this window, not about the lane: widened to
  2026-10-16 through 2026-11-11T13:44Z under the same counting rule, 163 runs
  executed both lanes and 3 of them failed failover while process-fault passed
  (runs 39091025824 and 39097018288 on 2026-10-18, 39201677644 on 2026-10-19), so
  earlier windows do contain failover-only failures. The wider split is 110
  process-fault failures against 11 failover, so the asymmetry survives the
  window change and only the absolute "never" does not. Within the pinned
  window the split is 46 runs with process-fault alone failing, 8 with both
  failing, and 16 with both passing, which is the same 70. An earlier revision of
  this note reported "26 process-fault, 26 failover" and concluded the lanes fail
  independently; that count did not reproduce and the conclusion was backwards.
  Whoever picks up #14361 should start from the process-fault lane.

  This series is nightly plus manual dispatch, not the gate's own runs: those 97
  runs are 16 `schedule` and 81 `workflow_dispatch`, and `sdk-java.yml` has no
  `pull_request` trigger at all. The nightly arm is worse — 15 of 16 nightlies
  failed a Hosted lane and none was fully green, while all 6 fully green runs came
  from the 54 completed dispatch runs. Read it as the harness's background failure
  rate, which is what makes the gate unrequireable, not as the gate's pass rate.

  The gate's own full tier is too young to give a rate, and it is a separate run
  list. `managed-agent-gate.yml` runs the lanes through reusable-workflow calls
  whose job names carry a `SDK Java (full) /` prefix. Of the 133
  `pull_request_review` runs of that workflow that finished success or failure
  on 2026-11-11, 38 executed both Hosted lanes, and every one of the 38 failed
  process-fault while passing failover — the same shape as above, and not one
  full-tier run that day had both lanes pass.

  The refusal itself has changed shape: the Runtime Broker now
  answers `409 managed_runtime_identity_conflict` where the original report had
  the Store answering `400 invalid_request`, freezing the turn the same way.

- **Approval timing.** The full suite starts at the first approval, so merge
  waits up to about two hours after it. Reviewers can approve earlier; a push
  after approval dismisses it and restarts the cycle.
- **Classification drift.** The push run and the approval run classify their
  own merge commits; if the base moves between them, the scope can differ.
  Both diff against their own first parent, which keeps the PR's change set
  stable unless conflict resolution changes it.
- **Narrow scope.** A core change outside the listed paths can still break the
  harness; the nightly run remains the backstop.

## Rollout

1. Merge this change; the gate reports on PRs but is not required.
2. Watch the full runs until #14361 is fixed and the pass rate is stable.
3. A maintainer adds `Managed Agent gate` to main's required checks (and to
   the merge queue if it is enabled again).

Step 2 has a measurement trap worth recording, because two reassuring series
do not measure the Hosted lanes at all:

- This workflow's own `pull_request_review` runs mostly select tier `none`.
  All 13 of its recent successes ran `SDK Java (none)` — no Java at all,
  because those heads did not touch the scoped paths. A green streak here says
  nothing about the full tier.
- This workflow's main failures can be an unrelated step. All 7 of its recent
  main failures were `Run Managed Agent Server Checkstyle` — one unused import,
  fixed by `da270e434` — after which main went green on this workflow while the
  Hosted lanes kept failing at the rate above.

Only runs that actually executed `Hosted process fault gates` and `Hosted
failover E2E` measure step 2. Filter on both jobs being present _and_ not
`skipped`, then exclude cancelled runs before reading a pass rate. The two ways a
run fails to be a measurement differ: a scoped-out PR selects tier `none` and
emits no Hosted job at all, while a `fast`-tier run emits both Hosted names and
skips them, so filtering on presence alone counts fast runs as measurements.

Name the run list and pin the window whenever quoting a rate, because the two
lists differ and an unpinned count drifts as runs arrive. `sdk-java.yml` is
nightly plus dispatch and has no `pull_request` trigger; the gate's own runs are
under `managed-agent-gate.yml`, where the reusable-workflow job names carry a
`SDK Java (full) /` prefix (for example run `43019171265`). The figures in Risks
are pinned to `sdk-java.yml` runs created between 2026-10-27T14:57Z and
2026-11-11T21:48:10Z; a later reader will get a different denominator from the same
query. Main's required checks live in ruleset `main`, not in legacy branch
protection, and adding the name there must not disturb its two-approval and
dismiss-on-push rules.

Only step 3's single name is needed. The computed name is deliberate, not a
defect to fix first: a touched PR shows `Managed Agent gate` as expected until
its first approval's full run reports it, and the ruleset already requires two
approvals, so waiting for that approval is the enforcement rather than a
deadlock. Adding `Managed Agent fast tier` as well would instead block every PR
that does not touch these paths, which never reports that name.

## Validation

- `scripts/tests/managed-agent-gate-workflow.test.js` evaluates the path
  matcher, the check-name and concurrency expressions, the fast matrix, and
  runs the tier-selection and report scripts against a stub `gh`.
- The existing SDK Java, Hosted, failure-issue, finalize and runner-routing
  meta-tests pin the changed contracts, including that an approval of a fork
  PR stays on hosted runners.
- After merge: a touched PR shows `Managed Agent fast tier` on push and
  `Managed Agent gate` after its first approval; an untouched PR shows a
  passing `Managed Agent gate` within a minute.

## Acceptance criteria

- A touched PR cannot report a passing `Managed Agent gate` without a full run
  on its current head.
- An untouched PR reports a passing `Managed Agent gate` without running Java.
- A second approval of the same head does not start a second full run after a
  pass.
- Nightly, dispatch and release runs still execute all 11 lanes.

## Open questions

- Whether to widen the scope to the broader pre-#14205 path list (about 49%
  of PRs instead of 27%).
- Whether the merge queue, if re-enabled, should run the full tier instead of
  the fast tier.
