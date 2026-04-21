# Run Prompts on a Schedule

> Use `/loop` and the cron scheduling tools to run prompts repeatedly, poll for status, or set one-time reminders within a Qwen Code session.

Scheduled tasks let Qwen Code re-run a prompt automatically on an interval. Use them to poll a deployment, babysit a PR, check back on a long-running build, or remind yourself to do something later in the session.

Tasks are session-scoped: they live in the current Qwen Code process and are gone when you exit. Nothing is written to disk.

> **Note:** Scheduled tasks are an experimental feature. Enable them with `experimental.cron: true` in your [settings](../configuration/settings.md), or set `QWEN_CODE_ENABLE_CRON=1` in your environment.

## Schedule recurring self-improvement

`/self-evolve` now has a first-class recurring mode for small, safe, locally
verifiable repository maintenance. It uses the same in-session cron scheduler
as `/loop`, but keeps `/self-evolve`'s isolated worktree and validation flow.

```text
/self-evolve --every 2h focus on safe CLI lint and test cleanups
/self-evolve focus on TODO follow-ups in docs every 6h
```

When you schedule recurring `/self-evolve`, Qwen Code:

- creates a session-scoped recurring job
- immediately runs the first self-evolve attempt now
- reuses the same one-shot `/self-evolve` safety path on every later fire

The optional direction text is a hard constraint on candidate selection:
`/self-evolve` still only acts on small, safe, locally verifiable changes
discovered in the repository, and it skips the run with `no_safe_task` if none
of those candidates clearly match the requested direction.

Once a run selects a candidate, it stays locked on that task. Validation
failures are fed back into the same child session so Qwen Code can keep
repairing the selected task in context for up to 5 rounds before it rolls the
attempt back.

## Schedule a recurring prompt with /loop

The `/loop` [bundled skill](skills.md) is the quickest way to schedule a recurring prompt. Pass an optional interval and a prompt, and Qwen Code sets up a cron job that fires in the background while the session stays open.

```text
/loop 5m check if the deployment finished and tell me what happened
```

Qwen Code parses the interval, converts it to a cron expression, schedules the job, and confirms the cadence and job ID. It then immediately executes the prompt once — you don't have to wait for the first cron fire.

### Interval syntax

Intervals are optional. You can lead with them, trail with them, or leave them out entirely.

| Form                    | Example                               | Parsed interval              |
| :---------------------- | :------------------------------------ | :--------------------------- |
| Leading token           | `/loop 30m check the build`           | every 30 minutes             |
| Trailing `every` clause | `/loop check the build every 2 hours` | every 2 hours                |
| No interval             | `/loop check the build`               | defaults to every 10 minutes |

Supported units are `s` for seconds, `m` for minutes, `h` for hours, and `d` for days. Seconds are rounded up to the nearest minute since cron has one-minute granularity. Intervals that don't divide evenly into their unit, such as `7m` or `90m`, are rounded to the nearest clean interval and Qwen Code tells you what it picked.

### Loop over another command

The scheduled prompt can itself be a command or skill invocation. This is useful for re-running a workflow you've already packaged.

```text
/loop 20m /review-pr 1234
```

Each time the job fires, Qwen Code runs `/review-pr 1234` as if you had typed it.

### Manage loops

`/loop` also supports two subcommands for managing existing jobs:

```text
/loop list
```

Lists all scheduled jobs with their IDs and cron expressions.

```text
/loop clear
```

Cancels all scheduled jobs at once.

## Set a one-time reminder

For one-shot reminders, describe what you want in natural language instead of using `/loop`. Qwen Code schedules a single-fire task that deletes itself after running.

```text
remind me at 3pm to push the release branch
```

```text
in 45 minutes, check whether the integration tests passed
```

Qwen Code pins the fire time to a specific minute and hour using a cron expression and confirms when it will fire.

## Manage scheduled tasks

Ask Qwen Code in natural language to list or cancel tasks, or reference the underlying tools directly.

```text
what scheduled tasks do I have?
```

```text
cancel the deploy check job
```

Under the hood, Qwen Code uses these tools:

| Tool         | Purpose                                                                                                         |
| :----------- | :-------------------------------------------------------------------------------------------------------------- |
| `CronCreate` | Schedule a new task. Accepts a 5-field cron expression, the prompt to run, and whether it recurs or fires once. |
| `CronList`   | List all scheduled tasks with their IDs, schedules, and prompts.                                                |
| `CronDelete` | Cancel a task by ID.                                                                                            |

Each scheduled task has an 8-character ID you can pass to `CronDelete`. A session can hold up to 50 scheduled tasks at once.

## How scheduled tasks run

The scheduler checks every second for due tasks and enqueues them when the session is idle. A scheduled prompt fires between your turns, not while Qwen Code is mid-response. If Qwen Code is busy when a task comes due, the prompt waits until the current turn ends.

All times are interpreted in your local timezone. A cron expression like `0 9 * * *` means 9am wherever you're running Qwen Code, not UTC.

### Jitter

To avoid every session hitting the API at the same wall-clock moment, the scheduler adds a small deterministic offset to fire times:

- **Recurring tasks** fire up to 10% of their period late, capped at 15 minutes. An hourly job might fire anywhere from `:00` to `:06`.
- **One-shot tasks** scheduled for the top or bottom of the hour (minute `:00` or `:30`) fire up to 90 seconds early.

The offset is derived from the task ID, so the same task always gets the same offset. If exact timing matters, pick a minute that is not `:00` or `:30`, for example `3 9 * * *` instead of `0 9 * * *`, and the one-shot jitter will not apply.

### Three-day expiry

Recurring tasks automatically expire 3 days after creation. The task fires one final time, then deletes itself. This bounds how long a forgotten loop can run. If you need a recurring task to last longer, cancel and recreate it before it expires.

One-shot tasks do not expire on a timer — they simply delete themselves after firing once.

## Cron expression reference

`CronCreate` accepts standard 5-field cron expressions: `minute hour day-of-month month day-of-week`. All fields support wildcards (`*`), single values (`5`), steps (`*/15`), ranges (`1-5`), and comma-separated lists (`1,15,30`).

| Example        | Meaning                      |
| :------------- | :--------------------------- |
| `*/5 * * * *`  | Every 5 minutes              |
| `0 * * * *`    | Every hour on the hour       |
| `7 * * * *`    | Every hour at 7 minutes past |
| `0 9 * * *`    | Every day at 9am local       |
| `0 9 * * 1-5`  | Weekdays at 9am local        |
| `30 14 15 3 *` | March 15 at 2:30pm local     |

Day-of-week uses `0` or `7` for Sunday through `6` for Saturday. When both day-of-month and day-of-week are constrained (neither is `*`), a date matches if either field matches — this follows standard vixie-cron semantics.

Extended syntax like `L`, `W`, `?`, and name aliases such as `MON` or `JAN` is not supported.

## Limitations

Session-scoped scheduling has inherent constraints:

- Tasks only fire while Qwen Code is running and idle. Closing the terminal or letting the session exit cancels everything.
- No catch-up for missed fires. If a task's scheduled time passes while Qwen Code is busy on a long-running request, it fires once when Qwen Code becomes idle, not once per missed interval.
- No persistence across restarts. Restarting Qwen Code clears all session-scoped tasks.
