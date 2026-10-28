# Autofix takeover round budget

[English](2026-10-24-autofix-takeover-round-budget.md) | [简体中文](2026-10-24-autofix-takeover-round-budget.zh-CN.md)

Status: implemented in this change, 2026-10-24.

## Problem statement

The `autofix/takeover` label is what hands a human-authored PR to the autofix
loop — applied by `@qwen-code /takeover` or by hand, since the scan posts a
first-pickup ack for a manual label too. It is deliberately persistent: it
raises the round cap from 10 to 100, and the ten-minute scan keeps managing the
PR until the label is removed or a circuit breaker fires.

Maintainers routinely want something narrower — "look at this feedback, fix it,
then leave the PR alone" — and today they have to express it through the
persistent mechanism:

- `@qwen-code /takeover from 99` spends the whole cap in one change-producing
  round, so the next scan pauses the PR. The counter is already past
  `CRITICAL_ONLY_AFTER_ROUND`, so that round is Critical-only and suggestions
  are merely recorded; the pause also applies `autofix/needs-human` and posts a
  "reached its round cap" notice, which reads as a failure rather than as a
  finished, bounded engagement. A no-op round leaves the counter untouched, so
  on a PR whose rounds keep finding nothing this workaround does not bound
  anything at all.
- Bare `/takeover` followed by `/takeover stop` gives a full-scope round, but it
  requires a human to watch the run and remember to stop it. Forgetting costs up
  to 100 rounds.

Neither workaround can state the actual intent, and neither bounds more than one
round.

## Proposed change

Add one parameterized form to the existing command:

```
@qwen-code /takeover for N
```

`N` is a one- or two-digit decimal `>= 1`. It engages (or re-arms) takeover
exactly like the bare command and additionally records an **engagement-scoped
round budget of N** on the engage/re-arm ack:

```
<!-- takeover-ack engaged -->
<!-- autofix-round-budget 3 -->
```

The effective round cap for that window becomes `min(takeover cap, N)`, so the
loop runs at most N rounds and then stops touching the PR. The budget and the
attempts spent are read per **engagement** — a maintainer command opens one, an
automatic growth-audit re-arm does not — so the audit keeps rebasing its round
window while the remaining budget still applies. A hand-applied label opens an
engagement too, and it carries no budget: it is the one route into management
that `for N` cannot bound.

## Behavior at the boundary

| State                                                           | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Budget spent on a human-authored PR                             | One bilingual "budget spent — released" note, then `autofix/takeover` is removed. No `autofix/needs-human`, no paused notice. A FORCED dispatch defers this to the next non-forced scan: that pass answers the dispatch out loud on the paused path, and the release that follows deletes the `autofix/needs-human` that pause applied. The deferred pass's notices quote the attempts spent, not the round counter a no-op-only engagement leaves at 0.                                                                                       |
| Budget spent on a bot-authored PR                               | The label is NOT removed (the bot PR is managed without it), so it lands on the existing paused path: paused notice + `autofix/needs-human`. A SPENT budget outlives any removal that leaves no `takeover-ack released` marker — the shepherd's three-day auto-release and a hand-removal alike — and the PR stays parked at N/N. An explicit `stop` posts that marker, which moves the engagement floor, so the budget ends there and standard management resumes, exactly as the ack says. An UNSPENT budget ends with the label either way. |
| A breaker stops the loop BEFORE the budget is spent             | The existing paused path runs: paused notice + `autofix/needs-human`. A breaker asks for a human, so it is never reported as a finished budget.                                                                                                                                                                                                                                                                                                                                                                                                |
| A breaker's condition met ON the attempt that spends the budget | The budget wins: that attempt is already counted, so the PR takes the release path and its note instead of the paused one. The consecutive-failure breaker cannot fire on the round that reaches N (its entry gate skips the cap round), so no breaker diagnosis is posted for a window that ended by design.                                                                                                                                                                                                                                  |
| `/retry` or a bare `/takeover` while a budgeted window is live  | Opens a new window with no budget — unbounded takeover, as today.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `/retry` after the budget released a human-authored PR          | Nothing happens until the PR is re-engaged. The release removed the label, so the PR is in neither selection pool; `/retry` posts its re-arm ack and says the counter reset, but no scan enumerates the PR. Use `/takeover` (with or without `for N`) to bring it back.                                                                                                                                                                                                                                                                        |
| Budget window superseded while a round is queued                | The window-key check discards the queued job, and — new for a budget — also discards a queued CONFLICT round, which that check otherwise exempts: the queued job runs on the old cap, so a live window carrying a budget marks it stale and the next scan re-selects it under the new window.                                                                                                                                                                                                                                                  |

## Key design decisions

1. **The budget counts attempts, and attempts are counted from eval markers.**
   A no-op round must consume a turn, or a PR whose rounds keep finding nothing
   would stay managed forever on a one-round budget. It writes
   `<!-- autofix-eval … round=ROUND -->` with its round UNCHANGED, so `ROUND`
   alone under-counts it; counting markers counts it exactly once. The same
   choice fixes the opposite error: a circuit breaker stamps its terminal
   marker with `round=MAX_ROUNDS` after far fewer real attempts, and a sentinel
   jump adds no marker, so five failures inside a twenty-round budget read as
   five attempts — the breaker's escalation is preserved instead of being
   mistaken for a finished budget.

2. **The budget is engagement-scoped, and carried on the ack.** It rides as its
   own marker on the comment that anchors the engagement, and it is read back
   from every ack/re-arm at or after that anchor — the scan's `BUDGET_FLOOR`
   predicate: a `takeover-ack engaged`, a `takeover-ack released` (which closes
   the engagement, so an explicit `stop` ends the budget), or an `autofix-rearm`
   that does NOT also carry an `autofix-eval ` marker. That exclusion is the whole point: it is
   what tells a maintainer's command from the automatic growth-audit re-arm,
   whose comment carries the round's eval marker. Round accounting
   (`autofix-round-start`) stays window-keyed — equality with the ack comment's
   `created_at` — so the two reads are deliberately NOT the same shape, and
   collapsing the budget read into the window-key equality would silently drop
   the budget and the spend census on every automatic re-arm.

3. **Exhaustion releases instead of escalating.** `autofix/needs-human` means
   "the loop stopped and a human must unstick something"; a finished budget
   leaves nothing stuck, so the label and the paused notice would both be false.
   Release is just the label DELETE, so the PR leaves the managed pool on its
   own. A forced dispatch cannot release either: it has to answer the dispatch
   out loud, so it pauses and the next non-forced scan releases. That release
   therefore deletes the escalation label too — the note denies that anything
   is waiting on a human, so the label its own deferral applied must not outlive
   it — and the deferred pass's notices quote the attempts rather than a round
   counter that no-ops never advance.

4. **Bot-authored PRs keep the paused path.** They are managed whether or not
   the label is present, so releasing it would hand them back to standard
   ten-round management and the budget would be a lie. They are the one case
   where the existing paused outcome is accurate.

5. **`for` and `from` are mutually exclusive.** Both are single parameterized
   forms with different meanings (suggestion budget vs. round budget); a body
   carrying both, a `for 0`, a three-digit value, or any trailing text stays
   "not an exact command" and does nothing.

6. **A queued conflict round is superseded by a budgeted window.** Conflicts are
   normally exempt from the superseded-window discard because they stay
   actionable. A budget is different: the queued job carries the old cap and
   would run past the new engagement limit, so a live window that carries a
   budget discards it too and the next scan re-selects the conflict under the
   new window.

7. **An automatic re-arm rebases the growth window, and the budget rides
   along.** The growth audit appends `<!-- autofix-rearm -->` to open a fresh
   window for its own round accounting, and suppressing that marker would pin
   the growth baseline after the first over-budget round and make every later
   round Critical-only — so it stays unconditional. It is not the only thing
   that re-anchors the growth baseline: a base-branch update
   (`autofix-base-updated`, which filters the earlier `autofix-growth-base`
   markers out of the baseline read) and the scan's first-pickup heal ack move
   it too. What keeps the budget honest is not the re-arm's exclusivity but its
   key: budget and spend are read per ENGAGEMENT rather than per window — a
   maintainer command opens one, an automatic re-arm (its comment also carries
   that round's eval marker) does not — so the audit rebases the baseline while
   the remaining budget and the attempts already spent continue to apply.

8. **Prepare mirrors the scan's attempt census.** A queued round can outlive the
   sibling that spent the window's last attempt: a no-op leaves `ROUND` at 0 and
   the window key unchanged, so neither the superseded-window check nor the
   round cap discards it. `review-address` therefore recounts the window's eval
   markers and discards when the budget is already spent.

## Files affected

- `.github/workflows/qwen-autofix.yml` — parser, route output wire, engage/re-arm
  ack markers, the scan's budget and attempt reads, the cap override, the
  cap-branch release, and prepare's mirror of the same census (the live budget
  read, the attempt recount and the two discard guards).
- `.github/workflows/qwen-fleet-shepherd.yml` — resume detection accepts the
  parameterized command forms, so a `for N` or `from N` body between the
  maintainer's comment and the ack landing is still read as evidence of a live
  engagement rather than as an idle paused PR.
- `.github/workflows/qwen-autofix-round-seed.md` — operator guide for both
  parameterized forms.
- `.github/workflows/qwen-autofix.md` — rationale record (af-159; af-160 carries
  the `env:` prose this change moves out of the workflow).
- `.github/workflows/.size-baseline` — ratchet entry.
- `scripts/tests/qwen-autofix-workflow.test.js` — parser, ack, cap-read and
  release coverage.

The workflow file sits against this repository's 470,000-byte gate
(`.github/scripts/check-workflow-size.sh`, env-overridable, and ~42 KB below
GitHub's own 512,000-byte start-runs limit), so this change also moves
duplicated `env:` commentary into the rationale record (af-160), leaving a
one-line summary plus a pointer per constant. That is a prose move only — no
constant, default, or behaviour changes.

## Scope boundaries

- No change to the round caps, the failure/convergence breakers, the
  Critical-only brake, or the growth budgets. The fleet shepherd is touched in
  exactly one place — its resume detector learns the two parameterized command
  forms — and its release policy is unchanged.
- No new labels. Budget exhaustion deliberately does NOT leave
  `autofix/needs-human` on human-authored PRs: a deferred release clears the
  one its own pause applied.
- No change to admission: the same author/write+ gate, fork rules and
  `autofix/skip` precedence apply to `for N` as to the bare command.

## Risks and limitations

- A run that is cancelled or dies in setup still spends an attempt: the
  report step is gated on `always()`, so it reaches its neither-success-nor-
  failure branch and writes an eval marker with a sentinel timestamp and the
  round advanced by one. Only a run killed before that finalizer runs is free.
  So the error direction is an EARLY release, not a delayed one, and the
  alternative (a dedicated counter that the finalizer incremented) would not
  change it.
- The "budget spent" note posts before the DELETE, and is deduplicated per
  window: if the DELETE fails, the next scan retries only the DELETE.
- The release note must land before the label goes: a failed note leaves the
  label in place and the next scan retries both, because once the label is gone
  the PR is in neither selection pool and nothing would ever re-post it.
- A budget below `CRITICAL_ONLY_AFTER_ROUND` keeps every budgeted round
  suggestion-capable. That is intended: the point of a budget is to shorten the
  engagement, not to narrow it.
- The budget is live while `autofix/takeover` is present, or — for a bot-authored
  PR whose budget is already SPENT — until a `takeover-ack released` marker moves
  the engagement floor. So an explicit `stop` ends it, while the shepherd's
  silent auto-release (and a hand-removal, which leaves no marker either) leaves
  the PR parked at N/N with `autofix/needs-human` until a new command moves the
  floor. An unspent budget dies with the label, which is what keeps `stop` able
  to clear a bot PR that was paused mid-budget.
- The budget rides on the engage ack, so an ack that never lands loses it and the
  engagement degrades to unbounded takeover. This is the seed marker's existing
  exposure rather than a new failure mode: the command job retries the ack once
  and warns loudly. The scan's heal ack has two triggers — no ack at all, or a
  label event newer than the last ack — and neither carries the budget, so a
  maintainer who re-applies the label by hand re-anchors the window and silently
  loses the remaining budget. A hand-applied label never had one: the label, not
  the command, is what engages management. Persisting the number anywhere else
  would need a second writer for a case the label already makes visible.

## Validation

- Parser replay of every accepted and rejected body shape.
- Ack replay pinning the marker on both the fresh-engage and re-arm paths.
- Cap-read replay proving the budget lowers the effective cap, that the
  engagement floor (not the window key) is what carries it across an automatic
  re-arm, and that the census keeps `win=none` markers out.
- Cap-branch replay proving the release path posts one note, deletes the label,
  and never APPLIES `autofix/needs-human` — while the deferred (forced-dispatch)
  pass pauses, quotes the attempts in its notices, and has its escalation
  cleared by the release that follows, 404 included.
- Not verifiable locally end to end: the command only runs in the upstream
  repository with the bot PAT. The shell blocks are replayed verbatim from the
  workflow file, so drift fails the suite.

## Open questions

- Should `for N` also be accepted together with `from M` (e.g. "this PR already
  had 4 rounds, give it 2 more")? Deferred: the two knobs answer different
  questions and combining them doubles the parser surface for a case no
  maintainer has asked for.
