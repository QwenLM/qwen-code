---
description: "Qwen Code memory diagnostics reference design. Add /doctor memory snapshots for heap, handles, file descriptors, and leak hints."
---

# Memory Diagnostics Reference Design

## Context

Issue #3000 tracks memory and performance diagnostics for long-running Qwen
Code sessions. The first PR should establish a small, low-risk diagnostic
surface before adding heavier profiling or retention changes.

The design is reference-first:

- Claude Code keeps memory diagnostics separate from heap snapshot generation.
  Its diagnostics include process memory, V8 heap statistics, heap spaces,
  resource usage, active handles/requests, file descriptors, Linux
  `smaps_rollup`, and leak hints.
- Codex focuses heavily on bounded retention and lazy loading for long-lived
  process state. Those ideas should guide later PRs that address conversation,
  command output, and history retention.

## First PR Scope

Add a `/doctor memory` diagnostic path that captures a single point-in-time
snapshot:

- `process.memoryUsage()`
- V8 heap statistics and heap spaces
- `process.resourceUsage()`
- active handle/request counts
- open file descriptor count when `/proc/self/fd` is available
- Linux `smaps_rollup` when available
- basic risk hints for heap pressure, detached contexts, excessive handles,
  excessive requests, high file descriptor count, and native memory pressure

This command should be cheap enough to run in normal sessions and safe on
platforms where Linux-only probes are unavailable.

## Non-Goals

This PR intentionally does not:

- write heap snapshots
- run continuous polling
- change prompt/history retention
- change tool output retention
- alter module loading behavior

Those are follow-up PRs after the diagnostic baseline exists.

## Follow-Up PRs

1. Add explicit snapshot/export support for deeper local investigation.
2. Add bounded retention for large command/tool outputs, using Codex's capped
   output retention as the main reference.
3. Audit lazy loading and module startup paths after measurements identify
   hot spots.
4. Add repeatable memory/performance benchmark scenarios for long-running
   sessions.
