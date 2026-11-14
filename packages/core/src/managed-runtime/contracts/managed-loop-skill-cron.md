
# /loop — run a prompt repeatedly

## Subcommands

If the input (after stripping the `/loop` prefix) is exactly one of these keywords, run the subcommand instead of scheduling:

- **`list`** — call CronList and display the results. Done.
- **`clear`** — call CronList, then call CronDelete for every job returned. Confirm how many were cancelled. Done.

## Parsing

Parse the input after removing the `/loop` prefix:

1. **Leading interval token**: if the first whitespace-delimited token matches `^\d+[smhd]$` (e.g. `5m`, `2h`), this is the fixed-interval recurring path. The rest is the prompt.
2. **Trailing "every" clause**: otherwise, if the input ends with `every <N><unit>` or `every <N> <unit-word>` (e.g. `every 20m`, `every 5 minutes`, `every 2 hours`), this is the fixed-interval recurring path. Extract that interval and strip it from the prompt. Only match when what follows "every" is a time expression — `check every PR` has no interval.
3. **No interval**: a Managed schedule on this Session requires a fixed interval. If the input has no interval, tell the user this Session schedules fixed-interval loops only and ask for an interval (for example `/loop 5m check the build`); do not schedule.

If an interval was given but the prompt is empty (e.g. `/loop 5m`), this is a fixed-interval **autonomous** loop — see the Autonomous mode section.

Examples:

- `5m /babysit-prs` → fixed interval `5m`, prompt `/babysit-prs` (leading interval token)
- `check the deploy every 20m` → fixed interval `20m`, prompt `check the deploy` (trailing "every" clause)
- `run tests every 5 minutes` → fixed interval `5m`, prompt `run tests` (trailing "every" clause)
- `check every PR` → no interval; ask for one ("every" is not followed by a time expression)
- `5m` → fixed-interval autonomous loop (interval `5m`, sentinel `<<autonomous-loop>>`)

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
   - `durable`: `true` (a Managed schedule is always durable; `durable: false` is refused).
2. Briefly confirm: what is scheduled, the cron expression, the human-readable cadence, that it runs until cancelled (a Managed schedule does not expire), and that they can cancel with CronDelete (include the job ID).
3. Then immediately execute the parsed prompt now. Do not wait for the first cron fire.
   - If it is a slash command, invoke it via the Skill tool.
   - Otherwise, act on it directly.

## loop.md task-file mode

Use this when the user wants the loop to work a task list kept in a file (they say "work through my loop.md", "loop over the tasks in .qwen/loop.md", or point at such a file). Tasks live in `.qwen/loop.md` (project) or `~/.qwen/loop.md` (home; project wins). Instead of a natural-language prompt, set the loop's `prompt` to a sentinel so each fire re-reads the file:

- Fixed interval → CronCreate `prompt`: `<<loop.md>>` (with `recurring: true` and `durable: true`)

At each fire you receive either the full task list (first delivery, after the file changes, or after a compaction) or a short reminder to keep working the list established earlier. Work the tasks. If `.qwen/loop.md` is absent at fire time, the loop falls back to autonomous mode (it keeps working autonomously instead of no-op'ing); a recreated file is picked up on the next fire. Confirm to the user in plain language ("looping over your `.qwen/loop.md` task list…"), not the raw sentinel.

## Autonomous mode

Use this for a bare `/loop <interval>` (an interval, no prompt, no file) — the user wants you to keep their work moving while they're away. Arm the loop with an autonomous sentinel and run the first check now:

- Fixed interval (`/loop <interval>`, no prompt) → CronCreate `prompt`: `<<autonomous-loop>>` (with `recurring: true` and `durable: true`)

The first immediate check, and each scheduled fire, advance work the conversation already established — finish things the user started, maintain an in-progress PR (address review threads, fix failing CI, resolve conflicts), honor "I'll also…" commitments. You are a steward, not an initiator: act on what the transcript already established; never invent new work or make irreversible changes (push, delete, send) without clear authorization. If everything is genuinely quiet, say so in one sentence and stop. The first fire (and the first after a compaction) delivers fuller guidance; later fires send a short reminder pointing back to it. Confirm to the user in plain language ("running an autonomous loop on your work…"), not the raw sentinel.

## Input
