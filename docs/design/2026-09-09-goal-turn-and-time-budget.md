# Stopping a Goal at a turn or an active-time budget

[English](2026-09-09-goal-turn-and-time-budget.md) | [简体中文](2026-09-09-goal-turn-and-time-budget.zh-CN.md)

## Problem

A Goal's autonomous continuation has one configurable ceiling: the token
budget, `GOAL_DEFAULT_TOKEN_BUDGET` of 30,000,000 by default. That ceiling
exists to bound runaway spend, and it is sized for that job -- a healthy long
run reaches it late.

It is not the bound a user reaches for when they want to cap a Goal's scope.
Asked to keep a Goal short, a user says "at most twenty turns" or "at most half
an hour", not "at most 1.2 million tokens". Today neither has any effect. The
objective template even invites the first phrasing (`Budget: stop as blocked
after 20 turns`), and `docs/users/features/goals.md` then has to say that
writing it configures nothing: it is an instruction to the model, which the
model may or may not honour, with no runtime timer behind it.

The record already carries both meters. `GoalRecord.turnCount` is incremented
by `reduceGoalTurnFinished` on every finished turn, and `activeTimeMs` is
committed by `transitionGoal` on every transition through `elapsedActiveTime`.
What is missing is a ceiling on either, and a stop when one is reached.

## Current state

- `tokenBudget?` is armed at creation from the runtime's `tokenBudgetGrant`,
  and moved forward to `tokensUsed + grant` when a resume or edit finds it
  spent (`rearmedTokenBudget`). The spent meter is never reset.
- `isGoalTokenBudgetSpent` is the single predicate behind both the runtime's
  stop and the reducer's re-arm, so the two cannot desynchronize.
- `queueContinuation` is the only path to an autonomous continuation. When the
  budget is spent it grants exactly one wind-down hand-off turn -- marked on
  the record as `windDownTurnId` once delivered -- and then settles the Goal as
  `usage_limited` with `limitKind: 'token_budget'` via `stopForSpentBudget`.
- Every surface renders a `usage_limited` Goal from its `status` and shows
  `lastReason` as prose. No surface maps `limitKind` to display text.

## Goals and non-goals

In scope: two operator settings that stop a Goal at a turn count or an amount
of active time, reaching the user through the same hand-off, the same
`usage_limited` status, and the same resume semantics as the token budget.

Out of scope: showing the ceilings in the status card, pill, or Web Shell
strip; changing what `tokensUsed` measures; per-turn or per-tool-call bounds;
and any change to the `Budget:` line in the objective template beyond
correcting the documentation that describes it.

## Design

**Two ceilings, shaped exactly like the token one.** `GoalRecord` gains
`turnBudget?` and `activeTimeBudgetMs?`. Both are absolute: the Goal stops when
`turnCount >= turnBudget`, or when elapsed active time reaches
`activeTimeBudgetMs`. Both are armed at creation from a grant, both move
forward on the resume or edit of a Goal that has spent them, and neither is
ever retrofitted onto a Goal created without one. `isGoalTurnBudgetSpent` and
`isGoalActiveTimeBudgetSpent` are the paired predicates, used by the runtime
and the reducer alike.

`isGoalActiveTimeBudgetSpent` takes the elapsed figure as an argument rather
than computing it, because active time keeps accruing while a Goal is `active`
and the caller is the one holding the clock. A stopped Goal's elapsed time is
its committed `activeTimeMs`, which is what makes the re-arm well defined:
`elapsed + grant`, measured against the same figure `transitionGoal` is about
to commit.

**Checked at the continuation boundary, never mid-turn.** All three ceilings
are read in `queueContinuation` through one new reader, `spentBudget`, which
returns the kind and the reason or nothing. A turn that crosses a ceiling still
runs to completion; the Goal stops before the next one is minted. This is
already how the token budget behaves, and it is the property that keeps a
budget from cutting a model off mid-thought.

**One reason per stop, token first.** When a single turn crosses more than one
ceiling, `spentBudget` reports token, then turns, then time. The token budget
is the one armed by default, so it is the one a user is likeliest to be asking
about. `limitKind` gains `'turn_budget'` and `'time_budget'`, and
`isGoalBudgetLimitKind` groups all three.

**The resume branch widens.** `reduceGoalControl`'s budget resume existed only
to clear `lastReason` and `limitKind`, and it keyed off `token_budget`
literally. Left alone, a turn-stopped Goal would resume still rendering "ran
its turn budget" as the reason it is currently active. It now keys off
`isGoalBudgetLimitKind`.

**Each budget re-arms independently.** A resume granted because the turns ran
out moves the turn ceiling and leaves an untouched token window exactly where
it was. Widening a ceiling nobody complained about would spend an
authorization the user did not give.

**Defaults are nothing, not a number.** Unlike the token budget, an absent or
invalid setting arms no ceiling at all. A cadence is a scope the operator
chooses; there is no number the project could pick on their behalf that would
be more right than "no ceiling". `0` and `-1` are explicit opt-outs, and the
runtime spells "arm nothing" as a non-finite grant, because `Infinity` would
not survive the JSON journal.

**Caps are typo guards.** `GOAL_MAX_TURNS_CAP` is 10,000 turns and
`GOAL_MAX_ACTIVE_MINUTES_CAP` is one week of active time. Neither is a policy
on long runs: an operator who wants more autonomy than that wants no ceiling,
which is the default. The CLI rejects an out-of-range value at startup, the
same way it rejects `model.goalTokenBudget`, so a misplaced zero surfaces as a
message rather than as a Goal that silently runs unbounded.

**Named `model.goalMaxTurns` and `model.goalMaxActiveMinutes`.** A `goals.*`
settings group exists, but it holds the model-proposal consent setting: it is
`requiresRestart: true` and ignores workspace scope. The two existing Goal
budget settings live under `model.*`, take effect without a restart, and are
settable per workspace, and they already have a three-layer validation path
(`validateGoalTokenBudget` → `resolveGoalTokenBudget` → `ConfigParameters`).
These two are budgets, so they follow their siblings.

**The hand-off prompt stops naming the token budget.** The hosts carry a plain
`windDown` boolean, so the wind-down line cannot say which ceiling was
reached. It now points at the budget line above it, which does. That budget
line becomes multi-segment -- tokens, turns, and, only when a time ceiling is
armed, active minutes -- so the model can see which allowance ran out.
Elapsed time with no ceiling to measure it against is left out entirely: it
would be a figure on every turn that nothing acts on.

## Scope

- `packages/core/src/goals/goal-protocol.ts`: the two `GoalLimitKind` values,
  `isGoalBudgetLimitKind`, the two record fields, `isGoalTurnBudgetSpent`,
  `isGoalActiveTimeBudgetSpent`, `goalTurnBudgetReason`,
  `goalActiveTimeBudgetReason`.
- `packages/core/src/goals/goal-reducer.ts`: the two grants on
  `GoalControlTransition`, `armedBudget` at creation, `rearmedTurnBudget`,
  `rearmedActiveTimeBudget`, `rearmedBudgets`, the widened resume condition,
  and the parser's key list, validation, rehydration, plus `transitionGoal`'s
  deletion branches.
- `packages/core/src/goals/goal-runtime.ts`: the two grants on
  `CreateGoalRuntimeOptions`, `spentBudget`, and its use in
  `queueContinuation`, `stopForSpentBudget`, `finishTurn`'s no-progress yield
  list, and `flushContinuation`'s `usage`.
- `packages/core/src/goals/goal-continuation-prompt.ts`: the widened
  `GoalContinuationUsage`, the multi-segment budget line, the wind-down line.
- `packages/core/src/config/config.ts`: the two parameters, their caps,
  validators and normalizers, the two grants, and the runtime wiring.
- `packages/cli/src/utils/runBudget.ts`, `packages/cli/src/config/config.ts`,
  `packages/cli/src/config/settingsSchema.ts`: startup validation, resolution,
  and the two schema entries, plus the regenerated
  `packages/vscode-ide-companion/schemas/settings.schema.json`.
- `packages/sdk-typescript/src/daemon/types.ts` and
  `packages/web-shell/client/daemon/session/mappers.ts`: the two new
  `limitKind` values and the two new record fields. The Web Shell parser
  rebuilds the record from an explicit whitelist, so a field it does not name
  is dropped on the live path.

No host changes. Every surface already renders a `usage_limited` Goal and its
reason.

## Constraints and risks

- **A cadence stop must not read as idleness.** The no-progress bound pauses a
  Goal that produced nothing for three turns. A Goal that crosses a cadence
  ceiling on the same turn is owed its hand-off and a resumable
  `usage_limited` stop, so the bound yields to every spent budget, exactly as
  it already yields to the token one.
- **Time is active time, not wall clock.** A Goal paused overnight resumes
  with the window it had. This is the only honest reading of a budget the user
  granted for work, and it falls out of `elapsedActiveTime` already gating on
  `status === 'active'`.
- **Idle active time still counts.** `elapsedActiveTime` accrues while the
  status is `active`, including between turns. A Goal left active without a
  host to continue it therefore spends its time window. That matches what the
  meter has always measured and what the status card already displays.
- **Two out-of-core whitelists.** The SDK's hand-copied union and the Web
  Shell's mapper each enumerate `limitKind` by value. Missing either drops the
  new kinds silently rather than loudly.
- **Default off means no behavioural change.** With both settings unset, no
  Goal carries either field and `spentBudget` reduces to the existing token
  check.

## Validation

- `goal-reducer.test.ts`: the spent-at-equality boundary; grants stamped on
  create and replace; a non-finite grant arming nothing; re-arm on resume for
  each kind and on edit; the stop prose cleared for every budget kind; an
  unspent ceiling left alone; no retrofit onto an unbounded Goal; only the
  spent ceiling re-armed; the wind-down marker dropped; an opted-out ceiling
  removed with no `undefined` key left behind; re-arm through an evidence
  resume; snapshot round-trip for both fields and both kinds; malformed
  ceilings rejected; a Goal persisted before the fields existed.
- `goal-runtime.test.ts`: no ceiling armed without a grant; the full turn-budget
  path (work turns, one hand-off, `usage_limited` with `turn_budget`, resume
  re-arming ahead of the count); the same for the time budget; active time not
  accruing while paused; one reason when a turn crosses two ceilings; the
  cadence figures reaching the host; no time figures without a time ceiling;
  a spent cadence budget outranking the no-progress bound; the stop showing
  even when the settle write fails.
- `goal-continuation-prompt.test.ts`: the turn segment beside the token one;
  active minutes only alongside their ceiling; the five whole-prompt pins
  updated for the new prefix and hand-off line.
- `config.test.ts` in core and cli, and `runBudget.test.ts`: the settings
  reaching the grants, the defaults being unbounded, each cap accepted and one
  past it rejected, and every invalid value rejected at startup.
- End to end against a real model: a Goal with `model.goalMaxTurns: 2` handing
  off on its third turn and stopping, and `/goal resume` granting another
  window; the same for `model.goalMaxActiveMinutes: 1`.

## Acceptance criteria

- With both settings unset, a Goal's record carries neither field and its
  behaviour is unchanged.
- A Goal that reaches either ceiling receives exactly one wind-down turn, then
  settles as `usage_limited` with the matching `limitKind` and a `lastReason`
  naming the budget.
- `/goal resume` clears the stop prose and the kind, and moves only the spent
  ceiling forward.
- Both new `limitKind` values survive the daemon wire into the Web Shell, and
  both new record fields survive the journal.
- An out-of-range or malformed setting fails startup with a
  `settings.json: model.goalMaxTurns` (or `goalMaxActiveMinutes`) message.

## Follow-up

- Show the cadence ceilings where the token pair is already shown: the footer
  pill, the ink and OpenTUI status cards, the headless `Usage:` line, and the
  Web Shell strip and Goals dialog.
- Reconsider whether idle active time between turns should count against the
  time budget, once there is a report of it mattering.
