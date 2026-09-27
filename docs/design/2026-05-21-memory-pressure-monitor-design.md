---
title: 'Memory Pressure Monitor'
date: '2026-05-21'
status: 'implemented'
---

# Memory Pressure Monitor

[English](2026-05-21-memory-pressure-monitor-design.md) | [简体中文](2026-05-21-memory-pressure-monitor-design.zh-CN.md)

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
- Do not request explicit GC outside the `critical` level. `global.gc()` only
  exists when Node was started with `--expose-gc`; without it the step just
  logs and does nothing, and `QWEN_MEMORY_ENABLE_GC=0` turns it off.
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
- `enableExplicitGC = true`

`enableExplicitGC` only has an effect when Node exposes `global.gc`. For this
reason the production entry `scripts/cli-entry.js` relaunches the interactive
CLI with `--expose-gc` (its bootstrap fast paths run without it);
`scripts/start.js` and `scripts/dev.js` also pass the flag, and `qwen review`
forwards it to the subprocess it spawns.

Environment overrides:

- `QWEN_MEMORY_PRESSURE_SOFT`
- `QWEN_MEMORY_PRESSURE_HARD`
- `QWEN_MEMORY_PRESSURE_CRITICAL`
- `QWEN_MEMORY_ENABLE_GC` — set to `0`, `false`, `off`, or `no` to disable
  explicit GC; any other value (including `1`) keeps it enabled.

Valid ratios must be ordered as `soft < hard < critical`, with a lower soft
bound of `0.3` and an upper critical bound of `0.98`. Ratio env vars are
parsed strictly with `Number()`, so values such as `0.8extra` are rejected
instead of partially accepted. Invalid memory-pressure env configuration
discards the entire override set — all three ratios fall back to
`DEFAULT_PRESSURE_CONFIG`, not just the offending one — and writes a visible
warning to stderr and to the debug log.

## Cleanup Policy

Pressure levels map to increasingly strong cleanup:

- `soft` (`light`): evict stale `FileReadCache` entries not accessed in 60
  minutes.
- `hard` (`moderate`): evict cache entries not accessed in 30 minutes, run
  microcompaction on old tool results and media, then clear the file-read
  cache.
- `critical` (`aggressive`): run the `hard` steps, plus `global.gc()` when
  `enableExplicitGC` is on.

The monitor intentionally does not trigger model-involving summarizing
compaction. That kind of compaction calls the model backend and rewrites
active chat state, so it should be triggered only from a call site that can
safely coordinate with the conversation loop. The `compact_history` step the
monitor does run is a deterministic, model-free microcompaction limited to
tool results and media; see the
[managed memory microcompaction plan](../plans/2026-07-11-managed-memory-microcompaction.md).

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
