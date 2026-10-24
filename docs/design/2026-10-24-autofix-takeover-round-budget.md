# Autofix takeover round budget

[English](2026-10-24-autofix-takeover-round-budget.md) | [简体中文](2026-10-24-autofix-takeover-round-budget.zh-CN.md)

Status: implemented in this change, 2026-10-24.

## Problem statement

`@qwen-code /takeover` is the only way to hand a human-authored PR to the
autofix loop, and it is deliberately persistent: it applies `autofix/takeover`,
raises the round cap from 10 to 100, and the ten-minute scan keeps managing the
PR until the label is removed or a circuit breaker fires.

Maintainers routinely want something narrower — "look at this feedback, fix it,
then leave the PR alone" — and today they have to express it through the
persistent mechanism:

- `@qwen-code /takeover from 99` spends the whole cap in one round, so the
  next scan pauses the PR. The counter is already past
  `CRITICAL_ONLY_AFTER_ROUND`, so that round is Critical-only and suggestions
  are merely recorded; the pause also applies `autofix/needs-human` and posts a
  "reached its round cap" notice, which reads as a failure rather than as a
  finished, bounded engagement.
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
exactly like the bare command and additionally records a **window-scoped round
budget of N** on the engage/re-arm ack:

```
<!-- takeover-ack engaged -->
<!-- autofix-round-budget 3 -->
```

The effective round cap for that window becomes `min(takeover cap, N)`, so the
loop runs at most N rounds and then stops touching the PR.

## Behavior at the boundary

| State                                                  | What happens                                                                                                                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Budget spent on a human-authored PR                    | One bilingual "budget spent — released" note, then `autofix/takeover` is removed. No `autofix/needs-human`, no paused notice.                                                |
| Budget spent on a bot-authored PR                      | The label is NOT removed (the bot PR is managed without it), so it lands on the existing paused path: paused notice + `autofix/needs-human`. The budget still stops it at N. |
| A breaker stops the loop BEFORE the budget is spent    | The existing paused path runs: paused notice + `autofix/needs-human`. A breaker asks for a human, so it is never reported as a finished budget.                              |
| `/retry` or a bare `/takeover` after a budgeted window | Opens a new window with no budget — unbounded takeover, as today.                                                                                                            |
| Budget window superseded while a round is queued       | The existing window-key check discards the queued job — conflicts included — so no old-cap work runs past the new limit.                                                     |

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

2. **The budget is window-scoped through the ack.** It rides as its own marker
   on the comment whose `created_at` is the window key, exactly like
   `autofix-round-start`. A superseded window's budget can never leak forward,
   and re-arming resets it by construction.

3. **Exhaustion releases instead of escalating.** `autofix/needs-human` means
   "the loop stopped and a human must unstick something"; a finished budget
   leaves nothing stuck, so the label and the paused notice would both be false.
   Release is just the label DELETE, so the PR leaves the managed pool on its
   own.

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

## Files affected

- `.github/workflows/qwen-autofix.yml` — parser, route output wire, engage/re-arm
  ack markers, scan budget read and cap override, cap-branch release.
- `.github/workflows/qwen-autofix-round-seed.md` — operator guide for both
  parameterized forms.
- `.github/workflows/qwen-autofix.md` — rationale record.
- `.github/workflows/.size-baseline` — ratchet entry.
- `scripts/tests/qwen-autofix-workflow.test.js` — parser, ack, cap-read and
  release coverage.

The workflow file sits against a hard 470,000-byte start-runs gate, so this
change also moves duplicated `env:` commentary into the rationale record
(af-160), leaving a one-line summary plus a pointer per constant. That is a
prose move only — no constant, default, or behaviour changes.

## Scope boundaries

- No change to the round caps, the failure/convergence breakers, the
  Critical-only brake, the growth budgets, or the fleet shepherd.
- No new labels. Budget exhaustion deliberately does NOT use
  `autofix/needs-human` on human-authored PRs.
- No change to admission: the same author/write+ gate, fork rules and
  `autofix/skip` precedence apply to `for N` as to the bare command.

## Risks and limitations

- A run cancelled before prepare writes no marker, so that round is free. The
  error direction is a delayed release, never an early one, and the alternative
  (a dedicated counter written from the always() finalizer) buys a much larger
  surface for one edge case.
- The "budget spent" note posts before the DELETE, and is deduplicated per
  window: if the DELETE fails, the next scan retries only the DELETE.
- A budget below `CRITICAL_ONLY_AFTER_ROUND` keeps every budgeted round
  suggestion-capable. That is intended: the point of a budget is to shorten the
  engagement, not to narrow it.
- The budget rides on the engage ack, so an ack that never lands loses it and the
  engagement degrades to unbounded takeover. This is the seed marker's existing
  exposure rather than a new failure mode: the command job retries the ack once
  and warns loudly, and the scan's heal ack (posted only when no ack exists)
  carries no budget, so the maintainer sees an ack without the budget sentence.
  Persisting the number anywhere else would need a second writer for a case the
  label already makes visible.

## Validation

- Parser replay of every accepted and rejected body shape.
- Ack replay pinning the marker on both the fresh-engage and re-arm paths.
- Cap-read replay proving the budget lowers the effective cap and that a
  superseded window's budget is ignored.
- Cap-branch replay proving the release path posts one note, deletes the label,
  and never applies `autofix/needs-human`.
- Not verifiable locally end to end: the command only runs in the upstream
  repository with the bot PAT. The shell blocks are replayed verbatim from the
  workflow file, so drift fails the suite.

## Open questions

- Should `for N` also be accepted together with `from M` (e.g. "this PR already
  had 4 rounds, give it 2 more")? Deferred: the two knobs answer different
  questions and combining them doubles the parser surface for a case no
  maintainer has asked for.
