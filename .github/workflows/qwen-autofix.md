# `qwen-autofix.yml` — design record

The autofix loop's workflow file carries an unusually dense commentary: every
threshold, every gate, and every fail-closed choice in it was paid for by a
live incident, and the reasoning is worth more than the line it guards. This
file is where that commentary lives.

## Why the prose moved out of the YAML

GitHub **refuses to start runs for a workflow file larger than 500 KB**
(512,000 bytes), and the refusal is silent — there is no annotation, no failed
run, no disabled-workflow banner.

On 2026-08-19 `qwen-autofix.yml` crossed that line (512,782 bytes) and the
loop went dark for a day with a symptom set that reads like an Actions outage
rather than a size limit:

| Trigger                               | Behaviour past the limit                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `schedule`                            | stops firing entirely — no run is created at all                                                                   |
| `workflow_dispatch`                   | a run is created and sits `queued` forever with **zero jobs**, uncancellable through the API                       |
| `issues`, `issue_comment`             | silently stop                                                                                                      |
| `pull_request`, `pull_request_review` | **keep working** — these resolve the workflow from the PR's own branch, so an older, smaller copy of the file runs |

That last row is what makes the failure so hard to read: the loop keeps posting
successful runs from PR events while every scheduled scan is dead. Cloning the
file to a new path does not help either — the copy inherits the size.

So: **prose belongs here, long steps belong in `.github/scripts/`.**
`.github/scripts/check-workflow-size.sh` fails CI before the limit can be
reached again.

## How the pointers work

Where a block of commentary used to sit, the workflow keeps its opening lines
plus a pointer:

```yaml
# Growth brake: measure the PR's net size (insertions minus
# deletions) over this window and ...
# Full rationale → qwen-autofix.md#af-030
```

Each section below is the **verbatim** text of the block that pointer replaced,
titled with the job and step it belongs to. Editing rules: keep the pointer and
the section id in sync, put new long-form reasoning here rather than in the
YAML, and never delete a section without deleting its pointer.

This file records _why the code is the way it is_, indexed by code site. For
task-oriented guides — what a maintainer types and what happens next — see:

- [`qwen-autofix-round-seed.md`](./qwen-autofix-round-seed.md) — seeding the
  round counter with `@qwen-code /takeover from N`.

## Contents

- [1. (top level) — One workflow for the whole autonomous-fix lifecycle:](#af-001)
- [2. run — Suggestions may improve a PR, but continuing to implement them after five…](#af-002)
- [3. run — Net-diff growth budgets per counting window — the SIZE sibling of the round brake above.…](#af-003)
- [4. route — The issue_comment clause is a cheap expression-level prefilter: the overwhelming…](#af-004)
- [5. route — Concurrency is keyed by TARGET, not shared and not fully unique:](#af-005)
- [6. route · Decide phases — Fork PR — decline, and say so. This event carries NO repository secrets: GitHub…](#af-006)
- [7. route · Decide phases — '<cmd> from N' — the ONE parameterized form, and the only place this workflow reads a…](#af-007)
- [8. issue-autofix — Secret-bearing and executes agent-driven code, but the agent runs inside the docker…](#af-008)
- [9. issue-autofix — route.issue_number is only set for forced dispatches; label events carry the issue in…](#af-009)
- [10. issue-autofix · Sanitize workspace git config — The runner USER's global config is the same exec surface as the workspace config below:…](#af-010)
- [11. issue-autofix · Remove stale sandbox containers — run-agent.mjs's budget kill removes the container it launched, but a JOB timeout still…](#af-011)
- [12. issue-autofix · Set up Node.js — No remote npm cache on the persistent pool: one measured review-address leg spent 339s…](#af-012)
- [13. issue-autofix · Verification gate — Run changed/related tests for the packages this fix touches.](#af-013)
- [14. issue-autofix · Publish PR — Take this PAT-bearing step off every mutable host git surface — both the shared config…](#af-014)
- [15. issue-autofix · Publish PR — Authenticate the push with a one-shot, host-scoped credential helper via `git -c`:…](#af-015)
- [16. takeover-command · Toggle takeover label — The round seed rides as its OWN marker on a separate line, NEVER as a field inside '<!--…](#af-016)
- [17. takeover-command · Toggle takeover label — Already managed: repeating the command is the ROUND-COUNTER RESET. A fresh engage ack…](#af-017)
- [18. takeover-command · Toggle takeover label — REST for consistency and runner-version independence: `gh pr edit`'s GraphQL lookup…](#af-018)
- [19. takeover-command · Toggle takeover label — REST for the same reason as the add above; the label name is a path segment and contains…](#af-019)
- [20. takeover-command · Toggle takeover label — TAKEOVER ACK — visible confirmation when a maintainer engages or releases a PR via the…](#af-020)
- [21. takeover-ack · Acknowledge takeover state change — Bilingual with COLLAPSED Chinese (project convention), built via printf so no workflow…](#af-021)
- [22. review-scan · Scan for PRs with new feedback — 'none' and HTTP 404 are DEFINITIVE answers, not lookup failures.](#af-022)
- [23. review-scan · Scan for PRs with new feedback — Same filter as the sibling upsert in 'Post autofix status comment', including its two…](#af-023)
- [24. review-scan · Scan for PRs with new feedback — FORK PRs are admitted per candidate: the author must hold write+ RIGHT NOW (the same…](#af-024)
- [25. review-scan · Scan for PRs with new feedback — Base of the auto-update-stale-base decision below. A PR can be red purely because it…](#af-025)
- [26. review-scan · Scan for PRs with new feedback — PRs whose review-address is already RUNNING OR QUEUED in any live autofix run must not…](#af-026)
- [27. review-scan · Scan for PRs with new feedback — Idle backoff, from the list's own updatedAt (no API call): a candidate with no activity…](#af-027)
- [28. review-scan · Scan for PRs with new feedback — Review-in-flight gate (#8888): NON_BLOCKING_CHECKS keeps an in-flight review-pr from…](#af-028)
- [29. review-scan · Scan for PRs with new feedback — First-pickup engage ack: fork label events carry no secrets and manual labels may race…](#af-029)
- [30. review-scan · Scan for PRs with new feedback — Grace windows keyed by WHO owns the missing ack, read from the label event's actor…](#af-030)
- [31. review-scan · Scan for PRs with new feedback — A FORCED dispatch refused here answers OUT LOUD. Observed on #7836: the fleet shepherd…](#af-031)
- [32. review-scan · Scan for PRs with new feedback — A MANAGED PR pausing at its cap deserves a visible reminder — maintainers otherwise…](#af-032)
- [33. review-scan · Scan for PRs with new feedback — Release evidence = a takeover unlabeled EVENT at-or-newer than the window key. GitHub…](#af-033)
- [34. review-scan · Scan for PRs with new feedback — A red check is a persistent STATE, not the instant it turned red.](#af-034)
- [35. review-scan · Scan for PRs with new feedback — Stamp the dispatch-pending marker now, while this scan still owns the decision: an…](#af-035)
- [36. review-scan · Scan for PRs with new feedback — Fan out: emit EVERY eligible PR up to the per-scan budget. The address matrix bounds…](#af-036)
- [37. build-cli · Prepare Qwen Code CLI — The repo-root dist/ plus packages/core/dist are shipped:](#af-037)
- [38. review-address — Secret-bearing and executes PR code, but every target is live-gated to write+ (internal)…](#af-038)
- [39. review-address — Simultaneity bound for the whole fleet — the ONLY place different PRs wait on each other…](#af-039)
- [40. review-address — Serialises every writer of THIS PR's head branch, across workflows.](#af-040)
- [41. review-address — SECURITY: checkout trusted base code first. The PR branch is checked out later in…](#af-041)
- [42. review-address · Prepare branch and feedback — Live-watermark revalidation: two near-simultaneous triggers for the SAME PR can both…](#af-042)
- [43. review-address · Prepare branch and feedback — Growth brake: measure the PR's net size (insertions minus deletions vs the merge base),…](#af-043)
- [44. review-address · Prepare branch and feedback — An orphan-history branch (fork takeover / adoption admits one — nothing on this job's…](#af-044)
- [45. review-address · Prepare branch and feedback — The marker's window field is spelled `key=`, NOT `win=`: this marker can legitimately…](#af-045)
- [48. review-address · Prepare branch and feedback — Which trusted humans have exhausted their per-window regular feedback budget (see…](#af-048)
- [49. review-address · Prepare branch and feedback — Time-budget exhaustions SINCE THE LAST SUCCESSFUL ROUND mean the standard…](#af-049)
- [50. review-address · Triage and address — Bound the agent below the job timeout so a runaway agent fails THIS step (not the whole…](#af-050)
- [51. review-address · Triage and address — Clamp the override to the budget ceiling: a repo variable past 7,200,000 ms (120m) would…](#af-051)
- [52. review-address · Push and report — Resolve the review threads whose findings the agent actually IMPLEMENTED, so a human…](#af-052)
- [53. review-address · Push and report — gh's stderr goes to a fresh mktemp regular file, never a named WORKDIR path: WORKDIR is…](#af-053)
- [54. review-address · Push and report — gh emits one node per line across every page; slurp them into the flat array both blocks…](#af-054)
- [55. review-address · Push and report — Deferred-findings persistence, shared by both arms below.](#af-055)
- [56. review-address · Push and report — Take this PAT-bearing step off every mutable host git surface — both the shared config…](#af-056)
- [57. review-address · Push and report — Authenticate push/fetch with a one-shot, host-scoped credential helper via a git_auth…](#af-057)
- [58. review-address · Push and report — Salvage a race-lost push instead of discarding the run. The per-PR head-write…](#af-058)
- [59. review-address · Push and report — Takeover milestone digest — roughly every 10 rounds. The takeover cap (100) bounds…](#af-059)
- [60. review-address · Report dry-run / failure — NOTE: the deferred-findings upsert below runs its PAT identity check and the script…](#af-060)
- [61. review-address · Report dry-run / failure — Leave a visible handoff + eval marker when the address did NOT publish a result — a…](#af-061)
- [62. review-address · Report dry-run / failure — First line only, markup neutralized (agent stdout can echo external PR-comment text and…](#af-062)
- [63. review-address · Report dry-run / failure — If feedback was actually read (prepare ran), stamp its newest ts so the watermark…](#af-063)
- [64. review-address · Report dry-run / failure — Prepare ran (NEWEST is set) but no verdict was reached. Ways that happens, and in ALL of…](#af-064)
- [65. review-address · Report dry-run / failure — The gate ran and rejected the agent's fix (a build/test failure). Before handing to a…](#af-065)
- [66. review-address · Report dry-run / failure — Say what actually happens next. The old "A human should take over this PR" read as a…](#af-066)
- [67. review-address · Report dry-run / failure — Pre-existing failures get the honest clause: the rejection is not the agent's and the…](#af-067)
- [68. review-address · Report dry-run / failure — NEWEST is empty because Prepare never RAN TO A VERDICT — an earlier step failed or the…](#af-068)
- [69. review-address · Report dry-run / failure — Consecutive-failure circuit breaker, distinct from the round cap.](#af-069)
- [70. review-address · Report dry-run / failure — -c drops any partial multi-byte sequence a byte-level head -c may have split, so the…](#af-070)
- [71. review-address · Report dry-run / failure — Bilingual companion. Repo convention is English first, Chinese in a collapsed <details>.…](#af-071)
- [72. review-address · Report dry-run / failure — Flip the status comment out of "working" so a finished round never leaves a live-looking…](#af-072)

---

<a id="af-001"></a>

### 1. (top level) — One workflow for the whole autonomous-fix lifecycle:

In `(top level)`.

```text
One workflow for the whole autonomous-fix lifecycle:

  issue → locate → fix → open PR        (issue phase)
  open PR → review → triage → fix → push (review phase)

The lifecycle is asynchronous — a PR is opened in one run and its review is
addressed in a later run once a reviewer has weighed in — so each scheduled
tick runs only the phase(s) that make sense, decided by the `route` job:
  • every 10m            → review phase; issue phase only if no PR needs work
  • issues:labeled        → issue phase when ready label, state, and sender match
  • pull_request_review   → review phase for submitted feedback on bot PRs
                            (open PRs only: reviews on closed/merged PRs
                            drop at the route gate; the scheduled scan is
                            the backstop for anything missed)
  • pull_request:labeled  → maintainer applies autofix/takeover → the loop
                            manages that PR (human-authored included, and
                            maintainer FORKS too: the fork's author must
                            hold write+ live and the PR must allow
                            maintainer edits — the bot then fetches/pushes
                            the fork branch directly; org-owned forks
                            cannot enable allow-edits → adoption instead);
                            unlabeled releases it. autofix/skip opts any PR
                            out everywhere and wins over takeover. Labels
                            need GitHub triage+, so the permission gate is
                            GitHub's own. The bot's OWN fork PRs (author ==
                            the autofix bot, e.g. its codex flow) are auto-
                            managed WITHOUT a label when allow-edits is on —
                            they are the bot's own generated work, trust-
                            equal to an in-repo bot PR; autofix/skip still
                            opts them out.
  • issue_comment         → '@qwen-code /takeover' (apply the label),
                            '@qwen-code /takeover from N' (apply it and
                            seed this window's round counter at N, for a
                            PR that already spent N rounds in review), and
                            '@qwen-code /takeover stop' (remove it) — sugar
                            for people without label access: the PR author,
                            or write+ collaborators. Exact-match constants,
                            and the ONLY side effect is the label toggle;
                            engagement/release still happen exclusively via
                            the label events, so manual labeling and the
                            commands are the same single mechanism.
  • workflow_dispatch     → force a phase, an issue, or a PR

Every GitHub write (issue/PR comments, labels, branch push, PR create) goes
through CI_DEV_BOT_PAT so the bot acts as the configured autofix identity.
PAT label writes can emit issues:labeled events; the route guards below make
those runs exit unless the label, issue state, and ready label all match.
```

<a id="af-002"></a>

### 2. run — Suggestions may improve a PR, but continuing to implement them after five…

In `run`.

```text
Suggestions may improve a PR, but continuing to implement them after five
change-producing rounds expands the diff and creates fresh review churn.
From round 6 onward, only Critical findings, formally requested changes,
failed checks, and base conflicts may drive code changes; lower-severity
feedback is recorded and left open. Lowered from 10: at 10 the threshold
only ever bound takeover PRs (the strict cap discards a plain PR at round
10 before Critical-only could engage), so long-running managed PRs spent
ten rounds growing their diff on suggestions before the brake applied.
Counted from the window's SEED, not always from zero: '@qwen-code
/takeover from N' starts the window's counter at N so a PR taken over
after N rounds of ordinary review reaches this threshold in the
REMAINDER rather than a fresh five. Without a seed the counter starts at
0 exactly as before, so a PR that spent nine human rounds getting to
"almost mergeable" no longer restarts the suggestion valve at full
travel the moment it is managed. The seed is window-scoped like every
other census: '@qwen-code /retry' or a bare re-takeover opens a window
with no seed and the counter returns to 0 (that IS what re-arming
means), so a late-stage PR is re-seeded by re-issuing the command with
its number. It does NOT seed the GROWTH brake below, which anchors its
baseline at the window's first measured round — a pre-takeover baseline
is not recoverable, so growth is always measured from engagement.
```

<a id="af-003"></a>

### 3. run — Net-diff growth budgets per counting window — the SIZE sibling of the round brake above.…

In `run`.

```text
Net-diff growth budgets per counting window — the SIZE sibling of the
round brake above. CRITICAL_ONLY_AFTER_ROUND counts rounds, but one round
can add hundreds of lines (#8853 grew 315 → 1393 net lines in four bot
rounds, +609 in a single "harden per review feedback" round; #8276 grew
~2700 net lines under management), so a managed PR can bloat drastically
while still under the round threshold — and every window re-arm reopens
the suggestion valve. The first round of a counting window records the
PR's net size (insertions minus deletions vs the merge base) as that
window's baseline; once live growth beyond the baseline exceeds a budget,
Critical-only mode engages early. Everything Critical-only preserves
still flows — Critical findings, Request changes reviews, in-budget
maintainer feedback, failed checks, conflict resolution — only the
suggestion channel stops. `@qwen-code /retry` (or re-engaging takeover)
opens a fresh window and re-anchors the baseline at the current size.
TWO budgets, not one: measured bloat concentrates in TESTS (#8853's
growth was 86% test lines — every round pins ever-more-marginal behavior;
#8276's was 78%), so a single budget is effectively spent by test growth
and cannot be tightened on tests without also strangling source fixes.
Test lines are *.test.*/*.spec.* files, __snapshots__/, __tests__/,
test-utils/, and
integration-tests/ (the pathspec lives in the prepare step); source is
everything else, minus mechanical churn (lockfiles and the regenerated
settings schema) that is skimmed rather than reviewed. Either budget
tripping engages the brake.
TUNABLE WITHOUT A CODE CHANGE like the scan budgets above; a malformed
value falls back to its default at the read site.
```

<a id="af-004"></a>

### 4. route — The issue_comment clause is a cheap expression-level prefilter: the overwhelming…

In `route`.

```text
The issue_comment clause is a cheap expression-level prefilter: the
overwhelming majority of comments never start a job at all. The real
gates (exact body match, sender authorization) live in 'Decide phases'.
Nuance: a body with LEADING whitespace dies here even though the decide
branch would trim it — fail closed, command must start the comment.
Both commands are prefiltered here (/takeover toggles the label, /retry
re-arms a stranded PR); everything else never starts a job.
The pull_request_review clause drops reviews on closed/merged PRs at the
gate: a PR that can no longer receive commits has nothing to address.
Finding-reply bursts on just-merged PRs otherwise start one no-op run
per reply (observed 2026-08-16: 24+ reply reviews on merged #9222 and
26 runs on merged #9189 within minutes — issue #9296). The fleet never
loses a legitimate target from this: the schedule scan engages any open
PR with review context on its next tick, and address-time revalidation
already drops targets whose PR closed after dispatch.
```

<a id="af-005"></a>

### 5. route — Concurrency is keyed by TARGET, not shared and not fully unique:

In `route`.

```text
Concurrency is keyed by TARGET, not shared and not fully unique:
  • cron ticks share one group (a newer tick supersedes a queued one)
  • review events coalesce PER PR (two reviews on the same PR seconds
    apart route once — the old shared group's one useful side effect,
    kept, without letting events on OTHER PRs cancel this one)
  • issue events coalesce PER issue
  • dispatches are unique per run and are never cancelled —
    fork-bridge dispatches included: `source` is a public
    workflow_dispatch input, so no dispatch may claim a trusted
    per-PR coalescing group by asserting an origin; fork-review
    bursts coalesce upstream instead (the signal per PR, the bridge
    per conclusion+head)
The old single shared cancel-in-progress group let ANY newer event kill
pending full scans while route jobs sat queued behind runner backlog —
observed as hours of scan starvation during review-event storms.
Five cases: schedule → one shared cron group (newer tick supersedes);
pull_request_review → per-PR, but ONLY when the review payload
already looks trusted (the group is entered before any step runs, so
an arbitrary commenter's review would otherwise cancel a queued
legitimate route and then die in 'Decide phases' — untrusted payloads
get a run-unique group and still face the real permission gate
inside; the association literal mirrors TRUSTED_ASSOC and the login
mirrors REVIEW_BOT); pull_request label events → per-PR (GitHub only
lets triage+ apply labels, so the whole event class is trusted —
in their OWN per-PR group (label-{N}), distinct from the review
group so a simultaneous review and label toggle on the same PR can
never cancel each other, and only the takeover label routes at all
(unrelated labels are filtered at the job gate); issue_comment → its own per-PR command group, but
ONLY when the commenter's payload association already looks trusted
(same prefilter pattern as reviews — an untrusted commenter must not
cancel a maintainer's queued command; untrusted payloads get a
run-unique group and still face the real permission gate inside), so
a burst of trusted command comments coalesces to at most two runs
with latest-intent semantics, never touching review routes;
issues → per-issue; anything else (dispatch) → unique per run_id,
never cancelled. A fork-bridge dispatch is still a dispatch here:
`source` is a public input any manual dispatch can set, so keying a
cancellable per-PR group on it would let a manual dispatch cancel a
queued one (and vice versa).
```

<a id="af-006"></a>

### 6. route · Decide phases — Fork PR — decline, and say so. This event carries NO repository secrets: GitHub…

In `route` · `Decide phases`.

```text
Fork PR — decline, and say so. This event carries NO
repository secrets: GitHub withholds them from every run
tied to a pull request whose head lives in a fork, and the
run header states it outright (`Secret source: None`). So
CI_DEV_BOT_PAT arrives EMPTY and neither review-scan nor
review-address could authenticate from here — the earlier
claim that "this event runs in BASE-repo context" held for
the workflow FILE, which is read from base, but not for the
credentials.
Admitting the PR anyway spent two API reads to decide it,
then three more failing inside the scan, which exited 1 on
`metadata_fetch_failed` — a reason whose blocked comment
promises "a later scheduled scan will retry", true for a
5xx and false for a credential this run was never handed.
Every review of a fork PR reddened the workflow while
changing nothing, and that noise buried the failures that
do need a human.
The label and the feedback both keep working: the scheduled
scan runs in repo context and admits fork takeover PRs on
its own. This mirrors the pull_request label branch below,
which already declines forks for exactly this reason.
```

<a id="af-007"></a>

### 7. route · Decide phases — '<cmd> from N' — the ONE parameterized form, and the only place this workflow reads a…

In `route` · `Decide phases`.

```text
'<cmd> from N' — the ONE parameterized form, and the only
place this workflow reads a value out of a comment body.
Kept inside the constants discipline above: the literal
prefix must still match TAKEOVER_COMMAND byte-for-byte, the
tail is a bounded integer, and the captured value only ever
reaches an integer comparison and a printf '%s' of a
re-validated number — never an unquoted shell word, a jq
program, or an API path. Seeds the round counter so a PR
that already burned N review rounds before takeover reaches
CRITICAL_ONLY_AFTER_ROUND after the remainder rather than a
full fresh five. 1..99: a seed at or past the effective cap
is clamped at the read sites, but rejecting 3-digit input
here keeps the obvious typo out entirely.
```

<a id="af-008"></a>

### 8. issue-autofix — Secret-bearing and executes agent-driven code, but the agent runs inside the docker…

In `issue-autofix`.

```text
Secret-bearing and executes agent-driven code, but the agent runs inside
the docker sandbox image and only ever writes a new branch as the
dev-bot — it never executes a foreign author's code. Forks of this repo
(and MAINTAINER_ECS_RUNNER_DISABLED) fall back to hosted. On
pull_request / pull_request_review events the ECS route additionally
needs a same-repo head or a write+ author (ci.yml's pick_runner form);
the other triggers skip that clause and rely on their own gates
instead: issues / schedule require autofix/approved plus
status/ready-for-agent on the issue, and workflow_dispatch rides the
actor's own write access. Docker availability on this pool is proven
in-repo by qwen-triage's container jobs, which run on the same
runner labels.
```

<a id="af-009"></a>

### 9. issue-autofix — route.issue_number is only set for forced dispatches; label events carry the issue in…

In `issue-autofix`.

```text
route.issue_number is only set for forced dispatches; label events carry
the issue in the payload, and scan-and-pick runs (cron, unforced
dispatch) share one 'scheduled' group. The old github.run_id fallback
made every scan-and-pick run its own group, so two overlapping scans
(cron fires every 40-70min, this job runs up to 180) could double-claim
the same issue — the claim recheck runs after assess and only narrows
the race to the short gap between the recheck and the claim's label
write; it does not close it. Queued (never cancelled) so the newest
pending tick still runs after a long scan if targets remain;
intermediate ticks are superseded, which is fine because each run
rescans from scratch.

GitHub evaluates concurrency before the job `if`, but after `needs`, so
the group is gated on the same runnability predicate as the `if` above,
plus a dry-run exclusion: runs whose issue phase will not execute
(do_issue=false takeover, review, and command events; label events
failing the decide gates; scheduled ticks whose review-scan still has
targets) and dry runs (if-runnable, but their Claim/Publish steps are
gated off) get a run-unique group instead — a run that never claims
entering a target-keyed group would replace the single pending run
there and silently cancel it. Same precedent as qwen-triage.yml's
triage/tmux jobs.
```

<a id="af-010"></a>

### 10. issue-autofix · Sanitize workspace git config — The runner USER's global config is the same exec surface as the workspace config below:…

Duplicated verbatim in 3 places: `issue-autofix` · `Sanitize workspace git config`, `build-cli` · `Sanitize workspace git config`, `review-address` · `Sanitize workspace git config`.

```text
The runner USER's global config is the same exec surface as the
workspace config below: pool jobs run human-authored code (branch
tests) as this user, and a stray `git config --global` outlives
the job on the persistent pool. Measured: run 31516789251 found
diff.external=global-driver in ~/.gitconfig, failing per-hunk
probe tests in every later verification gate on this host. The
gates read a throwaway global config now, so this scrub is host
hygiene plus protection for THIS job's PAT-bearing git steps,
which do read the real file. It runs BEFORE the .git early-exit:
host hygiene owes nothing to the workspace existing. Denylist
here, not the local allowlist below: the file belongs to the
pool image, so routing/credential keys (http.*, url.*,
credential.*) may be deliberate infra and are left alone — only
the command-execution families go, plus include/includeIf (which
can pull any of them back in) and protocol.ext.allow (which arms
the command-executing ext:: transport a kept url.insteadOf could
redirect to). Two ROUTING exceptions ride the denylist because
each defeats the PAT steps directly: url.*.insteadOf/
pushInsteadOf (rewrites the push/fetch URL at transport time —
the rest of url.* stays) and http.*.sslVerify/sslCAInfo (turns
a kept http.proxy into a TLS-terminating interceptor; the pool
works on the default CA today, so scrubbing these can only
fail loudly, never silently). Subsection slots are `.+`, never
`[^.]+`: git subsection names may contain dots (`[diff "a.b"]
command` flattens to diff.a.b.command and would slip past
`[^.]+`); overmatching is harmless in a denylist. Guarded
`|| true` twice: no global file and no match are both normal,
and either would kill the step under the default `bash -e` +
pipefail otherwise. The same denylist lives in
resanitize-git-config.sh, which the PAT-bearing steps re-run
AFTER branch code executed on the host; the workflow contract
tests pin every copy byte-identical — edit them together.
The GLOBAL scope spans TWO files — ~/.gitconfig and
${XDG_CONFIG_HOME:-~/.config}/git/config — but with both
present, `git config --global` lists and unsets ONLY
~/.gitconfig (probed on git 2.43 and 2.55: the listing omits
the XDG keys and --unset-all exits 5 with them live), so sweep
each file explicitly by pointing GIT_CONFIG_GLOBAL at it — the
env var replaces the whole global scope with exactly that
file, for reads and writes alike.
```

<a id="af-011"></a>

### 11. issue-autofix · Remove stale sandbox containers — run-agent.mjs's budget kill removes the container it launched, but a JOB timeout still…

Duplicated verbatim in 2 places: `issue-autofix` · `Remove stale sandbox containers`, `review-address` · `Remove stale sandbox containers`.

```text
run-agent.mjs's budget kill removes the container it launched,
but a JOB timeout still reaps only the HOST-side docker client,
not the container: a killed sandbox can keep running on this
persistent runner. Observed directly — a hung leg's container
name counter found qwen-code-0.21.8-0 already occupied and
picked -1. But the docker DAEMON is per host while this pool
runs several runner registrations on one OS, so a RUNNING
qwen-code-* container can belong to a job executing on another
registration of this same host — reaping it would destroy a
live sandbox mid-run. Reap only provably-dead containers
(exited/dead), before the sandbox picks a name (and before the
leftovers can wedge the daemon). Every docker call here is
tolerated: this step is hygiene, and a daemon blip, a racing
reap on another registration, or a container that refuses
removal must not kill the round at setup. Every call also runs
under `timeout` (GNU coreutils on the ubuntu runners): a daemon
that is alive but wedged blocks `docker ps` indefinitely, and
`|| STALE=''` catches only a nonzero exit, not a hang — the
step would sit until the job timeout, a silent round
reintroduced ahead of the very idle watchdog this PR adds.
```

<a id="af-012"></a>

### 12. issue-autofix · Set up Node.js — No remote npm cache on the persistent pool: one measured review-address leg spent 339s…

In `issue-autofix` · `Set up Node.js`.

```text
No remote npm cache on the persistent pool: one measured
review-address leg spent 339s in `Set up Node.js` restoring
2,654,052,865 bytes (~10 MB/s) to protect an `npm ci` that took
29s in the very next step, and those runners keep ~/.npm across
jobs anyway, so every leg paid the download again — up to ten
review-address legs per scan. The hosted fallback is ephemeral
and keeps the cache; the choice keys on the runner fact directly.
Keep the truthy literal in the MIDDLE of the ternary — GHA's
&&/|| return operand values and '' is falsy, so
`== 'self-hosted' && '' || 'npm'` yields 'npm' on BOTH pools
(the contract tests evaluate the expression for both runner
facts). package-manager-cache stops a future `packageManager`
field in package.json from silently re-enabling the cache here.
```

<a id="af-013"></a>

### 13. issue-autofix · Verification gate — Run changed/related tests for the packages this fix touches.

In `issue-autofix` · `Verification gate`.

```text
Run changed/related tests for the packages this fix touches.
--changed follows the import graph so transitive breakage is caught.
Full regression is covered by regular CI on the PR after the push.
Map each changed file to its OWNING npm workspace via the trusted
staged resolver, shared with the other verify gate so both resolve
packages identically. It expands the on-disk root package.json
workspaces globs (so a workspace the branch ADDS is included) and
takes each file's longest-prefix workspace — never a flat
'packages/<dir>' (ENOENT-crashes on nested packages) nor a fixture
package.json inside a workspace's src tree (would skip the owning
workspace's tests). No '|| true': a resolver error (missing node, an
unreadable manifest) must fail the gate loudly rather than silently
skip package tests; legitimate no-match input already exits 0 empty.
```

<a id="af-014"></a>

### 14. issue-autofix · Publish PR — Take this PAT-bearing step off every mutable host git surface — both the shared config…

In `issue-autofix` · `Publish PR`.

```text
Take this PAT-bearing step off every mutable host git surface —
both the shared config FILES and git's ENV channels — keep this
block byte-identical to its twin in 'Push and report' (the
contract test pins them equal). File scopes: the pool shares one
HOME across ~27 runner registrations and review-address fans out
max-parallel, so a concurrent job can rewrite ~/.gitconfig inside
this step's sweep->push window (a URL-scoped sslVerify=false there
overrides the -c pin below over real TLS); redirect global/system
to a per-run throwaway (as the gates do) so the push reads neither.
Env channels: branch code in an earlier step of THIS job can inject
env through $GITHUB_ENV, and several channels OUTRANK file config or
bypass it entirely — pin PATH to the staged trusted value and drop
LD_PRELOAD/LD_AUDIT/LD_LIBRARY_PATH first (else a swapped
git/sha256sum/bash defeats the digest gate below), then strip
GIT_CONFIG_COUNT/_PARAMETERS (command-line-precedence config),
GIT_ALLOW_PROTOCOL (env twin of protocol.allow — arms ext::),
GIT_SSL_NO_VERIFY/GIT_SSL_CAINFO (override the sslVerify pin over
real TLS), GIT_PROXY_COMMAND, GIT_EXEC_PATH (transport-helper
binary), GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR/GIT_OBJECT_DIRECTORY/
GIT_ALTERNATE_OBJECT_DIRECTORIES/GIT_SHALLOW_FILE (repoint the repo
git reads and pushes), GIT_ASKPASS/GIT_SSH/GIT_SSH_COMMAND
(credential/exec hijack). The throwaway global uses an
unpredictable mktemp path so a same-user watcher cannot re-plant
http.proxy/sslCAInfo into a fixed literal after the seed. All
probe-verified in the #8961 review.
```

<a id="af-015"></a>

### 15. issue-autofix · Publish PR — Authenticate the push with a one-shot, host-scoped credential helper via `git -c`:…

In `issue-autofix` · `Publish PR`.

```text
Authenticate the push with a one-shot, host-scoped credential
helper via `git -c`: nothing is written to the reused
workspace's .git/config (no error path can strand it there),
argv holds only the literal ${GITHUB_TOKEN} reference, and the
host scope means it cannot answer a non-GitHub URL. The leading
empty credential.helper RESETS the inherited helper list first:
helpers run in config order and the first to answer wins, so a
helper planted at any earlier scope would otherwise see the
request (and the env) before ours answers — probe-verified in
the #8961 review. http.sslVerify pins the transport: a kept
http.proxy plus a planted sslVerify=false would otherwise let
an interceptor read the credential off the wire.
```

<a id="af-016"></a>

### 16. takeover-command · Toggle takeover label — The round seed rides as its OWN marker on a separate line, NEVER as a field inside '<!--…

In `takeover-command` · `Toggle takeover label`.

```text
The round seed rides as its OWN marker on a separate line, NEVER as
a field inside '<!-- takeover-ack engaged -->'. That literal is
matched with jq `contains()` — closing '-->' included — at seven
read sites: four here (the ack dedup, the scan's first-pickup
dedup, and the two REARM_KEY window readers) and three in
qwen-fleet-shepherd.yml (the paused/resume detector). Appending a
field would silently break all seven: the window key would fall
back to an OLDER engage ack, so the round counter would read a dead
window, and the shepherd would stop seeing the engage as a resume
signal and age out a PR that was just re-armed. Same reasoning, and
the same shape, as the autofix-redcheck marker.
Rendered EN/ZH too, because the ack otherwise reports
"round 4/100" on its first managed round and reads like a bug.
```

<a id="af-017"></a>

### 17. takeover-command · Toggle takeover label — Already managed: repeating the command is the ROUND-COUNTER RESET. A fresh engage ack…

In `takeover-command` · `Toggle takeover label`.

```text
Already managed: repeating the command is the ROUND-COUNTER
RESET. A fresh engage ack starts a new counting window (only
markers newer than the latest ack count toward the cap), so
a PR that exhausted its rounds continues under management —
no label churn needed. The watermark is untouched: feedback
already addressed is never replayed.
Body built ONCE so the retry posts byte-identical text.
Same one-retry shape as the engage post below — the seed
marker's only copy rides in this body too — but the final
fallback is LOUD: nothing heals a missing re-arm (the scan
heals only engage-less PRs, and the pre-existing engage ack
suppresses the dedup), and a 're-armed' claim plus the
stale-escalation cleanup must not follow a window reset that
never landed (R7-7).
```

<a id="af-018"></a>

### 18. takeover-command · Toggle takeover label — REST for consistency and runner-version independence: `gh pr edit`'s GraphQL lookup…

In `takeover-command` · `Toggle takeover label`.

```text
REST for consistency and runner-version independence: `gh pr
edit`'s GraphQL lookup requests
repository.pullRequest.projectCards, which GitHub rejects on
the gh builds that still send that query (demonstrated on the
ECS pool — see pr-self-report-label.yml). This job runs on
ubuntu-latest, where the command still worked; REST behaves
the same on every runner image.
Idempotent create first, with the label's real color: the
REST add would silently create a missing label with a RANDOM
color (gh pr edit failed loud there), and this was the one
POST site without the guard its siblings carry
(pr-self-report-label.yml creates; repo-hygiene.yml probes).
```

<a id="af-019"></a>

### 19. takeover-command · Toggle takeover label — REST for the same reason as the add above; the label name is a path segment and contains…

In `takeover-command` · `Toggle takeover label`.

```text
REST for the same reason as the add above; the label name is a
path segment and contains a slash, so it must be URI-encoded.
A concurrent removal between the presence check and this
DELETE already reached the end state — the 404 must not abort
the step and drop the release ack below. Other failures (403,
5xx, network) also must not drop the ack — a later
`/takeover stop` retries the removal — but must not disappear
silently either: masked, the ack reads "released" while the
loop keeps managing the PR.
The 404-tolerance block is pinned byte-identical to the other
workflows' label DELETE (a contract test), so REMOVED_OK —
whether the takeover release actually LANDED — is derived
AFTER the idiom from the captured stream: gh api prints the
remaining-labels JSON body on success (even '[]'), while a
failure carries "HTTP <status>" in the error text. 404 =
already off (landed); any other HTTP error = the release did
NOT land and the needs-human removal below must NOT run
(R4-32) — or the PR keeps the takeover label (still capped,
nothing manages it now) while losing the only filterable
escalation state. The flag is keyed on the EXIT STATUS, with
one text-derived exception: a failed DELETE whose error
carries the exact "HTTP 404" token is the already-off case.
The match must stay that precise token, not a bare "404"
substring: transport failures embed the request URL — a PR
number containing 404 would flip the classification — while
no transport error carries an "HTTP" token (R6-1/R6-19).
```

<a id="af-020"></a>

### 20. takeover-command · Toggle takeover label — TAKEOVER ACK — visible confirmation when a maintainer engages or releases a PR via the…

In `takeover-command` · `Toggle takeover label`.

```text
===========================================================================
TAKEOVER ACK — visible confirmation when a maintainer engages or releases
a PR via the takeover label. Manual label toggles are explicit user
actions, so every one acks (no dedup wanted). Command-driven toggles are
acked by takeover-command itself in BOTH directions — the label event has
been observed to not fire at all (#7999, #8002), so those acks cannot
depend on this round-trip — and the route suppresses this job for them
(label sender is the bot). In-repo PRs only reach this job.
===========================================================================
Re-arm a stranded PR without deleting anything. Recovery previously meant
`gh api -X DELETE` on the bot's own autofix-eval marker comment: raw API
access, an erased audit trail, and undiscoverable unless you had read the
workflow. This posts ONE marker instead — the scan then re-reads the
feedback (the marker releases the watermark those older markers held) and
the round counter resets, because the marker also opens a fresh counting
window exactly like an engage ack.
```

<a id="af-021"></a>

### 21. takeover-ack · Acknowledge takeover state change — Bilingual with COLLAPSED Chinese (project convention), built via printf so no workflow…

In `takeover-ack` · `Acknowledge takeover state change`.

```text
Bilingual with COLLAPSED Chinese (project convention), built via
printf so no workflow indentation leaks into the markdown (4+
leading spaces would render the marker line as a code block).
Live label/author state decides WHAT to acknowledge: a skip label
vetoes the engagement (skip wins — no engaged anchor for
management the scans refuse), and a release on a BOT-authored PR
must not claim disengagement — standard bot management continues,
only takeover mode (raised cap) ends.
Fail CLOSED like the sibling takeover-command job: empty metadata
here would default HAS_SKIP to false and post a wrong "engaged"
ack on a skip-labeled PR during a transient API failure. A red
ack job posts nothing — engagement itself is scan-driven and
unaffected.
A base refusal needs no live state — it is decided entirely by the
route — so it does NOT ride on this read. Making the one ack whose
whole purpose is "say why nothing happened" depend on an unrelated
API call would reintroduce the silence it exists to remove.
```

<a id="af-022"></a>

### 22. review-scan · Scan for PRs with new feedback — 'none' and HTTP 404 are DEFINITIVE answers, not lookup failures.

In `review-scan` · `Scan for PRs with new feedback`.

```text
'none' and HTTP 404 are DEFINITIVE answers, not lookup failures.
GitHub returns 200 with permission 'none' for logins that exist but
hold nothing here (bot-type logins such as dependabot[bot], and org
logins), and 404 for logins that do not exist or are empty. Both
mean "no write access" — the routine rejection this gate is for.
Retrying them would burn 3 API calls plus back-off per candidate per
scheduled tick, forever, and strand the caller on
'permission_lookup_failed': a red forced run (exit 1) whose blocked
comment promises "a later scheduled scan will retry" — a retry that
can never succeed — while the actionable "grant the fork author
write access" guidance behind author_permission_* stays unreachable.
Only genuinely transient answers (5xx, network, auth) retry.
```

<a id="af-023"></a>

### 23. review-scan · Scan for PRs with new feedback — Same filter as the sibling upsert in 'Post autofix status comment', including its two…

In `review-scan` · `Scan for PRs with new feedback`.

```text
Same filter as the sibling upsert in 'Post autofix status comment',
including its two guards: `// ""` so a single comment with a null
body cannot abort the whole program (jq exits 5, all three
attempts fail, and the run reds out WITHOUT posting the very
status it exists to post), and --arg so a repo-configured
AUTOFIX_BOT_LOGIN containing " or \ is a mismatch instead of a jq
parse error. Stays an inline id stream into `tail -1` — it never
lands in a WORKDIR json file, so the WORKDIR page normalizer
(add-with-empty-default) must NOT be applied here: it would wrap
the id stream in an array and break the tail-1 consumer.
pipefail is set LOCALLY here rather than relied on: this `if`
must test gh's status, not jq's. A gh failure carrying an HTTP
status prints the error body to stdout, so jq errors out and the
retry fires — but a CONNECTION-level failure (TCP reset, TLS
abort, DNS blip) leaves stdout EMPTY, and `jq -rs` then prints
nothing and exits 0. Without pipefail that reads as success on
nothing read: status_lookup_ok=true, the empty id takes the
writer down the "no status comment yet" branch, and it posts a
DUPLICATE ⛔ blocked comment beside the stale ✅ one — the exact
two-status state this function exists to prevent — on a green
run. `defaults.run.shell: bash` already gives every step in this
file `-eo pipefail`, so this is redundant today; it is also the
only guard that survives that default changing or this helper
being lifted into a step that sets its own options.
```

<a id="af-024"></a>

### 24. review-scan · Scan for PRs with new feedback — FORK PRs are admitted per candidate: the author must hold write+ RIGHT NOW (the same…

In `review-scan` · `Scan for PRs with new feedback`.

```text
FORK PRs are admitted per candidate: the author must hold write+
RIGHT NOW (the same live-privilege rule as the comment command)
and the PR must allow maintainer edits (or the bot cannot push).
Two sources, unioned: takeover-LABELED forks (any eligible author,
explicit opt-in) AND the bot's OWN forks (bot-prs.json is
--author AUTOFIX_BOT) — a fork the bot itself opened is its own
generated work, trust-equal to an in-repo bot PR, so it needs no
label (autofix/skip still opts it out). Rare set — one permission
call each; the write+ check below still gates every candidate.
Appended after the rotated in-repo list: forks sit outside the
anti-starvation rotation, which only bites once in-repo
candidates alone exhaust the inspection budget.
```

<a id="af-025"></a>

### 25. review-scan · Scan for PRs with new feedback — Base of the auto-update-stale-base decision below. A PR can be red purely because it…

In `review-scan` · `Scan for PRs with new feedback`.

```text
Base of the auto-update-stale-base decision below. A PR can be red
purely because it merged a main that was BROKEN at the time and has
since been FIXED — observed repeatedly (a web-shell TS break, an
agent-registry test) stranding healthy PRs on a failure that has
nothing to do with them. GitHub's "Update branch" merges current
main in and re-runs CI, which clears it. We do that automatically
only when the SAME failing check also passed for the PR that produced
current main (MAIN_GREEN_CHECKS) — a necessary-but-NOT-sufficient
signal, NOT proof that main is healthy.

MAIN_GREEN_CHECKS is sourced from the last-merged PR's PRE-MERGE
check-runs, which ran against that PR merged with main-as-of-then —
never the tree now on main (ci.yml has no push trigger, so main's
squash commits carry no check-runs to read). main breaks here by
SEMANTIC CONFLICT: two PRs green apart but broken together. In exactly
that state the last-merged PR is green, this signal reads green, and
the update would merge a currently-broken main into a healthy PR. The
signal also inherits the last PR's matrix shape (a SKIPPED platform
job is absent, so a PR stranded on it is never unstuck — fail-safe,
but non-deterministic). The blast radius stays recoverable, not zero:
the merge (not rebase) is revertible, a marker bounds re-updates to
once per 2h, and the CAS (expected_head_sha) rejects a concurrent
push. A re-enabled merge queue would let us source this from a
genuinely validated merged tree instead: ci.yml DOES have a
merge_group trigger, so a merged tree's check-runs would land where
we could read them.

Fetch main's head and that check-name set ONCE per scan: resolve
main's head to the PR that produced it and read check-runs from that
PR's head SHA.
```

<a id="af-026"></a>

### 26. review-scan · Scan for PRs with new feedback — PRs whose review-address is already RUNNING OR QUEUED in any live autofix run must not…

In `review-scan` · `Scan for PRs with new feedback`.

```text
PRs whose review-address is already RUNNING OR QUEUED in any live
autofix run must not be re-targeted. Schedule/dispatch runs execute
against main's SHA, so their matrix jobs never appear in the PR's
statusCheckRollup — and a fanned-out matrix holds queued jobs well
past a 10-minute tick, so without this the next scan re-emits the
same PRs and the per-PR address groups accumulate duplicates that
later replay stale watermarks. The status filter is SERVER-side: a
client-side filter over the N newest runs loses a long-lived
fanned-out run once cron traffic pushes it past the window, and
its queued PRs silently stop looking busy. Filtered this way the
limit applies to LIVE runs only (at most a handful), and one
jobs-view per live run stays cheap.

FAIL-CLOSED: any enumeration failure (the run list, or one run's
jobs view) empties THIS scan's candidate set. Measured 2026-08-16
(#9296): silently swallowing these errors re-dispatched PRs whose
legs had been running or queued for 3-12 minutes; each duplicate
burned one build-cli (~5 min) before cancelling a queued sibling
leg through the per-PR group's latest-wins queue. A duplicate
costs far more than one skipped scan — the next tick re-inspects
with fresh reads. Only an EXPLICIT dispatch (workflow_dispatch
with a PR number) keeps its override semantics and is NOT emptied
by an enumeration failure — FORCED_PR is ALSO set for trusted
pull_request_review scans, which are not explicit dispatches. The
step also emits enum_failed: the scan exits 0, and an emptied set
would otherwise read exactly like "no PR needs work" and flip the
scheduled issue phase ON against its declared ordering. The
dispatch-pending status check below additionally covers the
window where the leg does not exist yet (behind build-cli).
```

<a id="af-027"></a>

### 27. review-scan · Scan for PRs with new feedback — Idle backoff, from the list's own updatedAt (no API call): a candidate with no activity…

In `review-scan` · `Scan for PRs with new feedback`.

```text
Idle backoff, from the list's own updatedAt (no API call): a
candidate with no activity for >24h is inspected on about one
scan in four instead of every one. The pool doubled in two
days (28 takeover PRs, 8 of them idle in "nothing new" state
for 10+ hours), and every idle inspection costs a unit of the
SHARED MAX_CANDIDATE_INSPECTIONS budget plus a slice of the
serial API walk over the candidate list. The win is small: a
few fewer gh round-trips per scan (~2-3 of the pool) and less
rate-limit pressure. It does NOT recover the job's queue or
startup latency, which dwarfed the walk in the #8002
measurement that motivated this. Idle PRs never reach the
10-target budget (the "nothing new" branch continues before
the TARGETS append), so that cap is NOT what this relieves.
Safe because comments, reviews, labels, and pushes all bump
updatedAt or route in real time; the two scan-only signals
that do NOT bump it — a base conflict appearing when main
moves, and still-red checks awaiting the redcheck marker —
wait out the backoff on a PR nobody touched in a day, then
self-correct (the eventual address run comments/pushes). The
slot is keyed by PR number mod 4 against a 600s time quantum
(same quantum as ROT_OFF), so each scan is an independent
~25% draw per idle PR — about one scan in four. This is NOT a
bounded gap: the scheduled scan lands every ~40-70 min on
this repo (not the */10 the cron implies), so the wait is
geometric — measured median ~2h, p90 ~6h across 100 real
scans. The forced-dispatch path never builds the list files,
so a forced PR is always inspected (fail-open, like a PR
missing from the set).
```

<a id="af-028"></a>

### 28. review-scan · Scan for PRs with new feedback — Review-in-flight gate (#8888): NON_BLOCKING_CHECKS keeps an in-flight review-pr from…

In `review-scan` · `Scan for PRs with new feedback`.

```text
Review-in-flight gate (#8888): NON_BLOCKING_CHECKS keeps an
in-flight review-pr from blocking the FEEDBACK gate (its
conclusion carries nothing the loop acts on — #7416), but every
head mutation this scan can make (a stale-base update-branch,
infra rerun, or address push later) is a synchronize event that
cancels the in-flight review via qwen-code-pr-review.yml's
cancel-in-progress, discarding up to ~3h of review work — the
self-reinforcing cancellation loop of #8830 (three killed runs
in one PR, two by merge-main). Its findings are also the very
feedback the next round should batch with, so deferring the
WHOLE round until the review lands loses nothing: the watermark
is not advanced on a skip, so the feedback stays visible. This
is deliberately SEPARATE from HAS_PENDING_CHECKS rather than a
NON_BLOCKING_CHECKS revert: that gate ages checks out after
PENDING_STALE_MIN and would also re-block on the review's
conclusion, reintroducing #7416's median-49-minute wait.
```

<a id="af-029"></a>

### 29. review-scan · Scan for PRs with new feedback — First-pickup engage ack: fork label events carry no secrets and manual labels may race…

In `review-scan` · `Scan for PRs with new feedback`.

```text
First-pickup engage ack: fork label events carry no secrets and
manual labels may race the ack job, so a takeover PR with NO
engage ack yet gets one here (identity-verified) — it is also
the round-window anchor. ic.json is re-fetched so THIS scan
already counts under the fresh key. ORDERING IS LOAD-BEARING:
ic.json for THIS candidate is fetched just above — reading a
previous candidate's file would mis-dedup (spurious re-ack →
window reset every scan), and a missing file would kill the
whole scan step under -eo pipefail. Dedup is author-filtered
(a forged human marker must not suppress the real ack), and a
label application NEWER than the latest bot ack means a fresh
engagement — post a fresh ack so the round window and cap
reset as documented (re-arm), which no ack job can do for
forks.
```

<a id="af-030"></a>

### 30. review-scan · Scan for PRs with new feedback — Grace windows keyed by WHO owns the missing ack, read from the label event's actor…

In `review-scan` · `Scan for PRs with new feedback`.

```text
Grace windows keyed by WHO owns the missing ack, read from
the label event's actor (pr-events.json is already here).
A bot-applied label came from takeover-command, which posts
the ack itself within seconds — fork or in-repo alike — so
a SHORT grace covers the write's own latency and an
ic.json snapshot taken between the label write and the ack
landing; past it, the command's post failed and the next
scheduled scan heals it (≤10 min), instead of waiting on
a label event that may never arrive. A human-applied
in-repo label is owned by the
DEDICATED ack job, which needs job-spin-up time — the
longer grace stands. A human-labeled fork has no other
owner, so no grace: the scan posts right here.
```

<a id="af-031"></a>

### 31. review-scan · Scan for PRs with new feedback — A FORCED dispatch refused here answers OUT LOUD. Observed on #7836: the fleet shepherd…

In `review-scan` · `Scan for PRs with new feedback`.

```text
A FORCED dispatch refused here answers OUT LOUD. Observed on
#7836: the fleet shepherd detected a merge conflict, posted
"dispatched the autofix loop to resolve it", and the dispatch
died right here with only the log line above — the PR page
showed a promise, the run showed green, and the conflict sat
unhandled for hours. The shepherd also dedups per head SHA,
and a capped PR gets no pushes, so its head never changes:
silence here freezes conflict handling until a human notices
by accident. Gate on workflow_dispatch — that is the explicit
dispatch lever (the shepherd's `gh workflow run` or a human).
FORCED_PR is ALSO set for every trusted pull_request_review
(route emits pr_number for those), which is not an explicit
dispatch: answering each one here spammed 7 refusals on
#7836, so review submissions stay covered by the
once-per-window pause notice below. No dedup on the dispatch
itself: the shepherd sends at most one per head, and a human
asking twice deserves two answers. fork-bridge dispatches are
the one dispatch-shaped exception: they are fork-PR reviews
laundered into dispatch form (a fork's review event carries no
secrets), not an explicit human/shepherd dispatch — answering
each one loudly would post one refusal per review on a capped
fork PR, the exact #7836 spam this gate exists to prevent.
But `source` is a public workflow_dispatch input any manual
dispatch can set, so the silence is honored ONLY on positive
proof of origin: a recent SUCCESSFUL fork-bridge run whose
title names this exact PR (the bridge propagates the signal's
run-name into its own title — both base-branch files, not
fork-forgeable). The window is generous because route backlog
can queue a dispatch for hours; the PR match, not the window,
is what proves origin. Unverified → answered like any
explicit dispatch.
```

<a id="af-032"></a>

### 32. review-scan · Scan for PRs with new feedback — A MANAGED PR pausing at its cap deserves a visible reminder — maintainers otherwise…

In `review-scan` · `Scan for PRs with new feedback`.

```text
A MANAGED PR pausing at its cap deserves a visible reminder —
maintainers otherwise learn about it only from workflow logs.
ALL managed PRs, not just takeover: the takeover-only gate
left standard bot PRs capping in silence (#7836 hit 10/10
with zero PR-visible notice), which is the root of the
frozen-conflict chain above. Once per counting window:
re-arming opens a fresh window and, if the cap is hit again,
a fresh reminder. A failed post retries naturally on the
next scan (marker still absent).
Dedup boundary = the current window key; with no engage ack
or re-arm yet (key 'none') fall back to LIFETIME dedup —
created_at is never > 'none' lexically, which would flip
this into posting every scan.
```

<a id="af-033"></a>

### 33. review-scan · Scan for PRs with new feedback — Release evidence = a takeover unlabeled EVENT at-or-newer than the window key. GitHub…

In `review-scan` · `Scan for PRs with new feedback`.

```text
Release evidence = a takeover unlabeled EVENT at-or-newer
than the window key. GitHub records it whenever the label
comes off — `/takeover stop`, the ack job, or a manual UI
removal — unlike the release-ack COMMENT, which both release
paths tolerate losing (R4-1): the stop branch swallows a
failed ack post, and the ack job's set -e aborts before it.
A re-arm advances REARM_KEY past the event, re-enabling the
label. Same-second ties resolve toward "released" — never
re-escalate a completed release (R5-9). Fail closed: an
unreadable event history suppresses the re-label rather than
risk the ping-pong.
A capped takeover candidate already paid for this paginated
endpoint earlier in the same iteration (pr-events.json,
gated by PR_EVENTS_OK) — reuse that fetch instead of paying
it twice per capped takeover PR per scan. Non-takeover
candidates keep the standalone fetch, and the fail-closed
semantics ride the flag: the engage-side '[]' fallback must
never read here as "no releases".
```

<a id="af-034"></a>

### 34. review-scan · Scan for PRs with new feedback — A red check is a persistent STATE, not the instant it turned red.

In `review-scan` · `Scan for PRs with new feedback`.

```text
A red check is a persistent STATE, not the instant it turned red.
Counting only "failed since the watermark" made a still-failing PR
invisible the moment the watermark passed the failure: measured on
#6451 (3 reds, all completed 09:30-09:51, watermark 10:55),
#7357 (red 07:59, watermark 09:18) and #7390 (red and watermark
both 11:27:37, so a strict `>` hid it the instant it appeared) —
all three sat red for hours while every scan logged "nothing new".

So: a currently-red check counts as feedback until the head it ran
against has been evaluated. The address job records the head it
reported on; a PR whose recorded head still matches is left alone,
which bounds this to ONE look per head instead of every scan.
Empty LIVE_HEAD → N_RED_NOW stays 0: fail-closed (no head → cannot judge → do not act),
unlike the recording side where an empty REPORT_HEAD keeps reds visible.
```

<a id="af-035"></a>

### 35. review-scan · Scan for PRs with new feedback — Stamp the dispatch-pending marker now, while this scan still owns the decision: an…

In `review-scan` · `Scan for PRs with new feedback`.

```text
Stamp the dispatch-pending marker now, while this scan still
owns the decision: an overlapping scan inspecting this PR while
build-cli runs (the leg has not materialized yet) sees the
PENDING status in its rollup and skips. Same-repo heads only —
a fork head sha cannot carry a status in this repo; fork
duplicates stay covered by the address-time revalidation. A
failed stamp degrades to a warning: the live-run enumeration
and the address-time gates remain. Dry runs stamp nothing: a
dry-run leg can die before any release runs (review-address is
skipped when build-cli fails), and a stranded real PENDING
would then block real scans — duplicate protection degrades to
those same surviving layers.
```

<a id="af-036"></a>

### 36. review-scan · Scan for PRs with new feedback — Fan out: emit EVERY eligible PR up to the per-scan budget. The address matrix bounds…

In `review-scan` · `Scan for PRs with new feedback`.

```text
Fan out: emit EVERY eligible PR up to the per-scan budget. The
address matrix bounds simultaneity (max-parallel) and the per-PR
concurrency groups plus the busy-PR skip and dispatch-pending
marker above prevent duplicate same-PR runs, so one scan drains
the whole backlog instead of
serving a single newest-first target per tick (which starved
older PRs for hours when cron ticks were sparse). The budget
break bounds this loop's RUNTIME and API usage too — each
candidate costs several serial API reads, so scanning past a
full budget would spend hundreds of calls for nothing. Never a
silent cap: the deferral is logged and the next scan picks up
the remainder (their signals persist).
```

<a id="af-037"></a>

### 37. build-cli · Prepare Qwen Code CLI — The repo-root dist/ plus packages/core/dist are shipped:

In `build-cli` · `Prepare Qwen Code CLI`.

```text
The repo-root dist/ plus packages/core/dist are shipped:
copy_bundle_assets.js already gathers every runtime asset (chunks,
vendor, web-shell, locales) under the root dist/, and the remaining
packages/*/dist would triple the artifact size without ever being
read by the legs — the verify gate's full `npm run build` wipes and
rebuilds each package's dist from branch sources (build_package.js
rms it first, so no staleness leaks through). packages/core/dist is
the exception: the settings-schema check runs BEFORE any build (on
every path, including no-action), and its generator — tsx run from
the repo root, whose tsconfig has NO `paths` — imports cli sources
that resolve '@qwen-code/qwen-code-core' through the workspace
symlink to core's dist entry point. Without it the generator crashes
with ERR_MODULE_NOT_FOUND and the gate misreports a deterministic
"settings schema is stale" rejection. The i18n check needs no dist:
it runs with cwd packages/cli, whose tsconfig `paths` map the
specifier to core's sources instead.
```

<a id="af-038"></a>

### 38. review-address — Secret-bearing and executes PR code, but every target is live-gated to write+ (internal)…

In `review-address`.

```text
Secret-bearing and executes PR code, but every target is live-gated to
write+ (internal) authors at scan AND address time. That is an
author-permission gate by design, not a head-repository gate: takeover
engages maintainer fork PRs, and the pattern matches qwen-code-pr-review,
whose ECS-routed review job also rides its upstream write+ check. The
job therefore runs host-side (no `container:`): the branch code it
executes is collaborator-authored — the same trust class ci.yml's
pick_runner routes onto this pool — and persistent-workspace residue is
scrubbed by the hygiene steps below. On pull_request /
pull_request_review events the ECS route additionally needs a same-repo
head or a write+ author (ci.yml's pick_runner form); issue_comment and
the other triggers skip that clause and rely on the live write+ gates.
Forks of this repo (and MAINTAINER_ECS_RUNNER_DISABLED) fall back to
hosted. Docker availability on this pool is proven in-repo by
qwen-triage's container jobs, which run on the same runner labels.
```

<a id="af-039"></a>

### 39. review-address — Simultaneity bound for the whole fleet — the ONLY place different PRs wait on each other…

In `review-address`.

```text
Simultaneity bound for the whole fleet — the ONLY place different PRs
wait on each other (the per-scan target budget and the inspection
budget are both far from binding at the current pool size).
Measured at 3, on the scan that selected 7 PRs: the legs started
3-at-a-time and each new one began 3-4s after a slot freed, so the
7th PR waited 81 minutes for a slot it could have had immediately.
5 halved that tail — the point of the cap is that a backlog cannot
open an unbounded number of agent runs at once, not the specific
number.
TUNABLE WITHOUT A CODE CHANGE: set QWEN_AUTOFIX_MAX_PARALLEL in
Settings → Variables to re-size the fleet as the takeover pool grows;
the literal below is only the fallback when the variable is unset.
Verified on a live runner that `max-parallel` accepts this expression
and schedules by it — a 6-leg matrix at 3 started 3, then began the
4th only once a slot freed.
Why 20: 37 PRs carried the label on 2026-08-08, so 5 slots served
~14% of them at a time and the tail measured at 3 simply reappeared
at a larger scale. The ecs-qwen fleet is 84 runners, so 20 concurrent
legs occupy under a quarter of it, and the executed legs sampled that
day finished in 3-28 minutes.
The 300-minute job cap puts the worst case at 5 runner-hours per slot
(100 across the fleet at 20) and holds the per-PR head-write
concurrency group for the same window. Different PRs never share that
group, so raising this does not add push contention.
RAISE BOTH TOGETHER: this must stay strictly below
MAX_TARGETS_PER_SCAN, or the scan cannot emit enough legs to fill the
matrix and the extra slots sit idle. A test pins that for the
fallbacks; for the variables it is an operator invariant.
```

<a id="af-040"></a>

### 40. review-address — Serialises every writer of THIS PR's head branch, across workflows.

In `review-address`.

```text
Serialises every writer of THIS PR's head branch, across workflows.
GitHub concurrency groups are repository-scoped, so sharing one name with
qwen-code-pr-review.yml's resolve-pr job is what makes the two mutually
exclusive — a per-workflow name only guards against itself.
Without this, a `@qwen-code /resolve` and this job's own conflict path
both merge the base branch and both push. Observed on #7355: /resolve
pushed at 03:51, this job pushed at 04:05 and was rejected `fetch first`,
discarding a full agent run and leaving no marker to show for it.
Serialising is strictly better than racing: this job fetches the head by
NAME at job start, so the second run reads the winner's result instead of
a stale base — its work is usable and its push lands, rather than being
rejected and thrown away. It may still spend an agent run: the
address-time recheck re-verifies lifecycle and consent (state, labels,
author, base, head branch) but not whether the conflict is still there.
The prefix is a LITERAL on both sides: job-level `concurrency` cannot read
the `env` context, so the two files cannot share a constant. A test pins
them equal instead, because a rename in one file alone silently unlocks
the race again with nothing failing.
```

<a id="af-041"></a>

### 41. review-address — SECURITY: checkout trusted base code first. The PR branch is checked out later in…

In `review-address`.

```text
SECURITY: checkout trusted base code first. The PR branch is checked
out later in "Prepare branch and feedback" after the trusted CLI
bundle (built once from this base in build-cli) is in place. Without
this pin, pull_request_review events would check out the PR merge ref
by default, letting PR-controlled code influence the secret-bearing
address run. The ref is pinned to the SHA build-cli compiled — not
the live default branch — so a mid-run base push can never leave a
leg running a bundle built from DIFFERENT sources than its checkout.
The SHA is validated fail-loud FIRST: actions/checkout resolves an
empty ref to the event default — on pull_request_review triggers the
PR merge ref — so a broken build-cli output must fail this leg
instead of silently unpinning it.
```

<a id="af-042"></a>

### 42. review-address · Prepare branch and feedback — Live-watermark revalidation: two near-simultaneous triggers for the SAME PR can both…

In `review-address` · `Prepare branch and feedback`.

```text
Live-watermark revalidation: two near-simultaneous triggers for the
SAME PR can both pass their (per-target, route-level) gates and both
scan before either has emitted a matrix job, so both emit this PR
with the same stale watermark. The per-PR address concurrency group
QUEUES the duplicate rather than discarding it — but that queueing
is exactly what makes this check sound: address jobs for one PR run
strictly one at a time, so by the time the duplicate runs here, the
first job's eval marker is posted and visible. Three duplicate
signatures: (a) a sibling evaluated through a NEWER live ts than
our matrix watermark; (b) a conflict-only sibling resolved and
marked at the SAME ts — with no newer feedback its marker keeps
ts=watermark while its ROUND advances past ours (ours is the max
round observed at scan time); (c) a no-op sibling judged THIS exact
head (its redcheck marker matches CHECKED_OUT_HEAD) while keeping
BOTH ts and round unchanged — neither (a) nor (b) fires, but
re-running would post a duplicate report for the same head. Either
way, if there is no live conflict left and nothing newer than the
live watermark, this run is a stale duplicate and discards itself.
```

<a id="af-043"></a>

### 43. review-address · Prepare branch and feedback — Growth brake: measure the PR's net size (insertions minus deletions vs the merge base),…

In `review-address` · `Prepare branch and feedback`.

```text
Growth brake: measure the PR's net size (insertions minus
deletions vs the merge base), split into test lines and source
lines, and compare against the sizes recorded when this counting
window opened. The baseline rides in the window's first pushed or
no-op report comment as its OWN marker (the autofix-redcheck
pattern — the positional autofix-eval parsers never change), so a
/retry or takeover re-engage re-anchors it with the window.
First-wins on read: a duplicate marker in one window cannot move
an anchored baseline. A handoff round writes no baseline; nothing
was pushed, so the next round re-measures the same size.
Growth-triggered Critical-only reuses the round brake's entire
deferral machinery below; the human batch budget stays
round-scoped, so maintainer feedback flows exactly as today.
Leading zeros are rejected, not just non-digits: bash [[ -gt ]]
reads a zero-padded operand as OCTAL, so '0400' would compare as
256 (the brake fires early) and '0900' raises "value too great
for base" inside [[ ]], which under an if-condition silently
evaluates false — the brake never engages. Both violate the
documented fallback promise, so pad-shaped values fall back too.
```

<a id="af-044"></a>

### 44. review-address · Prepare branch and feedback — An orphan-history branch (fork takeover / adoption admits one — nothing on this job's…

In `review-address` · `Prepare branch and feedback`.

```text
An orphan-history branch (fork takeover / adoption admits one —
nothing on this job's fetch requires a common ancestor) has no
merge base: the three-dot diff exits 128. Fail OPEN to zero like
the merge-tree conflict probe above — an unmeasurable PR skips
the brake rather than dying red at measurement every round.
A managed fork PR whose head branch is literally named 'main'
makes prepare's fork update-ref re-point refs/remotes/origin/main
at the fork head — the measurement would compare the branch
against itself (0/0 forever). Unmeasurable: skip the brake
(fail open), like the no-merge-base case.
Unmeasurable is a STATE, not a zero: substituting 0 nets would
anchor a bogus 0/0 baseline (or, against an existing anchor,
manufacture phantom growth). NET_MEASURED gates the whole brake:
no anchor, no marker, no engagement.
```

<a id="af-045"></a>

### 45. review-address · Prepare branch and feedback — The marker's window field is spelled `key=`, NOT `win=`: this marker can legitimately…

In `review-address` · `Prepare branch and feedback`.

```text
The marker's window field is spelled `key=`, NOT `win=`: this
marker can legitimately carry a different window key than its
comment's autofix-eval marker (a supersede-exempt conflict round
reporting after a re-arm). The window censuses attribute
positionally (last-wins) over their own scan-parsed eval
markers, and the distinct token stays as defense in depth for
any future substring consumer.
A stale-base auto-update merges current main into the branch,
moving the merge base the nets are measured against: overlap
resolutions then shift the measurement with no agent push. An
anchor recorded before the latest base update is not comparable
any more — ignore it, so the next round re-anchors at the
post-update size. (A conflict round's own merge of main is the
narrower residual; its delta is bounded by the overlap.)
```

<a id="af-048"></a>

### 48. review-address · Prepare branch and feedback — Which trusted humans have exhausted their per-window regular feedback budget (see…

In `review-address` · `Prepare branch and feedback`.

```text
Which trusted humans have exhausted their per-window regular
feedback budget (see CRITICAL_ONLY_HUMAN_BATCHES). A batch is
COUNTED only when a Critical-only round actually consumed it:
feedback items are bucketed into the (prev marker ts, marker ts]
span that evaluated them, spans are kept only for markers that
ran in Critical-only territory (acted rounds numbered past the
threshold, no-change rounds at it), and an author needs >= K
distinct consumed spans to land here. Fresh, not-yet-evaluated
feedback never counts against its own author, and everything is
window-scoped so a /retry resets the budget with the window.
Only feedback the deferred renderer below would actually defer is
counted: Critical-tagged items, Request changes / APPROVED reviews,
and inline comments rooted at a Critical comment or attached to a
Request changes review are never deferrable, so they must not burn
an author's budget — the item filter mirrors those predicates.
```

<a id="af-049"></a>

### 49. review-address · Prepare branch and feedback — Time-budget exhaustions SINCE THE LAST SUCCESSFUL ROUND mean the standard…

In `review-address` · `Prepare branch and feedback`.

```text
Time-budget exhaustions SINCE THE LAST SUCCESSFUL ROUND mean
the standard address-everything prompt is not converging at
this budget: re-running it unchanged just walks into the same
wall (#7929 burned three 50-minute timeouts that way, #7846
two — each a full agent run with nothing pushed). From the
second attempt on, tell the agent to narrow. Counted since
the last pushed/no-change round, NOT cumulatively: a push
falsifies "not converging" and resets the count, so a recovered
PR stops seeing the warning; until a round pushes or no-ops it
fires on every failing round (gate rejections included) —
correctly, since nothing has converged yet. (The
BREAKER in the report step stays cumulative — a push does not
make the next timeout cheaper in budget terms.) Window-scoped
like every other census (LIVE_REARM_KEY is the live window),
so a re-arm clears it. The needle matches the emitted
headline verbatim: first lines can embed provider error text
(API_ERROR_DETAIL), so a loose phrase could count a model
error message as a timeout.
```

<a id="af-050"></a>

### 50. review-address · Triage and address — Bound the agent below the job timeout so a runaway agent fails THIS step (not the whole…

In `review-address` · `Triage and address`.

```text
Bound the agent below the job timeout so a runaway agent fails THIS
step (not the whole job), leaving the always() verify and report
steps time to run and post a handoff. A job-level timeout would
cancel those steps too and leave the loop silent.

This step timeout is the BACKSTOP for a runaway that ignores the
agent's own timer; QWEN_TIMEOUT_MS below is the real budget.
Invariant: budget <= backstop - margin, where the margin covers
the internal kill path (SIGTERM, 10s grace, SIGKILL, marker write).

Measured on run 30646547838:

  setup (12 steps, ends at 'Post autofix status comment')  5-7m
  Triage and address   #8005 round 9  50m03s (its own timer)
                       #8211          12m45s
  Verification gate    #8211          22m48s
  push + report + finalize                     3-4s

Setup runs in EARLIER steps, so it never competes with the agent
for this cap. Worst-case budget:

  setup                    7
  Triage and address     130  (120 budget + 10 margin)
  Verification gate       60  (2.6x the measured 22m48s)
  Repair                  20
  Repair verification     60
  report                   3
  -------------------------------
  worst case             280  => job timeout 300, and the job runs
                                 on ubuntu-latest, whose own ceiling
                                 is 360.
```

<a id="af-051"></a>

### 51. review-address · Triage and address — Clamp the override to the budget ceiling: a repo variable past 7,200,000 ms (120m) would…

In `review-address` · `Triage and address`.

```text
Clamp the override to the budget ceiling: a repo variable past
7,200,000 ms (120m) would arm the timer past the 130-minute step
backstop, the cap would fire first, and the round would be
misreported as a crash. Malformed values fall back to the same
ceiling (run-agent.mjs's own || handles the empty/NaN case).
The {1,8} width bound keeps 10# inside int64: a 19+ digit value
wraps negative in (( )) and slips past the comparison unclamped.
10# forces base-10: a zero-padded value is octal in (( )) and would
error past the guard the same way.
A FLOOR, not just a ceiling — and the floor guards the likelier
mistake. Every comment here, the PR body and the operator message
all speak in MINUTES; this one variable wants MILLISECONDS. A
maintainer told to "raise the agent time budget" who sets
QWEN_AUTOFIX_TIMEOUT_MS=120 arms a 120 ms timer: every round
SIGTERMs instantly, writes agent-timeout, and reports "ran out of
time (timeout (120ms))" until TIMEOUT_WINDOW_CAP trips and AutoFix
stops on the PR — advising the human to raise the budget they just
raised, with no ::warning:: anywhere in that loop. 60000 rejects
every minutes-shaped value (1..999) and every 0/000, which the
bare regex admitted while the message claimed positivity.
Hand-maintained sibling of the triage-budget sanitize step in
qwen-triage.yml's authorize job; the failure modes deliberately
differ (this one clamps garbage to the ceiling, that one falls
back to the default), so a boundary-bug fix in one must be
re-derived in the other.
```

<a id="af-052"></a>

### 52. review-address · Push and report — Resolve the review threads whose findings the agent actually IMPLEMENTED, so a human…

In `review-address` · `Push and report`.

```text
Resolve the review threads whose findings the agent actually
IMPLEMENTED, so a human re-reviewing sees only what is still open
instead of re-reading every thread to work out what was handled.
The agent cannot do this itself - its sandbox carries no token -
so it records the inline-comment ids it implemented and this step,
which already holds the PAT, maps each to its thread. Findings it
DECLINED or deferred are deliberately left open. Best-effort
throughout: a resolve failure must never fail a good push.
Both this resolve block and the reply block below map an
inline-comment id to its review thread, so the threads are
fetched once here and shared. Hoisted above both so a round that
only replies (no resolved-comments.txt) still has them.
Paginated, because GitHub returns reviewThreads in ASCENDING
creation order: a single first-100 page is the OLDEST hundred,
which on a long-running PR is precisely not the threads this
round is answering. Measured on #8403 (1256 threads): one page
reached 8% of them, so an implemented Critical past it stayed
open and read as unaddressed, and a decline past it was answered
by silence — the two outcomes this function exists to prevent.
A partial fetch is USED, not discarded: losing twelve good pages
to a rate limit on the thirteenth would resolve nothing at all,
so the failure is announced and the threads in hand still map.
Residual: a thread with more than 100 comments still truncates,
so a comment past that page is unmapped and each block falls
back to the id as given; announced below, and unobserved so far.
Do NOT close that residual by adding endCursor to the inner
comments pageInfo: gh's paginator adopts the FIRST pageInfo
carrying both hasNextPage and endCursor, so the inner one would
hijack the thread-page cursor and stop after page one (exit 0, no
warning) — silently restoring the oldest-hundred bug this fetch
exists to fix. The outer cursor wins only because the inner
pageInfo asks for hasNextPage alone. The outer field ORDER is
load-bearing for the same reason: the scanner carries its flags
across pageInfo objects and breaks at the first one yielding
both, so alphabetizing to pageInfo{endCursor hasNextPage} makes
it break on the outer endCursor while hasNextPage still carries
the last INNER page's value (almost always false — thread comment
pages rarely truncate, and the outer page's own hasNextPage is
read only after the break) — gh then returns no cursor and the
walk silently stops after page one.
```

<a id="af-053"></a>

### 53. review-address · Push and report — gh's stderr goes to a fresh mktemp regular file, never a named WORKDIR path: WORKDIR is…

In `review-address` · `Push and report`.

```text
gh's stderr goes to a fresh mktemp regular file, never a named
WORKDIR path: WORKDIR is bind-mounted read-write into the agent
sandbox, so branch code from the round that just ran can plant
anything it likes at a predictable name here. A planted FIFO
blocks bash's O_WRONLY open before gh even execs, and the only
reader is the tail below gh — so the step would hang to the job
timeout AFTER the push landed, losing the report and the round
markers and breaking this block's own invariant that a resolve
failure must never fail a good push. A planted symlink would
instead truncate its target and fold 300 bytes of it into a
public ::warning::. Same reasoning, same shape as the `gh api
user` checks elsewhere in this file.
```

<a id="af-054"></a>

### 54. review-address · Push and report — gh emits one node per line across every page; slurp them into the flat array both blocks…

In `review-address` · `Push and report`.

```text
gh emits one node per line across every page; slurp them
into the flat array both blocks below already expect. The
stream is consumed inline into a shell variable and never
lands in a WORKDIR json file, so it takes no part in the
slurp normalizer the paginated WORKDIR fetches share.
Keep only thread-shaped documents: on a failing page gh skips
--jq and appends that page's raw response body (a rate-limit
message, or a GraphQL error envelope) to stdout after the good
nodes. Slurped unfiltered it becomes a stray element, and the
consumers below iterate .comments.nodes[] over it and exit 5 —
which under errexit aborts this step AFTER a good push, losing
the report and the markers. Both invariants above forbid that:
a resolve failure must never fail a good push, and a partial
fetch is used rather than discarded.
```

<a id="af-055"></a>

### 55. review-address · Push and report — Deferred-findings persistence, shared by both arms below.

In `review-address` · `Push and report`.

```text
Deferred-findings persistence, shared by both arms below.

No agent-writable path takes part in this. The script CONTENT
travels in expression context — captured at stage time from the
trusted checkout — so there is no staged copy to verify, and with
it go the digest gate, its check-then-use window, and the
planted-FIFO/huge-file reads that a path-based read invites. The
child's own messages travel on fd 3, which the parent captures,
while fd 1/2 are discarded; every loader side channel (auxv dumps,
ldd traces, whatever is next) writes there and cannot reach the
parsed output, and there is no log file to plant, race or bound.

/usr/bin/env is invoked by ABSOLUTE PATH: bash never does
function/alias lookup on a slash-bearing word, so a planted
BASH_FUNC_env%% cannot intercept the bootstrap. `-i` then drops
every BASH_FUNC_* import, BASH_ENV, SHELLOPTS, alias and trap.
LD_* is the one family env -i cannot block (ld.so acts while
loading env itself), so the ones that MATTER are cleared by
command-prefix assignment and the rest are caught by verifying the
RESULT: the child prints a liveness sentinel first, and its
absence — trace mode, exec failure, a missing interpreter — is
reported rather than passing silently for a successful round.
```

<a id="af-056"></a>

### 56. review-address · Push and report — Take this PAT-bearing step off every mutable host git surface — both the shared config…

In `review-address` · `Push and report`.

```text
Take this PAT-bearing step off every mutable host git surface —
both the shared config FILES and git's ENV channels — keep this
block byte-identical to its twin in 'Publish PR' (the contract
test pins them equal). File scopes: the pool shares one HOME
across ~27 runner registrations and review-address fans out
max-parallel, so a concurrent job can rewrite ~/.gitconfig inside
this step's sweep->push window (a URL-scoped sslVerify=false there
overrides the -c pin below over real TLS); redirect global/system
to a per-run throwaway (as the gates do) so the push reads neither.
Env channels: branch code in an earlier step of THIS job can inject
env through $GITHUB_ENV, and several channels OUTRANK file config or
bypass it entirely — pin PATH to the staged trusted value and drop
LD_PRELOAD/LD_AUDIT/LD_LIBRARY_PATH first (else a swapped
git/sha256sum/bash defeats the digest gate below), then strip
GIT_CONFIG_COUNT/_PARAMETERS (command-line-precedence config),
GIT_ALLOW_PROTOCOL (env twin of protocol.allow — arms ext::),
GIT_SSL_NO_VERIFY/GIT_SSL_CAINFO (override the sslVerify pin over
real TLS), GIT_PROXY_COMMAND, GIT_EXEC_PATH (transport-helper
binary), GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR/GIT_OBJECT_DIRECTORY/
GIT_ALTERNATE_OBJECT_DIRECTORIES/GIT_SHALLOW_FILE (repoint the repo
git reads and pushes), GIT_ASKPASS/GIT_SSH/GIT_SSH_COMMAND
(credential/exec hijack). The throwaway global uses an
unpredictable mktemp path so a same-user watcher cannot re-plant
http.proxy/sslCAInfo into a fixed literal after the seed. All
probe-verified in the #8961 review.
```

<a id="af-057"></a>

### 57. review-address · Push and report — Authenticate push/fetch with a one-shot, host-scoped credential helper via a git_auth…

In `review-address` · `Push and report`.

```text
Authenticate push/fetch with a one-shot, host-scoped credential
helper via a git_auth wrapper (see Publish PR) — nothing lands
in .git/config, argv holds only the ${GITHUB_TOKEN} reference,
the leading empty credential.helper resets the inherited
helper list so a planted helper never answers first, and
http.sslVerify pins the transport against a planted
sslVerify=false + proxy interceptor.
fetch.recurseSubmodules=false + protocol.ext.allow=never: the
salvage fetch must not walk a branch-planted submodule whose
.git/modules config was rewritten to an ext:: URL (resanitize
sweeps neither the kept fetch.* allowlist entry nor .git/modules)
and execute it with the PAT in env.
```

<a id="af-058"></a>

### 58. review-address · Push and report — Salvage a race-lost push instead of discarding the run. The per-PR head-write…

In `review-address` · `Push and report`.

```text
Salvage a race-lost push instead of discarding the run. The
per-PR head-write concurrency group serialises THIS repo's
workflows, but it cannot stop the PR author (or anything on the
fork side) pushing during the agent's ~120-minute window. The
stated budget widened it from ~50m, so a race-lost push is that
much likelier and the retry loop below stays bounded at 3 merges.
Observed twice in one day (#7983, #7985): a one-shot push died
`fetch first` and a full verified agent run was thrown away.
On rejection, fetch the moved head and MERGE it into the local
line (merge, not rebase: the agent's own conflict-resolution
rounds create merge commits, and a rebase would flatten them
and can silently re-introduce the conflicts it resolved). The
merge result descends from the remote head, so the retried push
is a fast-forward. A genuine content conflict aborts and falls
through to the existing failure path — same as today.
```

<a id="af-059"></a>

### 59. review-address · Push and report — Takeover milestone digest — roughly every 10 rounds. The takeover cap (100) bounds…

In `review-address` · `Push and report`.

```text
Takeover milestone digest — roughly every 10 rounds. The takeover
cap (100) bounds runaway but says nothing about when a human
should step in: #7469 ground to round 12 over 7 days with the
only "this is burning budget" signal buried in Actions logs.
Once 10+ rounds accumulate since the last digest, surface a
window-scoped census on the PR so the maintainer who engaged it
can decide: keep going, split the PR, or release. A SEPARATE
comment with its OWN marker and WITHOUT the autofix-eval marker:
every census (round, consec, watermark) selects on autofix-eval,
so this comment is invisible to all of them, and the feedback
filters drop bot comments, so the agent never sees it either.
Best-effort: a digest failure must never fail a good push.
```

<a id="af-060"></a>

### 60. review-address · Report dry-run / failure — NOTE: the deferred-findings upsert below runs its PAT identity check and the script…

In `review-address` · `Report dry-run / failure`.

```text
NOTE: the deferred-findings upsert below runs its PAT identity
check and the script itself in a sound /usr/bin/env -i child (see
the block near the end of this step) — the script arrives as
content from expression context, so there is no staged copy and
no digest gate. This step body needs no in-shell hardening
preamble for it.
The handoff `gh pr comment` here is pre-existing surface at the
workflow's baseline posture; hardening every pre-existing PAT gh
call against BASH_FUNC/transport plants (via the same clean-child
pattern) is tracked separately, out of this feature's scope.
The head the agent actually evaluated — captured in prepare before
any mutation, not the report-time remote head (which can move
during the run). Empty when prepare exited early, which matches
no marker and keeps reds visible — fail-open.
```

<a id="af-061"></a>

### 61. review-address · Report dry-run / failure — Leave a visible handoff + eval marker when the address did NOT publish a result — a…

In `review-address` · `Report dry-run / failure`.

```text
Leave a visible handoff + eval marker when the address did NOT publish a
result — a verify failure, or an agent/infra crash or timeout before the
verify gate ran. Without it the loop goes SILENT (no comment, no marker)
and the next scan re-targets the same feedback forever.

SUPPRESS entirely once "Push and report" already handled this run
(OUTCOME fixed or noop). That step is also always()-gated and runs even
if a LATER always() step (e.g. artifact upload) fails the job; without
this guard, such a late failure would flip JOB_STATUS to failure and
post a contradictory acted=false handoff on top of the published fix.
(A genuine push failure leaves OUTCOME=fixed but writes no marker, so
the next scan simply retries — it does not need a handoff here.)

SUPPRESS likewise for a stale-discarded run: it did no work, so a
late always()-step failure (e.g. artifact upload) must not turn a
deliberate no-comment/no-marker discard into a handoff that
consumes a round.
```

<a id="af-062"></a>

### 62. review-address · Report dry-run / failure — First line only, markup neutralized (agent stdout can echo external PR-comment text and…

In `review-address` · `Report dry-run / failure`.

```text
First line only, markup neutralized (agent stdout can echo
external PR-comment text and the marker regex spans '<!-- ... -->'
happily), and capped so a long span can't bloat the headline.
The tag substitutions are not just the comment opener: this
value flows into CAUSE_ZH -> HEADLINE_ZH, which renders INSIDE
the 中文说明 <details> wrapper — a bare `</details` in the
first 200 bytes would close that wrapper early and spill the
zh excerpt outside it.
`cut -c` counts BYTES, so the cap can split a multi-byte
character - and the classifier deliberately matches CJK renders,
so a >200-byte Chinese error is a supported input, not a
hypothetical. iconv -c drops the dangling bytes so the headline
stays valid UTF-8; it EXITS 1 when it discards one, which under
this step's `set -eo pipefail` would abort before the marker and
the gh pr comment - hence the `|| true`, same as the sibling
publish site below.
```

<a id="af-063"></a>

### 63. review-address · Report dry-run / failure — If feedback was actually read (prepare ran), stamp its newest ts so the watermark…

In `review-address` · `Report dry-run / failure`.

```text
If feedback was actually read (prepare ran), stamp its newest ts so
the watermark advances and the same feedback is not re-selected next
scan. If the crash happened before prepare, NEWEST is empty and the
watermark cannot advance — mark the round terminal (MAX_ROUNDS) so the
scan's max-round guard skips this PR instead of re-handing-off every
tick, without pretending the unread feedback was evaluated. The final
sentinel guards a cascading API failure that left WATERMARK empty too:
an empty ts= would not match the scan's `ts=([^ ]+)` regex, so the
terminal marker would be ignored and the PR re-handed-off. A far-future
ISO-8601 date is used (not a bare word) so it is both non-empty AND
sorts above any real timestamp in EVAL_WM's max, belt-and-suspenders
with the terminal round.
The gate declares its verdict explicitly (failed / noop / fixed).
An EMPTY outcome on a non-success job means it died BEFORE reaching
one - its own crash (a gate bug, an infra blip, a resolver error),
not a judgement on the agent's work. That must retry like any other
pre-verdict crash instead of advancing the watermark: the
nested-package ENOENT that stranded #7329/#7336 looked exactly like
a rejection, so a fix the agent had already written was discarded
and the PR sat idle until a human deleted the marker by hand.
```

<a id="af-064"></a>

### 64. review-address · Report dry-run / failure — Prepare ran (NEWEST is set) but no verdict was reached. Ways that happens, and in ALL of…

In `review-address` · `Report dry-run / failure`.

```text
Prepare ran (NEWEST is set) but no verdict was reached. Ways
that happens, and in ALL of them the agent evaluated NOTHING:
it produced no output at all (crashed before any verdict — a
staged runner that fails to boot), it died on a model
[API Error] (access/quota/5xx/transport), it TIMED OUT before
finishing, or the gate crashed after the agent wrote its
summary. So the watermark
must NOT advance past this feedback: an advance makes the next
scan see "nothing new" and never retry, stranding the PR on a
transient failure (an infra blip, a quota reset minutes away, a
model-access grant, a base-image bug fixed minutes later).
Stamp the sentinel ts (excluded from EVAL_WM) so the feedback
stays live and the next scan retries; the incremented round
still bounds retries before a terminal handoff, so a PERSISTENT
failure cannot loop forever.
```

<a id="af-065"></a>

### 65. review-address · Report dry-run / failure — The gate ran and rejected the agent's fix (a build/test failure). Before handing to a…

In `review-address` · `Report dry-run / failure`.

```text
The gate ran and rejected the agent's fix (a build/test
failure). Before handing to a human, check whether the PR is
merely BEHIND main: a build that fails on something main
already changed — e.g. #7471's update-notifier, removed by
#7515, left its import unresolved on a stale branch — is a
stale-base failure, NOT the fix. If behind, merge main in and
retry: the next round builds against current main. After the
update the PR is current, so a genuine fix-failure next round
is no longer "behind" and falls through to the handoff below —
which self-limits this to ONE base-update. update-branch is a
CAS on the checked-out head; any API failure is fail-safe (fall
through to the handoff). This is the agent-gate sibling of the
scan's stale-base auto-update, which only sees PR status
checks, never the gate's own build.
```

<a id="af-066"></a>

### 66. review-address · Report dry-run / failure — Say what actually happens next. The old "A human should take over this PR" read as a…

In `review-address` · `Report dry-run / failure`.

```text
Say what actually happens next. The old "A human should
take over this PR" read as a full release, but the loop
is NOT done with the PR: this feedback's watermark
advances (no automatic retry of THIS item), while
management continues for new feedback and base conflicts
— #7929 posted the old wording and then kept pushing
rounds, which read as a contradiction.
Name the gate ONLY when it actually ran: this branch is
reached for every outcome=failed verdict, but reject_fix
is the sole writer of gate-rejection.md — the failure.md /
dirty-tree / unchanged-branch / missing-summary paths made
no gate decision, so a blanket clause would repeat the very
wording-doesn't-match-behaviour bug this PR fixes.
```

<a id="af-067"></a>

### 67. review-address · Report dry-run / failure — Pre-existing failures get the honest clause: the rejection is not the agent's and the…

In `review-address` · `Report dry-run / failure`.

```text
Pre-existing failures get the honest clause: the rejection
is not the agent's and the repair was deliberately skipped.
The remedy depends on WHY it pre-exists, and this branch
only renders when the stale-base auto-update above did NOT
fire — which includes a branch current with main whose own
pre-round commits carry the failure, where "merge main"
changes nothing. CMP_R is assigned only when BOTH gh api
calls above succeed (each swallows failure into ''), so
an EMPTY CMP_R means the compare never ran — "measured
not-behind" and "never measured" get separate clauses:
the latter cannot assert the branch's own code is at
fault.
```

<a id="af-068"></a>

### 68. review-address · Report dry-run / failure — NEWEST is empty because Prepare never RAN TO A VERDICT — an earlier step failed or the…

In `review-address` · `Report dry-run / failure`.

```text
NEWEST is empty because Prepare never RAN TO A VERDICT — an
earlier step failed or the job stopped before the agent started:
installing/building the trusted base, node setup. That
is infra or a broken base, NOT the agent, and it is usually
transient (a base build fixed minutes later, an ENOSPC runner).
Match on "not a real Prepare run" rather than 'skipped' alone, so
this also covers a CANCELLED job (outcome 'cancelled') and a job
that stopped before Prepare even entered the step context
(outcome ''): a concurrency/manual cancel is not the agent's
fault either, and 'cancelled' is a DISTINCT value from 'skipped'
— matching only 'skipped' would send a cancel to the terminal
branch below. Terminal here is wrong: a web-shell TS break on
main failed the base build across a whole scan batch and stranded
SIX healthy PRs terminally, including ones at round 11. Retry
instead — sentinel ts keeps the feedback live — but still
increment the round so a PERSISTENTLY broken base is bounded and
cannot loop forever.
```

<a id="af-069"></a>

### 69. review-address · Report dry-run / failure — Consecutive-failure circuit breaker, distinct from the round cap.

In `review-address` · `Report dry-run / failure`.

```text
Consecutive-failure circuit breaker, distinct from the round cap.
Reaching this step at all means this round did NOT push (the push
and no-op paths report from "Push and report"), so this round is a
failure. Count how many failures precede it WITHOUT a break: walk
the bot's prior eval markers in API order (oldest-first, pinned
by sort_by so a stray reorder cannot corrupt the streak) and
reset the streak at each push ("Addressed the latest review
feedback"), deliberate no-op ("no changes needed"), or pre-agent
infra-failure marker ("AutoFix could not start"). After the
full walk, CONSEC_FAIL holds failures since the last progress
point plus one for this round. If the unbroken
streak (this round included) reaches the cap, stop retrying even
under takeover: a PR that fails this many times running is stuck
on something a re-run at the same budget will not fix (observed on
#6723: 7 straight failures, 3 timeouts + 4 gate rejections). Only
overrides a would-be RETRY — a round already terminal for another
reason keeps its own headline.
Transient model errors (429/5xx) are exempt: the CAUSE_MAX logic
above deliberately gives them the full round budget because they
self-heal once the provider recovers. Letting the breaker override
that would mark every in-flight PR terminal at once during a
provider outage — the failures are not the PR's fault and DO
self-heal. Auth errors are NOT exempt (they never self-heal).
Pre-agent infra failures (skipped/cancelled/empty Prepare outcome)
are exempt for the same reason: a broken base build or a runner
crash is not the PR's fault, self-heals, and hits the whole scan
batch at once — the exact scenario the retry path above exists to
prevent. The round cap + sentinel-ts /retry recovery already
bounds a persistently broken base. A stale-base retry (the gate
rejected the fix but the PR was behind main, so the base was just
updated) is exempt for the same reason — it is not the PR's fault
and self-limits to one round (after the update the PR is current).
```

<a id="af-070"></a>

### 70. review-address · Report dry-run / failure — -c drops any partial multi-byte sequence a byte-level head -c may have split, so the…

In `review-address` · `Report dry-run / failure`.

```text
-c drops any partial multi-byte sequence a byte-level head -c may
have split, so the comment body stays valid UTF-8. iconv -c still
EXITS 1 when it discards a byte, which under this shell's
`set -eo pipefail` would abort the step and skip the marker + gh
pr comment below — the exact silent stall this block prevents — so
`|| true` keeps the (already-emitted) cleaned text and continues.
The tag substitutions beyond `<!--` matter on the
address-summary/no-action shapes: SKILL mandates those files
END with their own collapsed <details> 中文说明 block, so a
mid-size summary whose mandated tail straddles the 1500-byte
cut leaves a live severed <details> opener that swallows the
中文说明 wrapper this step appends below.
```

<a id="af-071"></a>

### 71. review-address · Report dry-run / failure — Bilingual companion. Repo convention is English first, Chinese in a collapsed <details>.…

In `review-address` · `Report dry-run / failure`.

```text
Bilingual companion. Repo convention is English first, Chinese
in a collapsed <details>. failure.md itself stays English-only
— a byte-truncated excerpt of it is embedded above, and a
severed agent-written <details> there would swallow the rest of
the comment. So the Chinese lives in a SEPARATE agent-written
file, failure.zh.md, and the workflow wraps it in its OWN
<details> below: the wrapper tags are emitted HERE and the
closing </details> unconditionally, so a truncated translation
can lose content but can never swallow the markers that follow.
A missing failure.zh.md (run-agent.mjs wrote failure.md itself,
or the agent skipped it) degrades to the headline translation
alone — never fail the round over a missing translation.
```

<a id="af-072"></a>

### 72. review-address · Report dry-run / failure — Flip the status comment out of "working" so a finished round never leaves a live-looking…

In `review-address` · `Report dry-run / failure`.

```text
Flip the status comment out of "working" so a finished round never
leaves a live-looking line behind. PATCH-only on purpose: a round that
never posted a status (stale duplicate, dry run) must not gain one here.
The verdict stays in the round report this job already posts; this only
records that the round ended, and keeps the run link reachable.
Gated on 'stale' for the same reason the announcement is: the per-PR
concurrency group serialises duplicate address jobs, so the discarded
one runs AFTER the real round already finalised. Ungated, it would
overwrite that round's "finished" with its own "ended without
publishing" and report a successful round as a failed one. An empty
'stale' (prepare itself crashed) still finalises — that IS this job's
round, and it is exactly the case that must not stay "working".
```
