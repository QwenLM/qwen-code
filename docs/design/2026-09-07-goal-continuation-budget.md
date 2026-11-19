# Telling the model what its Goal has spent, and asking it to check its own progress

## Problem

The continuation prompt is four shared lines, a synthetic-turn guard, the data
block, and the standing objective guard. It tells the model what the objective
is and how to deliver it. It says nothing about two things the model has no
other cheap way to know.

**How much of the window is left.** A Goal stops when `tokensUsed` reaches
`tokenBudget`, 30,000,000 by default, and gets one wind-down turn to hand off.
Until that turn arrives the model has no signal at all: it cannot tell turn 3
of a long run from the turn before the budget stops it, so it cannot choose
between starting a broad investigation and finishing what it has. `get_goal`
can supply the figures, but asking on every turn would spend an extra tool call
to obtain context the runtime already holds when it schedules the turn.

**Whether the last turn accomplished anything.** The verifier only ever sees a
terminal proposal. A turn that proposes nothing is judged by nobody -- and a
turn spent restating status is exactly the turn that proposes nothing. Nothing
in the prompt asks the model to notice that its previous turn changed nothing
and to do something different.

Codex's continuation template runs to 56 lines and covers both: a budget block
with the same figures, plus work-from-evidence, no-progress, fidelity, and
completion-audit sections. Claude Code has no equivalent; its Stop hook feeds
back a refusal reason instead.

## Design

Two additions to the one place every host renders from.

**A token-budget line**, when the runtime supplies figures: what has been
spent, out of what, how much remains, and how many turns are behind it. Spelled
out with locale grouping rather than abbreviated, since a prompt is read once
by a model and not squeezed into a footer.

It sits after the standing objective guard and before the objective-updated
notice. The figures are context for the whole turn; the notice is about what
changed since the last one and reads last so it is acted on last.

It stays out of the data block deliberately. The line contains trusted runtime
figures, while the block is explicitly framed as untrusted task data. Keeping
the line outside preserves that trust boundary.

The remainder is clamped at zero. The wind-down turn runs with the window
already overspent, and a negative remainder would read as nonsense on the one
turn the figures matter most.

**Four progress lines**, on every turn except the hand-off. They ask the model
to treat the workspace rather than the conversation as authoritative, to work
toward the end state the objective asks for rather than a more easily reached
one, to judge whether its previous turn actually changed anything before
spending this one, and to check every explicit requirement against citable
evidence before proposing completion.

They are skipped on the wind-down turn, which is told not to start new work: a
line asking for "a different concrete action now" would contradict it. The
token-budget line is kept there, because a hand-off reports the numbers it
stopped at.

The judge-your-previous-turn line is also held back on the Goal's first turn.
`create` schedules a continuation before any Goal turn has finished, so on
that one turn there is no previous turn to judge, and asking for the judgement
invites the model to describe one. A host that reports no figures at all says
nothing about which turn this is, so the line stands there: silence is not
evidence of a first turn.

**Where the figures come from.** `GoalTurnHost.startGoalTurn` gains an optional
`usage`, and `flushContinuation` reads it off the record at scheduling time,
before the broadcast hands listeners a snapshot they may act on. The shared
`GoalContinuationUsage` type projects the three fields from `GoalRecord`, so
the runtime and renderer cannot drift into different shapes. The three hosts
copy it into their queue entries alongside the fields they already copy, and
pass it to the renderer. User-driven turns never render this prompt, so they
never carry figures.

`usage` remains optional on the public host and renderer contracts for
embedders that have no runtime figures. Its absence omits only the token-budget
line; the progress guidance still renders on non-wind-down turns.

## Scope

- `goal-continuation-prompt.ts`: the shared `usage` type, renderer input,
  `renderBudgetLine`, the four progress lines, their placement and their two
  exceptions, and the `buildGoalContinuationParts` pass-through.
- `goal-runtime.ts`: the `usage` field on the host contract, and reading it off
  the record in `flushContinuation`.
- `useMessageQueue.ts` and `use-llm-stream.ts`, `Session.ts`,
  `nonInteractiveCli.ts`: one field copied through each host's queue entry.
- `docs/users/features/goals.md`: what each continuation turn now tells the
  model.

Not changed: the `get_goal` and `update_goal` tool descriptions; the blocked
audit, which qwen already runs as a three-turn fingerprint check in the
runtime rather than as prompt text; and the runtime's own bounds, which are
separate work.

## Verification

- `goal-continuation-prompt.test.ts`: complete-string expectations pin both
  the ordinary production shape with usage and the wind-down shape. Focused
  cases cover the with-budget, no-budget, and overspent renderings; ordering
  checks keep the runtime figures outside the data block and above the
  objective-updated notice; first-turn and no-usage cases pin the two guidance
  exceptions.
- `useMessageQueue.test.ts`, `use-llm-stream.test.tsx`, `Session.test.ts`,
  `nonInteractiveCli.test.ts`: one case per host, pinning that the figures
  survive that host's copy. The field is optional on both sides of every hop,
  so a dropped copy typechecks and would cost the token-budget line on that
  host alone; each case fails when its copy is removed.
- `goal-runtime.test.ts`: the host receives the figures the record held when
  the turn was scheduled, before and after a turn bills; a Goal with no ceiling
  reports none; the wind-down hand-off carries them too.
- End to end against a real model: the rendered prompt read out of a session
  transcript, in this change's pull request under Evidence.
