# Autofix growth brake: audit instead of stop

## Problem statement

PR #9213 (`fix(review): fix silent reverse-audit retirement failures`,
under `autofix/takeover`) stalled at round 5. The deterministic growth
brake measured window growth of source 286 / test 948 net lines against
budgets of 400/400, saw two prior over-budget rounds with no shrinkage,
set `GROWTH_DIVERGED`, and the round became a `defer-to-human` handoff:
no code changes, no commit, no resolved threads, and a maintainer
question ("how to land this PR") whose honest answers were only "merge
what exists" or "re-arm and let the loop continue" — both things the
loop could have decided itself.

Three structural problems:

1. **The size signal is wired to a stop effector.** Over budget →
   Critical-only; still over budget across rounds → full stop. The loop
   has no mode between "patch freely" and "halt", so a budget breach
   that the remaining work could still satisfy terminates the takeover
   anyway.

2. **The growth the brake punishes is protocol-mandated.** The address
   protocol requires a pinned regression test for every fix; #9213 fixes
   behavior (receipt parsing, retirement semantics) that is ONLY
   observable through tests. The loop was stopped for doing what the
   loop's own rules require. 948 of the window's lines are the two test
   blocks that pin the PR's stated problem.

3. **The stopped state churns.** `GROWTH_DIVERGED` is enforced only by
   feedback.md text (it is deliberately not a step output), so every
   scan that sees new feedback past the watermark still launches an
   agent run that re-derives "still blocked" and can re-post the
   handoff — and new feedback keeps arriving: the review bot's
   `CHANGES_REQUESTED` state always passes the Critical-only filter,
   and update-branch merges regenerate reviews on every new head. The
   takeover label stays on; runs keep burning; nothing progresses
   until a human acts.

Historical justification for the brake is real (#8853 grew 315 → 1393
net lines in four bot rounds, +609 in a single round; #8276 grew ~2700
net lines under management). The brake's MEASUREMENT is sound; its
EFFECTOR is wrong.

## Design principles

1. **Solving the problem is primary; growth control is secondary.** The
   takeover exists to land fixes, not to police line counts.
2. **A size signal triggers a JUDGMENT, never a constraint or a stop.**
   Over budget means "audit the approach", not "you may not add lines"
   and never "halt".
3. **Terminal states are only "done" or "a genuinely human call".**
   Done = everything affordable solved, the rest tracked in follow-up
   issues. Human call = two defensible directions collide. Size is
   neither.

## Proposed changes

### A. Trigger: budget breach starts an audit round (qwen-autofix.yml)

The divergence ladder is replaced. Wherever the prepare step currently
sets `CRITICAL_ONLY_GROWTH=true` (window growth past either budget),
the round additionally becomes a growth-audit round (`KISS_AUDIT=true`
step output feeding feedback.md and the verdict gate). The
`GROWTH_DIVERGENCE_ROUNDS` escalation (over budget for N prior rounds
AND not shrinking → handoff) is retired with its repo variable; the
budgets themselves (`GROWTH_BUDGET_SRC_LINES`,
`GROWTH_BUDGET_TEST_LINES`) and the Critical-only engagement on breach
are unchanged — the audit rides on top of Critical-only, it does not
replace it.

Auditing at FIRST breach (not after two more over-budget rounds) saves
the rounds the divergence ladder used to spend proving non-convergence;
#9213 would have audited at round 3 instead of stopping at round 5.

The audit fires only when growth is measurable
(`NET_MEASURED=true`, i.e. a trusted merge base exists): the verdict
needs numbers to judge. The unmeasured advisory path (growth not
reported, no brake) is unchanged.

### B. Audit mode in the autofix skill (.qwen/skills/autofix/SKILL.md)

feedback.md gains a `Growth audit required` section (replacing the
`Needs a maintainer's decision — this PR is not converging` section)
carrying the growth numbers, the prior over-budget round count, and any
prior audit verdict markers (section D). The agent audits on two axes,
with the burden of proof inverted — the default assumption is that the
PR IS over-engineered, and the agent must disprove that:

- **KISS (structure):** does a structurally simpler approach achieve
  the same goal? The agent must either NAME the simpler alternative
  (shape, not prose) or justify each accumulated piece as load-bearing
  for a specific finding or failure mode.
- **Minimal change (footprint):** every changed file/hunk must trace to
  one of (a) the PR's original problem, (b) an accepted review finding,
  (c) fixing a failing check. The audit produces a traceability table;
  hunks with no trace are deletion candidates. This axis is nearly
  mechanical, which is what keeps the audit honest — a `sound` verdict
  requires an accounted origin for every chunk of growth.

The two axes are distinct: a fix can be structurally simple yet
footprint-wide, or footprint-tight yet guard-stacked. Either axis
failing is `drift`, and the verdict must name which.

Before any edit in an audit round the agent writes
`${WORKDIR}/growth-audit.json` (verdict-before-edit is a protocol
requirement; the gate below enforces presence and shape):

```json
{
  "verdict": "sound | drift | conflict",
  "kiss": { "result": "pass | fail", "simpler_alternative": "… | null" },
  "minimal_change": { "result": "pass | fail", "untraceable_hunks": ["…"] },
  "rationale": "…"
}
```

Routing per verdict, same round:

- `sound` — the approach is justified; continue addressing feedback
  normally (the remaining Criticals etc.).
- `drift` — implement the named simpler alternative and/or the deletion
  list first (typically net-negative), then continue addressing
  feedback.
- `conflict` — two defensible directions and the choice is not the
  agent's: STOP `BLOCKED` with a handoff that carries the audit's
  reasoning. This is the ONLY growth-related path to a human, and the
  human receives a narrowed question with evidence, not "the diff is
  too big".

### C. Verdict gate (.github/scripts/run-autofix-review-verification.sh)

In a round tagged `KISS_AUDIT`, a missing or malformed
`growth-audit.json` fails verification NON-retryable: the round reports
failure and the next scan re-runs the audit. A malformed verdict is
agent misbehavior, not a build problem, so the repair pass cannot fix
it and must not be invoked. This closes the rubber-stamp hole by the
absence side: an audit round that skips the audit cannot push. The tag
reaches the gate as a verify-step env (same pattern as
`FOOTPRINT_ENFORCE`), and shape validation uses `jq`, already a
workflow dependency. Shape validation enforces the taxonomy where it
is unambiguous (`sound` requires both axes `pass`, `drift` at least
one `fail`, `conflict` unconstrained), rejects multi-document verdict
files, and enforces the conflict routing: a `conflict` verdict whose
round did not stop with a handoff fails NON-retryable — conflict must
STOP BLOCKED, never push. The verify step runs on `always()`, and the
check must sit before the gate script's no-commit/failure.md
early-exits so it also applies to no-op audit rounds (a verdict of
`sound` with nothing left to fix still requires the audit artifact)
AND to conflict rounds (whose BLOCKED stop exits via `failure.md`;
the verdict must be validated and surfaced before that exit, or the
trail marker never posts and the park never engages).

### D. Verdict routing and the audit trail (qwen-autofix.yml report step)

The report never re-reads `growth-audit.json`: each gate records the
verdict it VALIDATED as a step output (`audit_verdict`), 'Finalize
verification' surfaces the verdict of the pass whose OUTCOME was
selected (a repair pass legitimately re-audits — its feedback rebuild
keeps the audit section and the SKILL mandates audit-first — so its
gate-validated verdict is the one the round's code was judged by; a
repair that validated nothing falls back to the first pass's validated
verdict), and both report steps consume that single output. The
gate-validated verdict is the only verdict that may reach the trail
marker and the re-arm.

Residual, shared trust domain: the verdict file is written during the
agent step, where branch code runs on a predictable WORKDIR, and the
gate's first read necessarily comes AFTER that — the gate validates
shape, taxonomy, and routing, but can never prove the file's
provenance against code that ran before its read (a planted
shape-valid `sound` replacing an honest `drift`/`conflict`). Blast
radius is control-plane forgery bounded by the window caps, held by
STRUCTURAL invariants rather than an enumerated channel list (the
entrance-by-entrance approach kept growing new entrances each review
round):

- A push requires `outcome=fixed|noop`, and 'Finalize verification'
  accepts those two outcomes ONLY from a pass whose step CONCLUSION is
  success — a gate that reached them exited 0. A gate killed mid-check
  concludes failure, so a forged `outcome=fixed` + `verified_head`
  appended to its discovered output file is discarded there (read as a
  crashed gate, retried) and never reaches the push condition. Every
  live exit additionally writes its own outcome AFTER the checks, so a
  mid-check append loses last-write-wins even without a kill.
- The gate launches through the workflow's `env -i` clean-child pattern
  with a step-level `BASH_ENV`/`SHELLOPTS` pin: bash sources a planted
  `BASH_ENV` at process STARTUP, before any body-side unset runs, so
  the pin + allowlisted child close the class instead of enumerating
  it. The runner's `$GITHUB_ENV`/`$GITHUB_PATH`/`$GITHUB_STEP_SUMMARY`
  BACKING files under `$RUNNER_TEMP/_runner_file_commands/` (which stay
  discoverable after the variable strip) are locked read-only for the
  step's lifetime, so no check can append an environment plant into the
  later PAT-bearing steps. The directory itself stays writable — the
  runner creates the next step's backing files there at step start, and
  locking it would stall every later step of the job — which leaves a
  rename-over residual (create a new file and rename it onto a locked
  one): narrower than the open append, and priced deliberately.
- The control bits ride the gate's own defended output: `kiss_audit`
  is recorded before any branch code runs and re-appended at EVERY exit
  with the same last-writer discipline as the verdict; later steps
  consume it (like `audit_verdict`) through the finalize chain, never
  steps.prepare's raw copy except as the crash fallback for a pass that
  died before recording it.

Known residuals, stated rather than claimed closed: the `$GITHUB_OUTPUT`
backing file itself stays writable (the gate must write it), so a
CONCURRENT detached writer spawned by branch code and outliving the gate
can still race the last append — outcome flips are blocked by the
conclusion gate above, and a forged trail marker on a FAILED round
cannot re-arm (the failure path never re-arms); and steps.prepare's
`kiss_audit` copy is consumed as the fallback only when no gate
recorded the bit (a crash path with no push).

Every audit round posts its verdict in the round report comment with a
machine-readable marker
(`<!-- autofix-growth-audit verdict=V win=WINDOW_KEY -->`), so later
rounds' audits can read the trail — a second audit after a prior
`sound` IN THE SAME WINDOW sees that its predecessor already blessed
the approach and must bring new evidence to repeat the verdict. The
trail and its new-evidence obligation are per-window: the feedback
reader filters on the live window key, and a completed `sound` verdict
re-arms, which moves the key past the marker — so a `sound`→re-arm
chain is invisible from inside each round in it, and the
human-greppable comment stream is the only cross-window bound. The
marker's `win` must be `steps.prepare.outputs.growth_base_win` (the key the baseline was READ
under), for the same reason the growth-now marker uses it: a conflict
round is exempt from supersede discard and can run with a stale window
after a re-arm, so a marker written under the dead key would be
invisible to every later read.

On `verdict=sound` on a COMPLETED round, the report step additionally
posts the re-arm marker comment (`<!-- autofix-rearm -->`). This reuses the existing
`LIVE_REARM_KEY` machinery exactly (window key = latest
`takeover-ack engaged` or `autofix-rearm` marker): the watermark
releases, queued old-window jobs supersede themselves, and the next
round re-anchors the growth baseline at the CURRENT size, so the
remaining work gets a fresh budget (completed-round report paths only
— a round that FAILED records the verdict but never re-arms).
Effectively an automatic, audit-gated `/retry`.

Explicit decision: the re-arm has full `/retry` semantics — the
per-window round counter and the suggestion valve reset too. Continuing
to solve the problem includes suggestions; if the regenerated
suggestions reproduce the bloat, the brake re-trips after another full
budget of growth and re-audits with the trail visible.
`TAKEOVER_MAX_ROUNDS` bounds each window individually; a chain of
`sound` re-arms is bounded only by the public audit trail and
milestone prompts, not by any global cap.

On `verdict=drift` there is no re-arm: the simplification is expected
to shrink the diff, and the brake re-measures naturally next round.

### E. Budget deferral through the #9189 queue (depends on #9189)

PR #9189 (unmerged as of this writing) adds the fourth address-review
disposition, Defer to follow-up: a VERIFIED finding whose fix lies
outside the PR's footprint/mainline is recorded in
`deferred-findings.json` and upserted into one per-PR tracking issue
that survives the merge. This design extends that reason taxonomy with
a budget class: an in-footprint, verified finding that does not fit the
window's remaining growth budget is deferred through the SAME pipeline
(single issue upsert, rc-id dedupe, token neutralization, thread reply,
left open). The existing "defer requires VERIFIED" constraint applies
unchanged, which is what prevents budget deferral from becoming a dump.

Until #9189 lands, sections A–D + F stand alone; the unaffordable tail
then simply stays deferred by Critical-only (no loss, no structured
queue).

### F. defer-to-human narrowed and idempotent

- Growth reaches a human only via a `conflict` verdict (section B). The
  skill's existing non-growth defer-to-human categories (product/scope
  choices, contradictory reviewers) are unchanged.
- Conflict-handoff idempotence: once a conflict handoff has been posted
  for this window, scans with no new wake since post nothing and do not
  launch the agent. The wake set is feedback the loop cannot produce
  itself: a trusted-human review or comment, or a failing check from
  OUTSIDE the loop's fleet. Excluded wholesale from the checks leg: the
  Qwen Autofix workflow's OWN check runs (address lanes included — under
  a park no address round can legitimately run, so any review-address
  check newer than the marker is the conflict round's OWN failed check,
  and counting it would let the loop's own output unpark the round it
  came from), AND the loop's sibling machinery — the review workflow
  (re-fired by every head the loop's own base-update merge creates),
  the CI-failure patrol (cron re-runs on the unchanged head), and the
  fork bridge/signal lanes (the loop's own checks for fork PRs). All of
  it completes after both park clocks with no human in the input, and
  the wasted failure rounds would feed the consecutive-failure cap
  toward a terminal lockout on the exact PR a human is settling.
  Belt-and-braces with the name exclusion, the loop performs NO head
  moves while a handoff pends: the scan's stale-base auto-update and
  the conflict round's own stale-base retry both skip parked PRs, so
  any check newer than both clocks ran on a head a human moved.
  `/retry` (which moves the window key past the marker) is the
  sanctioned lift. This fixes the handoff churn in problem 3 for the
  one remaining stopping path; the non-stopping paths do not churn by
  construction.

## State machine

Before:

```
normal → critical-only → (2+ over-budget rounds, not shrinking) → STOP, defer-to-human
```

After:

```
normal → critical-only (+ audit round at first budget breach)
           ├─ verdict sound   → continue; re-arm window at current size
           ├─ verdict drift   → simplify (net-negative), then continue
           └─ verdict conflict → ONE idempotent handoff with audit evidence
affordable work exhausted → terminal success: core landed,
                            tail in the per-PR deferral issue, label released
```

## Walkthrough: PR #9213 under this design

Round 3 (first breach): audit round. KISS axis — the accumulated
hardening (line-scoped polarity guard, single-receipt-form
certification, and the rest) each traces to a finding; no simpler
named alternative. Minimal axis — the 562-line repro block and
671-line retirement tests trace to the PR's original problem and
accepted findings. Verdict `sound` → re-arm → window baseline
re-anchored at current size. Rounds 4+: the two remaining Criticals
(small fixes) land well inside a fresh 400/400 budget; the reviewer's
marginal tail is deferred by Critical-only (and, post-#9189, its
verified off-mainline items queue into the tracking issue). PR
converges and the label releases with zero human rounds.

## Failure modes and bounds

- **Audit wrongly blesses real drift.** Bounded: the next breach in
  the SAME window re-audits with the prior verdict marker visible
  (across a `sound` re-arm the marker sits under the old window key —
  the cross-window bound is the public comment stream), and repeated
  `sound` verdicts against monotonically growing diffs are a public,
  greppable pattern for maintainers.
- **Audit wrongly condemns a sound design.** Cost is one extra
  simplification round; the deletion list is traceability-derived and
  posted, so a bad list is visible before it is re-derived next round.
  The failure mode is a wasted round, never a stop.
- **Rubber-stamping.** Burden inverted (assume over-engineered),
  traceability table required, verdict gate rejects absent/malformed
  verdicts, trail is public.
- **Cost.** One audit round per budget breach — one agent run,
  replacing the handoff round that ran anyway.
- **Existing brakes untouched.** Round-based Critical-only,
  per-window human feedback budgets, failed-check handling, and
  `TAKEOVER_MAX_ROUNDS` all remain as they are.

## Test impact

`scripts/tests/qwen-autofix-workflow.test.js` pins the current
behavior and must be rewritten with the change:

- The whole `it('escalates to a maintainer-decision handoff …')` case
  (~L6742–7378): it pins the `GROWTH_DIVERGENCE_ROUNDS` variable,
  extracts and executes the divergence block against a fixture history
  of `autofix-growth-now` markers (deduped on `run=`, ordered on
  `measured=`, filtered by the comparability cutoff), pins the
  malformed-rounds sanitize fallback, then executes the feedback.md
  handoff-guard block and asserts `## Needs a maintainer's decision`,
  `defer-to-human`, and the SKILL text `this PR is not converging`.
  All of it is replaced by the audit trigger, verdict routing, and the
  new SKILL text. The fixture marker helper itself survives — the audit
  reads the same `autofix-growth-now` history the divergence ladder
  did.
- New pins: audit trigger at first breach (and NOT on round-based
  Critical-only without a breach); verdict gate rejecting a KISS_AUDIT
  round with missing/malformed `growth-audit.json`;
  `<!-- autofix-growth-audit … -->` trail marker in the report;
  `<!-- autofix-rearm -->` posted iff verdict is `sound` on a completed
  round (the failure path records the verdict but never re-arms);
  conflict handoff idempotence.

## Rollout and dependencies

- Sections A–D and F are independent and can land first.
- Section E depends on #9189 merging; land #9189 first so there is
  exactly one deferral pipeline.
- #9213 itself does not wait for this design: `@qwen-code /retry` is
  today's manual equivalent of the `sound` exit, merging as-is plus
  follow-up issues is today's manual equivalent of the deferral exit.

## Non-goals

- The bot never merges on its own; terminal success still ends in
  human review/merge.
- Review-side finding generation is not made budget-aware here (the
  reviewer keeps producing findings; the audit + deferral absorb them).
  Making the review pipeline aware of budget state is a follow-up lever.
- No topology-scaled budgets. The audit makes the exact budget value
  far less load-bearing; scaling it is deferred unless evidence says
  otherwise.
