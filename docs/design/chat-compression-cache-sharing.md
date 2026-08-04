# Chat Compression Cache Sharing

## Context

Chat compression currently sends a cold side query with a dedicated system
instruction, no main-session tool declarations, and a media-slimmed copy of
the conversation. Providers whose prompt-cache key starts with tools and the
system instruction cannot reuse the main session's cached prefix.

## Design

Compression first attempts a specialized single-turn request when all of the
following are true:

- the compression model is the current main model;
- the active provider is Anthropic or DashScope and cache control is enabled,
  or the provider is Gemini or Vertex AI (implicit provider-managed caching;
  `enableCacheControl` does not apply);
- slimming found no media that would change the provider-facing history.

The request uses the current turn's effective generation config, including
per-request tool overrides used by subagents, and the complete curated
history. The existing compression instruction is appended as the final user
message.
Gemini and Vertex AI rely on their provider-managed implicit prefix cache.
Nothing consumes or executes function calls from this request. A response
containing a function call, an empty response, a malformed state snapshot, or
a request error is discarded and retried once through the existing cold side
query. Cancellation does not trigger the fallback.

Using the current `GeminiChat` keeps the request scoped to the live session.
The process-global fork cache is intentionally not used because it retains
only a short history tail and can belong to another concurrent session.

Histories containing media and sessions using a distinct compaction model stay
on the existing path. This keeps the first version limited to requests whose
cache identity can be established without changing media or provider routing.

## Verification

Unit tests assert exact system, tools, full-history, and trailing-directive
construction; provider/model/media gates; tool-call and malformed-response
fallback; and cancellation behavior. Provider testing should compare the
serialized request prefix and cached-token usage for the main turn and
compression request.
