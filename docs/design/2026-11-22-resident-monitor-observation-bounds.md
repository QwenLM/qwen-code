# Resident Managed Monitor: bounded observation windows

[English](2026-11-22-resident-monitor-observation-bounds.md) | [简体中文](2026-11-22-resident-monitor-observation-bounds.zh-CN.md)

Status: proposed for #18073, resident lane only.

## Problem

`HostedMonitorLoop` aggregates every line printed during one debounce window into a single observation and a single notification. `max_events` limits the number of windows, not the number of lines or bytes within a window. A busy watch can therefore create an arbitrarily large observation, externalization dependency, and model input turn.

## Goals

- Bound every resident observation by retained line count and UTF-8 line-text bytes.
- Keep the original line order and append one accurate omission marker when truncation occurs.
- Use exactly the same bounded lines for the stored observation and the notification.
- Apply the rule to both periodic flushes and the final flush caused by a watch exit.
- Preserve observation sequence, notification cadence, quota accounting, and settlement behavior.

## Non-goals

- Do not change the worker-owned lane in #17953.
- Do not change debounce timing, `max_events`, the partial-line cap, per-line notification truncation, Store behavior, or public configuration.
- Do not claim that a 64 KiB line-text budget proves a worst-case size for the JSON envelope or any other transport encoding.

## Design

The shared resident helper accepts one window and returns at most 1,000 lines, including the optional omission marker. Its line-text budget is 64 KiB, including newline separators and the marker.

A window already within both limits is returned unchanged. Otherwise, the helper keeps the longest legal prefix of complete source lines. It never slices a line or a multibyte character. The final item is `... N more lines omitted`, where `N` is the exact number of unretained source lines. A single over-budget line is omitted rather than sliced, so the result can consist only of the marker.

`HostedMonitorLoop.flush` applies the helper once after taking ownership of the buffered lines. The resulting array is used for both `monitors.observe` and `buildMonitorNotificationInput`. Existing XML escaping and display-control sanitization remain in the notification layer, and the observation representation remains unchanged.

The constants are private implementation limits rather than new operator settings. Splitting a large window is deliberately avoided because it would consume observation quota faster and change notification cadence.

## Edge cases

- Empty and already bounded windows preserve their content.
- The marker counts toward both the 1,000-line result and the 64 KiB line-text budget.
- UTF-8 byte length, not JavaScript string length, determines the byte budget.
- A multibyte character is kept only as part of a complete retained source line.
- The omission marker reports all omitted source lines, including lines dropped because of either limit.
- Existing small observations, notification tags, wake linkage, and quota settlement remain unchanged.

## Validation

Unit tests cover unchanged small windows, line-count truncation with the marker included, UTF-8 byte truncation with multibyte text, and an individually over-budget line.

Real `HostedMonitorLoop` tests use the fake executor, manual clock, actual session authority, and local resource store. They verify the periodic flush and the exit flush independently, including observation and notification identity, exact omission counts, byte limits, and one observation sequence per original window.

Repository checks include focused Vitest files, build, TypeScript checks, and formatting/lint checks on the changed files. No live model, external managed service, credential, or dangerous watch command is required.

## Acceptance criteria

- Every resident observation contains at most 1,000 lines and at most 64 KiB of line text.
- Truncated windows have one accurate omission marker and no partial source line.
- Observation and notification contain the same bounded content.
- Periodic and exit flushes each consume one observation revision, with existing settlement behavior unchanged.
- The worker lane and public configuration are untouched.
