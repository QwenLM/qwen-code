# Run Prompts on a Schedule

> Use `/loop` to run prompts repeatedly on a recurring interval within Qwen Code.

Scheduled loops let Qwen Code re-run a prompt automatically. Use them to poll a deployment, babysit a PR, check back on a long-running build, or remind yourself to do something later.

Loops are **persisted to disk** (`.qwen/loop-state.json`), so if your session exits unexpectedly you can restore them in the next session with `/loop restore`.

## Quick start

```text
/loop 5m check if the deployment finished and tell me what happened
```

Qwen Code starts a loop that runs "check if the deployment finished..." every 5 minutes. The prompt executes immediately, then repeats on the interval.

## Interval syntax

Intervals are optional. You can lead with them, trail with them, or leave them out entirely.

| Form                    | Example                               | Parsed interval              |
| :---------------------- | :------------------------------------ | :--------------------------- |
| Leading token           | `/loop 30m check the build`           | every 30 minutes             |
| Trailing `every` clause | `/loop check the build every 2 hours` | every 2 hours                |
| No interval             | `/loop check the build`               | defaults to every 10 minutes |

Supported units: `s` (seconds, min 10s), `m` (minutes), `h` (hours), `d` (days, max 1d). Decimal values like `1.5h` are supported.

Trailing `every` also accepts full words: `every 5 minutes`, `every 2 hours`, `every 1 day`.

## Named loops and multiple concurrent loops

By default, starting a new loop replaces any existing unnamed loop. To run multiple loops concurrently, give each one a name with `--id`:

```text
/loop 5m --id ci check CI status
/loop 10m --id deploy check deploy health
```

Up to 50 loops can run concurrently (configurable via `loopMaxConcurrent` setting).

## Limit iterations

Use `--max N` to automatically stop after N iterations:

```text
/loop 1h --max 5 summarize new commits
```

This runs 5 times (once immediately, then 4 more at 1-hour intervals) and stops.

## Loop over another command

The scheduled prompt can be a command or skill invocation:

```text
/loop 20m /review-pr 1234
```

Each time the loop fires, Qwen Code runs `/review-pr 1234` as if you had typed it.

## Manage loops

| Command               | Description                                                    |
| :-------------------- | :------------------------------------------------------------- |
| `/loop list`          | List all active loops with IDs, prompts, intervals, and status |
| `/loop status [id]`   | Show detailed status of a specific loop (or the default)       |
| `/loop stop [id]`     | Stop a specific loop (or the default if no ID given)           |
| `/loop stop --all`    | Stop all loops                                                 |
| `/loop pause [id]`    | Pause a loop — its timer stops but state is kept               |
| `/loop pause --all`   | Pause all loops                                                |
| `/loop resume [id]`   | Resume a paused loop                                           |
| `/loop resume --all`  | Resume all paused loops                                        |
| `/loop restore`       | Restore loops from a previous session                          |
| `/loop restore --all` | Restore loops even if some are already active                  |

Tab completion is available for subcommands and loop IDs.

## Persistence and session restore

Loop state is automatically saved to `.qwen/loop-state.json` in your project directory. When you start a new session, Qwen Code checks for saved loops and shows a notification:

```text
2 previous loop task(s) found. Use /loop restore to resume or /loop stop to dismiss.
```

**Missed task detection**: If a saved loop was due to fire while no session was running, Qwen Code flags it as "missed" and tells you how overdue it is.

**Multi-session coordination**: A file lock (`.qwen/loop-lock.json`) prevents two sessions from restoring the same loops simultaneously. Only one session at a time can restore persisted loops for a given project.

## Failure handling

If a loop iteration results in an error, Qwen Code applies **exponential backoff**: the next retry waits 2x the normal interval, then 4x (capped at 4x). After **3 consecutive failures**, the loop is automatically **paused**.

A paused loop keeps its state and can be resumed:

```text
/loop resume ci
```

Resuming resets the failure counter and restores the normal interval.

## Auto-expiry

Recurring loops automatically expire **7 days** after creation. The loop stops on the next iteration after the expiry time. This prevents forgotten loops from running indefinitely.

Loops with `--max 1` complete after a single iteration, well before the expiry time.

The expiry duration is configurable via the `loopExpiryDays` setting.

## Jitter

To avoid multiple loops firing at the exact same moment, each loop gets a small deterministic offset added to its interval:

- The offset is up to **10% of the interval**, capped at **30 seconds**.
- The offset is derived from the loop ID, so the same loop always gets the same offset.
- Jitter can be disabled globally via the `loopJitterEnabled` setting.

## Settings

| Setting             | Type    | Default | Description                                            |
| :------------------ | :------ | :------ | :----------------------------------------------------- |
| `loopEnabled`       | boolean | `true`  | Enable or disable the `/loop` command entirely         |
| `loopMaxConcurrent` | number  | `50`    | Maximum number of concurrent loops                     |
| `loopExpiryDays`    | number  | `7`     | Days before recurring loops auto-expire (0 to disable) |
| `loopJitterEnabled` | boolean | `true`  | Add deterministic jitter to loop intervals             |

Settings can be configured in `.qwen/settings.json` or via `/settings`.

## How loops run

The loop scheduler uses `setTimeout` with drift protection for accurate timing:

- **Short intervals (<=60s)**: A single `setTimeout` fires the next iteration.
- **Long intervals (>60s)**: Periodic checks with a dynamically shrinking interval ensure the timer fires within 1 second of the target time, even after system sleep.

Loops fire **one at a time** through a serial prompt queue. If multiple loops are due simultaneously, they execute in sequence — each waits for the previous one's AI response to complete before firing.

If a loop prompt is a UI-only command (like `/help`) that doesn't trigger AI streaming, a **3-second safety timer** automatically advances the loop to prevent hanging.

## Limitations

- Loops fire only while Qwen Code is running and idle. If Qwen Code is busy with a long response, the loop waits.
- With multiple loops, prompts are serialized — they don't run in parallel.
- Persisted state is per-project (`.qwen/loop-state.json`). If two sessions write their own loops, the later write overwrites the earlier one. The file lock only coordinates `/loop restore`, not active loop persistence.
