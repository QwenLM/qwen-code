# goal-draft: a bundled skill that writes verifier-judgeable Goals

## Problem

`/goal <objective>` accepts any non-empty string. The objective is judged by an independent verifier that only sees transcript evidence (`goalJudge.ts`, `goal-verifier.ts`): printed text cannot prove that tests passed or files changed, claims about user actions need a real user message, and an objective nobody can evidence keeps the loop running until a limit stops it. Nothing in the product tells users this. The only guidance was the web-shell placeholder `all tests pass and the lint is clean`, which itself has no check attached.

## Survey

The closest existing analogues both converge on the same shape: OpenAI's curated `define-goal` skill for Codex `/goal` (one objective string; five questions — what will be true, what evidence proves it, what threshold, what scope, when to stop and ask; at most one clarifying question) and the community `agent-goal-skill` (a fixed Goal / Context / Constraints / Done when / On block block, binary shell-checkable criteria, `<TODO>` for unknowns). Claude Code's `/goal` documentation asks for "one measurable end state, a stated check, constraints that matter" and a turn/time clause; Claude Code has no goal-writing skill — its `ProposeGoal` tool prompt carries the rules instead (≤500 characters, verifiable from the conversation alone, never widen scope). Ralph-style loops push the stop condition into the harness and rank guardrails; Anthropic's long-running-agent harness note flags "editing tests to pass" as the failure to forbid. Spec/PRD skills (superpowers, ai-dev-tasks, spec-kit, Kiro EARS, BMAD) contribute the interview discipline: batch questions, offer options, mark assumptions instead of blocking, and never start implementing.

What differs for an autonomous loop versus a PRD: the stop condition must be machine-checkable, there must be a negative stop (budget) and a block protocol, the same agent grades itself so cheap exits must be forbidden, and the whole thing must fit one session's evidence budget.

## Design

A bundled skill at `packages/core/src/skills/bundled/goal-draft/SKILL.md`, registered like every bundled skill as `/goal-draft` (model-invocable too). It is instructed to be read-only and auto-approves only the non-mutating tools (`get_goal`, `read_file`, `glob`, `grep_search`); `allowedTools` is an additive grant, so the read-only discipline is enforced by the skill's prose. `ask_user_question` is deliberately not granted: an allow rule for it would override the tool's `'ask'` default session-wide and run it without the question dialog, fabricating a declined-answer result. It never runs the checks, never edits, and cannot call `/goal` (built-in commands are not model-invocable by design).

Steps:

0. Decide whether the request is a Goal at all; one-shot tasks and judgement calls are not.
1. `get_goal`; if a Goal is active, offer `edit` versus `set`, never a second concurrent goal.
2. Ground in the workspace: verify named files and find the real test/lint/build commands; never invent paths, mark unknowns `<TODO>`.
3. At most one round of 1–3 multiple-choice questions, only when the answer changes the check, scope, or budget; if no verification path can be found the skill must ask rather than invent one; headless takes the recommended default and marks `[ASSUMPTION]`.
4. Draft in a fixed contract, one paragraph, English labels: `Outcome:` / `Done when:` (numbered, binary, at least one tool-observable with "paste that line") / `Must not:` / `Budget:` / `On block:` / `Context:`.
5. Self-check nine rules (binary items, a named check, no subjective adjectives, no "after the user confirms", budget or block clause, one outcome, verified context, length, irreversible actions in Must not) and print the objective plus a one-line `/goal set …` the user can run as-is. Stop.

The labels map onto verifier rules: `Done when` items produce `external_fact` evidence; `Must not` closes the exits the verifier cannot see; `On block` routes decisions to `blockerKind: authority` instead of a "user confirms" completion condition; `Budget` avoids indefinite "insufficient evidence" loops.

The objective is handed over on one line because `parseGoalCommand` splits on whitespace and re-joins with single spaces, so newlines would be flattened anyway.

## Scope of this change

- The skill and its test (`SKILL.test.ts` pins the allowed tools, the step order, the contract labels, the question rules, and the "do not run /goal, do not begin the task" stop).
- `docs/users/features/goals.md` (commands, how a Goal is judged, writing a good objective, `/goal-draft`), rows in `commands.md`, a pointer from `headless.md`.
- The web-shell Goals dialog placeholder now shows an objective with a check, a guardrail, and a budget in both locales.

## Phase 2: `propose_goal`

A core tool, registered beside `get_goal` / `update_goal` (so never for subagents), only when the host can show a dialog (`resolveInteractionMode !== 'headless'`) and `goals.modelProposed` is not `disabled`. It reuses the generic `info` confirmation: the objective is in both the invocation description (the one field every host forwards — the Web Shell drops an `info` prompt) and the plain-text prompt, and `requiresUserInteraction()` is `true` so no allow rule, YOLO, or AUTO_EDIT (which auto-approves `info` confirmations) can skip the dialog. Preconditions are checked before the dialog and again in `execute()`, because `/goal` can change the session while the dialog is open: plan mode, untrusted folder, no Goal persistence, and an active Goal all refuse with guidance (an active Goal is never replaced from the tool; the model hands over a `/goal edit` / `/goal set` line instead). A stopped Goal is replaced through `replace` with its expected version; no Goal creates. The tool only dispatches; the runtime's own broadcast renders the Goal card and starts the first Goal turn after the current turn ends, so the tool result tells the model to acknowledge in one sentence and end the turn.

`goals.modelProposed` (`alwaysAsk` | `disabled`, default `alwaysAsk`) sits in `WORKSPACE_RESTRICTED_SETTINGS`, so a repository cannot switch the tool on. An `auto` mode that lets the model skip the dialog (Claude Code's `ask_user: false`) is deliberately not offered.

The skill's hand-off now prefers the tool when it is available and no Goal is active, and keeps the printed `/goal set` line for headless runs, the disabled setting, and the active-Goal case.

## Later phases (not in this change)

- `parseGoalCommand` keeps newlines for `set`/`edit`.
- A deterministic lint on `/goal set` (rules 1–6 above) that warns and points at `/goal-draft`, and a "refine" entry in the web-shell Goals dialog.

## Verification

- `packages/core`: `bundled-skills.integration.test.ts` parses the new SKILL.md; `goal-draft/SKILL.test.ts` (8 tests); `tsc --noEmit` clean; eslint clean.
- Built CLI run headless in a throwaway project with a `test` and `coverage` script: `/goal-draft make the auth tests pass and raise coverage` produced a six-part objective citing the real `node --test test/` and `c8 …` scripts, two `[ASSUMPTION]` notes, and a `/goal set …` line; the project tree was untouched. `/goal-draft clean up the auth module` turned "clean" into an explicit, assumption-tagged observable definition (tests pass, exports referenced, diff confined to `src/auth`) and invited the user to redefine it.
