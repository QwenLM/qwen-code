---
description: Run one safe repository improvement now, or schedule it to repeat in this session.
whenToUse: Use when you want a prompt-orchestrated alternative to self-evolve with session-scoped scheduling, worktree isolation, and dev plus test subagents.
---

You are the controller for `/evolve`.

The raw user arguments are:

`{{args}}`

Your job is to interpret the invocation, use tools directly, and finish in one
turn.

## Core Rules

- Never tell the user to use `/loop`.
- Use `cron_create`, `cron_list`, and `cron_delete` directly.
- Any recurring job created by this command must store a prompt that begins
  with `/evolve:once`.
- Only treat cron jobs whose prompt starts with `/evolve:once` as belonging to
  this command.
- Keep recurring jobs session-scoped. Do not write scheduler state to disk.
- If you schedule a recurring job, immediately perform the first one-shot
  attempt in this same turn. Do not wait for the next cron fire.
- If recurring mode is unavailable because cron tools are not available, say
  that recurring `/evolve` is unavailable in the current session and stop.
- For the immediate attempt after scheduling, follow the one-shot workflow
  below in the current turn. Do not try to invoke `/evolve:once` from inside
  this same turn.

## Mode Parsing

Parse the arguments in this order:

1. Empty args: run one-shot with no direction.
2. Exactly `list`: list only `/evolve:once` jobs.
3. Exactly `clear`: delete only `/evolve:once` jobs.
4. Starts with `--once`: strip it and run one-shot.
5. Starts with `--direction`: treat the rest as the one-shot direction.
6. Starts with `--every`: parse the next interval token or interval phrase as
   the cadence; the rest is the direction.
7. Ends with `every <interval>`: recurring.
8. Starts with `每隔 <interval>` or `每 <interval>`: recurring.
9. Ends with `每隔 <interval>`: recurring.
10. Otherwise: one-shot with the full remaining text as the direction.

## Interval Parsing

Accept these interval forms:

- short English: `30m`, `2h`, `1d`, `45s`
- long English: `30 minutes`, `2 hours`, `1 day`
- simple Chinese: `30分钟`, `30 分钟`, `2小时`, `2 小时`, `1天`, `1 天`

Convert the interval to cron with these rules:

- minutes under 60: `*/N * * * *`
- hours under 24: `0 */N * * *`
- days: `0 0 */N * *`
- seconds: round up to whole minutes, minimum 1 minute
- uneven intervals such as `90m`: round to the nearest clean cadence and say
  what you rounded to

Prefer these clean minute values: `1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30`

Prefer these clean hour values: `1, 2, 3, 4, 6, 8, 12`

## Recurring Behavior

If the invocation is recurring:

1. Build the stored prompt exactly as one of:
   - `/evolve:once`
   - `/evolve:once --direction <direction text>`
2. Call `cron_create` with that prompt and `recurring=true`.
3. Mention the job id, the human cadence, and that recurring jobs auto-expire
   after 3 days.
4. Then continue into the one-shot workflow below in the same turn using the
   same direction.

## List Behavior

- Call `cron_list`.
- Show only jobs whose prompt starts with `/evolve:once`.
- If none exist, say there are no scheduled evolve jobs.

## Clear Behavior

- Call `cron_list`.
- Delete only jobs whose prompt starts with `/evolve:once`.
- Report how many scheduled evolve jobs were deleted.

## One-Shot Workflow

Use this workflow both for direct one-shot invocations and for the immediate
run that happens after scheduling.

### 1. Create an isolated worktree

- Discover the repo root with git.
- Create a unique temporary worktree from `HEAD`.
- Use a branch name like `evolve/<slug>-<timestamp>`.
- Use a temp directory under `${TMPDIR:-/tmp}`.
- Do not rely on shell cwd persistence. Every shell command must explicitly use
  the worktree path.

### 2. Select one small task

- Narrow the direction into exactly one small, safe, locally verifiable change.
- Prefer tasks that touch at most 1 to 3 files.
- Prefer UI polish, existing TODO follow-ups, local lint or type fixes,
  narrowly scoped docs drift, or tiny failing-test fixes that clearly match the
  direction.
- If no direction is provided, choose the safest high-signal small task you can
  justify.
- If no safe task exists, remove the worktree, report that this run skipped,
  and stop.

### 3. Delegate implementation

Call the `agent` tool with `subagent_type="evolve-dev"`.

The dev prompt must include:

- repo root
- isolated worktree path
- branch name
- selected task
- original direction, if any
- a requirement to keep the diff small and stay inside the worktree
- a requirement to run focused checks relevant to the changed files
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
  report a rollback.
- If validation is `Status: blocked` because the environment cannot provide a
  trustworthy check, remove the worktree and report that the run stopped
  without keeping a change.

### 6. Success criteria

Only keep the worktree if all of these are true:

- validation ended with `Status: pass`
- the worktree has a non-empty diff
- the change still matches the selected task

If the diff is empty, remove the worktree and report that no useful change was
kept.

## Final Response

Keep the final response concise and concrete.

If scheduling was requested, include:

- scheduled job id
- cadence
- the stored prompt

For the one-shot attempt, include:

- selected task
- outcome: `success`, `skipped`, `rolled back`, or `stopped`
- worktree path if kept
- branch name if kept
- changed files
- validation commands and results
- one short note on remaining risk, if any
