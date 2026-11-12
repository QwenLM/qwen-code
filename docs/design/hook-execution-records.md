# Hook execution records and transport

[English](hook-execution-records.md) | [简体中文](hook-execution-records.zh-CN.md)

Status: implemented, 2026-11-12. Validation and review results are reported separately.

## Problem and scope

HookProgress describes local executions but does not provide safe, durable turn statistics. This change covers local main-agent hooks with explicit history-turn ownership, persistence, ACP transport, SDK reduction and paginated reads. Web Shell UI, managed execution, async final results and subagent aggregation are excluded.

## Contract and ownership

Capture a UUID and immutable runtime/session/history-prompt ownership at the actual start callback. Bind ACP history ownership before prompt hooks; retries and continuations keep the original turn. No owner means no turn record. Preserve existing progress fields and attach an allowlisted hookLifecycle payload. Keep configuration sources through planning. Names use explicit configuration names or type and batch position; never use commands, URLs, prompts, output or raw errors.

Events are started, ended (success/blocked/error/timeout/cancelled), or dispatched. Async dispatch has its own duration and is not a terminal success. Refused async handoffs are errors; batches cancelled before execution do not contribute lifecycle records. Terminal events carry full identity. Replay-only starts are unknown and make persisted coverage partial. Record/transport failure cannot change hook decisions or redirect a late event into another session.

## Persistence and transport

Use system/ui_telemetry with event.name hook_lifecycle. Reuse deletion identities and remap session/prompt IDs when forking. Include pre-prompt hooks in the turn's rewind boundary, reconstruct that boundary on full/selective restore, and reject late terminal records from rewound executions. Exclude diagnostics from model history and ordinary telemetry restoration. Preserve metadata through bridge compaction and lifecycle replay. Observe MessageBus replacement and disposal in ACP; send empty agent_message_chunk updates with \_meta.hookLifecycle.

A browser-safe pure Core contract supplies parsing, reduction and summaries to the reader, bridge and bundled SDK. Parse at each input boundary, then share typed per-execution merge rules. The reader updates a request-local Map directly; the SDK reducer preserves immutable state and accepts an array of updates for history replay, copying the Map at most once per batch. SDK declarations remain independent of Core. Duplicate starts cannot overwrite terminals; identity conflicts within the selected turn mark incomplete data. VS Code history and usage rebuilding exclude Hook diagnostics alongside request/tool lifecycle events.

## Turn queries

GET /session/:id/turns/:promptId/hooks and its workspace-qualified form return sessionId, promptId, snapshot, start, totalExecutions, summary, executions, nextStart and coverage. SDK exposes getSessionTurnHooksPage. Default limit is 50, range 1–500; start requires a signed transcript snapshot. Use the existing Hook turn hints to read only the requested turn's lifecycle records in the selected active branch. Aggregate every recorded execution in that turn before pagination, sorted by startedAt and executionId; cross-turn execution-ID auditing is outside this query.

Resolve and validate the snapshot without generating navigation previews. Cache each turn's sorted executions, summary and coverage on its existing transcript index cache entry, accounting for the retained result in the shared 64 MiB budget and five-minute lifetime. If the result cannot fit, return it without retaining it. Frozen pages reuse the aggregate; fresh appended snapshots use a different cache entry. Return copies of only the requested entries and summary so callers cannot mutate cached results. A truncated, replaced or equal-length rewritten file invalidates a frozen snapshot.

Both routes are persisted-workspace scoped and reuse transcript runtime resolution, archive locks, generation checks and storage context. Flush a live first page using the existing transcript barrier; frozen pages do not flush. Read cold sessions without loading them. Unknown/ambiguous/removed runtimes never fall back to primary. Old turns without events are unrecorded, managed sessions unsupported, known gaps partial. Totals describe recorded executions, not proof of complete historical instrumentation.

## Validation and delivery

The [E2E plan](../plans/hook-execution-records-e2e.md) defines baseline, real-command scenarios and deterministic regression checks.

Verify real command hooks, cancellation, async dispatch, overlapping batches, retries/continuations, late ends, multiple sessions/workspaces, replay ordering, fork/delete/rewind, safe payloads, blank-row suppression and more than 1,000 executions across frozen pages. Run package tests, build/typecheck/bundle, SDK declaration/browser checks and two clean self-audit passes. E2E baseline uses global qwen; verification uses the local bundle.

No migrations or new retention limits. Existing sessions remain readable. Relevant implementation areas are Core hooks/recording/transcript readers, ACP session and bridge, daemon session routes, and SDK daemon API/UI helpers. No unresolved product decisions.
