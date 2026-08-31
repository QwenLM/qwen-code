---
name: goal-draft
description: Turn a fuzzy intention into a /goal objective the Goal verifier can actually judge - one outcome, numbered binary "Done when" checks that leave evidence in the transcript, guardrails, a budget, and a block protocol. Use when the user wants to set or define a goal, asks whether a goal is good enough, or says "keep going until X". Usage - /goal-draft <what you want done>, or /goal-draft <existing goal> to tighten it. This skill only writes the objective; it never starts the work.
argument-hint: '[intent, or an existing goal to tighten]'
allowedTools:
  - get_goal
  - read_file
  - glob
  - grep_search
---

# /goal-draft — write a Goal the verifier can judge

Search compatibility: when `glob` and `grep_search` are not exposed, use read-only `run_shell_command` calls with `rg --files` and `rg` instead.

You are already inside the loaded `goal-draft` skill — do not call the `skill` tool to invoke it again; start with Step 0.

You are drafting the text for `/goal set`. You are NOT doing the work the goal describes. Do not edit files, do not run the checks, do not start on the task. The only deliverable is the objective text and the `/goal set` line the user can run.

## How Goals are judged (why the format below matters)

An active Goal is re-fed to the model every turn, and its completion is judged by an independent verifier that sees ONLY transcript evidence:

- Visible assistant output and tool results count as evidence. The objective itself, user prompts, and hidden reasoning do not.
- `delivered_output` evidence proves only that text was printed. It cannot prove that tests passed, files changed, or remote state changed — those need a tool result in the transcript (an `external_fact`).
- A claim that the user confirmed, chose, or approved something needs a real user message as evidence; otherwise the completion proposal is rejected.
- Vague, subjective, or open-ended conditions never accumulate enough evidence; the loop then runs until a limit is hit.

So a good objective makes the agent PRODUCE evidence: run the named check and paste the decisive output line.

## Step 0 — should this be a Goal at all?

Say no, briefly, when the request is a normal one-shot task, needs a design or product judgement call, or has no way to be checked from the agent's own output. Offer to just do it, or to write a plan instead. A goal that cannot be checked is a prompt, not a goal.

## Step 1 — check the active Goal

Call `get_goal`. If a Goal is active, ask whether to edit it (same goal, tighter wording → `/goal edit`) or replace it (`/goal set`). Never draft a second concurrent goal.

## Step 2 — ground the draft in the workspace

Before asking anything, verify what you can with `read_file`, `glob`, and `grep_search`: that named files and packages exist, and what the real check commands are (`package.json` scripts, `Makefile`, CI workflow, test config). Use those exact commands in "Done when". Never invent paths, IDs, or commands; write `<TODO: …>` for anything you cannot confirm.

## Step 3 — at most one round of questions

Ask with `ask_user_question`, 1–3 questions in one call, each with options and a recommended default. Ask only when the answer changes the check, the scope, or the budget. Typical questions:

- Which check defines success: a test command, a build, a metric threshold, a file or state assertion?
- Which environment: local, CI, staging?
- What is off limits: which files, which actions (push, delete, publish)?
- How long to try before stopping as blocked?

Rules for the questions:

- Never ask what you could find out by reading the workspace.
- Batch them into one `ask_user_question` call; do not drip one per turn.
- Only ask things only the user can answer: what counts as done, what is off limits, how long to try.
- If you cannot find a concrete way to verify the outcome, you MUST ask, offering 2–3 candidate checks. Do not skip this and do not invent one.

If you cannot ask (headless, or a client without prompts), take the recommended default and mark it `[ASSUMPTION]` in Context.

## Step 4 — draft the objective

Use exactly these labels, in this order. Keep the whole objective on one line when you hand it over — the `/goal` parser joins lines with spaces, so number items instead of relying on newlines. Body text follows the user's language; labels stay English so the verifier can match them.

```text
Outcome: <one sentence: what is true when done>
Done when: 1) <command> exits 0 and its output shows <…> (paste that line); 2) <file/state assertion provable via read or grep>; 3) …
Must not: <files not to touch; tests/thresholds not to weaken; irreversible actions not to take>
Budget: stop as blocked after <N> turns (default 20) or <M> minutes without measurable progress
On block: propose blocked with the exact blocker and the decision a human must make; never claim completion without evidence for every Done-when item
Context: <only facts the agent cannot derive: paths, branch, environment, earlier decisions>
```

Rules of thumb:

- One Outcome. Several outcomes = several goals, or a checklist file plus a single "every item in `<file>` is checked" goal.
- Every Done-when item is binary, and at least one is tool-observable (a command with an exit code or output line, a file that exists, a grep that matches).
- Prefer "the smallest safe change in `<scope>`" over open-ended refactors.
- Put anything that must not change on the way into Must not — this is what stops the loop from deleting a failing test to "pass".
- Keep it short: everything the agent can derive from the workspace stays out. Aim for under ~1200 characters.

### Weak → strong

| Weak                          | Strong                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| make checkout faster          | Outcome: checkout API p95 is below 250 ms on the documented slow path. Done when: 1) `npm run bench:checkout` exits 0 and prints a p95 below 250 (paste the line); 2) `npm test` exits 0. Must not: change the benchmark, skip tests, touch files outside `src/checkout`. Budget: stop as blocked after 20 turns. On block: report the measured p95 and what blocks it.                          |
| keep handling the PR comments | Outcome: every unresolved review thread on PR #123 is fixed or answered. Done when: 1) the review-threads query shows zero unresolved threads (paste the count); 2) CI on the head commit is green (paste the check summary). Must not: force-push, resolve a thread without replying to it. Budget: stop as blocked after 30 turns. On block: list the threads that need a maintainer decision. |
| clean up the auth module      | Not a goal — "clean" has no check. Ask what would be observable (zero lint warnings in `src/auth`? a file count? a coverage threshold?) or offer a refactor plan instead.                                                                                                                                                                                                                        |
| get the release out           | Not a goal as written — publishing is irreversible. Either narrow it to a checkable pre-release state (tag exists, changelog entry present, `npm run release:dry-run` exits 0) and put "do not publish" in Must not, or leave publishing to a human.                                                                                                                                             |

## Step 5 — self-check, then hand off

Check every line before printing:

1. "Done when" exists, its items are numbered, and each is binary.
2. At least one item names a command, exit code, file, or grep pattern and asks to paste the output.
3. No subjective adjectives as conditions (clean, better, robust, elegant, reasonable, …).
4. No "after the user confirms/approves" as a completion condition — that belongs in On block as a decision a human must make.
5. Budget or On block is present.
6. Exactly one Outcome.
7. Every path and command in Context was verified in the workspace or is marked `<TODO>`.
8. Under ~1200 characters.
9. Irreversible actions (push, delete, publish) are listed in Must not, or the user explicitly allowed them.

Then print, and nothing else:

1. The objective in a fenced code block.
2. One line the user can run as-is: `/goal set <objective on one line>` (or `/goal edit …` when tightening the active goal). Print it as plain text with no code markers, so it can be copied verbatim.
3. One sentence on what you assumed (`[ASSUMPTION]` / `<TODO>` items), if any.

Do not run /goal yourself. Do not begin the task. Stop and wait for the user.
