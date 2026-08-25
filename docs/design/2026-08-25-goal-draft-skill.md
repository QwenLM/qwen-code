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

## Later phases (not in this change)

- A `propose_goal` core tool with an approval dialog, mirroring Claude Code's `ProposeGoal` + `modelProposedGoals` (read from user/policy settings only), so the skill can offer "Set this goal" instead of a line to paste. `parseGoalCommand` keeps newlines for `set`/`edit`.
- A deterministic lint on `/goal set` (rules 1–6 above) that warns and points at `/goal-draft`, and a "refine" entry in the web-shell Goals dialog.

## Verification

- `packages/core`: `bundled-skills.integration.test.ts` parses the new SKILL.md; `goal-draft/SKILL.test.ts` (8 tests); `tsc --noEmit` clean; eslint clean.
- Built CLI run headless in a throwaway project with a `test` and `coverage` script: `/goal-draft make the auth tests pass and raise coverage` produced a six-part objective citing the real `node --test test/` and `c8 …` scripts, two `[ASSUMPTION]` notes, and a `/goal set …` line; the project tree was untouched. `/goal-draft clean up the auth module` turned "clean" into an explicit, assumption-tagged observable definition (tests pass, exports referenced, diff confined to `src/auth`) and invited the user to redefine it.
