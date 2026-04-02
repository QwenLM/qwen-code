# Loop System Design

> Multi-task, session-persistent, failure-resilient periodic prompt scheduler.
>
> User documentation: [Scheduled Tasks](../../users/features/scheduled-tasks.md).

## Overview

The `/loop` command schedules prompts to run at fixed intervals. It supports multiple concurrent named loops, file persistence across sessions, exponential backoff on failure, deterministic jitter for load spreading, auto-expiry, multi-session coordination via file locks, and a configurable feature gate.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                         CLI Layer (React / Ink)                      │
│                                                                      │
│  ┌──────────────────┐   ┌────────────────────────────────────────┐  │
│  │  loopCommand.ts   │   │  AppContainer.tsx                      │  │
│  │                   │   │                                        │  │
│  │  - parseLoopArgs  │   │  - setIterationCallback (prompt queue) │  │
│  │  - subcommands    │   │  - streamingState useEffect            │  │
│  │  - feature gate   │   │  - safety timer start/clear            │  │
│  │  - capacity check │   │  - persist after completion            │  │
│  │  - lock acquire   │   │  - startup: missed-task notification   │  │
│  └────────┬─────────┘   └──────────────┬─────────────────────────┘  │
│           │                             │                            │
│           ▼                             ▼                            │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │                     Core Layer (framework-agnostic)           │    │
│  │                                                               │    │
│  │  ┌────────────────────────────────────────────────────────┐  │    │
│  │  │  LoopManager (singleton)                                │  │    │
│  │  │                                                         │  │    │
│  │  │  tasks: Map<id, LoopState>                              │  │    │
│  │  │  activeResponseLoopId: string | null                    │  │    │
│  │  │  defaultLoopId: string | null                           │  │    │
│  │  │                                                         │  │    │
│  │  │  start / stop / stopOne / pause / resume                │  │    │
│  │  │  onIterationComplete / executeIteration / scheduleNext  │  │    │
│  │  │  checkExpired / getMissedTasks / toPersistedStates       │  │    │
│  │  │  startSafetyTimer / clearSafetyTimer                    │  │    │
│  │  └────────────────────────────────────────────────────────┘  │    │
│  │                                                               │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │    │
│  │  │ loopJitter.ts │  │ loopLock.ts  │  │ loopPersistence  │   │    │
│  │  │               │  │              │  │                  │   │    │
│  │  │ FNV-1a hash   │  │ PID-based    │  │ v2 JSON format   │   │    │
│  │  │ deterministic │  │ file lock    │  │ v1 migration     │   │    │
│  │  │ 10% cap, 30s  │  │ stale detect │  │ write debounce   │   │    │
│  │  └──────────────┘  └──────────────┘  └──────────────────┘   │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  Disk: .qwen/loop-state.json  .qwen/loop-lock.json                  │
└──────────────────────────────────────────────────────────────────────┘
```

## Key Design Decisions

### 1. setTimeout over cron

We use `setTimeout`-based scheduling rather than cron expressions because:

- **Sub-minute granularity**: Supports intervals as short as 10 seconds. Cron has 1-minute minimum.
- **No parsing overhead**: Interval → milliseconds is a trivial conversion vs 5-field cron parsing.
- **Drift protection**: For intervals >60s, a periodic check with dynamically shrinking intervals ensures <1s accuracy even after system sleep.

### 2. Serial prompt execution

Multiple loops share a single "streaming slot" (`activeResponseLoopId`). Only one loop can submit a prompt to the AI at a time. When a loop's timer fires and the slot is busy, it retries every 1 second until the slot frees.

**Rationale**: The underlying AI streaming pipeline (`useGeminiStream`) is inherently serial. Trying to parallelize would require fundamental changes to the streaming architecture. The serial approach is simple, correct, and matches the single-conversation UX.

### 3. Default loop backward compatibility

When `config.id` is omitted, the loop is tracked via `defaultLoopId`. A new unnamed `start()` auto-stops the previous default. This preserves the original single-loop `/loop` behavior while allowing explicit multi-loop via `--id`.

### 4. PID-based lock over file lock (flock)

Multi-session coordination uses a JSON lock file with PID-based liveness detection:

```json
{ "sessionId": "session-12345", "pid": 12345, "acquiredAt": ..., "heartbeatAt": ... }
```

A lock is stale when **both** conditions hold:

- `heartbeatAt` is older than 60 seconds
- `isPidAlive(pid)` returns false

**Why not `flock`**: OS-level file locks are not portable, behave differently across NFS/macOS/Linux, and silently leak on certain crash scenarios. PID checking is simple, debuggable (human-readable JSON), and correct for same-machine CLI use.

### 5. Fire-and-forget persistence with debounce

Persistence calls use `void persistLoopStates(...)` (fire-and-forget) to avoid blocking the UI. A debounce mechanism skips writes if one is already in flight and was started within 5 seconds. This prevents rapid iterations from causing I/O contention.

When the last loop completes, `toPersistedStates()` returns `[]`, which triggers `clearPersistedLoopState()` to delete the file automatically.

## State Machine

```
                    start(skip=true)
                         │
           ┌─────────────▼──────────────┐
           │  waitingForResponse = true  │◄──── executeIteration()
           │  activeResponseLoopId = id  │          ▲
           └─────────────┬──────────────┘          │
                         │                          │
          onIterationComplete()                     │
                         │                          │
           ┌─────────────▼──────────────┐          │
           │  waitingForResponse = false │          │
           │  activeResponseLoopId = null│          │
           └─────────────┬──────────────┘          │
                         │                          │
              ┌──────────┼──────────┐               │
              ▼          ▼          ▼               │
           [done]    [paused]  scheduleNext()       │
           stopOne()  isPaused    │                  │
                      =true       │  setTimeout      │
                                  └─────────────────┘

  pause() ──► isPaused=true, clear timers, release slot
  resume() ──► isPaused=false, scheduleNext()
  stop() ──► delete from Map, clear all timers
```

## Scheduling Details

### Timer strategy

| Interval | Strategy                                                           |
| :------- | :----------------------------------------------------------------- |
| <= 60s   | Single `setTimeout(callback, intervalMs)`                          |
| > 60s    | Periodic `setTimeout(check, min(remaining, 30s))` with convergence |

The convergence strategy shrinks the check interval as the target time approaches, achieving <1s precision for any interval length.

### Backoff

On failure, the next interval is multiplied by `2^consecutiveFailures`, capped at 4x:

| Failures | Multiplier | 5m interval becomes |
| :------- | :--------- | :------------------ |
| 0        | 1x         | 5m                  |
| 1        | 2x         | 10m                 |
| 2        | 4x (cap)   | 20m                 |
| 3        | — (paused) | —                   |

### Jitter

```
offset = round(fnv1a(loopId) / 2^32 * min(interval * 0.1, 30_000))
```

- FNV-1a hash of the loop ID produces a stable fraction in [0, 1).
- Multiplied by 10% of the interval, capped at 30 seconds.
- Added to every `scheduleNext` call, so the effective interval is `base + jitter`.

### Expiry

```
expiresAt = startTime + 7 days   (configurable via loopExpiryDays)
```

Checked in two places:

1. `checkExpired()` runs every 60 seconds via `setInterval` (with `unref()` to not block process exit).
2. `scheduleNext()` checks before setting the next timer — immediate cleanup.

Loops with `maxIterations=1` complete after their single iteration, before the expiry timer fires.

## File Formats

### `.qwen/loop-state.json` (v2)

```json
{
  "version": 2,
  "tasks": [
    {
      "id": "ci-check",
      "config": {
        "prompt": "check CI status",
        "intervalMs": 300000,
        "maxIterations": 0,
        "id": "ci-check",
        "expiresAt": 1712755200000
      },
      "iteration": 4,
      "startedAt": 1712150400000,
      "createdAt": 1712150400000,
      "nextFireAt": 1712151000000
    }
  ],
  "lastUpdatedAt": 1712150700000
}
```

**v1 migration**: Files without a `version` field are automatically migrated to v2 on load. The single task gets `id: "migrated-v1"` and `createdAt` from `startedAt`.

**Validation**: On load, each task is validated for shape and bounds:

- `prompt` must be non-empty string
- `intervalMs` must be within `[MIN_INTERVAL_MS, MAX_INTERVAL_MS]`
- `maxIterations` must be >= 0
- Invalid tasks are silently filtered out

### `.qwen/loop-lock.json`

```json
{
  "sessionId": "session-12345",
  "pid": 12345,
  "acquiredAt": 1712150400000,
  "heartbeatAt": 1712150400000
}
```

## Safety Timer

When a loop fires a prompt that doesn't trigger AI streaming (e.g., `/help`, `/clear`), the streaming completion handler never fires and the loop would hang. The safety timer detects this:

1. **Start**: Called in the iteration callback, sets a 3-second timeout.
2. **Clear**: Called when `streamingState` transitions away from Idle (streaming started) or when `onIterationComplete` is called normally.
3. **Fire**: If neither happens within 3 seconds, auto-calls `onIterationComplete(true)` to advance the loop.

## Feature Gate

Controlled via settings (`.qwen/settings.json`):

```json
{
  "loopEnabled": true,
  "loopMaxConcurrent": 50,
  "loopExpiryDays": 7,
  "loopJitterEnabled": true
}
```

The gate is checked at the top of the command handler. When `loopEnabled: false`, all `/loop` subcommands return an error message. Settings changes take effect immediately (no restart required).

## Test Coverage

| File                 | Tests  | Coverage                                                                                           |
| :------------------- | :----- | :------------------------------------------------------------------------------------------------- |
| `loopManager.ts`     | 53     | State machine, multi-task, backoff, safety timer, expiry, jitter, retry, persistence serialization |
| `loopPersistence.ts` | 14     | v2 read/write, v1 migration, validation (5 branches), corrupted file, filtering                    |
| `loopLock.ts`        | 12     | Acquire (4 paths), release (2), renew (2), isLockHeld (2), directory creation, corruption          |
| `loopJitter.ts`      | 6      | Bounds, cap, determinism, distribution                                                             |
| **Total**            | **85** |                                                                                                    |

## Comparison with Claude Code

| Dimension        | Qwen Code (this implementation) | Claude Code                 |
| :--------------- | :------------------------------ | :-------------------------- |
| Scheduling       | setTimeout + drift protection   | 1-second cron polling       |
| Min interval     | 10 seconds                      | 1 minute (cron limit)       |
| Concurrency      | 50 named loops                  | 50 cron tasks               |
| Failure handling | Backoff + auto-pause + resume   | Fire-and-forget             |
| Persistence      | File-based, manual restore      | File-based, auto-restore    |
| Multi-session    | PID-based lock                  | File lock + PID + heartbeat |
| Jitter           | 10% of interval, 30s cap        | 10% of interval, 15min cap  |
| Auto-expiry      | 7 days (configurable)           | 7 days (GrowthBook-tunable) |
| User interface   | `/loop` subcommands             | LLM-driven tool calls       |
| Feature gate     | Settings-based                  | GrowthBook + env vars       |
| Tests            | 85 unit tests                   | No test files found         |
