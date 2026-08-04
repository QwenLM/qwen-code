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
- the active provider is Anthropic or DashScope and cache control is enabled;
- the chat has a provider-reported prompt token count to anchor the estimate;
- the effective prompt token count plus the bounded compression output reserve
  fits the model's context window.

The request uses the current turn's effective generation config, including
per-request tool overrides used by subagents, and the complete curated
history, including media. The normal model-modality filtering is applied when
the request is sent, so supported media remains unchanged and unsupported
media uses the same placeholders as other model requests. The existing
compression instruction is appended as the final user message.
Nothing consumes or executes function calls from this request. A response
containing a function call, an empty response, a malformed state snapshot, or
a request error is discarded and retried once through the existing cold side
query. Its media-slimmed input is built lazily only when that fallback is
needed. Cancellation does not trigger the fallback.

Using the current `GeminiChat` keeps the request scoped to the live session.
The process-global fork cache is intentionally not used because it retains
only a short history tail and can belong to another concurrent session.

Sessions using a distinct compaction model stay on the existing path because
their cache identity differs from the main session. Media-bearing histories
use the shared path first so the unchanged provider-facing prefix can reuse the
main session's cache.

## Verification

Unit tests assert exact system, tools, full-history, and trailing-directive
construction; provider/model gates; media preservation on the shared path;
window preflight; media slimming after fallback; tool-call and
malformed-response fallback; and cancellation behavior. Provider testing
should compare the serialized request prefix and cached-token usage for the
main turn and compression request.
