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

`extractErrorMessage` has eight call sites, all in `bridge.ts`:

| Call site                                   | Surface                                             |
| ------------------------------------------- | --------------------------------------------------- |
| `broadcastTurnError`                        | `turn_error`, `entry.turnError`, and refresh replay |
| timed-out `newSession` cleanup quarantine   | daemon stderr                                       |
| two `model_switch_failed` publishers        | SSE event message                                   |
| approval-mode restore                       | daemon stderr                                       |
| timed-out session-action cleanup quarantine | daemon stderr                                       |
| `sendPrompt` forward failure                | daemon stderr                                       |
| pending-prompt cancel-forward failure       | daemon stderr                                       |

`transcript-replay.ts` defines a separate local helper with the same name;
it is not a call site of the bridge helper and is untouched by this change.

`classifyTurnErrorKind` exact-matches the message against `terminated`; that
error arrives via the plain-text `data.details` shape and is unaffected by
adding a nested-`error` branch.

## Proposed change

Extend `extractJsonRpcErrorDetail` in `packages/acp-bridge/src/bridge.ts`
with one more fallback: after the existing `data` string / `data.details` /
`data.message` checks, read a nested `data.error` — accepting either a plain
string or an object with a string `message` while preserving the existing
top-level precedence. Update the `extractErrorMessage` doc comment to name the
`data.error.message` shape as the ACP SDK's JSON-parsed-message artifact.

That is the entire production change. `broadcastTurnError` then publishes the
provider's own message as `turn_error.data.message`. The Web Shell transcript
error block, live-state `turnError` summary, refresh replay, and SDK consumers
of that `turn_error` (including `DaemonHttpError`) then receive the real reason
with no wire schema change and no SDK or webui edits. The separate
turn-status overlay normalization path is unchanged.

Result for the motivating failure: the transcript shows
`The engine is currently overloaded, please try again later` instead of
`Internal error`.

## Key decisions

- **Fix at message extraction, not an additive wire field.** An alternative
  considered was adding `turn_error.data.detail` and plumbing it through
  `DaemonTurnErrorData`, the UI normalizer, transcript block types, and the
  webui adapter. That preserves the generic `message` for hypothetical
  string matchers but costs four packages of churn for the same user-visible
  result. The eight bridge call sites above are display, log, or event
  surfaces. The only behavioral check on the extracted message recognizes
  `terminated`, which already arrives through `data.details`, so enriching
  the nested shape is safe and minimal.
- **Preserve existing precedence.** A string `data`, top-level `details`, or
  top-level `message` continues to win over the new nested `error.message`
  fallback.
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

- Should the separate `normalizeTurnResultError` path used by turn-status
  polling also extract provider detail or carry the provider `type` (e.g.
  `engine_overloaded_error`) as a structured code? Deferred — this PR only
  changes bridge extraction for `turn_error`; the terminal overlay may still
  retain the generic `Internal error`.
- If provider blobs prove unwieldy in practice, where should the length cap
  live — the bridge extractor or the event publisher? Deferred until observed.
