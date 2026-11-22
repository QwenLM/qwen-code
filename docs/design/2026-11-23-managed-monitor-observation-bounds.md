# Managed Monitor: bounded observation windows

[English](2026-11-23-managed-monitor-observation-bounds.md) | [简体中文](2026-11-23-managed-monitor-observation-bounds.zh-CN.md)

Status: proposed for #18073, covering both Managed Monitor lanes.

## Problem

`HostedMonitorLoop` and `WorkerMonitorPolicy` each aggregate every line printed during one debounce window into a single observation and notification. `max_events` limits windows, not the lines or bytes within one window.

For the resident lane, this creates an arbitrarily large stored observation, externalization dependency, and model input turn. The worker lane also carries the lines twice: directly in the observation entry and inside its base64 `managed-input` notification. An oversized first entry cannot be split by the batching loop and is refused by the 512 KiB delivery request guard, blocking every later entry including the terminal one.

## Goals

- Apply one line-count and UTF-8 line-text rule to both lanes.
- Keep the original line order and append one accurate omission marker when truncation occurs.
- Use exactly the same bounded lines for an observation and its notification.
- Keep every worker observation entry below the delivery request limit, including XML-heavy content after JSON escaping and base64 encoding.
- Preserve observation sequence, notification cadence, quota accounting, and settlement behavior for periodic and exit flushes.

## Non-goals

- Do not change debounce timing, buffering before a flush, `max_events`, the partial-line cap, per-line notification truncation, Store behavior, or public configuration.
- Do not split one window into multiple observations, which would consume quota faster and change notification cadence.
- Do not claim a live model, external managed service, or production watch was exercised by the local tests.

## Design

The shared `boundMonitorObservationLines` helper accepts one window and returns at most 1,000 lines, including the optional omission marker. Its raw line-text budget is 32 KiB, including newline separators and the marker.

A window already within both limits is returned unchanged. Otherwise, the helper keeps the longest legal prefix of complete source lines. It never slices a source line or a multibyte character. The final item is `... N more lines omitted`, where `N` is the exact number of unretained source lines. A single over-budget line is omitted rather than sliced.

`HostedMonitorLoop.flush` applies the helper once and uses the result for both `monitors.observe` and `buildMonitorNotificationInput`. `WorkerMonitorPolicy.flush` does the same before constructing the notification resource and calling `enqueueObservation`. Existing XML escaping, display-control sanitization, and observation schemas remain unchanged.

The 32 KiB budget deliberately leaves room for both worker representations. Raw lines are JSON-escaped in the observation, while notification content can expand sixfold under XML escaping before base64 encoding. A 64 KiB budget passed a plain-text regression but still produced a 651,558-byte request for quote-heavy content. The smaller shared budget covers that case instead of sizing only for plain text.

The constants remain private implementation limits rather than new operator settings.

## Edge cases

- Empty and already bounded windows preserve their content.
- The marker counts toward both the 1,000-line result and the 32 KiB raw line-text budget.
- UTF-8 byte length, not JavaScript string length, determines the raw byte budget.
- The omission marker reports all omitted source lines, including lines dropped because of either limit.
- Existing small observations, notification tags, wake linkage, and quota settlement remain unchanged.

## Validation

Helper tests cover unchanged small windows, exact line and byte boundaries, line-count truncation, multibyte UTF-8 text, and an individually over-budget line.

Resident tests use the fake executor, manual clock, actual session authority, and local resource store. They independently cover periodic and exit flushes, observation and notification identity, exact omission counts, byte limits, and one observation sequence per original window.

Worker tests drive the real `WorkerMonitorPolicy` and inspect the staged delivery entry. Plain-text and XML-heavy cases assert the serialized request limit, shared observation and notification lines, exact omission counts, and raw byte limit. A separate publisher and applier path runs small and oversized windows through final delivery and verifies that the observation commits once and the monitor record settles.

The original plain-text regression produced a 1,426,041-byte request and left the oversized applier case at observation sequence zero. The first 64 KiB implementation also failed the XML-heavy case at 651,558 bytes. The final shared implementation passes all 65 tests across the three focused files. Repository type, formatting, lint, and diff checks are recorded with the PR evidence.

## Acceptance criteria

- Every observation in either lane contains at most 1,000 lines and at most 32 KiB of raw line text.
- Truncated windows have one accurate omission marker and no partial source line.
- Observation and notification contain the same bounded content.
- Plain-text and XML-heavy worker entries fit the delivery request limit, and the oversized applier case settles.
- Periodic and exit flushes preserve existing sequence, quota, and settlement behavior.
