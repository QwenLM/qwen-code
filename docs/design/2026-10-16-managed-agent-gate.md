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
  `main-ci-failure-issue.yml` route.

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

| Trigger                    | Condition                                                        | Tier | Lanes                                        |
| -------------------------- | ---------------------------------------------------------------- | ---- | -------------------------------------------- |
| `pull_request` push        | touches Managed Agent paths                                      | fast | flyway guard, real-daemon E2E, Linux Java 21 |
| `pull_request_review`      | first maintainer approval of the current head, touches the paths | full | all 11 lanes                                 |
| `push` to main             | touches the paths                                                | fast | as above                                     |
| `merge_group`              | touches the paths                                                | fast | as above                                     |
| nightly, dispatch, release | unchanged (`sdk-java.yml` called directly)                       | full | all 11 lanes                                 |

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

The `gate` job always runs and reports the tier result. Its name is computed:

| Event                 | Scope                 | Name                                 |
| --------------------- | --------------------- | ------------------------------------ |
| any                   | untouched             | `Managed Agent gate` (pass)          |
| `pull_request`        | touched               | `Managed Agent fast tier`            |
| `pull_request_review` | touched, full run     | `Managed Agent gate`                 |
| `pull_request_review` | touched, no full run  | `Managed Agent review (no full run)` |
| `push`, `merge_group` | touched               | `Managed Agent gate`                 |
| any                   | tier selection failed | `Managed Agent gate` (fail)          |

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
post-merge fast tier files the same deduplicated autofix issue as other main
failures. `qwen-triage-finalize.yml` now lists `Managed Agent gate` in place
of `SDK Java`, which has had no `pull_request` trigger since #14205.

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
