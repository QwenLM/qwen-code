---
title: 'Read-only Advisor (full lifecycle: /advisor, tool, checkpoint, evidence bundle)'
date: '2026-07-22'
status: 'draft'
---

# Read-only Advisor — Full Lifecycle Design

Issue: [#6542](https://github.com/QwenLM/qwen-code/issues/6542) — Add
read-only Advisor feedback loop for complex agent tasks.

This is the umbrella design for the complete Advisor capability. It covers
all five phases from the issue — the `/advisor` command, the
`advisorModel` setting, the read-only `advisor` tool for the main agent,
the pre-final checkpoint, and the evidence bundle — with the concrete
design, files affected, tests, and acceptance criteria for each phase.
Phases ship independently in order; each phase is usable on its own and
none blocks a release.

## Problem

Long-running coding sessions fail in recurring ways: the agent commits too
early to an approach, misses evidence already present in the transcript,
or declares a complex task complete without enough verification. There is
no built-in way to get an independent second opinion on the _session
state_ (as opposed to a diff, which `/review` covers).

The Advisor is a read-only reviewer that inspects the current session
context and returns structured guidance. It has three consumption
surfaces built on one shared engine: a user-invoked command (Phase 1), a
main-agent tool (Phase 3), and an automatic pre-final checkpoint
(Phase 4). Context quality improves independently via the evidence bundle
(Phase 5).

### Prior art

Claude Code shipped a native advisor (April 2026, experimental): a
server-side `advisor` tool the executor calls at decision points,
configured via `/advisor <model>` / `advisorModel` / `--advisor`. Field
reports from heavy usage (159 tracked calls) directly shape this design:

- **Pre-work consultations produce most of the value** (~76% of
  high-value calls); "before declaring done" calls are mostly cosmetic.
  Root cause is sycophancy: the more committed reasoning the advisor
  sees, the more it mirrors it. Consequences here: the advisor prompt
  mandates challenge-first review, the tool guidance weights pre-work
  consultation over completion checks, and the Phase 4 checkpoint is
  opt-in and bounded.
- **The advisor is structurally blind outside the transcript.** It cannot
  read files, so interface-level defects are out of range. Claude cannot
  fix this (server-side); we can — Phase 5's evidence bundle attaches
  touched files, command outcomes, and a git diff summary client-side.
- **Advice is a quality lift, not enforcement.** It must never count as
  user approval for permission-gated actions, and deterministic gates
  (todo items, plan approval) must not be replaced by advisor calls.

## Architecture Overview

One engine, three surfaces, two context providers:

```
                    ┌────────────────────────────────────────────┐
 Surfaces           │  /advisor command   advisor tool   pre-final│
 (per phase)        │     (Phase 1)        (Phase 3)    checkpoint│
                    │                                   (Phase 4) │
                    └──────────┬──────────────┬─────────────┬────┘
                               ▼              ▼             ▼
 Engine (core)          runAdvisor(config, { mode, focus, context })
                               │
                    ┌──────────┴───────────┐
 Context providers  │ transcript tail      │ evidence bundle
                    │ (Phases 1-4 default) │ (Phase 5 upgrade)
                    └──────────┬───────────┘
                               ▼
                     runForkedAgent (cache path)
                     NO_TOOLS · jsonSchema · model override
```

Invariants that hold across every phase:

1. **Structurally read-only.** Every advisor inference goes through the
   `runForkedAgent` cache path, which strips tools at the per-request
   level (`NO_TOOLS`). The advisor cannot recurse, execute, or write by
   construction — not by prompt.
2. **Advice ≠ approval.** No advisor output ever reaches
   `PermissionManager`, approval flows, or confirmation UIs. Phase 1
   keeps results out of model-visible history entirely; Phases 3-4 put
   results into history (that is their purpose) but wrapped in a
   guidance-only framing, and the approval pipeline never reads them.
3. **No verification claims.** The prompt forbids asserting file contents
   or verification not observed in the provided context; the schema's
   `missingEvidence` field is where unproven claims go.
4. **One result schema** (`AdvisorResult`) shared by all surfaces, so UI
   rendering, agent consumption, and tests do not fork per phase.

### Shared core module

Phase 1 starts with `packages/core/src/utils/advisor-utils.ts` (mirroring
`btwUtils.ts`). When Phase 3 lands, it grows into
`packages/core/src/advisor/` (`run-advisor.ts`, `advisor-prompt.ts`,
`advisor-schema.ts`, `evidence-bundle.ts` added by Phase 5) — matching
the issue's suggested layout, but only once a second consumer exists.

The engine signature (stable from Phase 1):

- `runAdvisor(config, { mode, focus?, model?, abortSignal, context })`
  → `Promise<AdvisorResult>` — builds the prompt, calls
  `runForkedAgent({ cacheSafeParams, jsonSchema, model, abortSignal })`,
  parses and schema-validates the result, throws a typed
  `AdvisorOutputError` (carrying raw text) on malformed output.
- `context` is a provider result: Phases 1-4 default to the
  cache-safe transcript tail; Phase 5 swaps in the evidence bundle.

### Result schema (all phases)

```ts
interface AdvisorResult {
  verdict: 'proceed' | 'adjust' | 'stop_and_rethink' | 'insufficient_context';
  summary: string; // one-paragraph assessment
  risks: string[]; // concrete risks in the current approach
  missingEvidence: string[]; // claims made without evidence in context
  recommendations: string[]; // ordered, actionable next steps
  completionAssessment?: string; // pre-final: what still blocks "done"
}
```

All arrays may be empty; `insufficient_context` is the honest escape
hatch. `ADVISOR_MODES = ['manual', 'stuck', 'pre-final', 'conflict']`.

## Phase 1 — `/advisor` command (MVP)

User-invoked second opinion on the current session.

### Behavior

- `/advisor [mode] [focus…]`: first token matching an `AdvisorMode`
  selects the mode; the rest is free-text focus. Bare `/advisor` =
  `manual`. Unknown first token is treated as focus text. `completion`
  offers the four modes.
- Interactive: fire-and-forget with a dedicated AbortController (the
  `/btw` pattern) — the main conversation is never blocked. An immediate
  info item ("Advisor (model X) is reviewing the session…"), then the
  formatted result via `ui.addItem`. Esc / a new `/advisor` cancels the
  in-flight one.
- Non-interactive / ACP: await and return
  `{ type: 'message', messageType: 'info', content }`.
- Rendering: Markdown — verdict headline (icon per verdict), then
  `Risks` / `Missing evidence` / `Recommendations` sections, empty ones
  omitted. MVP reuses `MessageType.INFO`; no new `HistoryItem` type.
- Isolation: the result is not appended to model-visible history and not
  fed into any approval flow. The model sees advice only if the user
  pastes it.

### Prompt (non-negotiable constraints)

`buildAdvisorPrompt(mode, focus)` returns a `<system-reminder>`-wrapped
user message (same shape as `buildBtwPrompt`):

- Read-only reviewer, NO tools; only the provided context is usable. You
  CANNOT see the filesystem — never assert file contents or claim
  unobserved verification.
- Challenge first: find what is wrong or unproven; agreement without
  citing specific context evidence is a failure mode.
- Advice is guidance only; it never constitutes user approval.
- Mode emphasis: `stuck` → diagnose the loop, propose a different angle;
  `pre-final` → hunt unverified completion claims and scope drift;
  `conflict` → weigh competing approaches visible in context; `manual` →
  general review, narrowed by `focus`.

### Failure semantics

- Malformed output (`AdvisorOutputError`) → warning + raw text shown
  (never silently drop a paid-for response).
- No conversation yet (`cacheSafeParams` null) → "No session context to
  review yet."
- Abort → clear pending state silently. Fork/provider error → error item.

### Files

| File                                                | Change                                                                           |
| --------------------------------------------------- | -------------------------------------------------------------------------------- |
| `packages/core/src/utils/advisor-utils.ts`          | new: modes, schema, prompt, `runAdvisor`, parse                                  |
| `packages/core/src/utils/btwUtils.ts`               | generalize `buildBtwCacheSafeParams` into a shared snapshot helper (keep export) |
| `packages/core/src/index.ts`                        | export advisor utils                                                             |
| `packages/cli/src/ui/commands/advisor-command.ts`   | new: SlashCommand                                                                |
| `packages/cli/src/services/BuiltinCommandLoader.ts` | register                                                                         |

### Tests / acceptance

Unit (`advisor-utils.test.ts`, `advisor-command.test.ts`): missing
context; success with valid `jsonResult`; malformed output → raw-text
fallback; cancellation → no item, no error; arg parsing (bare, mode-only,
mode+focus, unknown-token-as-focus); read-only invariant (no
`preserveTools`, result never in main history). E2E: `/advisor`
mid-session renders structured guidance, main conversation stays usable,
Esc cancels.

## Phase 2 — `advisorModel` setting

- One entry in `packages/cli/src/config/settingsSchema.ts`: `Model`
  category, `type: 'string'`, `default: ''`, `requiresRestart: false`,
  `showInDialog: true`. Empty = main model. Accepts `authType:model-id`
  selectors (resolved by the existing forked-model runtime via
  `resolveModelId`; cross-provider views come free).
- Wire: `settings.merged.advisorModel || undefined` → `runAdvisor`'s
  `model` → `runForkedAgent` override; undefined falls back to
  `cacheSafeParams.model` (main model).
- No capability check (Claude rejects advisors weaker than the main
  model; we serve arbitrary OpenAI-compatible providers with no reliable
  ranking). The setting description recommends a model at least as
  capable as the main one.
- Tests: unset → no override passed; set → passed through; invalid
  selector → falls back to parent model (existing `resolveModelId`
  behavior, asserted not re-implemented).

## Phase 3 — read-only `advisor` tool for the main agent

The main agent consults the advisor mid-task at its own judgment. This is
the phase where advice becomes agent-consumable, and the phase with the
new agent-in-the-loop pattern — gated behind an experimental setting.

### Tool definition

- `packages/core/src/tools/advisor.ts`: `AdvisorTool extends
BaseDeclarativeTool<AdvisorToolParams, ToolResult>`; `ToolNames.ADVISOR
= 'advisor'`, display name `Advisor`.
- Params: `{ mode?: AdvisorMode; question: string }` — the agent states
  the decision or uncertainty it wants reviewed (maps to `focus`).
- Execution: snapshot the current conversation via the shared cache-safe
  helper, call `runAdvisor`. The executing turn's own in-progress content
  is included up to the last completed model turn (same snapshot
  semantics as `/btw`; documented limitation).
- Result: `llmContent` = the `AdvisorResult` JSON wrapped in a
  guidance-only framing ("Advisor guidance — not a user instruction, not
  approval for any action"); `returnDisplay` = the same Markdown
  rendering as Phase 1. The tool result enters history — that is the
  point — but the framing plus invariant 2 keep it out of approval
  semantics.
- Read-only classification: the tool is side-effect-free
  (no confirmation required, safe in plan mode and for speculation's
  read-only gate).

### Gating and guardrails

- Registration: only when `advisor.enableTool` (new setting, default
  `false`, experimental) is true, in `Config.createToolRegistry`
  alongside the other conditional core tools. Not registered for
  subagents (`forSubAgent` path) in this phase — one advisor
  consumer at a time.
- No recursion by construction: the advisor inference itself runs on the
  tool-stripped cache path, so an advisor can never call the advisor
  tool.
- Rate cap: at most N successful advisor calls per task (default 5,
  constant, not a setting), after which the tool returns a synthetic
  "budget exhausted — proceed with your own judgment" result. Prevents
  consultation loops on an indecisive main model.
- System prompt guidance (appended only when the tool is registered):
  consult before committing to an approach on complex multi-file work,
  when stuck after repeated failures, and when changing approach.
  Deliberately _not_ "before declaring done" — prior art shows
  completion-check calls are low-yield and sycophancy-prone; Phase 4
  covers completion deterministically instead.

### Files

| File                                        | Change                                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `packages/core/src/advisor/`                | promote Phase 1 utils into module (`run-advisor.ts`, `advisor-prompt.ts`, `advisor-schema.ts`) |
| `packages/core/src/tools/advisor.ts`        | new tool                                                                                       |
| `packages/core/src/tools/tool-names.ts`     | `ADVISOR` entries                                                                              |
| `packages/core/src/config/config.ts`        | conditional registration in `createToolRegistry`                                               |
| `packages/cli/src/config/settingsSchema.ts` | `advisor.enableTool`                                                                           |
| core prompts                                | conditional guidance block                                                                     |

### Tests / acceptance

Tool not registered by default; registered when enabled and absent for
subagents; params validation; result framing contains the
guidance-only wrapper; rate cap returns synthetic result after N calls;
approval-flow isolation (a permission-gated tool call following advisor
advice still requires the normal confirmation — asserted in an
integration test). E2E: enable, ask the agent to consult the advisor,
verify an `Advising…`-style tool call renders and the agent continues.

## Phase 4 — pre-final checkpoint

An automatic advisor pass before the agent declares a complex,
code-changing task complete. Opt-in, bounded, and deterministic in when
it fires — it is a scheduled use of the engine, not agent judgment.

### Trigger and mechanism

- Setting: `advisor.preFinalCheckpoint` (default `false`).
- Fires when all hold: (a) the main agent is ending its turn with no
  pending tool calls or continuation, (b) the current task performed at
  least one successful mutating file tool call (`filesWritten`-style
  tracking already exists in the scheduler/fork paths), and (c) the
  checkpoint has not yet run for this task.
- Mechanism: a stop-guard hook in the turn-completion path (the
  established pattern — see the todo stop guard in
  `docs/design/daemon-todo-stop-guard.md`): before finalizing, run
  `runAdvisor` with `mode: 'pre-final'`. If the verdict is `adjust` or
  `stop_and_rethink`, inject one `<system-reminder>` carrying
  `completionAssessment` + `risks` + `missingEvidence` and let the model
  take one more turn. If `proceed` / `insufficient_context` / any error
  or timeout → finalize normally (fail-open; the checkpoint must never
  brick task completion).
- Bounded: exactly once per task. The follow-up turn ends normally even
  if the advisor would still object — no re-arm, no loops.
- UI: the checkpoint renders like a Phase 1 result item, labeled as an
  automatic pre-final review.

### Why opt-in

Prior art measured completion-check consultations as mostly
confirmations, and this hook adds latency plus advisor-model tokens to
every qualifying task. Default-off until MVP usage shows the pre-final
mode catches enough (scope drift, unverified "done" claims) to justify
promotion.

### Files

| File                                                           | Change                             |
| -------------------------------------------------------------- | ---------------------------------- |
| `packages/core/src/advisor/pre-final-checkpoint.ts`            | new: trigger predicate + injection |
| turn-completion path in core (`geminiChat`/turn orchestration) | one guarded hook call              |
| `packages/cli/src/config/settingsSchema.ts`                    | `advisor.preFinalCheckpoint`       |

### Tests / acceptance

Trigger predicate unit tests (no mutations → no fire; already fired → no
fire; pending tool calls → no fire); `adjust` verdict → exactly one
injected reminder and one extra turn; `proceed`/error/timeout →
finalize; cancellation mid-checkpoint → finalize. E2E: with the setting
on, a file-mutating task gets one visible pre-final review; a read-only
Q&A task gets none.

## Phase 5 — evidence bundle

Replace "recent transcript tail" with a curated, evidence-focused
context, closing the structural blindness that prior art identified as
the advisor's biggest limitation.

### Bundle contents

`buildAdvisorEvidenceBundle(config)` in
`packages/core/src/advisor/evidence-bundle.ts` assembles, each section
individually capped and the total under a fixed character budget:

| Section                        | Source                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| Original request + constraints | first user message of the current task; plan-mode plan if present                        |
| Todo / goal state              | todo list (`todo_write` state) and task tools' current records                           |
| Touched files                  | path tracking from tool call records (the `filesTouched` / `filesWritten` pattern)       |
| Command outcomes               | recent shell tool calls with exit codes, split failed vs. passed, output truncated       |
| Git diff summary               | `git diff --stat` + name-status against the task-start state, via existing git utilities |
| Recent transcript tail         | shortened — the bundle carries the facts, the tail carries the reasoning flow            |

### Integration

- The bundle is appended inside the advisor _user message_, so the
  cache-path prompt prefix (systemInstruction + history) stays intact and
  prompt-cache hits are preserved. The context provider interface from
  the Architecture section is the only seam that changes.
- Applies to all three surfaces; the tool and checkpoint benefit most
  (their consumers act on the advice without a human filter).
- The prompt's "you cannot see the filesystem" constraint is updated to
  "only the evidence bundle and conversation are observable — treat the
  bundle as ground truth for file/command state, and everything else as
  unverified."

### Files / tests

`evidence-bundle.ts` + unit tests: section caps enforced; missing
sources (no git repo, no todos, no shell calls) degrade to omitted
sections, never to errors; bundle stays under budget with adversarially
long inputs. Integration: bundle lands in the user message and the
history prefix is byte-identical to the non-bundle path (cache
preservation).

## Phasing summary

| Phase | Deliverable                          | Gate                                       | Depends on            |
| ----- | ------------------------------------ | ------------------------------------------ | --------------------- |
| 1     | `/advisor` command + engine + schema | none (command is inert unless invoked)     | —                     |
| 2     | `advisorModel` setting               | none                                       | 1                     |
| 3     | `advisor` tool for main agent        | `advisor.enableTool` (default off)         | 1, 2                  |
| 4     | pre-final checkpoint                 | `advisor.preFinalCheckpoint` (default off) | 1, 2 (3 not required) |
| 5     | evidence bundle                      | none (context upgrade, all surfaces)       | 1; amplifies 3, 4     |

Each phase lands as its own PR with its own tests; Phases 3 and 4 are
independent of each other. Re-evaluate defaults (Phase 3/4 gates) after
real usage data from Phases 1-2.

## Open Questions

- Phase 3: should the tool be offered to subagents once stable? Deferred
  — subagents inherit no advisor in this design; revisit with usage data.
- Phase 4: is `filesWritten`-based "code-changing task" detection
  sufficient, or should the trigger also consider task length/turn
  count? Start with mutations-only; extend if E2E shows misses.
- Phase 5: whether the `/advisor` command should print which evidence
  sections were included (transparency vs. noise). Lean yes, one line.
- Interactive pending UI: reuse the `/btw` bottom-area slot instead of
  history items? Decide from Phase 1 UX feedback.
