# /review: promote language-pitfall and wrapper/proxy checks out of Agent 1a

Issue: [#9788](https://github.com/QwenLM/qwen-code/issues/9788)

## Problem

Agent 1a's brief folds two checks into its line-by-line walk as bullets:

- **Language-pitfall scanning** — carry a per-language checklist (JS falsy-zero,
  `==` coercion, closure-captured loop vars; Python mutable defaults,
  late-binding closures; Go nil-map writes, range-var capture; SQL string
  concatenation, timezone/DST arithmetic, float equality) and pattern-match the
  diff against it.
- **Wrapper/proxy routing** — a structural expectation: every method of a
  wrapping type (cache, proxy, decorator, adapter) routes through the wrapped
  instance, never back through a registry/session/global (self-re-entry), and
  the wrapper forwards every method its callers actually use.

Both are different attention modes from the line-by-line rhythm, and folded
into it they get diluted by it. The low-effort inline pass already separates
exactly these two as angles C and D; the higher tiers never got the split.

## Change

Two new Step 3A whole-diff roles, built by `agent-prompt` like every other
role, rostered and coverage-checked from the plan:

| Role | Dimension             | Rostered                                                |
| ---- | --------------------- | ------------------------------------------------------- |
| `1d` | Language-pitfall scan | high effort, always (3A)                                |
| `1e` | Wrapper/proxy routing | high effort, when the diff signals a wrapping type (3A) |

The corresponding bullets leave Agent 1a's brief so the same ground is not
double-flagged by the briefs (overlap that happens in practice is still
handled by the existing dedup/verification stages, as with any two dimensions).

### Effort gate

Same shape as the adversarial personas (6a/6b/6c): `plan.effort !== 'medium'`.
`low` never fans out agents, so "not medium" is the high gate the roster
already uses. Medium keeps its reduced set; the fail-safe (no effort recorded)
keeps the full roster, now including 1d/1e.

### 1e's conditional roster signal

The capture commands already parse the diff (`parseDiff`), so the signal is
computed there at plan time and written into the plan report as a single
top-level boolean `wrapperSignal`:

- a file **path** matches the wrapper vocabulary, or
- an **added line** (`+`) matches it.

Vocabulary (case-insensitive substring, no word boundaries — PascalCase names
like `CachedModelProvider` carry no boundary between the words):
`wrapper`, `proxy`, `decorator`, `adapter`, `delegate`, `facade`, `cached`,
`caching`. Bare `cache` is deliberately out: it is too common as an ordinary
identifier for the gate to stay a gate.

The roster predicate is fail-safe, mirroring 1b's `hasDeletions` precedent
(and correcting the issue's "mirror Agent 8" phrasing — Agent 8 is optional by
construction and never rostered; the conditional-roster precedent is 1b):
**only an explicit `wrapperSignal: false` keeps 1e out of the roster.** An
absent field (a plan written by an older CLI — measured version skew), a
garbage value, or `true` all roster it. Since 1a loses the clause in this same
change, a detection miss must not leave the class owned by nobody; a false
positive costs one agent that returns an empty-scope receipt.

Detection recall is imperfect by design — a wrapping type with no vocabulary
word in its name or diff lines (`class FastThing { constructor(private slow: Thing) }`)
skips the gate. The issue asked for a cheap plan-time signal with this
trade-off; the fail-safe covers ambiguity of the signal, not absence of it.

### Topology: Step 3A only

1d/1e are whole-diff walkers like 1a, so they exist only in the 3A branch of
`requiredAgents`. Under the 3B territory fan-out, chunk agents already own
every dimension for their own lines — including these two, generically, as
today (`buildChunkAgentPrompt`'s "you own every dimension" block). The
detailed checklists are NOT attached to the chunk brief in this change:

- 3B coverage of these checks is unchanged by the split (the bullets lived in
  1a's brief, and 3B never ran 1a's brief anyway — no regression).
- Attaching two more lenses to 17+ chunk briefs is a separate surface (scope
  framing, brief-size budget, tests) the issue does not ask for.

SKILL.md's 3B ownership sentence is updated to keep naming the checks.

### No repository-context allow-list entry

`REPOSITORY_CONTEXT_ROLES` is not extended: a manifest cannot require 1d/1e
back, same as it cannot require the personas into a medium review. Both are
effort-gated cost decisions the roster owns.

## Files affected

- `packages/cli/src/commands/review/lib/agent-briefs.ts` — `RoleId` union,
  `BRIEFS['1d']`, `BRIEFS['1e']`, 1a's two bullets removed.
- `packages/cli/src/commands/review/lib/diff-plan.ts` — wrapper vocabulary,
  per-file signal during `parseDiff`, `DiffPlan.wrapperSignal`.
- `packages/cli/src/commands/review/lib/report.ts` — `wrapperSignal` carried
  into `PlanReport` (all three capture commands spread `buildPlanReport`, so
  the field rides through `fetch-pr` / `capture-local` / `plan-diff`).
- `packages/cli/src/commands/review/lib/roster.ts` — `RosterPlan.wrapperSignal`,
  `hasWrapperTypes(plan)`, 1d/1e in the 3A high branch.
- `packages/core/src/skills/bundled/review/SKILL.md` — agent counts, medium
  skip list, `--role` selector list, 3B ownership sentence, whiff-check agent
  list, role table (trim 1a, add 1d/1e rows).
- `packages/cli/src/commands/review/agent-prompt.ts` — extends the existing
  diff-only precision-degradation clause to 1e (its forwarding-completeness
  walk greps call sites that live outside the diff, like 1b's replacements
  and 1c's consumers).
- `docs/users/features/code-review.md` — agent counts, capability table,
  cost table.
- Tests: `roster.test.ts`, `diff-plan.test.ts`, `report.test.ts`,
  `agent-prompt.test.ts`, `SKILL.test.ts`, plus any fixture the larger 3A
  roster reaches.

`check-coverage` and `compose-review` need no code change: they are BRIEFS-
and `requiredAgents(plan)`-driven. (`agent-prompt` only extends the existing
diff-only degradation clause to 1e — see "Files affected".)

## Scope boundaries

- No change to the low-effort inline angles (C and D stay as they are).
- No chunk-brief lens attachment (see Topology above).
- No DESIGN.md rewrite (historical record).
- 1d/1e are not budget-exempt; they get the ordinary diff-derived tool budget.

## Open questions

None — triage's two design notes are resolved above (fail-safe rostering; 3B
coverage left explicit-but-generic, no lens attachment).
