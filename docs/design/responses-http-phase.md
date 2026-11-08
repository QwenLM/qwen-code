# Responses HTTP errors and assistant phase

[English](responses-http-phase.md) | [简体中文](responses-http-phase.zh-CN.md)

## Problem

Responses loses HTTP headers and later diagnostic fields, misses 408/409 retries, ignores explicit retry directives, and discards assistant message phase during manual replay.

## Design

Carry allowlisted response headers and structured error fields on a Responses-specific error. Preserve request/trace IDs and structured gateway diagnostics, excluding unrelated account metadata. Keep error-body read bounds, credential redaction and bounded excerpts for unstructured errors. Cancellation and permanent quota exhaustion remain authoritative.

Shared retry call sites recognize this error type, honor explicit x-should-retry values, retry 408/409/429 and 5xx by default, and use existing attempt budgets and abortable provider-directed waits. Ordinary 404 stays nonretryable. Other providers retain existing classification. The shared delay parser also supports retry-after-ms.

Persist message ID and optional phase as serializable text-part metadata. Update it from message lifecycle events and preserve message boundaries during consolidation. Responses replay emits valid assistant phases without emitting local metadata. Transport and truncation recovery preserve distinct message boundaries, including fully overlapping text with a different phase. Existing histories without metadata retain their behavior.

## Validation and limits

Compare the reproduced packaged baseline with the rebuilt CLI using localhost endpoints and code mode. Cover recovery, stop directives, ordinary 404, delay/cancellation, redaction, late phase, multiple messages, JSON history and the next tool turn. Run focused unit suites, build, bundle and type checking.

These fixes do not establish the production gateway's missing resource or a score improvement. No live evaluation is included.
