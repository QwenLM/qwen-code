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
- the active provider is Anthropic or OpenAI-compatible and cache control is
  enabled;
- slimming found no media that would change the provider-facing history.

The request uses the current turn's effective generation config, including
per-request tool overrides used by subagents, and the complete curated
history. The existing compression instruction is appended as the final user
message.
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

OpenAI-compatible endpoints use the same prefix-preserving request shape even
when their cache controls are unknown, allowing server-side automatic prefix
caches such as vLLM to match it. Qwen Code does not send provider-specific cache
fields to these endpoints. For the official OpenAI API, requests share a stable
session cache key; each concurrently running subagent appends its stable agent
identity so unrelated prefixes do not compete under the parent's key. This
follows OpenAI's recommendation to keep total traffic across all prefixes for
one key near 15 requests per minute and partition higher-volume traffic with a
[stable mapping](https://developers.openai.com/api/docs/guides/prompt-caching#improve-cache-hit-rates-with-a-prompt-cache-key).
GPT-5.6 and later compression requests additionally mark the last reusable
user/tool boundaries and select explicit-only cache mode, so the new
compression directive does not move the effective cache breakpoint.

## Verification

Unit tests assert exact system, tools, full-history, and trailing-directive
construction; provider/model/media gates; tool-call and malformed-response
fallback; and cancellation behavior. Provider testing should compare the
serialized request prefix and cached-token usage for the main turn and
compression request.
