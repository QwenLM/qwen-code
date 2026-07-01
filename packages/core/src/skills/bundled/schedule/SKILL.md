---
name: schedule
description: Create and manage durable scheduled tasks (routines) that run on the local machine via the schedule daemon, even with no session open. Usage - /schedule review new PRs at 9am on weekdays, /schedule in 2 weeks remove the feature flag. /schedule list to show tasks, /schedule run <id> to run one now, /schedule delete <id> to remove one.
argument-hint: '<description> | list | run <id> | delete <id>'
allowedTools:
  - schedule_create
  - schedule_list
  - schedule_run
  - schedule_delete
---

# /schedule — local always-on scheduled tasks (routines)

A scheduled task is a durable routine stored under `~/.qwen/scheduled-tasks/`.
The `qwen schedule daemon` process fires each due task as a fresh headless
`qwen -p` run in the task's own working directory — so tasks keep running with
no interactive session open. This is distinct from `/loop`, which only runs
while the current session stays open.

## Subcommands

Strip the `/schedule` prefix, then look at the input:

- **empty** — call ScheduleList and show the result. Done.
- **`list`** — call ScheduleList and show the result. Done.
- **`run <id>`** — call ScheduleRun with that id. Report the run id it returns. Done.
- **`delete <id>`** (also `remove`, `rm`) — call ScheduleDelete with that id. Confirm. Done.
- **anything else** — treat the whole input as a natural-language request to
  create a task (see below).

## Creating a task

When the input describes work to schedule, create it with **ScheduleCreate**.
Resolve these fields from the request, then confirm the resolved schedule when
you create it:

1. **Schedule** — pass exactly one:
   - `cron` (5-field, local time) for recurring requests. Examples:
     `0 9 * * 1-5` = weekdays 9am, `0 * * * *` = hourly, `*/30 * * * *` = every 30 min.
   - `fireAt` (ISO 8601 with offset) for a one-shot ("once", "tomorrow at 3pm",
     "in 2 weeks"). Resolve the phrase against the current date/time to an
     absolute timestamp and confirm it.
   - Prefer off-`:00`/`:30` minutes for approximate times (e.g. `57 8 * * *`
     instead of `0 9 * * *`) so many machines don't all hit the API at once.
2. **prompt** — a fully self-contained instruction. The task runs headless with
   NO memory of this conversation, so restate the repo/cwd, the goal, and what
   success looks like. Do not reference "the current conversation".
3. **name** — a short kebab-case id (e.g. `daily-pr-review`).
4. **description** — a one-line summary for the list.
5. **cwd** — default to the current working directory unless the user names
   another. Use an absolute path.
6. **approvalMode** (optional) — how the unattended run is gated:
   `auto` (default; safe actions auto-approved, risky ones blocked and recorded),
   `yolo` (approve everything), `auto-edit`, `default`, or `plan`. Only raise it
   above `auto` when the user asks for full autonomy.
7. **model** / **sandbox** (optional) — per-task model id; run inside the sandbox.

After creating, tell the user in one or two lines: what was scheduled, the
human-readable cadence (or absolute one-shot time), and that it runs via the
schedule daemon — remind them to start it with `qwen schedule daemon` if it is
not already running. Manage tasks later with `/schedule list`, `/schedule run
<id>`, and `/schedule delete <id>`.

## Input
