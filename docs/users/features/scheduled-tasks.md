# Run Prompts on a Schedule

> Use `/loop` and the cron scheduling tools to run prompts repeatedly, poll for status, or set one-time reminders within a Qwen Code session.

Scheduled tasks let Qwen Code re-run a prompt automatically on an interval. Use them to poll a deployment, babysit a PR, check back on a long-running build, or remind yourself to do something later in the session.

Tasks created from the terminal are session-scoped: they live in the current Qwen Code process and are gone when you exit. Nothing is written to disk.

Messaging channels use a separate persistent scheduler so results can be pushed back to the originating chat after the current turn. See [Scheduled Channel Loops](./channels/overview#scheduled-channel-loops) for the channel commands, persistence behavior, and delivery constraints.

> **Tip:** Scheduled tasks are enabled by default. To disable them, set `experimental.cron: false` in your [settings](../configuration/settings.md), or set `QWEN_CODE_DISABLE_CRON=1` in your environment.

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

### Autonomous mode

Running `/loop` with **no prompt** starts an autonomous loop instead of repeating a fixed prompt. Qwen Code acts as a steward of the work already established in the conversation — it keeps your work moving while you're away:

```text
/loop
```

A bare `/loop` (no prompt, no interval) runs a self-paced autonomous loop; `/loop <interval>` with no prompt runs the same autonomous loop on a fixed cadence (e.g. `/loop 10m`). On each fire it advances what the conversation already set up — finishing things you started, maintaining an in-progress PR (addressing review threads, fixing failing CI, resolving conflicts), and honoring follow-up commitments. It only acts on work the transcript already established: it never invents new work or makes irreversible changes (push, delete, send) without clear authorization, and it stops once everything is quiet.

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

## Wake the session only when something changed

A recurring task can carry a **gate**: a shell command that runs at each fire time, outside the model. If it prints nothing and exits 0, the fire is skipped — no turn runs and nothing is added to the conversation. If it prints output, the task's prompt runs with that output attached and marked as data produced by the command. A command that fails, prints binary data or runs longer than 60 seconds is reported once, then counted silently until it succeeds again or is blocked; `CronList` shows the count.

Use a gate for watches that are usually quiet, with a command that keeps its own cursor and prints only what changed:

```text
every 2 minutes, run ./check-pr.sh 15057 as a gate; when it prints something, handle the events it lists
```

Qwen Code calls `CronCreate` with `gate: "./check-pr.sh 15057"` and confirms the command the way it confirms a `Monitor` command: once, when the task is created, with the option to always allow it. The command then runs unattended from the project directory with the session's environment. A durable gated task keeps working after a restart when the command is read-only, a saved `Monitor(...)` or `Bash(...)` rule allows it, or the session runs in auto or yolo mode; otherwise the next fire reports the rule to add instead of running the command. That rule is the one `Monitor`'s "always allow" would save, and for a compound command (a test of a command substitution, an `if`, a heredoc) it may not cover every part; put such a probe in a script and allow the script instead. A deny rule for the command stops the gate in every mode.

A gate must finish in the foreground, so a command that puts any part of itself in the background with `&` is refused, and so is one made only of comments. A gate already runs in a shell, so write the command itself rather than a shell wrapper around it: `bash -c '…'` is refused, so that the permission rules check exactly the text that runs; the error names the command they would have checked. The `&` check reads the text rather than running it, so where it is unsure it refuses: an `&` inside a comment, a heredoc or `(( … ))` is refused too, so put such a command in a script and use the script as the gate. A spelling it cannot follow (`eval`, a script piped into `sh`) is caught when the gate runs instead: a gate that exits with nothing on stdout while something it started in the background still holds its stdout is reported as a failure, not skipped quietly, and what it left running in its process group is stopped (on Linux and macOS; a part that moved to a process group of its own, as `setsid` does, is not). Under the bwrap shell execution sandbox (not available to `qwen serve` sessions) the background part ends with the command, so only the text check applies there.

Write a gated prompt as instructions ("for each event in the gate output, …"), not as a slash command. In a `qwen serve` daemon, the Web Shell's scheduled-task form offers the same gate command, the task card shows its recent outcomes, and "Run now" on a gated task asks the model to run the gate itself first, exactly as written, and to follow the task only when the command exits 0 and prints something on standard output (a scheduled fire ignores warnings on standard error, and so should the model); a task bound to the current daemon conversation (`sessionMode: "current"`) can carry a gate too.

## Manage scheduled tasks

Ask Qwen Code in natural language to list or cancel tasks, or reference the underlying tools directly.

```text
what scheduled tasks do I have?
```

```text
cancel the deploy check job
```

Under the hood, Qwen Code uses these tools:

| Tool         | Purpose                                                                                                                                   |
| :----------- | :---------------------------------------------------------------------------------------------------------------------------------------- |
| `CronCreate` | Schedule a new task. Accepts a 5-field cron expression, the prompt to run, whether it recurs or fires once, and an optional gate command. |
| `CronList`   | List all scheduled tasks with their IDs, schedules, prompts, and the gate and its recent outcomes when one is set.                        |
| `CronDelete` | Cancel a task by ID.                                                                                                                      |

Each scheduled task has an 8-character ID you can pass to `CronDelete`. A session can hold up to 50 scheduled tasks at once.

## How scheduled tasks run

The scheduler checks every second for due tasks and enqueues them when the session is idle. A scheduled prompt fires between your turns, not while Qwen Code is mid-response. If Qwen Code is busy when a task comes due, the prompt waits until the current turn ends. A gated task runs its gate command first and is enqueued only when the command prints output.

All times are interpreted in your local timezone. A cron expression like `0 9 * * *` means 9am wherever you're running Qwen Code, not UTC.

### Jitter

To avoid every session hitting the API at the same wall-clock moment, the scheduler adds a small deterministic offset to fire times:

- **Recurring tasks** fire up to 10% of their period late, capped at 15 minutes. An hourly job might fire anywhere from `:00` to `:06`.
- **One-shot tasks** scheduled for the top or bottom of the hour (minute `:00` or `:30`) fire up to 90 seconds early.

The offset is derived from the task ID, so the same task always gets the same offset. If exact timing matters, pick a minute that is not `:00` or `:30`, for example `3 9 * * *` instead of `0 9 * * *`, and the one-shot jitter will not apply.

### Recurring-task expiry

Recurring tasks automatically expire 7 days after creation by default. The task fires one final time, then deletes itself. This bounds how long a forgotten loop can run.

To change the limit, set `experimental.cronRecurringMaxAgeDays` in your [settings](../configuration/settings.md), or set the `QWEN_CODE_CRON_MAX_AGE_DAYS` environment variable (the environment variable wins — convenient for cloud or container deployments where editing `settings.json` is impractical). A value of `0` disables expiry entirely, so tasks run until you delete them — useful for long-running daemon deployments that host daily reports, digests, or ongoing monitoring. The configured limit also applies to durable tasks restored from disk after a restart.

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
