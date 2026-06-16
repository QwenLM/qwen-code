# Prompt Queue Backpressure

## Summary

`qwen serve` now applies per-session prompt admission backpressure. The default limit is `5` pending prompts per session. A pending prompt is one that the daemon has accepted through `sendPrompt` and that has not settled yet, including prompts waiting in the per-session FIFO and the prompt currently executing.

`branchSession` remains serialized behind the same per-session FIFO, but it is not a prompt and does not consume this prompt limit.

## Semantics

- Default: `maxPendingPromptsPerSession = 5`.
- Disabled: `0` or `Infinity` means unlimited.
- Invalid: negative numbers, fractions, and `NaN` are rejected by bridge construction and `runQwenServe`. The CLI flag accepts non-negative integers; `0` disables the cap.
- Authority: the bridge is the admission gate. SDK-side accounting is an early-fail guard, not a replacement for server enforcement.
- Prompt deadline: `--prompt-deadline-ms` still applies only to prompts that were already accepted. It is not a queue admission cap.

## Bridge Behavior

`SessionEntry` tracks `pendingPromptCount`. `sendPrompt` is intentionally not `async`, so the admission check can throw synchronously before HTTP routes return `202 Accepted`.

Admission flow:

1. Look up the session.
2. Reject pre-aborted signals before incrementing the counter.
3. If `pendingPromptCount >= maxPendingPromptsPerSession`, throw `PromptQueueFullError`.
4. Increment the counter and enqueue the prompt on the FIFO.
5. Release the slot exactly once when the caller-visible prompt promise settles.

Failures do not poison the FIFO because the queue tail still swallows each prompt result. The original caller still receives the prompt rejection.

## HTTP Behavior

`POST /session/:id/prompt` catches synchronous `PromptQueueFullError` before emitting an accepted response. The route returns:

- Status: `503`
- Header: `Retry-After: 5`
- Body: `{ code: 'prompt_queue_full', error, sessionId, limit, pendingCount }`

No `promptId` is returned when admission fails.

`/capabilities` advertises:

```json
{
  "limits": {
    "maxPendingPromptsPerSession": 5
  }
}
```

When the cap is disabled, the advertised value is `null`.

## ACP HTTP Behavior

The ACP JSON-RPC transport maps `PromptQueueFullError` to a stable error shape instead of falling through to an unstructured internal error:

```json
{
  "data": {
    "errorKind": "prompt_queue_full",
    "sessionId": "...",
    "limit": 5,
    "pendingCount": 5
  }
}
```

## SDK Behavior

`DaemonClient` has a local per-session reservation for `prompt()` calls. It reserves before sending the HTTP request and releases on:

- legacy blocking `200` completion,
- non-blocking `202` turn completion,
- `turn_error`,
- caller abort,
- SSE end,
- fetch or response parsing failure.

`DaemonPendingPromptLimitError` means the SDK rejected locally and did not send the prompt request.

The SDK option accepts the numeric capability value directly; `null` disables the local cap to match `/capabilities.limits.maxPendingPromptsPerSession`.

`DaemonSessionClient` applies the same local limit for the long-lived subscription path. Static `createOrAttach`, `load`, and `resume` keep their existing parameter positions; direct construction may override the local cap.
