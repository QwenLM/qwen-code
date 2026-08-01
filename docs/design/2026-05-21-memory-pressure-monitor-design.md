---
title: 'Memory Pressure Monitor'
date: '2026-05-21'
status: 'implemented'
---

# Memory Pressure Monitor

## Problem

Long-running Qwen Code sessions can accumulate memory through large tool
results, repeated file reads, chat history, and native/external allocations.
Before this change, the core package had diagnostics and session-reset cleanup,
but no runtime response when memory pressure rises during normal tool
execution.

The highest-value cache-specific gap is `FileReadCache`: it already has a
bounded FIFO size, but it did not have a time-based eviction path. That means a
session can retain inactive file-read metadata until the hard entry limit is
hit, even when the process is under memory pressure.

## Goals

- Add a low-overhead memory pressure check after tool execution.
- Prefer surgical cleanup before destructive cleanup.
- Respect container memory limits when cgroup v2 or cgroup v1 memory limit
  files are available.
- React to V8 heap pressure before JavaScript heap OOM on high-memory hosts.
- Keep subagent/scoped `Config` instances isolated from parent session cleanup.
- Make behavior configurable through environment variables without adding a new
  user-facing settings surface.

## Non-Goals

- Do not add a background polling loop.
- Do not make explicit GC the default; it only runs when enabled and Node was
  started with `--expose-gc`.
- Do not change prior-read enforcement semantics. Cache eviction can remove old
  metadata, but it must not weaken stale-file checks for retained entries.

## Design

`Config.initialize()` creates one `MemoryPressureMonitor` per initialized
`Config`. `getMemoryPressureMonitor()` mirrors the existing `getFileReadCache()`
Object.create isolation pattern: when a child config is created through
prototype delegation, the getter lazily installs an own monitor bound to that
child config.

`CoreToolScheduler.executeSingleToolCall()` calls `scheduleCheck()` in its
`finally` block after ending the tool span. `scheduleCheck()` coalesces multiple
calls in the same event-loop turn with `queueMicrotask`, so concurrent read-like
tool batches do not run one memory check per tool result.

The monitor uses the stronger of two pressure signals:

- RSS divided by an effective process memory limit. Prefer cgroup v2
  `/sys/fs/cgroup/memory.max` when it is a finite positive value; fall back to
  cgroup v1 `/sys/fs/cgroup/memory/memory.limit_in_bytes`, then to
  `os.totalmem()` otherwise. cgroup v1's huge "unlimited" sentinel values are
  ignored.
- V8 `heapUsed` divided by `getHeapStatistics().heap_size_limit`.

Using both signals matters because containers usually fail by RSS/cgroup limit,
while local high-memory machines can hit V8 heap OOM long before RSS is a large
fraction of total system memory.

Default thresholds are intentionally conservative enough to react before the OS
or container OOM killer does:

- `softPressureRatio = 0.50`
- `hardPressureRatio = 0.65`
- `criticalRatio = 0.80`
- `cleanupCooldownMs = 5000`
- `enableExplicitGC = false`

Environment overrides:

- `QWEN_MEMORY_PRESSURE_SOFT`
- `QWEN_MEMORY_PRESSURE_HARD`
- `QWEN_MEMORY_PRESSURE_CRITICAL`
- `QWEN_MEMORY_ENABLE_GC=1`

Invalid ratios fall back to defaults. Valid ratios must be ordered as
`soft < hard < critical`, with a lower soft bound of `0.3` and an upper
critical bound of `0.98`. Ratio env vars are parsed strictly with `Number()`,
so values such as `0.8extra` are rejected instead of partially accepted.
Invalid memory-pressure env configuration writes a visible warning to stderr
and to the debug log before falling back to defaults.

## Cleanup Policy

Pressure levels map to increasingly strong cleanup:

- `soft`: evict stale `FileReadCache` entries not accessed in 60 minutes.
- `hard`: evict cache entries not accessed in 30 minutes.
- `critical`: clear the file-read cache and optionally trigger `global.gc()`.

The monitor intentionally does not force chat compaction. Compaction can call
the model backend and rewrite active chat state, so it should be triggered only
from a call site that can safely coordinate with the conversation loop.

Cleanup is fire-and-forget from the scheduler, but the monitor guards cleanup
steps with `cleanupInProgress` and a cooldown timestamp. A higher-pressure
cleanup can bypass the cooldown and queue behind an in-progress lower-pressure
cleanup, so a `critical` check is not lost while a `soft` cleanup is finishing.
After successful cleanup it logs an RSS delta on `setImmediate()`, but RSS
movement is diagnostic only: V8 and libc may retain freed pages even when
JavaScript objects became collectible. Consecutive failures count cleanup-step
exceptions, not unchanged RSS, and the counter is reset on a new session. If
three successful cleanup attempts in a row free less than 1% RSS, the monitor
emits `memory-cleanup-ineffective` as a diagnostic signal without treating the
cleanup step itself as failed.

## Test Coverage

The implementation is covered by:

- threshold validation tests;
- environment config parsing, fallback, visible warning, and explicit GC tests;
- pressure classification tests using mocked `process.memoryUsage()`;
- cgroup v2 `memory.max` and cgroup v1 `memory.limit_in_bytes` behavior;
- V8 heap limit behavior;
- `scheduleCheck()` coalescing;
- scheduler integration that invokes `scheduleCheck()` after tool execution;
- soft and critical cleanup actions;
- cleanup failure accounting for thrown cleanup steps;
- cleanup listener exception isolation and ineffective-cleanup diagnostics;
- child `Config` monitor isolation through `Object.create`;
- `FileReadCache.evictNotAccessedSince()` behavior.

## Risks And Tradeoffs

- RSS can stay flat after cleanup because V8 or libc may retain freed memory.
  RSS deltas are logged, but unchanged RSS does not count as a cleanup failure.
- Time-based file-read cache eviction may reduce fast-path hits for old files,
  but it preserves recently active entries and only runs under memory pressure.
