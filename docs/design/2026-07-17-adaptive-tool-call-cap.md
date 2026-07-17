# Adaptive per-turn tool-call cap

Date: 2026-07-17
Status: Implemented
Area: `packages/core` loop detection

## Problem

The always-on per-turn tool-call cap (`model.maxToolCallsPerTurn`, default 100)
is a blunt circuit breaker: it halts the turn on the 101st tool call regardless
of whether the model is actually stuck or doing productive work. Large
multi-package implementation turns legitimately exceed 100 tool calls, so the
cap kills productive work — a false positive.

Concrete case: session `80db472f-…` (qwen-code-x1, "Web Shell git status/diff
chip"). The `继续Phase 2` turn made exactly 100 tool calls and was hard-halted
mid-`npm run build` with no completion summary. Analysis of that turn and its
siblings:

| turn | tool calls | distinct (tool,args) keys | max repeat of one key | max same-name streak |
| ---- | ---------- | ------------------------- | --------------------- | -------------------- |
| 7    | 96         | 96                        | 1                     | 7                    |
| 8    | 100        | 99                        | 2                     | 3                    |
| 9    | 95         | 95                        | 1                     | 7                    |

Productive turns are highly diverse: no single `(tool, args)` call repeats more
than twice. A genuinely stuck turn repeats the same call many times.

## Design

Make the cap **adaptive**: distinguish a productive long turn from a stuck one
using a repetition signal, and only hard-halt the latter (plus an absolute
backstop).

Two thresholds derived from the configured soft cap `S = maxToolCallsPerTurn`:

- **Soft cap `S`** (default 100): when the turn exceeds `S` tool calls, halt
  only if a stuck-repetition signal is present; otherwise treat the turn as
  productive and let it continue.
- **Hard cap `S * ADAPTIVE_CAP_HARD_MULTIPLIER`** (multiplier 3 → 300 by
  default): absolute backstop. Halt regardless of repetition once exceeded, so
  a runaway that varies arguments on every call (which no repetition signal
  catches) is still bounded.

Stuck-repetition signal: the maximum number of times any single `(tool, args)`
key has appeared in the turn reaches `GLOBAL_DUPLICATE_THRESHOLD` (6). This
reuses the existing global-duplicate semantics and has a wide safety margin
(productive turns observed ≤ 2).

The same-name streak is intentionally NOT used as a gate signal: parallel tool
batches (e.g. several `read_file` of different files in one assistant message)
legitimately produce same-name streaks of 6–7, too close to the action
stagnation threshold of 8.

### Always-on tracking

The cap is always-on (not gated by `skipLoopDetection`), but the existing
`globalToolCallCounts` map is only maintained inside the gated heuristic path.
To keep the always-on cap independent of the gated path, the cap maintains its
own small always-on tracker:

- `capKeyCounts: Map<string, number>` — per-`(tool,args)` counts this turn.
- `capMaxKeyRepeat: number` — running max of any single key's count.

Maintained in `checkAlwaysOnSafeties` for every `ToolCallRequest`, cleared in
`reset()` and on `Retry` (consistent with how the heuristic path clears
`globalToolCallCounts` on retry).

## Behavior matrix (soft cap `S`, hard cap `H = 3S`)

| total calls     | repetition signal    | result             |
| --------------- | -------------------- | ------------------ |
| `≤ S`           | any                  | allow              |
| `S < total ≤ H` | max key repeat `< 6` | allow (productive) |
| `S < total ≤ H` | max key repeat `≥ 6` | halt (stuck)       |
| `> H`           | any                  | halt (backstop)    |

When `S ≤ 0` the cap is disabled (`getMaxToolCallsPerTurn()` returns
`Infinity`); behavior is unchanged (never fires).

## Files changed

- `packages/core/src/services/loopDetectionService.ts` — adaptive cap logic +
  always-on tracker.
- `packages/core/src/services/loopDetectionService.test.ts` — updated cap tests
  - new adaptive cases.
- `packages/cli/src/config/settingsSchema.ts` — `maxToolCallsPerTurn`
  description.
- `docs/users/configuration/settings.md` — same.

## Non-goals / follow-ups

- Resuming a halted turn in place (architecturally infeasible: the turn is
  already returned when the dialog appears).
- Changing the loop-detected dialog UI (separate improvement).
- A separate config knob for the hard cap (derived from the soft cap; raising
  `maxToolCallsPerTurn` scales both).
- A recency-windowed or result-aware stuck signal. The current signal is a
  monotone per-turn max: the same `(tool, args)` repeated 6 times anywhere in
  the turn marks it stuck, even if those repeats are legitimate (e.g. re-running
  the same build/test after successive fixes). This is never a regression — the
  signal only acts past the soft cap, where the old cap always halted — but that
  productive class does not benefit. The "productive turns repeat ≤ 2" evidence
  comes from one session's three turns; revisit with a windowed signal if
  telemetry shows this false-stuck pattern.
- Telemetry differentiation of the two halt reasons. Soft-cap-stuck and
  hard-backstop both emit `TURN_TOOL_CALL_CAP`; a boolean/attribute on
  `LoopDetectedEvent` would tell which fired in the wild (useful for validating
  the 3× multiplier). The headless message already hedges to cover both.
- The ACP/daemon path (`recordDaemonToolCalls` in
  `packages/cli/src/acp-integration/session/Session.ts`) has its own blunt
  per-turn cap that does not use `LoopDetectionService`. It still halts at the
  soft cap regardless of repetition. Aligning it with this adaptive behavior is
  a separate follow-up (it tracks tool calls in batches and would need its own
  per-`(tool,args)` repeat tracking). The interactive TUI path that produced
  the reported false positive is fixed here.
