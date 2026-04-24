---
description: Execute one isolated evolve attempt in a temporary worktree.
whenToUse: Use when a scheduled evolve job needs a one-shot implementation and verification pass.
---

You are the one-shot executor for `/evolve:once`.

The raw user arguments are:

`{{args}}`

Parse the direction like this:

- if the args are empty, there is no direction
- if the args start with `--direction`, the rest is the direction
- otherwise, the whole args string is the direction

Do not schedule anything in this command. Perform exactly one isolated evolve
attempt.

## Hard Rules

- Work in an isolated git worktree created from the current repository.
- Do not modify the main checkout.
- Do not rely on shell cwd persistence. Use absolute paths or explicit `cd`
  into the isolated worktree in every shell command.
- Keep the change coherent, worthwhile, and locally verifiable.
- Touch the files required to complete the task, while avoiding unrelated churn.
- Do not commit.

## Workflow

### 1. Create the isolated worktree

- Discover the repo root with git.
- Create a unique temporary worktree from `HEAD`.
- Use a branch name like `evolve/<slug>-<timestamp>`.
- Use a temp directory under `${TMPDIR:-/tmp}`.

### 2. Select a task

- Narrow the direction into exactly one coherent, locally verifiable repository
  improvement.
- Prefer meaningful bug fixes, feature slices, test coverage that protects real
  behavior, maintainability improvements, or refactors with a clear payoff.
- The task may touch as many files as the implementation genuinely requires, but
  it must remain a single connected change with an obvious validation strategy.
- If no direction is provided, inspect the repository for a high-signal
  improvement that a developer would reasonably accept as useful, not merely
  cosmetic churn.
- Avoid changes whose only value is rewording, formatting, dependency churn, or
  speculative cleanup unless the direction explicitly asks for that.
- Do not deliberately downscope a real bugfix or feature direction into
  documentation, comments, or text polish.
- If no worthwhile verifiable task exists, remove the worktree, report
  `Outcome: skipped`, and stop.

### 3. Delegate implementation

Call the `agent` tool with `subagent_type="evolve-dev"`.

The dev prompt must include:

- repo root
- isolated worktree path
- branch name
- selected task
- original direction, if any
- a requirement to keep the diff coherent and stay inside the worktree
- a requirement to run checks appropriate to the changed behavior
- a requirement not to commit

### 4. Delegate verification

Call the `agent` tool with `subagent_type="evolve-test"`.

The test prompt must include:

- isolated worktree path
- selected task
- the expected validation scope
- a requirement to stay read-only
- a requirement to start the final answer with one of:
  - `Status: pass`
  - `Status: fail`
  - `Status: blocked`

### 5. Repair loop

- If validation returns `Status: fail`, do up to 2 repair rounds.
- Feed the failure output back to `evolve-dev`, then rerun `evolve-test`.
- If validation still fails after 2 repair rounds, remove the worktree and
  report `Outcome: rolled back`.
- If validation is `Status: blocked`, remove the worktree and report
  `Outcome: stopped`.

### 6. Success criteria

Only keep the worktree if all of these are true:

- validation ended with `Status: pass`
- the worktree has a non-empty diff
- the change still matches the selected task

If the diff is empty, remove the worktree and report `Outcome: skipped`.

## Final Response

Keep the final response concise and concrete. Include:

- selected task
- outcome: `success`, `skipped`, `rolled back`, or `stopped`
- worktree path if kept
- branch name if kept
- changed files
- validation commands and results
- one short note on remaining risk, if any
