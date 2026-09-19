# Managed memory and a stable session prefix

[English](managed-memory-stable-prefix.md) | [简体中文](managed-memory-stable-prefix.zh-CN.md)

## Problem and status

Draft fix for the client-side mechanism in #11550. A managed-memory write
currently refreshes the live system instruction before the existing history.
On providers without an explicit cache breakpoint, that changes the request
prefix and can force the unchanged conversation to be processed again.

This is a static client-side diagnosis, not a measurement of llama.cpp cache
eviction. The revised candidate is implemented locally but has not been run or
submitted.

## Decision

Keep Config's memory snapshot fresh, but do not rebind the current chat's live
system instruction after an automatic managed-memory write or extraction.
Explicit refreshes keep their existing behavior.

This avoids the stale-state defect in the first candidate: new chats and
subagents still read the refreshed Config snapshot. For the current chat,
foreground writes are already visible in tool history and query-driven recall
reads the rebuilt indexes. The client clears its surfaced-path dedupe set after
a write so an updated file can be selected again, and cancels any recall that
started against the old index.

ACP user-triggered remember remains an explicit prefix-changing operation.
Forget is not claimed fixed by this change.

## Implementation boundary

Split snapshot refresh from live-instruction refresh. Managed-write handling and
successful extraction rebuild indexes, refresh the Config snapshot, invalidate
current recall state, and leave the live instruction unchanged. Preserve cursor
ordering, failure handling, the helper's boolean result, and all explicit
instruction-refresh consumers. Do not change ACP snapshot code, permissions, or
background request routing.

## Acceptance and limits

The local tests encode these boundaries but have intentionally not been run:
automatic writes refresh the snapshot without rebinding the live instruction;
extraction invalidates recall only after indexing; explicit refresh still updates
the instruction; and a memory change clears surfaced-path dedupe. Before merge,
run only the affected test files and compare consecutive captured requests on a
representative OpenAI-compatible backend.

Background requests to a single-slot backend can still evict foreground KV
state. Stable request text does not prevent server eviction or prove reduced
reprocessing/billing. That part of the original report requires backend-specific
evidence and must remain separate from this client-side fix.
