# Surface provider error detail in `turn_error` messages

Date: 2026-08-30
Status: proposed

## Problem statement

When a daemon-hosted prompt turn fails because the model provider rejects the
request, the Web Shell shows the bare text `Internal error`. The actual
provider reason (e.g. `The engine is currently overloaded, please try again
later`) never reaches any user-visible surface, so users cannot distinguish a
transient provider overload from a genuine daemon bug. Observed in production
on session `eeab9c1c-305d-4259-8a37-2ef8d07ca934`: four turn failures, all
displayed as `Internal error`, all caused by the upstream
`engine_overloaded_error` body.

## Current state

The error travels through five layers; the detail is dropped at the third:

1. **core (agent child).** The provider returns the error as a stream chunk
   (`finish_reason: "error_finish"`, JSON body in `delta.content`). The
   pipeline throws `StreamContentError` whose `.message` is the raw upstream
   JSON string
   (`packages/core/src/core/openaiContentGenerator/pipeline.ts`).
2. **ACP SDK (agent child).** The catch-all in `#tryCallRequestHandler`
   serializes a non-`RequestError` throw as
   `RequestError.internalError(JSON.parse(error.message))` — i.e. wire shape
   `{code: -32603, message: 'Internal error', data: <parsed message>}`.
   For a JSON message like ours this yields
   `data: {error: {message, type}}`; for a plain-text message that fails
   `JSON.parse` it yields `data: {details: <message>}`
   (`@agentclientprotocol/sdk`, `acp.js`).
3. **acp-bridge (daemon).** `broadcastTurnError`
   (`packages/acp-bridge/src/bridge.ts`) builds the `turn_error` SSE event
   with `message = extractErrorMessage(err)`. `extractJsonRpcErrorDetail`
   today reads a string `data`, `data.details`, and `data.message` — but
   **not** the nested `data.error.message` the JSON-parsed shape produces.
   It therefore falls back to `err.message`, the generic `Internal error`.
4. **sdk-typescript.** `turn_error` validates with only
   `sessionId` + `message` required and normalizes to a
   `DaemonUiErrorEvent` whose `text` is that message.
5. **webui.** `turn_error` stays in the transcript (never routes to notices)
   and renders as a `system_error` block whose text is the event message.

Because the plain-text shape (`data.details`) already surfaces through the
existing extractor, only the JSON-parsed shape loses its detail. The gap is a
missing branch in one helper, not an absent wire field.

`extractErrorMessage` has exactly five call sites, all in `acp-bridge`, and
all are display or log surfaces with no string-matching behavioral consumer:

| Call site                                   | Surface                                                                            |
| ------------------------------------------- | ---------------------------------------------------------------------------------- |
| `bridge.ts` `broadcastTurnError`            | `turn_error` event message, `entry.turnError`, refresh replay, turn-status overlay |
| `bridge.ts` `sendPrompt` forward-failed log | daemon stderr                                                                      |
| `bridge.ts` cancel-forward-failed log       | daemon stderr                                                                      |
| `bridge.ts` approval-mode restore log       | daemon stderr                                                                      |
| `bridge.ts` channel quarantine log          | daemon stderr                                                                      |
| `transcript-replay.ts` tool-result replay   | restored transcript error text                                                     |

`classifyTurnErrorKind` exact-matches the message against `terminated`; that
error arrives via the plain-text `data.details` shape and is unaffected by
adding a nested-`error` branch.

## Proposed change

Extend `extractJsonRpcErrorDetail` in `packages/acp-bridge/src/bridge.ts`
with one more fallback: after the existing `data` string / `data.details` /
`data.message` checks, read a nested `data.error` — accepting either a plain
string or an object with a string `message` (mirroring the desktop client's
`getAcpErrorDetail`, which has shipped the same precedence for ACP internal
errors). Update the `extractErrorMessage` doc comment to name the
`data.error.message` shape as the ACP SDK's JSON-parsed-message artifact.

That is the entire production change. `broadcastTurnError` then publishes the
provider's own message as `turn_error.data.message`, and every downstream
surface — the Web Shell transcript error block, the live-state `turnError`
summary, refresh replay, `DaemonClient`'s `DaemonHttpError`, and the daemon
stderr logs — shows the real reason with no wire schema change and no
SDK/webui/desktop edits.

Result for the motivating failure: the transcript shows
`The engine is currently overloaded, please try again later` instead of
`Internal error`.

## Key decisions

- **Fix at message extraction, not an additive wire field.** An alternative
  considered was adding `turn_error.data.detail` and plumbing it through
  `DaemonTurnErrorData`, the UI normalizer, transcript block types, and the
  webui adapter. That preserves the generic `message` for hypothetical
  string matchers but costs four packages of churn for the same user-visible
  result. Every actual `message` consumer is enumerated above and is a
  display/log surface, so enriching `message` directly is safe and minimal.
- **Precedence matches desktop.** Top-level `details`/`message` win over the
  nested `error.message`, identical to `formatQwenAcpErrorMessage`'s
  `getAcpErrorDetail` in
  `packages/desktop/packages/shared/src/agent/qwen-agent.ts`. One consistent
  de-facto contract for ACP `-32603` data across clients.
- **No new length bound.** The existing `data.details` path is already
  unbounded, so a pathological provider blob flows today; this change keeps
  parity instead of inventing a second policy. Render-side control-character
  sanitization (`sanitizeDaemonTerminalText`) and event-bus frame byte
  accounting already apply. A bound can be revisited as its own change.
- **No new `errorKind`.** `DaemonErrorKind` stays closed; this change only
  improves human-readable text. A structured kind (e.g. provider-overload)
  belongs with retry-classification work, not text plumbing.

## Files affected

| File                                                 | Change                                                                                                                                                            |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/acp-bridge/src/bridge.ts`                  | nested `data.error` branch in `extractJsonRpcErrorDetail`; doc comment                                                                                            |
| `packages/acp-bridge/src/bridge.test.ts`             | new `extractErrorMessage` cases: nested `error.message`, string `error`, precedence over/absence of top-level keys, non-JSON fallback unchanged                   |
| `integration-tests/fake-openai-server.ts`            | test infrastructure: `errorContent` choice field emitting a single `error_finish` chunk (error body and finish reason on the same chunk, matching real gateways)  |
| `integration-tests/fake-openai-server.test.ts`       | self-test pinning the same-chunk invariant                                                                                                                        |
| `integration-tests/cli/qwen-serve-streaming.test.ts` | regression case: fake OpenAI server emits an `error_finish` chunk with a JSON error body; assert the session SSE `turn_error` `message` carries the provider text |
| `docs/developers/daemon/09-event-schema.md`          | `turn_error` row: note that `message` may carry provider-supplied detail for `-32603` agent failures                                                              |

## Scope boundaries

- No retry-behavior change. Classifying `engine_overloaded_error` as
  retryable (503-equivalent) is a separate, independent follow-up.
- No change to `matchTurnEvent`, `normalizeTurnResultError`, the prompt
  ledger record shape, or the Java SDK.
- TUI (non-daemon) error rendering is untouched; it does not traverse the
  bridge extractor.
- No `DaemonErrorKind` additions and no Web Shell UI restructuring.

## Open questions

- Should `normalizeTurnResultError` (turn-status polling overlay) also carry
  the provider `type` (e.g. `engine_overloaded_error`) as a structured code?
  Deferred — current overlay consumers only display `message`.
- If provider blobs prove unwieldy in practice, where should the length cap
  live — the bridge extractor or the event publisher? Deferred until observed.
