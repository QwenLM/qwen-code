# Mock OpenAI Server E2E Testing

How to use a mock chat-completions server to drive the CLI through scenarios
that are hard to provoke against a real model.

## When to use this vs `--openai-logging`

- **`--openai-logging`**: passive. You let real model traffic flow and inspect
  the captured request/response pairs after the fact. Right when the bug shows
  up against a real model and you want to see what was actually sent.
- **Mock server**: proactive. You control responses to drive the client into
  specific states — context overflow, malformed tool calls, specific finish
  reasons, multi-turn tool loops, slow streams. Right when the bug requires a
  response shape you can't reliably get from a real model, or when reproducing
  needs to be deterministic.

## Template

`scripts/mock-openai-server.js` is a zero-dependency Node script. Edit
`handleRequest()` at the top; protocol plumbing (HTTP, SSE streaming,
chat-completion shape, usage block) is handled below the fold.

`handleRequest({ body, inputTokens, requestIndex })` returns either:

- `{ kind: 'error', status, body }` — writes the body as JSON with the given
  status (e.g., simulate 400 / 429 / 500).
- `{ kind: 'message', content?, tool_calls?, finish_reason?, usage? }` —
  wrapped as a chat completion. Streamed or non-streamed automatically based
  on `body.stream`.

Helpers exposed at the top: `approxTokens(str)`, `toolCall(name, args)`,
`messagesContain(body, substring)`, `errorBody(message, type, extra)`.

## Pointing the CLI at the mock

```bash
PORT=8765 LOG_FILE=/tmp/mock.log \
  node .qwen/skills/e2e-testing/scripts/mock-openai-server.js &

http_proxy= https_proxy= \
<qwen> --auth-type openai \
  --openai-base-url http://127.0.0.1:8765/v1 \
  --openai-api-key sk-mock \
  -m mock-model \
  --approval-mode yolo --output-format json \
  -p 'your prompt'
```

## Verifying the mock is being hit

Tail the log file (or stderr if `LOG_FILE` is unset). You should see a
`{"kind":"listening",...}` line at startup, then one `{"kind":"request",...}`
per call. If you see nothing, the CLI is going to the real upstream — usually
because `--openai-base-url` was missing or the auth-type didn't switch.

## Specializing `handleRequest`

### Identify which caller is making the request

The CLI invokes the model from many code paths (subagents, summarizers,
planners, classifiers, etc.). Each typically injects a distinctive system
prompt or user-message preamble. Grep the source for the prompt string of
the caller you care about, copy a stable substring, and match on it:

```js
function handleRequest({ body }) {
  if (messagesContain(body, '<paste a stable substring from the caller>')) {
    // route for caller A
  }
  // fallthrough: route for everything else
}
```

Pick a substring that is unlikely to appear in user content and unlikely to
churn (avoid version numbers, dates, or rephrased sentences). If the prompt
in the codebase changes, your mock will silently fall through — log the
fingerprint match in the request log so divergence is easy to spot.

### Drive a tool-call loop

```js
return {
  kind: 'message',
  content: "I'll glob first.",
  tool_calls: [toolCall('glob', { pattern: '**/*.md' })],
};
```

`finish_reason` defaults to `'tool_calls'` when `tool_calls` is present,
`'stop'` otherwise. Override with `finish_reason: 'length'` to test
truncation handling.

### Simulate context overflow

```js
if (inputTokens >= 30000) {
  return {
    kind: 'error',
    status: 400,
    body: errorBody(
      `This model's maximum context length is 30000 tokens. However, you requested 0 output tokens and your prompt contains at least ${inputTokens} input tokens, for a total of at least ${inputTokens} tokens.`,
      'invalid_request_error',
      { param: 'input_tokens' },
    ),
  };
}
```

### Override `usage` when client behavior depends on it

Some client flows branch on the reported `usage` block — token counts feed
budget checks, telemetry, retry/backoff logic, and similar guards. The
default usage is `chars/4` over the raw request body, which roughly tracks
the real conversation size. When that's not what your scenario needs, pass
`usage` explicitly to spoof a specific count:

```js
return {
  kind: 'message',
  content: '...',
  usage: { prompt_tokens: 5000, completion_tokens: 50, total_tokens: 5050 },
};
```

## Gotchas

- **Streaming vs non-streaming both need to work.** Most flows stream, but
  some sub-paths (notably non-interactive utility calls) use non-streaming.
  The template handles both — don't add response logic that only works for
  one mode.
- **`finish_reason: 'tool_calls'` is required when emitting tool_calls.** The
  template defaults to this; only override when intentionally testing
  malformed responses.
- **Distinguishing requests by index alone is fragile.** The CLI may retry,
  background-fetch, or fan out. Prefer matching on message content.
- **Approximate token counting (chars/4) is fine for shape tests** but will
  not match a real tokenizer. Don't write assertions tighter than ±20%.

## Reference: existing specialization

`knowledge/qwen-code/scripts/issue-3664-mock-server.js` is a worked example —
the template specialized to reproduce subagent context overflow. It shows
caller fingerprinting, error injection at a token threshold, and per-caller
response branching. Read it side-by-side with the template if you need to see
how the pieces fit together for a concrete scenario.
