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

That gate is a ceiling, and a ceiling only objects once a file is nearly at the
wall — so growth accumulates unremarked until one unlucky PR has to pay for
everyone. This file regained 78 KB in that migration and gave 25 KB of it back
in a single feature commit two days later, with nothing raising a hand. The
same script therefore also enforces a **ratchet**: every workflow's recorded
size lives in `.size-baseline`, and exceeding it by more than the allowance
fails until the number is updated in the same PR. Growing a file is still
allowed — the ratchet only insists the growth be visible in review rather than
discovered at the wall.

The ratchet's blast radius is scoped to the PR that earned it (#9904). The
comparison above is worktree-vs-checked-in-baseline, so a file that grew on
main without the same-PR bump would otherwise fail every unrelated open PR on
a file it never touched — that red-walled the queue twice in two weeks
(#9747, #9822). Given the PR's base commit (`WORKFLOW_SIZE_BASE_SHA`, wired
in `ci.yml`), the gate hard-fails only when the PR's copy of the file differs
from the base; a byte-identical copy means the staleness is main-side drift
and earns a warning pointing at the one-line baseline-bump PR instead. An
unresolvable base keeps the strict failure — the gate fails closed.

### Steps that moved out, not just their prose

`review-address` · `Push and report` was 626 lines of inline shell — ~41 KB,
the third-largest `run:` body in the file after
`Scan for PRs with new feedback` and `Prepare branch and feedback` — and its
body now lives in `.github/scripts/autofix-push-and-report.sh`. The YAML keeps
the step's `if:` and `env:`: when it runs, and what reaches it.

**The file is never executed from disk.** The stage step reads it from the
trusted-base checkout, before any branch code has run, and passes the text
through step output; the step runs those bytes. That is the delivery the inline
block already had — the workflow file's own bytes, chosen by GitHub, not by
anything on the runner — and the one `upsert-deferred-issue.sh` uses.

This matters because `Push and report` holds the PAT and runs _after_ the agent
and the verification gate have executed branch code on this host. A copy staged
under `${RUNNER_TEMP}` would be theirs to swap, which is why the staged scripts
that do live on disk (`resanitize-git-config.sh`, the gate runner) each carry a
digest the invoking step re-checks. Content delivery removes the object those
digests exist to protect: nothing to stage, nothing to digest, nothing to type
check, no second open, and no check→use window between the steps. The
qualifier that makes it hold is that a step output is fixed when its step ends
— later steps read the recorded value, so a disk write after staging cannot
change what arrives here. It is not a claim that the value is unreachable
while the stage step is still running.

`docs/design/autofix-gate-runner-isolation.md` finishes the job: once this step
is its own `publish` job, checking out the trusted base and never executing
branch code, the script can simply be run from the checkout.

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
- [73. review-address · Report dry-run / failure — Idle (silent-sandbox) timeouts are EXCLUDED from the cumulative timeout cap.…](#af-073)
- [74. run — Per-author tail budget inside Critical-only mode. An account is an…](#af-074)
- [75. run — Growth audit: a budget breach engages Critical-only AND makes the round a…](#af-075)
- [76. run — Failed-check annotation patterns that mean the INFRASTRUCTURE died, not the code…](#af-076)
- [77. run — Upper bound on review targets emitted per scan (fan-out defense-in-depth; excess…](#af-077)
- [78. run — Upper bound on candidates INSPECTED per scan: idle candidates consume serial API…](#af-078)
- [79. run — Commit-status context stamped PENDING on a PR head when a scan dispatches a…](#af-079)
- [80. run — Consecutive-failure sub-cap, distinct from the total round cap (TAKEOVER_MAX_ROUNDS,…](#af-080)
- [81. run — Cumulative agent-timeout sub-cap, the sibling of the consecutive cap for the…](#af-081)
- [82. route · Decide phases — Real-time review triggers: process the SAME managed set the scheduled scan does,…](#af-082)
- [83. route · Decide phases — Comment-command sugar over the labels: TAKEOVER_COMMAND applies TAKEOVER_LABEL,…](#af-083)
- [84. route · Decide phases — The bot only applies this label from takeover-command, which posts the engage…](#af-084)
- [85. issue-autofix · Sanitize workspace git config — Rather than denylist each exec-vector family (which kept missing new ones), KEEP…](#af-085)
- [86. issue-autofix · Stage trusted schema gate — The staged copy's trusted-base provenance holds at cp time only: RUNNER_TEMP is…](#af-086)
- [87. issue-autofix · Verification gate — Settings-schema freshness gate, shared with the triage-and-address verify step…](#af-087)
- [88. issue-autofix · Withdraw claim on failure — Same hygiene as the PR-lane DETAIL_FILE excerpt: -c drops a partial multi-byte…](#af-088)
- [89. takeover-command · Toggle takeover label — Ack HERE, not via the pull_request:labeled round-trip: that event has been…](#af-089)
- [90. takeover-command · Toggle takeover label — Release ack, direct from the command — the exact mirror of the engage side…](#af-090)
- [91. retry-command · Post re-arm marker — Management resumed — the escalation label is stale. 404 is the common case (the…](#af-091)
- [92. takeover-ack · Acknowledge takeover state change — R2-4 mirror for the engaged direction: a delayed engaged ack — a red run re-run…](#af-092)
- [93. takeover-ack · Acknowledge takeover state change — The escalation label goes stale on a real engage or any release (a human is…](#af-093)
- [94. review-scan · Scan for PRs with new feedback — Every lane that reaches this scan is supposed to hold the PAT: route now…](#af-094)
- [95. review-scan · Scan for PRs with new feedback — Candidate PRs: open, same-repo, targeting main, and either authored by the…](#af-095)
- [96. review-scan · Scan for PRs with new feedback — Same admission as the scheduled scan below. In-repo PRs fail CLOSED on a missing…](#af-096)
- [97. review-scan · Scan for PRs with new feedback — Skip-labeled PRs are excluded HERE, not only at the address gate: that gate…](#af-097)
- [98. review-scan · Scan for PRs with new feedback — Dispatch-pending marker: a scan that dispatched this PR within…](#af-098)
- [99. review-scan · Scan for PRs with new feedback — Delay-window fallback: a review run parked BEFORE its job starts (the 10-minute…](#af-099)
- [100. review-scan · Scan for PRs with new feedback — Auto-rerun a check that died on INFRASTRUCTURE, not the code (see…](#af-100)
- [101. review-scan · Scan for PRs with new feedback — startedAt is the only staleness clock: a check blocks only if it started within…](#af-101)
- [102. review-scan · Scan for PRs with new feedback — Ack-on-defer (#8888): a real-time human review routed this scan straight here,…](#af-102)
- [103. review-scan · Scan for PRs with new feedback — Pre-first-eval floor: the PR's IMMUTABLE creation time. Feedback cannot predate…](#af-103)
- [104. review-scan · Scan for PRs with new feedback — ROUND counting is windowed by KEY EQUALITY, not timestamps: the current window…](#af-104)
- [105. review-scan · Scan for PRs with new feedback — Seed for THIS window, from the '<cmd> from N' marker carried by the comment that…](#af-105)
- [106. review-scan · Scan for PRs with new feedback — Consent may have moved since PR_META: skip wins everywhere, and a takeover…](#af-106)
- [107. review-scan · Scan for PRs with new feedback — The escalation label rides EVERY cap detection, noticed or not: the…](#af-107)
- [108. review-scan · Scan for PRs with new feedback — Conflict-park gate for the loop's OWN head move: while a conflict handoff pends…](#af-108)
- [109. review-scan · Scan for PRs with new feedback — Auto-update a PR that is red ONLY because of a stale base (see the…](#af-109)
- [110. review-scan · Scan for PRs with new feedback — STALE_BASE_REDS is pure jq over data already in memory (CHECKS_JSON,…](#af-110)
- [111. review-address · Stage trusted schema gate and agent runner — The staged copies' trusted-base provenance holds at cp time only: RUNNER_TEMP is…](#af-111)
- [112. review-address · Prepare branch and feedback — This PAT-bearing step runs git (status/restore/fetch/checkout and a push…](#af-112)
- [113. review-address · Prepare branch and feedback — ---- address-time eligibility recheck --------------------------- Fan-out can…](#af-113)
- [114. review-address · Prepare branch and feedback — Maintainer-fork target: the branch does not exist on origin — fetch it (data…](#af-114)
- [115. review-address · Prepare branch and feedback — Allow-edits pushes ride the classic-PAT grant — GITHUB_TOKEN and fine-grained…](#af-115)
- [116. review-address · Prepare branch and feedback — Release the dispatch-pending marker the emitting scan stamped on this head: the…](#af-116)
- [117. review-address · Prepare branch and feedback — Mechanical churn must not burn the budget: one dependency bump rewrites hundreds…](#af-117)
- [118. review-address · Prepare branch and feedback — The instant THIS round's net was measured. Stamped into the growth-now marker so…](#af-118)
- [119. review-address · Prepare branch and feedback — NOTE (#9114 R2-8/R6-3): re-anchoring on an EXTERNAL head move (an author push)…](#af-119)
- [120. review-address · Prepare branch and feedback — KNOWN RESIDUAL (#9114): this sibling read still filters on the comment's…](#af-120)
- [121. review-address · Prepare branch and feedback — Growth audit: a budget breach engages Critical-only AND makes the round a…](#af-121)
- [122. review-address · Prepare branch and feedback — Conflict-handoff idempotence: a conflict verdict parks the PR at a genuinely…](#af-122)
- [123. review-address · Prepare branch and feedback — Growth audit (a size signal triggers a JUDGMENT, never a stop): the window is…](#af-123)
- [124. review-address · Post autofix status comment — The agent below runs for up to 130 minutes and the verification gate adds more,…](#af-124)
- [125. review-address · Triage and address — The primary attempt's real budget: 120m, with a 10-minute margin under the…](#af-125)
- [126. review-address · Triage and address — Prepare severed hooks for its PAT-bearing git ops; THIS step holds no PAT, so…](#af-126)
- [127. review-address · Repair deterministic rejection — Which side is corrupt is NOT known here — jq -s fails if EITHER input is…](#af-127)
- [128. review-address · Finalize verification — The verdict travels WITH the attempt whose outcome is selected: a repair pass…](#af-128)
- [129. review-address · Finalize verification — Conclusion gate: fixed/noop are the ONLY outcomes that release the PAT push. A…](#af-129)
- [130. review-address · Finalize verification — handoff and the two brake-violation rejections are deliberate, PUBLISHED…](#af-130)
- [131. review-address · Push and report — Growth-audit trail (+ re-arm on sound): audit rounds record the verdict under…](#af-131)
- [132. review-address · Push and report — The mirror of the resolve above: a finding the agent did NOT resolve keeps its…](#af-132)
- [133. review-address · Push and report — Idempotence gate: a crash-and-rerun of this round, a same-run repair that…](#af-133)
- [134. review-address · Push and report — The tree the gate verified is what gets pushed: assert HEAD is the gate's…](#af-134)
- [135. review-address · Push and report — Bounded retry on the report post: this one comment carries the round's ENTIRE…](#af-135)
- [136. review-address · Push and report — Crossing trigger, not an equality test: failure rounds also advance the round…](#af-136)
- [137. review-address · Report dry-run / failure — This step also posts a round report (timeout / gate-rejection / abort), so it…](#af-137)
- [138. review-address · Report dry-run / failure — handoff rounds end with a SUCCESS job status (a deliberate verdict), so they…](#af-138)
- [139. review-address · Report dry-run / failure — Cause-aware wording, most specific first — a model error and a gate crash each…](#af-139)
- [140. review-address · Report dry-run / failure — A deliberate stop, not a failed fix: the agent stopped under instruction and…](#af-140)
- [141. review-address · Report dry-run / failure — A brake VIOLATION, not a failed fix: the agent stopped under instruction but…](#af-141)
- [142. review-address · Report dry-run / failure — The committed sibling of the dirty-handoff violation: the round HAS a commit…](#af-142)
- [143. review-address · Report dry-run / failure — A conflict round must PARK quietly at the human call: its own stale-base merge…](#af-143)
- [144. review-address · Report dry-run / failure — Prepare RAN (outcome success/failure) but produced no feedback to read — prepare…](#af-144)
- [145. review-address · Report dry-run / failure — CUMULATIVE timeout breaker — the sibling of the consecutive one above, for the…](#af-145)
- [146. review-address · Report dry-run / failure — The agent committed (verify recorded committed=true before any gate could fail),…](#af-146)
- [147. review-address · Report dry-run / failure — Same byte-budget hygiene as the English excerpt above. 3000 bytes ≈ 1000 CJK…](#af-147)
- [148. route — Persistent pool, not hosted: a hosted backlog queued route past the cron period, and af-005's…](#af-148)
- [149. review-address · Report dry-run / failure — Hold the stale-base refresh while a review-pr is in flight on the PR.…](#af-149)

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
its queued PRs silently stop looking busy. The union covers THREE
statuses — in_progress, queued, AND pending: GitHub reports a run
'pending' while its remaining jobs wait on concurrency groups
(neither 'queued' nor 'in_progress'), and the run-level status
trails the job-level flip by minutes, so the two-status union
loses legs that are already running. Measured 2026-08-21 (#9596):
a run whose four legs had been running for several minutes still
listed 'pending', the scan re-dispatched all four, and every
duplicate burned one build-cli (~5 min) before queueing behind
the per-PR group it should have skipped. Pending runs cost one
extra jobs-view each and match nothing until their matrix
materialises. Filtered this way the limit applies to LIVE runs
only (at most a handful), and one jobs-view per live run stays
cheap. The enumeration calls the runs API directly, not `gh run
list --status`: gh validates --status against a client-side
allow-list that only accepts 'pending' from 2.65.0 onward, while
the self-hosted ecs-qwen pool (already used by the issue-autofix,
build-cli, and review-address sibling jobs) lags the hosted
images — an older gh exits 1 on the flag and FAIL-CLOSED below
then silently empties every scan. The API's status filter is
server-side on every gh version.

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

<a id="af-073"></a>

### 73. review-address · Report dry-run / failure — Idle (silent-sandbox) timeouts are EXCLUDED from the cumulative timeout cap.

In `review-address` · `Report dry-run / failure`.

```text
TIMEOUT_WINDOW_CAP exists to stop a PR that is too big to finish a
round inside the agent's time budget; its remedy says so ("split or
reduce the PR, or raise the agent time budget AND its step backstop").
An idle timeout is a different failure entirely: run-agent.mjs's idle
watchdog kills the round after QWEN_IDLE_TIMEOUT_MS (20m) because the
sandbox produced no output at all — the four observed hangs (#8663 x2,
#8761 r3, #8763 r4) each printed their last byte at docker container
entry and then sat silent. Nothing about the PR caused it, and the
breaker's own headline already told the reader that "no budget increase
can cure" it. Counting a failure whose prescribed remedy is
inapplicable is what parked healthy PRs.

Measured on 2026-08-21, over the preceding 14 days: 119 timeouts, of
which 58 (49%) were idle. 51 windows tripped this cap, every one of
them at exactly N=3. Of the 12 open PRs then carrying
autofix/needs-human, 9 had been stopped here — #8332 at 24 rounds,
#8368 at 28, #8276 at 16, all still producing pushed rounds when they
were parked. With idle rounds counted, the fleet timeout rate was
8.5% per round, so a window accumulated three of them in ~35 rounds by
arithmetic alone, independent of whether the PR was stuck. Excluding
idle drops the rate to 4.3%, which needs ~69 rounds — beyond the
deepest window ever observed (22/100).

The escape hatch that makes the exclusion safe: an idle round pushes
nothing and matches none of CONSEC_FAIL's streak-reset needles
("Addressed the latest review feedback", "no changes needed", "AutoFix
could not start", "updated a stale base"), so a persistently wedged
sandbox still terminates the PR at CONSECUTIVE_FAILURE_CAP. What no
longer terminates it is idle rounds INTERLEAVED with real progress —
which is the intended change: that PR is not stuck, the runner is.

Two consequences inside the block. IDLE_N's needle became the full
emitted headline prefix ('AutoFix ran out of time before finishing
(idle-timeout') rather than a bare 'idle-timeout' substring: IDLE_N is
now subtracted from TIMEOUT_N, so it MUST be a subset of it, and a
loose needle could otherwise match provider error text that
API_ERROR_DETAIL puts on the same first line and drive the difference
negative. And the all-idle remedy branch is gone as unreachable: the
guard now fires only when BUDGET_TIMEOUT_N alone reaches the cap, so a
tripped window always holds at least TIMEOUT_WINDOW_CAP genuine budget
timeouts — idle rounds can outnumber budget ones in it, but the budget
remedy applies because those budget timeouts exist, not because they
are the majority.

Idle rounds stay visible through a job-log ::warning:: rather than a PR
comment — the signal belongs to whoever owns the runners, and infra
noise should not spend a comment on someone's PR. The census and its
warning run outside the cap's terminal guard: the all-idle shape stops
via the consecutive breaker with that breaker's headline, and the
terminal run's log is exactly where the wedged runner must be named.

The same exclusion applies to the prepare step's PRIOR_TIMEOUTS census
(af-049): its budget warning tells the agent to narrow scope — the
budget remedy again — and an idle round never exhausted any budget, so
it must not steer the narrowing. Idle rounds are excluded there with
the same needle the cap census uses.
```

<a id="af-074"></a>

### 74. run — Per-author tail budget inside Critical-only mode. An account is an…

In `run`.

```text
Per-author tail budget inside Critical-only mode. An account is an
ACCOUNTABILITY unit, not a throttle: a human login can host an automated
reviewer loop with the exact regeneration property the review bot has
(feedback re-generated after every push, at zero marginal cost). So the
brake keys on measured regeneration, not identity: every source gets a
bounded number of untagged feedback batches per counting window once
Critical-only engages — the review bot's budget is zero (all deferred),
a human's is this many CONSUMED batches. Past it, continuing requires
one conscious act (**[Critical]**, a Request changes review, or /retry),
which is precisely what separates intent from automation.
```

<a id="af-075"></a>

### 75. run — Growth audit: a budget breach engages Critical-only AND makes the round a…

In `run`.

```text
Growth audit: a budget breach engages Critical-only AND makes the round a
growth-audit round. The agent audits the PR's approach on two axes — KISS
(name a structurally simpler alternative or prove each piece load-bearing)
and minimal change (every changed hunk traces to the PR's problem, an
accepted finding, or a failing check) — and records a machine-readable
verdict (sound/drift/conflict) in growth-audit.json, which the
verification gate requires in audit rounds. sound re-arms the window at
the current size (audit-gated /retry) and the loop continues; drift
simplifies first, then continues; conflict is the ONLY growth path to a
human, and it idles subsequent scans until a trusted human responds. A
size signal triggers a JUDGMENT, never a stop: solving the problem is
primary, growth control secondary. See docs/design/autofix-growth-audit.md.
An auth/access model error (401/402/403, "no access"/"does not exist")
never self-heals - only a maintainer can fix the key - and every retry
costs an agent run AND a PR comment. Cap those attempts far below
MAX_ROUNDS so the actionable "check the model key" message lands in an
hour instead of a day. Transient (429/5xx) errors keep the full budget.
```

<a id="af-076"></a>

### 76. run — Failed-check annotation patterns that mean the INFRASTRUCTURE died, not the code…

In `run`.

```text
Failed-check annotation patterns that mean the INFRASTRUCTURE died, not the
code — a self-hosted runner losing the server, the disk filling, a runner
shutdown, or a git fetch/clone dying mid-transfer. Such a check is red for a
reason unrelated to the PR and clears on a re-run (observed: #7490's E2E
"runner lost communication"; #6506's checkout "RPC failed; curl 92" /
"fetch-pack: invalid index-pack output" — both green on the rerun). The scan
auto-reruns those failed jobs ONCE, guarded by run_attempt so a persistent
infra problem cannot loop. Deliberately conservative — only unambiguous
machine/transport failures, never a bare test-level timeout, which could be
a real regression (a co-present timeout does not block a match — one
matching line classifies the run). Case-insensitive, vs the annotations.
```

<a id="af-077"></a>

### 77. run — Upper bound on review targets emitted per scan (fan-out defense-in-depth; excess…

In `run`.

```text
Upper bound on review targets emitted per scan (fan-out defense-in-depth;
excess is logged and deferred to the next scan).
TUNABLE WITHOUT A CODE CHANGE: set the repository variable to re-size the
loop as the takeover pool grows — Settings → Variables, no PR, no deploy.
The literal here is only the fallback when the variable is unset.
Why 30: 37 PRs carried autofix/takeover on 2026-08-08, so the previous
budget of 10 emitted at most 27% of the eligible set per tick and pushed
the rest a scan further out every time. It must also stay strictly above
the address matrix's max-parallel or the matrix can never fill, and the
same-repo candidate pool was 51, so 30 still bounds a pathological
backlog. RAISE BOTH TOGETHER: this must stay above QWEN_AUTOFIX_MAX_PARALLEL.
```

<a id="af-078"></a>

### 78. run — Upper bound on candidates INSPECTED per scan: idle candidates consume serial API…

In `run`.

```text
Upper bound on candidates INSPECTED per scan: idle candidates consume
serial API calls even when they emit nothing, and takeover widens the
candidate pool. Candidates are inspected NEWEST-first; past the budget
the oldest tail defers — old quiet PRs are the least likely to hold new
feedback, and a deferred PR with a live conflict is still picked up by
the shepherd's conflict lever.
TUNABLE WITHOUT A CODE CHANGE, for the same reason as the two above: this
one gates whether a PR is even LOOKED AT, so it has to grow ahead of the
candidate pool or the oldest PRs starve. The pool was 51 same-repo open
PRs on 2026-08-08, still under the 60 fallback.
```

<a id="af-079"></a>

### 79. run — Commit-status context stamped PENDING on a PR head when a scan dispatches a…

In `run`.

```text
Commit-status context stamped PENDING on a PR head when a scan dispatches
a review-address leg for it, and re-stamped SUCCESS by the leg on
checkout. It closes the visibility window between dispatch and leg
materialization: build-cli runs in between, and until the matrix expands
the leg does not exist in the live-run jobs view, so an overlapping scan
would re-dispatch the same PR. The scan treats a PENDING marker fresher
than DISPATCH_STATUS_TTL_MINUTES as busy (a run that dies before the leg
materializes leaves a marker that expires by age). Commit statuses only —
the check-run creation API needs a GitHub App, and this workflow
authenticates with a PAT. Same-repo heads only get a stamp: a fork head
sha does not exist in this repo's object store.
```

<a id="af-080"></a>

### 80. run — Consecutive-failure sub-cap, distinct from the total round cap (TAKEOVER_MAX_ROUNDS,…

In `run`.

```text
Consecutive-failure sub-cap, distinct from the total round cap (TAKEOVER_MAX_ROUNDS, documented at its declaration in qwen-autofix.yml). The
total cap bounds how many PRODUCTIVE rounds a PR may take; this bounds how
many rounds may fail IN A ROW with nothing pushed. Under takeover a PR gets
up to 100 rounds, but a PR that fails to push this many times running is not
iterating, it is stuck — a too-large / fast-conflicting PR whose fix keeps
timing out or failing the gate. Retrying at the same budget will not fix
that; a human has to rebase or split it. Any pushed round OR a legitimate
"no changes needed" no-op resets the streak, so this only ever fires on an
unbroken run of failures. Observed on #6723: 7 straight failed rounds (3
timeouts, 4 gate rejections) over 8 hours, heading for 100.
```

<a id="af-081"></a>

### 81. run — Cumulative agent-timeout sub-cap, the sibling of the consecutive cap for the…

In `run`.

```text
Cumulative agent-timeout sub-cap, the sibling of the consecutive cap for
the failure shape it cannot see: timeouts INTERLEAVED with successful
rounds. A success resets the consecutive streak, but it does not make the
next timeout any cheaper — each one burns a full agent budget (~50m of
runner time) and pushes nothing. Observed on #7929: three timeouts with
pushed rounds in between, so the consecutive cap never fired and the PR
kept walking into the same wall; #7846 the same, twice. Counted over the
current counting window (window-scoped like every other census), so a
re-arm clears it along with the round counter. Counts BUDGET timeouts
only: silent-sandbox (idle) timeouts are infra, not PR size, and are
excluded — see qwen-autofix.md#af-073.
```

<a id="af-082"></a>

### 82. route · Decide phases — Real-time review triggers: process the SAME managed set the scheduled scan does,…

In `route` · `Decide phases`.

```text
Real-time review triggers: process the SAME managed set the
scheduled scan does, so feedback is picked up seconds after the
review instead of waiting for a schedule GitHub throttles hard
(the */10 cron actually lands every 40-70min on this repo).
Reviews must come from trusted senders (collaborators or the
review bot) so arbitrary commenters cannot force expensive
review-scan runs. Only pull_request_review:submitted triggers
(not per-comment events) to avoid redundant runs on
multi-comment reviews.
```

<a id="af-083"></a>

### 83. route · Decide phases — Comment-command sugar over the labels: TAKEOVER_COMMAND applies TAKEOVER_LABEL,…

In `route` · `Decide phases`.

```text
Comment-command sugar over the labels: TAKEOVER_COMMAND
applies TAKEOVER_LABEL, 'TAKEOVER_COMMAND stop' removes it —
nothing else. The label stays the single source of truth:
engagement and release happen ONLY via the label events
below; the command also posts acks directly in both
directions (#7999, #8002). Exact match on the trimmed body (constants, never
user-input parsing); allowed senders: the PR author (who may
lack label access) or a write+ collaborator. This immediately
narrows a previously fully-closed surface reopened under
maintainer mandate.
```

<a id="af-084"></a>

### 84. route · Decide phases — The bot only applies this label from takeover-command, which posts the engage…

In `route` · `Decide phases`.

```text
The bot only applies this label from takeover-command,
which posts the engage ack ITSELF: the labeled event
has been observed to simply not fire (#7999 — the
author read the silence as failure and removed the
label; #8002), so the user-visible ack must not
depend on this round-trip. Suppress only the ack —
the immediate scan is this event's real work and
still routes.
```

<a id="af-085"></a>

### 85. issue-autofix · Sanitize workspace git config — Rather than denylist each exec-vector family (which kept missing new ones), KEEP…

Duplicated verbatim in 3 places: `issue-autofix` · `Sanitize workspace git config`, `build-cli` · `Sanitize workspace git config`, `review-address` · `Sanitize workspace git config`.

```text
Rather than denylist each exec-vector family (which kept missing
new ones), KEEP a known-safe allowlist and --unset-all everything
else: this closes the whole class, including knobs not yet
enumerated. The kept set is only plumbing that carries no command
— repo format, remote, branch, fetch/gc/pack/index, safe.directory,
extensions, and submodule url/active/branch (NOT
submodule.*.update, which can be `!cmd`). actions/checkout
re-establishes remote/auth afterward. `|| true` on the grep: no
non-allowlisted keys (the steady state on an already-sanitized
runner) means grep exits 1, which would kill the step exactly
when there is nothing to clean.
```

<a id="af-086"></a>

### 86. issue-autofix · Stage trusted schema gate — The staged copy's trusted-base provenance holds at cp time only: RUNNER_TEMP is…

In `issue-autofix` · `Stage trusted schema gate`.

```text
The staged copy's trusted-base provenance holds at cp time only:
RUNNER_TEMP is writable by the branch/agent code later steps run
on this host, so record the digest in GITHUB_OUTPUT — expression
context, which a disk write after staging cannot reach — for the
PAT-bearing step to verify at invocation time. The trusted PATH is
recorded the same way and before any branch code runs, so a
$GITHUB_ENV-planted PATH/preload cannot swap the sha256sum/bash/git
the PAT step resolves (that would defeat the digest gate itself).
```

<a id="af-087"></a>

### 87. issue-autofix · Verification gate — Settings-schema freshness gate, shared with the triage-and-address verify step…

In `issue-autofix` · `Verification gate`.

```text
Settings-schema freshness gate, shared with the triage-and-address
verify step so the two copies cannot drift (rationale + the
generator crash guard live in the script). On failure it writes
outcome=failed to GITHUB_OUTPUT and exits 1.
Run the copy staged from the trusted base checkout: a PR branch
that predates the script does not contain it (bash would exit 127
and kill the gate with no outcome), and the gate logic must come
from the trusted base, not the branch under verification.
```

<a id="af-088"></a>

### 88. issue-autofix · Withdraw claim on failure — Same hygiene as the PR-lane DETAIL_FILE excerpt: -c drops a partial multi-byte…

In `issue-autofix` · `Withdraw claim on failure`.

```text
Same hygiene as the PR-lane DETAIL_FILE excerpt: -c drops a
partial multi-byte sequence the byte-level head -c may have
split, and the markup neutralization stops a failure.md quoting
HTML whose opener sits before the 1500-byte cut and closer
after it (`<!--`) — or a contract-violating `<details` — from
swallowing the 中文说明 <details> block appended below
(|| true: iconv -c exits 1 when it discards a byte, which
under set -eo pipefail would drop the whole comment post).
```

<a id="af-089"></a>

### 89. takeover-command · Toggle takeover label — Ack HERE, not via the pull_request:labeled round-trip: that event has been…

In `takeover-command` · `Toggle takeover label`.

```text
Ack HERE, not via the pull_request:labeled round-trip: that
event has been observed to simply not fire (#7999 — the
author read the silence as failure and removed the label;
#8002 — no ack for hours), and fork label events could never
ack at all (they carry no secrets). Every admission gate
above has already passed, so 'engaged' is truthful for both
in-repo and fork PRs. The route side suppresses the
label-path ack when the label sender is the bot, and the
scan's first-pickup ack dedups against this comment — and
heals it on the next scan if this post fails, which is why
a failure here only warns.
```

<a id="af-090"></a>

### 90. takeover-command · Toggle takeover label — Release ack, direct from the command — the exact mirror of the engage side…

In `takeover-command` · `Toggle takeover label`.

```text
Release ack, direct from the command — the exact mirror of
the engage side above, for the same reason: the unlabeled
round-trip is the thing we no longer trust, fork unlabeled
events can never ack (no secrets), and a non-main release
never even reaches the ack job. A loud add next to a mute
stop would re-create the "did it work or did the event get
lost?" ambiguity on the release side. Variant selection
mirrors the ack job verbatim (live author + skip label from
the same PR_INFO the gates used); the route side suppresses
the unlabeled-path ack when the label sender is the bot.
```

<a id="af-091"></a>

### 91. retry-command · Post re-arm marker — Management resumed — the escalation label is stale. 404 is the common case (the…

In `retry-command` · `Post re-arm marker`.

```text
Management resumed — the escalation label is stale. 404 is the
common case (the PR was never paused). Remove it only when the
PR will actually be MANAGED after this re-arm (R5-2): the scan
candidate population is bot-authored or takeover-labeled PRs
only, so on an auto-released human PR (no takeover label, not
bot-authored) /retry posts a marker nothing will act on — the
label must stay as the only filterable escalation state. Skip
also wins over re-arm everywhere (a frozen PR keeps its label),
and the read FAILS CLOSED (mirrors takeover-ack's exit-1).
```

<a id="af-092"></a>

### 92. takeover-ack · Acknowledge takeover state change — R2-4 mirror for the engaged direction: a delayed engaged ack — a red run re-run…

In `takeover-ack` · `Acknowledge takeover state change`.

```text
R2-4 mirror for the engaged direction: a delayed engaged ack — a
red run re-run later, or overlapping runs from quick label
toggles — must not DELETE a fresh cycle's needs-human and must
not post a marker that resets the round window (REARM_KEY is
the newest engage marker). Label absent → the engagement ended
after this event. A bot engage ack at/after the newest labeled
event → the current cycle is already acked. Both skip without
posting or touching labels; an unreadable history skips too
(fail closed — the scan's NEED_ENGAGE_ACK dedup heals a
genuinely missed ack, while nothing heals a stale marker).
```

<a id="af-093"></a>

### 93. takeover-ack · Acknowledge takeover state change — The escalation label goes stale on a real engage or any release (a human is…

In `takeover-ack` · `Acknowledge takeover state change`.

```text
The escalation label goes stale on a real engage or any release
(a human is driving again). NOT on base-refused (nothing changed)
and NOT on skip-blocked (management never resumed) — and a
RELEASE onto a skip-frozen PR also keeps the label: nothing
manages or restores that PR, so it must stay in the needs-human
filter (R4-3). 404 is the common case (the PR was never paused).
Runs BEFORE the ack comment: the state change already happened
(the human toggled the label — the comment is purely
informational), so a transient comment failure aborting this step
under set -e must not strand the stale label.
```

<a id="af-094"></a>

### 94. review-scan · Scan for PRs with new feedback — Every lane that reaches this scan is supposed to hold the PAT: route now…

In `review-scan` · `Scan for PRs with new feedback`.

```text
Every lane that reaches this scan is supposed to hold the PAT:
route now declines the one event GitHub is known to run without
secrets (a fork PR's own review) before it can set do_review. An
empty PAT here is therefore a deleted or renamed secret, or a lane
nobody has modelled yet — neither repaired by a later tick, and
neither visible to a job `if:`, which cannot read the `secrets`
context at all.
It must not be quiet. With no credential every `gh` call below
answers as if the repository held no PRs, so the scan would walk an
empty candidate list and report a healthy fleet of zero — green,
forever, while the whole loop is dead.
```

<a id="af-095"></a>

### 95. review-scan · Scan for PRs with new feedback — Candidate PRs: open, same-repo, targeting main, and either authored by the…

In `review-scan` · `Scan for PRs with new feedback`.

```text
Candidate PRs: open, same-repo, targeting main, and either
authored by the dev-bot or opted in via TAKEOVER_LABEL. A PR
carrying SKIP_LABEL is excluded everywhere — skip wins over
takeover when both are present. A forced PR must still pass all
these checks. NOTE `.isCrossRepository == false` (fail-closed on a
missing field), never a `// true` default piped through `not`:
jq's // treats false as empty, so that form is false for EVERY
input and silently green-no-op'd all forced dispatches.
```

<a id="af-096"></a>

### 96. review-scan · Scan for PRs with new feedback — Same admission as the scheduled scan below. In-repo PRs fail CLOSED on a missing…

In `review-scan` · `Scan for PRs with new feedback`.

```text
Same admission as the scheduled scan below. In-repo PRs fail
CLOSED on a missing isCrossRepository field (`.isCrossRepository
== false`, never a `// true | not` default — jq's // treats false
as empty, so that form is false for EVERY input and silently
green-no-op'd all forced dispatches). Fork PRs are admitted under
the scan's OWN fork rules (allow-edits on; the live write+ author
gate runs in the shell case just below, mirroring the scan's
per-candidate permission call) so the real-time route's fork
pickup is not silently discarded here.
```

<a id="af-097"></a>

### 97. review-scan · Scan for PRs with new feedback — Skip-labeled PRs are excluded HERE, not only at the address gate: that gate…

In `review-scan` · `Scan for PRs with new feedback`.

```text
Skip-labeled PRs are excluded HERE, not only at the address
gate: that gate discards without writing a marker, so the
watermark never advances and an unfiltered scan would re-emit
the PR (checkout, npm ci, build) every tick forever.
Rotating start offset (changes every ~10 minutes): a fixed
newest-first order plus the inspection budget would starve the
oldest tail FOREVER once the pool exceeds the budget; rotation
guarantees every candidate is reached within pool/budget scans.
```

<a id="af-098"></a>

### 98. review-scan · Scan for PRs with new feedback — Dispatch-pending marker: a scan that dispatched this PR within…

In `review-scan` · `Scan for PRs with new feedback`.

```text
Dispatch-pending marker: a scan that dispatched this PR within
DISPATCH_STATUS_TTL_MINUTES may still be building its CLI
bundle — its matrix leg does not exist yet, so the live-run
busy enumeration above cannot see it. The emitting scan stamped
a PENDING status on the PR head at dispatch (same-repo heads
only), and the leg re-stamps it SUCCESS on checkout; treat a
fresh PENDING as busy. Costs no extra API call — the rollup is
already in PR_META. Unlike the in-memory busy skip this runs
after the metadata fetch, so it consumes inspection budget;
acceptable because the case is rare (a PR dispatched <30m ago).
```

<a id="af-099"></a>

### 99. review-scan · Scan for PRs with new feedback — Delay-window fallback: a review run parked BEFORE its job starts (the 10-minute…

In `review-scan` · `Scan for PRs with new feedback`.

```text
Delay-window fallback: a review run parked BEFORE its job
starts (the 10-minute environment wait) has no review-pr
check-run yet, but a push now would still supersede it (the
review workflow's own supersede handling, #10110: a parked or
pre-threshold run yields to the push — its work is discarded
exactly as the old synchronize cancel did — and only a
past-threshold run salvages; the hold keeps the loop from
forcing either). Only pull_request_target runs are affected —
comment/review-triggered runs use per-run concurrency groups
that a synchronize never touches, so holding the round for
one would defer autofix for nothing (R2-1). Match against the
scan's REVIEW_RUNS_JSON fetch — one page of the review
workflow's runs, empty on lookup failure — by immutable head
SHA or PR number, never by fork-controlled bare branch name.
```

<a id="af-100"></a>

### 100. review-scan · Scan for PRs with new feedback — Auto-rerun a check that died on INFRASTRUCTURE, not the code (see…

In `review-scan` · `Scan for PRs with new feedback`.

```text
Auto-rerun a check that died on INFRASTRUCTURE, not the code (see
INFRA_FAILURE_SIGNATURES). Only reached when the PR has a FAILED
check; then, for each, we read its annotations and — if they carry
a machine-death signature — rerun that run's failed jobs ONCE. The
once is enforced by run_attempt: a run already retried to attempt 2
and still infra-failing is persistent, so we stop and leave it. No
marker needed; the attempt counter is the guard, and after a rerun
the attempt increments so the next scan skips it. Any API failure
here is fail-safe: it just means no rerun.
```

<a id="af-101"></a>

### 101. review-scan · Scan for PRs with new feedback — startedAt is the only staleness clock: a check blocks only if it started within…

In `review-scan` · `Scan for PRs with new feedback`.

```text
startedAt is the only staleness clock: a check blocks only if it
started within the bound; one with no startedAt (queued, not yet
running) is not blocking (the next scan re-checks once it starts).
The dispatch-pending marker is exempted by context: it is this
loop's own StatusContext busy signal (no .workflowName/.name, so
it passes the filters above) and its dedicated TTL check above is
the authority on it — the 330-minute horizon here would keep a
stranded marker blocking long past its TTL.
```

<a id="af-102"></a>

### 102. review-scan · Scan for PRs with new feedback — Ack-on-defer (#8888): a real-time human review routed this scan straight here,…

In `review-scan` · `Scan for PRs with new feedback`.

```text
Ack-on-defer (#8888): a real-time human review routed this
scan straight here, but the gate holds every mutation — from
the human's seat the bot read their review and then did
nothing. Say so once per in-flight review (the marker embeds
the review-pr check's startedAt, so a NEW review re-arms the
ack). The feedback itself needs no ack: the watermark is not
advanced on this skip, so the next scan after the review
lands still sees and addresses it. Cron scans stay silent —
nothing arrived in them that a human is waiting on, and the
fleet table already shows the deferral.
```

<a id="af-103"></a>

### 103. review-scan · Scan for PRs with new feedback — Pre-first-eval floor: the PR's IMMUTABLE creation time. Feedback cannot predate…

In `review-scan` · `Scan for PRs with new feedback`.

```text
Pre-first-eval floor: the PR's IMMUTABLE creation time. Feedback
cannot predate the PR, and unlike the head commit date this never
advances when the branch is synced with main ("Update branch"/base
merge), so an early base-sync merge cannot bury a comment made before
the first eval. If the metadata query failed (empty), fall back to an
EMPTY floor — over-inclusive (evaluates all feedback once, then the
first eval writes a marker) but never buries. NEVER fall back to the
mutable head commit date: a base-sync HEAD would recreate the burial.
```

<a id="af-104"></a>

### 104. review-scan · Scan for PRs with new feedback — ROUND counting is windowed by KEY EQUALITY, not timestamps: the current window…

In `review-scan` · `Scan for PRs with new feedback`.

```text
ROUND counting is windowed by KEY EQUALITY, not timestamps: the
current window key is the created_at of the latest
'<!-- takeover-ack engaged -->' comment ('none' before any
takeover), every marker records the key of the window it was
produced in (win=…, legacy markers count as 'none'), and only
markers of the CURRENT window count toward the cap. Timestamp
windowing would race an in-flight address job selected before a
re-arm: its marker lands AFTER the ack and would instantly
re-cap the fresh window — key equality cannot. Within a window
the highest round wins (a terminal handoff marker must make the
scan skip regardless of order).
```

<a id="af-105"></a>

### 105. review-scan · Scan for PRs with new feedback — Seed for THIS window, from the '<cmd> from N' marker carried by the comment that…

In `review-scan` · `Scan for PRs with new feedback`.

```text
Seed for THIS window, from the '<cmd> from N' marker carried by
the comment that IS the window key — so it is window-scoped for
free, exactly like the key itself: a later /retry or a bare
/takeover opens a window whose anchor has no marker and the seed
returns to 0. Read by created_at equality against REARM_KEY, so a
seed from a SUPERSEDED window can never leak into the live one.
`scan` (not `capture`, which errors when absent) and `last`
(a hand-written marker further down a bot comment loses to the
workflow's own, which is always the final line).
```

<a id="af-106"></a>

### 106. review-scan · Scan for PRs with new feedback — Consent may have moved since PR_META: skip wins everywhere, and a takeover…

In `review-scan` · `Scan for PRs with new feedback`.

```text
Consent may have moved since PR_META: skip wins everywhere,
and a takeover notice additionally requires the label to
still be present — a label removed (or skip added) moments
ago must not receive a stale 'paused' notice. The read
FAILS CLOSED (mirrors takeover-ack): an unreadable label
state must not get a notice or the escalation label —
collapsing the failure to '' would ignore a concurrently
added skip for standard bot PRs.
```

<a id="af-107"></a>

### 107. review-scan · Scan for PRs with new feedback — The escalation label rides EVERY cap detection, noticed or not: the…

In `review-scan` · `Scan for PRs with new feedback`.

```text
The escalation label rides EVERY cap detection, noticed
or not: the once-per-window dedup suppresses repeat
comments, but the label is what makes a paused PR
filterable (the shepherd's auto-release ages from the
cap notice itself, not from the label) — and applying
it unconditionally backfills the already-paused fleet
via the scan rotation after this ships (idle backoff:
expect hours, not the first scan).
```

<a id="af-108"></a>

### 108. review-scan · Scan for PRs with new feedback — Conflict-park gate for the loop's OWN head move: while a conflict handoff pends…

In `review-scan` · `Scan for PRs with new feedback`.

```text
Conflict-park gate for the loop's OWN head move: while a
conflict handoff pends in the live window, an update-branch
merge re-fires every synchronize-triggered workflow on the new
head, and those loop-generated checks complete after both
park clocks — lifting the park with zero human activity, and
every woken round feeds CONSEC_FAIL toward a terminal lockout
on the exact PR a human is settling. Mirrors prepare's
conflict-handoff idempotence block (same marker scan, same
wake legs, same fail-closed fallbacks); a base that goes
stale during a park is re-handled by the address gate's own
stale-base retry once a human wakes a round.
```

<a id="af-109"></a>

### 109. review-scan · Scan for PRs with new feedback — Auto-update a PR that is red ONLY because of a stale base (see the…

In `review-scan` · `Scan for PRs with new feedback`.

```text
Auto-update a PR that is red ONLY because of a stale base (see the
MAIN_GREEN_CHECKS rationale above). The gate: the failing check also
passed for the PR that produced current main (a necessary-but-NOT-
sufficient signal — NOT proof main is healthy), and the PR is behind
or diverged, so it actually carries a stale base. Runs after the
round cap and pending-checks gates but before the feedback logic,
because a stuck-on-stale-base PR often has no NEW feedback at all (it
just sits red), which is exactly #7490's case.
```

<a id="af-110"></a>

### 110. review-scan · Scan for PRs with new feedback — STALE_BASE_REDS is pure jq over data already in memory (CHECKS_JSON,…

In `review-scan` · `Scan for PRs with new feedback`.

```text
STALE_BASE_REDS is pure jq over data already in memory
(CHECKS_JSON, MAIN_GREEN_CHECKS) — free, and far more selective
than the compare round-trip. Compute it FIRST and skip the network
call entirely when there is no stale-base red to act on (the common
case: a green PR, or one whose red check is also red on main).
CANCELLED is deliberately omitted from the PR-side selector: a
cancelled check is not evidence of a stale base. External commit
statuses are also excluded: a StatusContext exposes .context, not
.name/.workflowName, so it yields "" and select(. != "") drops it
(conservative — only Actions check-runs are matched).
```

<a id="af-111"></a>

### 111. review-address · Stage trusted schema gate and agent runner — The staged copies' trusted-base provenance holds at cp time only: RUNNER_TEMP is…

In `review-address` · `Stage trusted schema gate and agent runner`.

```text
The staged copies' trusted-base provenance holds at cp time only:
RUNNER_TEMP is writable by the branch/agent code later steps run
on this host, so the two digested copies — resanitize-git-config.sh
and run-autofix-review-verification.sh — record each digest in
GITHUB_OUTPUT — expression context, which a disk write after staging
cannot reach — for the invoking step to verify before execution.
(The step's other staged scripts carry no digest.) The gate runner is
pinned too: it runs the branch's own build/test between the two
gate passes, so an unverified copy would let the branch define
its own verdict. The trusted PATH is recorded before any branch
code runs, so a $GITHUB_ENV-planted PATH/preload cannot swap the
sha256sum/bash/git the steps resolve (that would defeat the digest
gate itself).
```

<a id="af-112"></a>

### 112. review-address · Prepare branch and feedback — This PAT-bearing step runs git (status/restore/fetch/checkout and a push…

In `review-address` · `Prepare branch and feedback`.

```text
This PAT-bearing step runs git (status/restore/fetch/checkout and a
push preflight) on the shared host BEFORE the agent/gate, so it
takes the same hermetic preamble the push steps do — the contract
test pins the executable lines equal across all three. Pin PATH and
drop the preload channels, strip git's env knobs, redirect the file
scopes to an unpredictable per-run throwaway (a concurrent job's
~/.gitconfig rewrite during this step's long window — staging, node
setup, npm ci, artifact download all sit before it — cannot steer
its git, and a fsmonitor/askpass/gpg.program plant cannot fire).
```

<a id="af-113"></a>

### 113. review-address · Prepare branch and feedback — ---- address-time eligibility recheck --------------------------- Fan-out can…

In `review-address` · `Prepare branch and feedback`.

```text
---- address-time eligibility recheck ---------------------------
Fan-out can hold this job queued for hours behind max-parallel,
and the matrix snapshot cannot see lifecycle changes: a PR
closed or merged while queued must not get a secret-bearing
agent run, a branch push, or a comment; an author/base/head
change must not be processed against stale assumptions. Re-fetch
and require the same shape the scan selected. A failed fetch is
UNKNOWN and discards too (fail closed — the next scan re-emits a
still-valid target).
```

<a id="af-114"></a>

### 114. review-address · Prepare branch and feedback — Maintainer-fork target: the branch does not exist on origin — fetch it (data…

In `review-address` · `Prepare branch and feedback`.

```text
Maintainer-fork target: the branch does not exist on origin —
fetch it (data only; hooks are severed) from the fork. A public
repo's fork heads are always public, so this fetch is anonymous:
`-c credential.helper=` resets the inherited helper list (a
planted global extraheader could 401 and hand a planted helper
this step's PAT — the same class the push sites reset against)
and `http.sslVerify=true` pins the transport. Fail closed on a
401 rather than authenticate.
```

<a id="af-115"></a>

### 115. review-address · Prepare branch and feedback — Allow-edits pushes ride the classic-PAT grant — GITHUB_TOKEN and fine-grained…

In `review-address` · `Prepare branch and feedback`.

```text
Allow-edits pushes ride the classic-PAT grant — GITHUB_TOKEN
and fine-grained PATs are documented as NOT receiving it.
Prove push access NOW, before an agent round is spent, instead
of 403ing at the report step after the work is done.
One-shot host-scoped helper like the push steps: the leading
empty credential.helper resets the inherited helper list (a
planted helper must never answer first) and http.sslVerify
pins the transport — full rationale → af-015.
```

<a id="af-116"></a>

### 116. review-address · Prepare branch and feedback — Release the dispatch-pending marker the emitting scan stamped on this head: the…

In `review-address` · `Prepare branch and feedback`.

```text
Release the dispatch-pending marker the emitting scan stamped on
this head: the leg has materialized, so from here the live-run
busy enumeration sees it and a PENDING status must not keep
overlapping scans away. Best-effort — a miss only delays the next
scan's view, and the marker expires by age anyway. A head that
moved since the dispatch left the stamp on the old sha; the
current head's rollup no longer shows it, so this re-stamp lands
where the next scan actually looks. Same-repo heads only — a fork
head sha is absent from this repo's object store and was never
stamped; dry runs stamp nothing either.
```

<a id="af-117"></a>

### 117. review-address · Prepare branch and feedback — Mechanical churn must not burn the budget: one dependency bump rewrites hundreds…

In `review-address` · `Prepare branch and feedback`.

```text
Mechanical churn must not burn the budget: one dependency bump
rewrites hundreds of package-lock.json lines and one
`generate:settings-schema` run regenerates the committed schema —
skimmed, not reviewed, so they measure no review burden. Keep the
list tight and name generated artifacts EXACTLY; a broad glob
would silently exempt hand-written files from the budget. Applied
to BOTH measurements: a lockfile can live under a test directory
(integration-tests/package-lock.json), and excluding it from one
side only would corrupt the NET_SRC subtraction.
```

<a id="af-118"></a>

### 118. review-address · Prepare branch and feedback — The instant THIS round's net was measured. Stamped into the growth-now marker so…

In `review-address` · `Prepare branch and feedback`.

```text
The instant THIS round's net was measured. Stamped into the
growth-now marker so the census filters on measurement
time, not the marker comment's created_at — the report posts the
marker only after the agent's ~120-minute run, so a round in
flight when a concurrent base update lands would otherwise pass a
created_at filter while carrying pre-update sums (#9114 R2-6).
Emitted ONLY when a measurement happened: an unmeasured attempt
that still stamped would be explicit in the per-run collapse and
displace the same run's real measurement (#9192 R4-3).
```

<a id="af-119"></a>

### 119. review-address · Prepare branch and feedback — NOTE (#9114 R2-8/R6-3): re-anchoring on an EXTERNAL head move (an author push)…

In `review-address` · `Prepare branch and feedback`.

```text
NOTE (#9114 R2-8/R6-3): re-anchoring on an EXTERNAL head move (an
author push) is deliberately NOT done here. The obvious signal —
comparing the checked-out head against the bot's last judged head
(autofix-redcheck) — is wrong: that marker records the head the
agent was GIVEN, before its own push, so it differs after every
pushing round and would re-anchor on the bot's own fixes, zeroing
the census in exactly the push regime the handoff exists for. A
correct version needs both a bot-authored-move test and a
PERSISTED cut (a one-round cut is re-admitted the next round);
that is its own change, tracked in #9114.
```

<a id="af-120"></a>

### 120. review-address · Prepare branch and feedback — KNOWN RESIDUAL (#9114): this sibling read still filters on the comment's…

In `review-address` · `Prepare branch and feedback`.

```text
KNOWN RESIDUAL (#9114): this sibling read still filters on the
comment's created_at, not a prepare-time measured= like the
growth-now read below. Its values are measured in prepare too, so a
round whose agent run straddles a base update can anchor the window
on pre-update values. Narrow (the update must land inside the
anchor round's own agent run) and first-wins, so it cannot be
re-poisoned later in the window; stamping measured= into the
growth-base marker is tracked with the rest of #9114 rather than
widening this change.
```

<a id="af-121"></a>

### 121. review-address · Prepare branch and feedback — Growth audit: a budget breach engages Critical-only AND makes the round a…

In `review-address` · `Prepare branch and feedback`.

```text
Growth audit: a budget breach engages Critical-only AND makes the
round a growth-audit round — a size signal triggers a JUDGMENT,
never a stop. The agent audits the approach (KISS + minimal
change, burden of proof inverted) and records a machine-readable
verdict the verification gate requires: sound re-arms the window
at the current size and the loop continues, drift simplifies
first, conflict is the only growth path to a human. Count this
window's prior per-round over-budget rounds for the audit's
context (the trajectory clause in feedback.md uses the same
number). Read this window's prior per-round growth markers
(written by the report step):
<!-- autofix-growth-now src=N test=N over=BOOL round=N run=ID measured=TS key=W -->
Deduped by run=GITHUB_RUN_ID (the per-workflow-run id) and ORDERED
by measured=: the report post's bounded retry re-posts one run's
marker, and a failed job's re-run keeps the same run_id, so a run
collapses to its LATEST measurement — and that collapse happens
BEFORE the over/window/cutoff filters, or a re-run that came back
under budget would still be represented by its stale over=true
attempt. Within the collapse an explicit measured= beats the
created_at fallback: a re-run attempt that crashed BEFORE prepare
— or whose measurement failed — posts an inert over=false marker
with no measured=, whose fallback (post-run) timestamp would
otherwise outdate and erase the same run's real prepare-time
measurement. Every distinct address run has a fresh run_id.
KNOWN RESIDUAL (#9114): during the one-time deploy transition a
run whose FIRST attempt posted a legacy (no measured=) over=true
marker and whose re-run crashes before prepare still collapses
fallback-vs-fallback on created_at — the later inert marker wins
and erases the count. Self-limiting: once deployed, every real
measurement carries measured= and beats any inert marker.
round=/eval-watermark are NOT a safe identity — a state-triggered
lane (a persistent merge conflict selects the PR every scan with no
new evaluable feedback) freezes both NEWEST and ROUND, so distinct
over-budget runs would share them and collapse, stalling the count.
Filtered on measured= (the prepare-time measurement instant, NOT
the comment's post-agent created_at) after GROWTH_NOW_CUTOFF, so a
round measured against a pre-base-update tree is dropped rather
than counted in this window's census. KNOWN RESIDUAL (#9114): the
tree is fixed at the branch fetch/checkout while the cutoff comes
from ic.json fetched afterwards, so a base update landing between
the fetch and the measured_at stamp admits a pre-update marker;
self-heals at the next re-arm/base update. measured= is OPTIONAL
in the scan: markers posted before it existed fall back to their
comment's created_at, so deploying this does not blank the census
of a window that is already in flight.
The CURRENT run's own markers are excluded (run != GITHUB_RUN_ID):
a re-run of a failed job keeps the same run id and its failed
attempt already posted a marker, so counting it would over-report
the round's own attempt as a PRIOR one.
```

<a id="af-122"></a>

### 122. review-address · Prepare branch and feedback — Conflict-handoff idempotence: a conflict verdict parks the PR at a genuinely…

In `review-address` · `Prepare branch and feedback`.

```text
Conflict-handoff idempotence: a conflict verdict parks the PR at
a genuinely human call. Until a trusted human responds, scans
must not launch agents or post comments — review-bot regeneration
alone (an update-branch merge re-reviews every new head) would
otherwise churn one identical handoff after another. Wake only on
feedback the loop cannot produce itself: trusted-human
reviews/comments, or a failing check from OUTSIDE the Qwen Autofix
workflow (a CI build/test the loop did not run). The Qwen Autofix
workflow's OWN check runs are excluded wholesale: under a park no
address round can legitimately run, so any review-address check
newer than the marker is necessarily the conflict round's own
failed check (posted after the handoff) — counting it would let
the loop's own output unpark the very round it came from, and the
resulting wasted failure rounds feed CONSEC_FAIL toward a terminal
lockout on the exact PR a human is trying to settle. A manual
job re-run reaches prepare and parks green (no failed check), and
/retry remains the sanctioned lift. A /retry re-arm moves
LIVE_REARM_KEY past the marker's win= and lifts the park on its
own.
Two more loop-generated events must not wake: a stale-base
auto-update is the loop's OWN head move — the red checks it
REACTS to completed before its marker (they are the condition it
handles, not human feedback), so the checks leg counts only
failures completing after BOTH the conflict marker and the
latest base update; and CANCELLED never wakes — an
update-branch push cancels in-flight runs on the old head (and a
close/reopen does the same), which the loop produces without any
human.
The exclusion set is wider than the loop's own workflow: the
loop's SIBLING machinery produces check events too — the review
workflow re-fires on every head the loop's own base-update merge
creates, the CI-failure patrol re-runs flaky failures on the
UNCHANGED head by cron, and the fork lanes carry the loop's own
checks for fork PRs. All of it completes after both clocks with
no human anywhere in the input, so all of it is excluded by
name; and while a handoff pends, the loop performs NO head
moves at all (the scan's stale-base auto-update and the
conflict round's own stale-base retry both skip parked PRs),
so any check newer than both clocks is human-caused.
```

<a id="af-123"></a>

### 123. review-address · Prepare branch and feedback — Growth audit (a size signal triggers a JUDGMENT, never a stop): the window is…

In `review-address` · `Prepare branch and feedback`.

```text
Growth audit (a size signal triggers a JUDGMENT, never a stop):
the window is over its growth budget, so before any other work
the round audits the approach — two axes, burden of proof
inverted — and records a machine-readable verdict the
verification gate requires. sound re-arms the window and the
loop continues, drift simplifies first, conflict is the only
growth path to a human. The section carries the numbers and the
window's audit trail so a re-audit after a prior verdict must
bring new evidence to repeat it.
```

<a id="af-124"></a>

### 124. review-address · Post autofix status comment — The agent below runs for up to 130 minutes and the verification gate adds more,…

In `review-address` · `Post autofix status comment`.

```text
The agent below runs for up to 130 minutes and the verification gate adds
more, but nothing reaches the PR thread until "Push and report" at the
very end: a maintainer who just engaged takeover sees silence and cannot
tell a working round from a stuck one. The agent's output already
streams live to the Actions log, so publish that link up front.
Upserted by marker so one status comment per PR is EDITED each round
(edits notify nobody) rather than stacking a new comment against a
100-round cap. Runs after prepare so a revalidated-away stale duplicate
never announces a round it will not run. Best-effort: a status post that
fails warns and continues — it must never cost the round.
```

<a id="af-125"></a>

### 125. review-address · Triage and address — The primary attempt's real budget: 120m, with a 10-minute margin under the…

In `review-address` · `Triage and address`.

```text
The primary attempt's real budget: 120m, with a 10-minute margin
under the 130-minute step backstop above. The margin covers the
internal kill path (SIGTERM, 10s grace, SIGKILL, marker write);
if the step cap fires first, `agent-timeout` is never written and
the report step misclassifies the round as a crash.
QWEN_AUTOFIX_TIMEOUT_MS can only LOWER the fallback without a code
change: the run block clamps it to the 7,200,000 ms ceiling
(BUDGET_CAP_MS, the fallback itself), so raising the budget still
requires editing this default, BUDGET_CAP_MS, and the step backstop,
while a misconfigured variable degrades to a warning, not a misreport.
```

<a id="af-126"></a>

### 126. review-address · Triage and address — Prepare severed hooks for its PAT-bearing git ops; THIS step holds no PAT, so…

In `review-address` · `Triage and address`.

```text
Prepare severed hooks for its PAT-bearing git ops; THIS step
holds no PAT, so the branch's own hooks may check the agent's
commits again. HONEST LIMIT: the model key (OPENAI_API_KEY) IS
forwarded into the docker sandbox by the CLI, and the agent's
job is to build/test the branch — so on a taken-over
human-authored PR, branch-controlled scripts can read that key.
This is an accepted, explicit consequence of takeover
(triage+-gated, in-repo branches only, whose authors are
write-capable collaborators); keep AUTOFIX_OPENAI_API_KEY a
low-privilege, quota-bounded, rotatable key.
```

<a id="af-127"></a>

### 127. review-address · Repair deterministic rejection — Which side is corrupt is NOT known here — jq -s fails if EITHER input is…

In `review-address` · `Repair deterministic rejection`.

```text
Which side is corrupt is NOT known here — jq -s fails if
EITHER input is unparseable, and today's topology cannot
even produce a pre-existing carry (WORKDIR is wiped at run
start and there is exactly one repair step), so this branch
is defensive. Say what is certain: the merge failed, the
earlier set is kept, this round's is preserved unmerged.
The only loss path in this feature without a raw dump: the
newer set is discarded here and the eval watermark means
nothing re-derives it, so print it before deleting. `::` is
neutralized because the content is agent-written and a raw
`::` at line start would be parsed as a workflow command.
```

<a id="af-128"></a>

### 128. review-address · Finalize verification — The verdict travels WITH the attempt whose outcome is selected: a repair pass…

In `review-address` · `Finalize verification`.

```text
The verdict travels WITH the attempt whose outcome is
selected: a repair pass legitimately re-audits (its feedback
rebuild keeps the audit section; the SKILL mandates
audit-first), and the verdict its gate validated is the one
the round's code was judged by — binding the first pass
unconditionally dropped it. The :- fallback mirrors COMMITTED:
a repair that validated nothing leaves the first pass's
validated verdict as the record.
```

<a id="af-129"></a>

### 129. review-address · Finalize verification — Conclusion gate: fixed/noop are the ONLY outcomes that release the PAT push. A…

In `review-address` · `Finalize verification`.

```text
Conclusion gate: fixed/noop are the ONLY outcomes that release
the PAT push. A silent gate death (the step killed mid-check)
concludes failure, yet its step-output file stays discoverable
under $RUNNER_TEMP and appendable — a forged outcome=fixed +
verified_head must not flow to the push condition. Accept
fixed/noop only from a pass whose step concluded success;
anything else reads as a crashed gate (empty outcome → the
report's retry path), never as a verdict, and the audit bit
riding the tainted outputs is discarded with it.
```

<a id="af-130"></a>

### 130. review-address · Finalize verification — handoff and the two brake-violation rejections are deliberate, PUBLISHED…

In `review-address` · `Finalize verification`.

```text
handoff and the two brake-violation rejections are
deliberate, PUBLISHED verdicts, not failures: the agent
stopped under instruction (the growth-brake BLOCKED stop)
and the 'Report dry-run / failure' step posts the honest
headline, the handoff note, and the eval marker for all
three. Failing the job here would leave a red
review-address check that completes AFTER the marker's
ts=NEWEST — the next scan's N_FAILED_CHECKS includes this
workflow's own review-address checks, so it would count
the round's own rejection as NEW feedback and re-dispatch
the very item the headline promises not to retry, turning
one deliberate stop into a self-feeding loop.
```

<a id="af-131"></a>

### 131. review-address · Push and report — Growth-audit trail (+ re-arm on sound): audit rounds record the verdict under…

In `review-address` · `Push and report`.

```text
Growth-audit trail (+ re-arm on sound): audit rounds record the
verdict under the key the baseline was READ under — same rule as
the growth markers, same dead-key hazard (a supersede-exempt
round can report under a stale WINDOW after a re-arm). The
verdict comes from AUDIT_VERDICT — the verdict the verification
GATE validated and surfaced as a step output — NOT a re-read of
growth-audit.json: the branch's own build/tests run as the runner
user and WORKDIR is a predictable path they can write, so the
file could change after the gate looked. Re-arming is allowed
for completed rounds only ($1 = allow): a sound verdict whose
round then FAILED must not re-anchor the window — the failure
path re-measures under the same window instead.
```

<a id="af-132"></a>

### 132. review-address · Push and report — The mirror of the resolve above: a finding the agent did NOT resolve keeps its…

In `review-address` · `Push and report`.

```text
The mirror of the resolve above: a finding the agent did NOT
resolve keeps its thread open, and this answers it IN that thread.
Without it the reason sits only in the round summary, so the
reviewer who opens the still-open thread sees silence and cannot
tell their finding was read. Same neutralisation as the summary
body — a reply is model output posted verbatim under the bot
identity, so it could otherwise smuggle a forged control marker.
Best-effort: a reply failure must never fail a good push.
```

<a id="af-133"></a>

### 133. review-address · Push and report — Idempotence gate: a crash-and-rerun of this round, a same-run repair that…

In `review-address` · `Push and report`.

```text
Idempotence gate: a crash-and-rerun of this round, a
same-run repair that regenerates the dispositions, or a
later round whose agent rewrites an unchanged declination
must not post the same bot reply twice on one thread
(observed 2026-08-16: an identical reply posted three
times, #9296). Skip when the thread already carries a
comment by the bot whose body EQUALS the neutralised body
about to be posted; a changed body — a new reason in a
later round — still posts. Best-effort like the rest: with
a stale or empty threads view this degrades to the old
post-always behavior.
```

<a id="af-134"></a>

### 134. review-address · Push and report — The tree the gate verified is what gets pushed: assert HEAD is the gate's…

In `review-address` · `Push and report`.

```text
The tree the gate verified is what gets pushed: assert HEAD is
the gate's verified_head before touching credentials. A repo
redirect (a planted .git/commondir/GIT_DIR — the first defused
by resanitize, the second by the env strip) would otherwise let
`git rev-parse HEAD` and the push read an attacker repo whose
HEAD differs; this compares against the value the gate recorded
in GITHUB_OUTPUT (unreachable from a disk write). Empty
verified_head only on a noop, which does not reach this push.
```

<a id="af-135"></a>

### 135. review-address · Push and report — Bounded retry on the report post: this one comment carries the round's ENTIRE…

In `review-address` · `Push and report`.

```text
Bounded retry on the report post: this one comment carries the
round's ENTIRE persisted state (autofix-eval watermark/round,
redcheck head, growth baseline). The push has already landed, so
a transient API failure here loses the marker while keeping the
growth — the retry scan would re-anchor the baseline at the
post-push size and re-evaluate feedback it already addressed.
Three attempts bound that to genuine outages; the final failure
keeps today's semantics (step fails, no marker, next scan
retries the round).
```

<a id="af-136"></a>

### 136. review-address · Push and report — Crossing trigger, not an equality test: failure rounds also advance the round…

In `review-address` · `Push and report`.

```text
Crossing trigger, not an equality test: failure rounds also
advance the round counter, so `push@9, crash@10, push@11`
would skip an exact %10 check forever — and a failure-heavy
PR is the very PR the digest exists for. Post on the first
PUSHED round once 10+ rounds have accumulated since the last
digest in THIS window (or since the window opened). The
window opens at the round SEED, not at zero: a '/takeover
from 60' counter starts at 60, so the no-digest-yet baseline
is the seed — otherwise the seed-inflated counter digests on
the window's first push with a 1-2 round census.
```

<a id="af-137"></a>

### 137. review-address · Report dry-run / failure — This step also posts a round report (timeout / gate-rejection / abort), so it…

In `review-address` · `Report dry-run / failure`.

```text
This step also posts a round report (timeout / gate-rejection /
abort), so it writes the per-round growth-now marker too — else an
over-budget round that never reaches 'Push and report' leaves a
history gap and the census under-reports. Empty outputs
(prepare never ran) fall through the :-0/:-false marker fallbacks
to an inert over=false entry — measured= then OMITS itself (an
EMPTY measured= value matches no scan and would silently drop the
marker these fallbacks exist to keep); the reader falls back to
the comment's created_at.
```

<a id="af-138"></a>

### 138. review-address · Report dry-run / failure — handoff rounds end with a SUCCESS job status (a deliberate verdict), so they…

In `review-address` · `Report dry-run / failure`.

```text
handoff rounds end with a SUCCESS job status (a deliberate
verdict), so they must trigger on the outcome itself — without
this clause nothing would post and the loop would go silent on
exactly the rounds that most need a visible human handoff. The
two brake-violation rejections are green, published verdicts
for the same reason (finalize passes them so their own check
cannot re-select the PR), so they key on the outcome the same
way.
```

<a id="af-139"></a>

### 139. review-address · Report dry-run / failure — Cause-aware wording, most specific first — a model error and a gate crash each…

In `review-address` · `Report dry-run / failure`.

```text
Cause-aware wording, most specific first — a model error and a
gate crash each name the operator fix, while a bare no-output
crash points at a human. (The API clause runs first as
defense-in-depth: today run-agent writes failure.md on the
API-death path and the gate converts that to an explicit
outcome=failed, so GATE_CRASHED is false — but if the gate
ever changes, a model blip must not be reported as a gate
problem.) No Run log here — the report block below appends
it (avoid a duplicate).
```

<a id="af-140"></a>

### 140. review-address · Report dry-run / failure — A deliberate stop, not a failed fix: the agent stopped under instruction and…

In `review-address` · `Report dry-run / failure`.

```text
A deliberate stop, not a failed fix: the agent stopped
under instruction and deferred the item to a human. No
stale-base retry (there is no fix to re-attempt) and the
headline says what actually happened — the old
"could not produce a passing fix" wording reported the
brake's decision as a failure and buried the handoff.
Wording guard: no "🤖 AutoFix stopped" prefix — the fleet
shepherd's REASON regex reads that as a TERMINAL stop
reason, and this stop is transient (the loop stays
engaged); the shepherd contract test pins the distinction.
```

<a id="af-141"></a>

### 141. review-address · Report dry-run / failure — A brake VIOLATION, not a failed fix: the agent stopped under instruction but…

In `review-address` · `Report dry-run / failure`.

```text
A brake VIOLATION, not a failed fix: the agent stopped
under instruction but left a dirty workspace, so the
gate rejected the round under its own outcome (never
retryable — a repair pass would commit against the
brake). No stale-base probe: there is no fix to
re-attempt, and the probe's update-branch would merge
main for a retry that must not happen. The watermark
still advances (the feedback WAS read), so the item
hands to a human without any automatic-retry promise.
Wording guard: no "🤖 AutoFix stopped" prefix, same
reason as the handoff branch above.
```

<a id="af-142"></a>

### 142. review-address · Report dry-run / failure — The committed sibling of the dirty-handoff violation: the round HAS a commit…

In `review-address` · `Report dry-run / failure`.

```text
The committed sibling of the dirty-handoff violation:
the round HAS a commit beside handoff.md. The gate
rejected it non-retryably under its own outcome, so the
repair pass never engages and the handoff note survives
to be posted. The runner-side commit was NOT pushed —
only 'Push and report' (fixed/noop) publishes — so it is
discarded with the runner, the same committed_rc the
failure.md "commit discarded" wording keys on.
Wording guard: no "🤖 AutoFix stopped" prefix, same
reason as the handoff branch above.
```

<a id="af-143"></a>

### 143. review-address · Report dry-run / failure — A conflict round must PARK quietly at the human call: its own stale-base merge…

In `review-address` · `Report dry-run / failure`.

```text
A conflict round must PARK quietly at the human call: its
own stale-base merge would re-fire every synchronize-
triggered workflow on the new head, and those loop-
generated checks complete after the conflict marker this
same report posts — waking the very park it establishes.
The scan's stale-base auto-update carries the matching
gate; base staleness is re-handled by this retry once a
human wakes.
```

<a id="af-144"></a>

### 144. review-address · Report dry-run / failure — Prepare RAN (outcome success/failure) but produced no feedback to read — prepare…

In `review-address` · `Report dry-run / failure`.

```text
Prepare RAN (outcome success/failure) but produced no feedback to
read — prepare itself crashed or timed out before emitting a
verdict. Mark
terminal so the scan skips (it can't advance the watermark
without a read); do NOT imply MAX_ROUNDS attempts were made when
zero rounds happened. The headline states the real recovery
(delete the marker) rather than promise a re-trigger the
max-round guard would ignore.
```

<a id="af-145"></a>

### 145. review-address · Report dry-run / failure — CUMULATIVE timeout breaker — the sibling of the consecutive one above, for the…

In `review-address` · `Report dry-run / failure`.

```text
CUMULATIVE timeout breaker — the sibling of the consecutive
one above, for the failure shape it cannot see: timeouts
interleaved with pushed rounds. A push resets CONSEC_FAIL,
but it does not make the next timeout cheaper — each burns a
full agent budget with nothing to show (observed on #7929:
three timeouts with successes in between; #7846 twice). The
census reuses PRIOR_HEADS, so it is window-scoped exactly
like the consecutive one and a re-arm clears it. Only the
cap gate below overrides a would-be RETRY: a round already
terminal keeps its own headline (the consecutive breaker
included). The idle census and its warning run OUTSIDE that
guard: the all-idle shape terminates via the consecutive
breaker above, and that terminal run's job log is exactly
where the wedged runner must be named.
```

<a id="af-146"></a>

### 146. review-address · Report dry-run / failure — The agent committed (verify recorded committed=true before any gate could fail),…

In `review-address` · `Report dry-run / failure`.

```text
The agent committed (verify recorded committed=true before
any gate could fail), but every path that reaches this
handoff skipped "Push and report" — nothing landed on the
branch. Say so before the agent's address-summary.md, which
can read like a success and cite that now-discarded commit
SHA. Keyed on committed, NOT outcome=failed: the abort/no-op
paths (failure.md, dirty tree, unchanged branch, missing
summary) made no commit and keep the neutral framing below.
```

<a id="af-147"></a>

### 147. review-address · Report dry-run / failure — Same byte-budget hygiene as the English excerpt above. 3000 bytes ≈ 1000 CJK…

In `review-address` · `Report dry-run / failure`.

```text
Same byte-budget hygiene as the English excerpt above. 3000
bytes ≈ 1000 CJK characters — roughly the information in the
1500-byte English excerpt. Beyond the `<!--` escape, also
neutralize the tag forms that could interact with THIS
wrapper: a translation quoting HTML is pathological (SKILL
forbids HTML in failure.zh.md), but must not be able to open
or close a <details>/<summary> that swallows the closing tag
the workflow emits below.
```

<a id="af-148"></a>

### 148. route — Persistent pool, not hosted: a hosted backlog queued route past the cron period, and af-005's supersede then starved every scan round.

In `route` and `review-scan`.

```text
route and review-scan run on the persistent pool, not the
hosted one. They are short trusted base-repo jobs, but they
gate the WHOLE fan-out: while they sit queued, no
review-address leg starts. On 2026-08-25 a hosted-runner
backlog queued route for over 20 minutes — longer than the
cron period — and af-005's newer-tick-supersedes-older rule
then cancelled every still-queued round: nine consecutive
schedule runs died without scanning while the ecs-qwen pool
stood mostly idle. The supersede rule stays — it is right
once route gets a runner in seconds; the fix is taking the
hosted queue out of the critical path. review-scan moves
with it because it shares the gate, and its own hosted waits
delayed every fan-out by the same backlog. Both keep the
fork-trust clause of the sibling lanes: pull_request and
pull_request_review resolve this file from the PR's own
merge commit, so only same-repo heads and write-access
authors may reach the persistent pool; everything else stays
hosted, and the kill-switch wins everywhere. Neither job
checks code out — route only decides phases, and review-scan
only calls the API — so the shared workspace needs no
restore or wipe step here. The pool still leaves two marks
on the lane, both closed in the same change. One: gh reads
its config from the shared, attacker-writable $HOME, so both
steps carry the heavy jobs' gh hardening preamble — a planted
~/.config/gh/config.yml could reroute their gh calls into a
local socket, taking CI_DEV_BOT_PAT with the scan and forged
collaborator-permission answers with route. Two: review-scan
fills a per-run WORKDIR with API dumps that no VM teardown
removes on the pool, so it gets a fixed autofix* per-run path
(the age sweep can reclaim it after a hard kill), an EXIT
trap, and an always() cleanup step mirroring issue-autofix.
```

<a id="af-149"></a>

### 149. review-address · Report dry-run / failure — Hold the stale-base refresh while a review-pr is in flight on the PR.

In `review-address` · `Report dry-run / failure`.

```text
The scan's dispatch gate (#8888/#8899) already refuses to start a round
while review-pr is live, but the loop had one more head-moving write
outside that hold: this step's stale-base retry calls update-branch at
REPORT time, hours after the dispatch gate last looked. A review can
start in that window — a human /review comment, a bot re-request, or a
run the scan's fail-open probe missed — and the merge push would then
supersede a lifecycle review run mid-flight (#10110; before the salvage
threshold that discards its work exactly as the old cancel did), or
invalidate a command run's posting: every review pins the head it
reviews (QWEN_CI_REVIEW_EXPECTED_HEAD_SHA) and its guard blocks the
final post when the head moved, so even the uncancellable per-run-group
reviews lose their whole run to a head move.

So the retry probes for a live review first, with the scan gate's exact
probe pair: the statusCheckRollup filter (any live review-pr check from
the review workflow, trigger-independent), then the runs-API fallback
for pull_request_target runs still parked in the 10-minute delay window
with no check-run yet. On a live review the update is DEFERRED, not
skipped: the same 9999 sentinel MARK_TS the retry branch uses keeps the
feedback live, the next scan re-runs the round (itself held while the
review is still in flight), and that round's report step performs the
refresh once the review has landed. One extra round of latency, bounded
by MAX_ROUNDS, against hours of discarded review work.

Fail-open on probe errors, deliberately: the probe is an optimization,
and failing closed would wedge stale-base recovery — the path that
un-sticks red PRs — on any transient API error. A probe error therefore
reads as "no review live" and the update proceeds, which is exactly the
pre-#10110 behavior. The deferred headline joins CONSEC_FAIL's
streak-reset needles ("deferred a stale-base refresh"): like the
updated-a-stale-base round it defers to, the round's failure is not
evidence about the PR, and counting it toward the cap would park a PR
for having been reviewed at the wrong moment.
```
