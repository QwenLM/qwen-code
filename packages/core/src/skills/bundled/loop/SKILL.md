---
name: loop
description: Create a loop that runs a prompt now and follows up either on a fixed schedule or through self-paced wakeups. Usage - /loop check the build, /loop 5m check the build, /loop check the PR every 30m. /loop list to show jobs, /loop clear to cancel all.
argument-hint: '[interval] [prompt] | list | clear'
allowedTools:
  - cron_create
  - cron_list
  - cron_delete
  - loop_wakeup
---

# /loop — run a prompt repeatedly

## Subcommands

If the input (after stripping the `/loop` prefix) is exactly one of these keywords, run the subcommand instead of scheduling:

- **`list`** — call CronList and display the results. Done.
- **`clear`** — call CronList, then call CronDelete for every job returned. Confirm how many were cancelled. Done.

## Parsing

Parse the input after removing the `/loop` prefix:

1. **Empty input**: show usage `/loop [interval] [prompt]` and stop. Do not call CronCreate or LoopWakeup in this slice.
2. **Leading interval token**: if the first whitespace-delimited token matches `^\d+[smhd]$` (e.g. `5m`, `2h`), this is the fixed-interval recurring path. The rest is the prompt.
3. **Trailing "every" clause**: otherwise, if the input ends with `every <N><unit>` or `every <N> <unit-word>` (e.g. `every 20m`, `every 5 minutes`, `every 2 hours`), this is the fixed-interval recurring path. Extract that interval and strip it from the prompt. Only match when what follows "every" is a time expression — `check every PR` has no interval.
4. **Prompt-only input**: otherwise, the entire input is the prompt and this is the prompt-only self-paced path.

If the resulting prompt is empty, show usage `/loop [interval] [prompt]` and stop.

Examples:

- `5m /babysit-prs` → fixed interval `5m`, prompt `/babysit-prs` (leading interval token)
- `check the deploy every 20m` → fixed interval `20m`, prompt `check the deploy` (trailing "every" clause)
- `run tests every 5 minutes` → fixed interval `5m`, prompt `run tests` (trailing "every" clause)
- `check every PR` → prompt-only self-paced path, prompt `check every PR` ("every" is not followed by a time expression)
- `check the deploy` → prompt-only self-paced path, prompt `check the deploy`
- `5m` → empty prompt → show usage

## Prompt-only self-paced path

Use this path only when the user supplied a prompt and no interval.

1. Do not call CronCreate for this path.
2. If this tick opens with a `<task-notification>` block (a monitor or background event re-invoked you, not a bare `/loop` wakeup prompt), handle that event before re-running the prompt.
   - If the notification says the watched condition was met, cancel any pending fallback LoopWakeup with CronDelete if you still have its ID, then finish the loop.
   - If a monitor auto-stopped on idle or max-events, restart it once if the watch is still useful, re-arm the fallback, report the restart count to the user, and include that count in the LoopWakeup prompt or reason (for example, `monitor restarted 1/1 time`) so it survives context compaction. If it auto-stops again on the next tick, end the loop and report the repeated auto-stop to the user.
   - If the signal is ambiguous, re-arm a shorter follow-up and investigate on the next tick. If the signal remains ambiguous for three consecutive ticks, end the loop and report that the watch could not reach a clear conclusion.
3. Run the parsed prompt immediately now.
   - If it is a slash command, invoke it via the Skill tool.
   - Otherwise, act on it directly.
4. Before ending the turn, decide whether another check is useful.
   - Call LoopWakeup only if continued follow-up is useful.
   - Do not call LoopWakeup if the task is complete.
   - Do not call LoopWakeup if the task is blocked on user input or external state that cannot be checked later.
   - Do not call LoopWakeup just to keep polling when no useful next check exists.
   - If you started a background agent or a Monitor, it wakes you via a terminal `<task-notification>` on exit, failure, cancellation, or monitor auto-stop — so set LoopWakeup as a long fallback rather than a short poll. Do not omit it just because something is watching: the work may hang, or a Monitor may auto-stop on idle or max-events (and one owned by another agent routes its notification only to that agent). Omit LoopWakeup only on the terminal conditions above (complete, blocked, or repeated monitor auto-stop).
5. When scheduling a continuation, call LoopWakeup with:
   - `delaySeconds`: the next useful delay in seconds. The runtime clamps to 60–3600 (1–60 min); follow the tool's own guidance on picking a value — it accounts for the prompt-cache window and for the fallback-heartbeat case when a background task will wake you.
   - `prompt`: `/loop ${original prompt}` plus any state the next tick must preserve, such as `monitor restarted 1/1 time`.
   - `reason`: a short reason for the chosen delay. Include the monitor restart count here when re-arming after an auto-stop.
6. Briefly tell the user what was done now. If a wakeup was scheduled, include when the next check is expected. If no wakeup was scheduled because a notification ended the loop, mention whether the stale fallback was cancelled; if the wakeup ID was lost, ignore or answer the stale wakeup briefly when it fires.

## Fixed-interval recurring path

Use this path only for inputs with a leading interval token or a trailing "every" clause.

### Interval to cron

Supported suffixes: `s` (seconds, rounded up to nearest minute, min 1), `m` (minutes), `h` (hours), `d` (days). Convert:

| Interval pattern   | Cron expression        | Notes                                     |
| ------------------ | ---------------------- | ----------------------------------------- |
| `Nm` where N <= 59 | `*/N * * * *`          | every N minutes                           |
| `Nm` where N >= 60 | `0 */H * * *`          | round to hours (H = N/60, must divide 24) |
| `Nh` where N <= 23 | `0 */N * * *`          | every N hours                             |
| `Nd`               | `0 0 */N * *`          | every N days at midnight local            |
| `Ns`               | treat as `ceil(N/60)m` | cron minimum granularity is 1 minute      |

If the interval does not cleanly divide its unit (for example `7m` gives uneven gaps at `:56` to `:00`, or `90m` is 1.5 hours which cron cannot express), pick the nearest clean interval and tell the user what you rounded to before scheduling.

### Action

1. Call CronCreate with:
   - `cron`: the expression from the table above
   - `prompt`: the parsed prompt from above, verbatim (slash commands are passed through unchanged)
   - `recurring`: `true`
   - `durable`: `true` if the user's language implies persistence ("keep doing this", "set this up permanently", "every day even after restart"). Otherwise omit (defaults to session-only).
2. Briefly confirm: what is scheduled, the cron expression, the human-readable cadence, that recurring tasks auto-expire after 7 days, and that they can cancel sooner with CronDelete (include the job ID).
3. Then immediately execute the parsed prompt now. Do not wait for the first cron fire.
   - If it is a slash command, invoke it via the Skill tool.
   - Otherwise, act on it directly.

## loop.md task-file mode

Use this when the user wants the loop to work a task list kept in a file (they say "work through my loop.md", "loop over the tasks in .qwen/loop.md", or point at such a file). Tasks live in `.qwen/loop.md` (project) or `~/.qwen/loop.md` (home; project wins). Instead of a natural-language prompt, set the loop's `prompt` to a sentinel so each fire re-reads the file:

- Self-paced (no interval) → LoopWakeup `prompt`: `<<loop.md-dynamic>>`
- Fixed interval → CronCreate `prompt`: `<<loop.md>>` (with `recurring: true`, and `durable: true` if persistence is implied)

At each fire you receive either the full task list (first delivery, after the file changes, or after a compaction) or a short reminder to keep working the list established earlier. Work the tasks; in self-paced mode re-arm LoopWakeup with `<<loop.md-dynamic>>` only when continued follow-up is useful (same "don't re-arm if complete/blocked" rules as the prompt-only path). If `.qwen/loop.md` is absent at fire time, treat the tick as a no-op. Confirm to the user in plain language ("looping over your `.qwen/loop.md` task list…"), not the raw sentinel.

## Input
