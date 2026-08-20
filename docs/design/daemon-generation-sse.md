# Daemon stateless generation SSE

## Goal

Add `POST /session/:id/generate`, a request-scoped SSE endpoint for short,
stateless text generation. The caller supplies one plain-text `prompt`. The ACP
child first resolves the configured fast model and falls back to the session's
main model when the fast model is missing or cannot be resolved.

## Contract

The request body is `{ "prompt": string }`. Prompts must be non-empty and no
larger than 32 KiB in UTF-8. The endpoint emits `started`, optional `thinking`,
`delta`, `done`, and `error` SSE events. It is consumed with `fetch`, because
native `EventSource` cannot send a POST body.

Generation is isolated from the main conversation: it does not read or mutate
chat history, does not use the main system prompt or memory, and always sends
`tools: []`. Clients cannot select a model or generation settings.
The contract is task-agnostic: translation is the first Web Shell consumer,
not part of the endpoint schema.

## Architecture

The route asks `AcpSessionBridge` for a generation stream. The bridge creates a
request ID and registers a bounded request-scoped queue before dispatching
`qwen/control/session/generation/start` to the ACP child. The child tries
`config.getFastModel()` first, falls back to `config.getModel()` during
resolution, creates the matching content generator through
`BaseLlmClient.resolveForModel`, and consumes
`generateContentStream`. Chunks return through
`qwen/notify/session/generation/event` and are routed only to the registered
request queue. They are not published to the session EventBus or replay ring.

Client disconnect sends `qwen/control/session/generation/cancel`; the child
aborts the matching controller. A bounded bridge queue protects the daemon
from a slow HTTP reader. The HTTP writer honors `res.write()` backpressure.

## Model fallback

Fallback is selection-time only. An absent or invalid fast model selects the
main model. Once generation starts, provider failures end the stream; switching
models after deltas have been emitted would duplicate or mix output.

## Web Shell thinking translation

Completed thinking blocks expose a translation action on hover. The action
remains visible while the thinking block is expanded. The
Web Shell sends a translation prompt through this endpoint and renders deltas
in a popover. The final input and output token counts appear below the
translation. The popover can cancel an in-flight request or discard the cached
result and translate again. A content-free `thinking` event reports progress without
exposing reasoning. Active thinking blocks never expose the action.
Completed translations are cached in page memory by language, message, and
content, so reopening the popover does not make another model request; a page
refresh clears the cache.

## Non-goals

- Conversation context or history
- Tool calls
- Arbitrary model or sampling overrides
- SSE replay or reconnect resume
- A task registry or task-specific schemas
- Changes to `packages/core`
