# Privacy-Safe Tool-Result Boundary Diagnostics

## Summary

Add opt-in debug-log events that explain where an oversized tool-result representation changes between production, model finalization, session recording, ACP or Headless projection, and the actual writer. The events contain only sizes, process-local HMACs, mutation state, and privacy-safe artifact state/kinds. Diagnostic failures remain isolated from tool execution and transport behavior.

## Scope

The implementation covers every built-in tool-result route:

- `CoreToolScheduler` records raw producer input and its terminal output for interactive, Headless, and agent executions, so scheduler-side persistence, truncation, hooks, and display compaction are attributable before finalization.
- ACP and speculative execution invoke tools directly, so those runtimes record the same producer boundary after `execute()` settles.
- `finalizeToolResponses()` covers interactive, Headless, ACP, agent, and speculative model-facing aggregation.
- `ChatRecordingService.recordToolResult()` is the shared recorder boundary.
- ACP live and replay delivery are observed immediately before and after textual projection.
- Headless JSON, stream-json, persistent SDK transport, subagent, Text retention, and DualOutput are observed at their shared adapter projection. JSON and stream-json writers provide exact emitted frame sizes; Text has no tool-result wire frame.
- The ACP NDJSON hook provides the serialized payload byte count; the diagnostic adds the single newline byte written by that transport.

Custom adapters and prebuilt custom `tool_result` messages remain outside the built-in Headless route. Generic frame limits, backpressure, replay aggregate limits, and artifact lifecycle remain tracked separately.

## Event Contract

Diagnostics run only when `QWEN_DEBUG_LOG_FILE` is enabled and a debug-log session is active. An event is eligible only when at least one textual representation exceeds 65,536 JSON UTF-8 bytes or the observed boundary changed a representation.

Each event records:

- boundary stage and representation kind;
- JavaScript code units, raw UTF-8 bytes, and exact JSON-string UTF-8 bytes;
- a process-local HMAC-SHA-256 for each textual slot;
- HMACs for available session, prompt, tool-call, and tool-name identifiers;
- mutation state plus one artifact summary per tool call, containing producer-persistence state (`undecided`, `none`, or `reusable`) and deduplicated kind enums only;
- exact serialized frame bytes at ACP and Headless writer boundaries.

The HMAC key is generated randomly once per process. Every string is hashed independently with an eight-byte byte-length prefix followed by its UTF-16LE code units; values are never concatenated before hashing. Hashing code units preserves distinctions between valid Unicode and lone-surrogate JavaScript strings while keeping equal values comparable inside one process without creating stable cross-process content fingerprints.

No event contains output text, prompts, artifact paths, artifact titles or URLs, session IDs, prompt IDs, tool-call IDs, tool names, arguments, or filesystem paths. Structured rich displays are not recursively inspected: the Phase 2 byte contract applies only to the textual model, display, ACP content/raw, and Headless content representations. Artifact summaries use the existing kind enum plus `unknown`; reusable persistence files contribute the safe `file` kind. Batch writer events keep summaries in the same order as their tool-call identifiers instead of collapsing mixed states or kinds.

## Failure and Rate-Limit Behavior

The observer performs its enablement check before scanning or hashing values. All observation, hashing, classification, and logging code is wrapped in a failure boundary; exceptions are swallowed and never alter the value or write path.

A process-wide limiter emits at most 50 eligible events per 60-second window. Additional eligible events increment a suppressed counter. The first eligible event in a later window reports the accumulated count, then resets it.

The existing `qwen serve` large-pipe-frame observer remains the only daemon attribution mechanism for frames at or above 256 KiB. These diagnostics correlate representations and exact writer sizes but do not emit production telemetry or replace large-frame attribution.

## Implementation Shape

A small Core utility owns event eligibility, exact JSON-string byte accounting, HMAC generation, artifact-state classification, rate limiting, and debug-log output. It accepts textual values lazily so disabled diagnostics do not traverse tool results.

Core call sites add observations at scheduler producer input/output, the speculative producer route, finalizer input/output, and recorder input/output. ACP adds its direct producer observation. Recorder-only diagnostic metadata is stripped before the transcript record is constructed.

A CLI-internal helper owns ACP and Headless projection correlation. It records projection input/output and associates eligible projected objects plus their safe artifact summaries with the later writer through weak references. Subagent progress carries only this closed-enum summary, only while diagnostics are enabled; raw persistence paths and structured artifacts never enter that event path. Eligibility includes both changed projections and oversized unchanged exemptions such as A2UI. This avoids marker parsing and avoids any schema or wire metadata change.

## Compatibility

The change is diagnostic-only when disabled and does not modify tool results, projections, transcripts, schemas, ACP messages, Headless messages, SDK types, or protocol versions. Debug log files gain new JSON-shaped lines only when explicitly enabled. HMACs intentionally change after every process restart.

## Verification

Focused tests cover exact JSON byte accounting (including escapes and Unicode), HMAC equality and mutation mismatch, identifier redaction, artifact tri-state/kinds, mixed batch artifact summaries, enablement, rate limiting, suppressed counts, failure isolation, Core boundary integration, ACP live/replay projection, ACP NDJSON byte counts, Headless JSON/stream-json writer byte counts, and Text retention without a tool-result wire event.

A deterministic fake-MCP exercise records before/after evidence for a 499,999-byte result across Headless JSON, stream-json, persistent stream-json/SDK transport, Text, and ACP where feasible. It verifies exact logged writer bytes, process-local HMAC correlation, absence of fixture text and identifiers in the log, unchanged producer artifact size/hash, and unchanged user-visible output.
