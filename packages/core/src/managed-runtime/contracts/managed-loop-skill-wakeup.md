# /loop — run a prompt repeatedly

## Subcommands

If the input (after stripping the `/loop` prefix) is exactly one of these keywords, run the subcommand instead of scheduling:

- **`list`** — call CronList and display the results. Done.
- **`clear`** — call CronList, then call CronDelete for every job returned. Confirm how many were cancelled. Done.

## Parsing

Parse the input after removing the `/loop` prefix:

1. **Empty input** (no prompt, no interval): the **autonomous path** — run a self-paced autonomous loop. See the Autonomous mode section.
2. **Prompt-only input**: otherwise, the entire input is the prompt and this is the prompt-only self-paced path.

A Managed Session on this profile follows up through self-paced wakeups, not a fixed cron schedule. If the user asks for a fixed interval (for example `/loop 5m …` or `… every 20m`), tell them this Session schedules self-paced follow-ups only and run the prompt now with a self-paced wakeup; do not attempt a cron schedule.

Examples:

- `check every PR` → prompt-only self-paced path, prompt `check every PR`
- `check the deploy` → prompt-only self-paced path, prompt `check the deploy`
- (empty) → self-paced autonomous loop (sentinel `<<autonomous-loop-dynamic>>`)

## Prompt-only self-paced path

Use this path only when the user supplied a prompt and no interval.

1. This path follows up through self-paced wakeups only.
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

## loop.md task-file mode

Use this when the user wants the loop to work a task list kept in a file (they say "work through my loop.md", "loop over the tasks in .qwen/loop.md", or point at such a file). Tasks live in `.qwen/loop.md` (project) or `~/.qwen/loop.md` (home; project wins). Instead of a natural-language prompt, set the loop's `prompt` to a sentinel so each fire re-reads the file:

- Self-paced (no interval) → LoopWakeup `prompt`: `<<loop.md-dynamic>>`

At each fire you receive either the full task list (first delivery, after the file changes, or after a compaction) or a short reminder to keep working the list established earlier. Work the tasks; re-arm LoopWakeup with `<<loop.md-dynamic>>` only when continued follow-up is useful (same "don't re-arm if complete/blocked" rules as the prompt-only path). If `.qwen/loop.md` is absent at fire time, the loop falls back to autonomous mode (it keeps working autonomously instead of no-op'ing); a recreated file is picked up on the next fire. Confirm to the user in plain language ("looping over your `.qwen/loop.md` task list…"), not the raw sentinel.

## Autonomous mode

Use this for a bare `/loop` (no prompt, no file) — the user wants you to keep their work moving while they're away. Arm the loop with an autonomous sentinel and run the first check now:

- Self-paced (empty input) → LoopWakeup `prompt`: `<<autonomous-loop-dynamic>>`

The first immediate check, and each scheduled fire, advance work the conversation already established — finish things the user started, maintain an in-progress PR (address review threads, fix failing CI, resolve conflicts), honor "I'll also…" commitments. You are a steward, not an initiator: act on what the transcript already established; never invent new work or make irreversible changes (push, delete, send) without clear authorization. If everything is genuinely quiet, say so in one sentence and stop. The first fire (and the first after a compaction) delivers fuller guidance; later fires send a short reminder pointing back to it. Re-arm LoopWakeup with `<<autonomous-loop-dynamic>>` (same "don't re-arm if complete/blocked" rules). Confirm to the user in plain language ("running an autonomous loop on your work…"), not the raw sentinel.

## Input
