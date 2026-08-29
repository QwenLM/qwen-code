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
  enabled, or the provider is Gemini or Vertex AI (implicit provider-managed
  caching; `enableCacheControl` does not apply);
- the chat has a provider-reported prompt token count to anchor the estimate;
- the effective prompt token count plus the bounded compression output reserve
  fits the model's context window.

The request uses the current turn's effective generation config, including
per-request tool overrides used by subagents, and the complete curated
history, including media. The normal model-modality filtering is applied when
the request is sent, so supported media remains unchanged and unsupported
media uses the same placeholders as other model requests. The existing
compression instruction is appended as the final user message.
Gemini and Vertex AI rely on their provider-managed implicit prefix cache.
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

OpenAI-compatible endpoints use the same prefix-preserving request shape even
when their cache controls are unknown, allowing server-side automatic prefix
caches such as vLLM to match it. Qwen Code does not send provider-specific cache
fields to these endpoints. For the official OpenAI API, requests share a stable
session cache key; each concurrently running non-fork subagent appends its
stable agent identity so unrelated prefixes do not compete under the parent's
key, while a fork retains the session key because its inherited prefix matches
the parent. This follows OpenAI's recommendation to keep total traffic across
all prefixes for one key near 15 requests per minute and partition
higher-volume traffic with a
[stable mapping](https://developers.openai.com/api/docs/guides/prompt-caching#improve-cache-hit-rates-with-a-prompt-cache-key).
GPT-5.6 and later compression requests additionally mark the last reusable
user/tool boundaries and select explicit-only cache mode, so the new
compression directive does not move the effective cache breakpoint.

## Verification

Unit tests assert exact system, tools, full-history, and trailing-directive
construction; provider/model gates; media preservation on the shared path;
window preflight; media slimming after fallback; tool-call and
malformed-response fallback; and cancellation behavior. Provider testing
should compare the serialized request prefix and cached-token usage for the
main turn and compression request.

The reported live-provider cache figures are one-off validation evidence, not
a checked-in benchmark. To reproduce them, route one interactive CLI process
through a transparent OpenAI-compatible proxy, send a nonce-bearing main turn,
then run `/compress` and a follow-up that recalls the nonce. Record only message
roles, lengths and hashes, tool hashes, cache-field presence, and provider usage
(never prompts or authorization). Verify that the main and compression requests
share the same system, initial user, and tool hashes, and compute each hit rate
as `cached_tokens / prompt_tokens`. The validation used DashScope `qwen3.7-max`:
the main turn reported 18,944 / 19,627 cached tokens (96.52%), and compression
reported 18,944 / 20,409 (92.82%). A deterministic exact-prefix mock comparison
matched the longest byte-identical serialized prefix: clean `main` took the cold
summarizer path with zero cached tokens, while this design matched 28,032 /
29,034 prompt tokens (96.55%). Credentials, captured prompts, and the private
proxy harness are intentionally not committed; the unit tests are the durable
request-shape verification.
