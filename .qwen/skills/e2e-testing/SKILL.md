---
name: e2e-testing
description: Guide for running end-to-end tests of the Qwen Code CLI, including headless mode, MCP server testing, and API traffic inspection. Use this skill whenever you need to verify CLI behavior with real model calls, reproduce user-reported bugs end-to-end, test MCP tool integrations, or inspect raw API request/response payloads. Trigger on mentions of E2E testing, headless testing, MCP tool testing, or reproducing issues.
---

# E2E Testing Guide

How to run the Qwen Code CLI end-to-end — from building the bundle to inspecting
raw API traffic. Use when unit tests aren't enough and you need to verify behavior
through the full pipeline (model API → tool validation → tool execution).

## Setup

### Which binary to use

- **Reproducing bugs**: use the globally installed `qwen` command — this matches
  what the user ran when they filed the issue.
- **Verifying fixes**: build first (`npm run build && npm run bundle`), then run
  `node dist/cli.js` — this tests your local changes.
- **Runtime-only checks (fastest)**: `npm run dev -- "<prompt>" <flags>` — runs TS
  source via tsx, no build. Use `build && bundle` + `node dist/cli.js` only when the
  shipped artifact itself matters. (`<qwen>` below can be `npm run dev --`.)

### Running against a real model

Headless auth comes from `~/.qwen`. Force a known-good model with `--auth-type` +
`--model`:

```bash
<qwen> "your prompt" --auth-type openai --model deepseek-v4-flash \
  --approval-mode yolo --output-format json
```

**Gotcha:** `--model` alone won't switch providers — `--auth-type` (`openai`/`anthropic`/`qwen-oauth`/`gemini`/`vertex-ai`) does. Omit it and the run falls back to the default provider and dies
on its missing key.

### Isolating runtime artifacts

`QWEN_RUNTIME_DIR=<dir>` redirects qwen's runtime output — `tmp/`, `debug/`,
and `projects/<sanitized-cwd>/...` (chat recordings, auto-memory, history) —
into `<dir>` instead of `~/.qwen`. Config (`settings.json`, OAuth tokens,
`commands/`) still reads from `~/.qwen`, so real auth and provider config
work without any setup.

**Use when** repeated test runs would clutter your real chat history or
auto-memory. **Skip when** the bug you're reproducing depends on the user's
actual history or runtime state — that _is_ the repro.

```bash
QWEN_RUNTIME_DIR=/tmp/test-1/runtime <qwen> "prompt" ...
```

## Run modes

### Headless Mode

Run the CLI non-interactively with JSON output (`<qwen>` = `qwen` or
`node dist/cli.js` per above):

```bash
<qwen> "your prompt here" \
  --approval-mode yolo \
  --output-format json \
  2>/dev/null
```

`--output-format json` emits **one JSON array** (all messages, flushed at end of turn) — filter with `jq '.[] | …'`, never a bare `jq 'select(…)'`. (`--output-format stream-json` instead emits NDJSON, one object per line.) Element types:

- `type: "system"` — init: `tools`, `mcp_servers`, `model`, `permission_mode`
- `type: "assistant"` — model output: `content[].type` is `text`, `tool_use`, or `thinking`
- `type: "user"` — tool results: `content[].type` is `tool_result` with `is_error`
- `type: "result"` — final output with `result` text and `usage` stats

Filter with `jq` — lead with `.[]` to enter the array, e.g. tool-result errors:
`... 2>/dev/null | jq '.[] | select(.type=="user") | .message.content[] | select(.is_error)'`

### Interactive Mode (tmux)

Use when you need to verify TUI rendering, test keyboard interactions, or see
what the user sees. Headless mode is simpler when you only need structured output.

#### Launching

```bash
tmux new-session -d -s test -x 200 -y 50 \
  "cd /tmp/test-dir && <qwen> --approval-mode yolo"
sleep 3  # wait for TUI to initialize
```

#### Sending prompts

Split text and Enter with a short delay — sending them together can cause the
TUI to swallow the submit:

```bash
tmux send-keys -t test "your prompt here"
sleep 0.5
tmux send-keys -t test Enter
```

#### Waiting for completion

Poll for the streaming indicator to disappear instead of blind sleeping. The
footer placeholder `Type your message` is _always_ rendered — don't grep for
that or the loop exits on iteration 1 while the model is still working. The
status line `esc to cancel` is present only while the model is producing
output:

```bash
for i in $(seq 1 60); do
  sleep 2
  tmux capture-pane -t test -p | grep -q "esc to cancel" || break
done
```

#### Capturing output

```bash
tmux capture-pane -t test -p -S -100   # -S -100 = 100 lines of scrollback
```

#### Limitations

- **Key combos**: `tmux send-keys` cannot reliably send all key combinations.
  `C-?`, `C-Shift-*`, and function keys with modifiers are unsupported or
  unreliable. For these, use the `InteractiveSession` harness in
  `integration-tests/interactive/` or test manually.
- **Visual artifacts**: `capture-pane` captures the final rendered frame, not
  intermediate states. Flicker, tearing, or brief blank frames cannot be
  detected this way.

#### Cleanup

```bash
tmux kill-session -t test
```

## Inspecting

### Inspecting Raw API Traffic

When debugging model behavior (wrong tool arguments, schema issues), enable API
logging to see the exact request/response payloads:

```bash
<qwen> "prompt" \
  --approval-mode yolo \
  --output-format json \
  --openai-logging \
  --openai-logging-dir /tmp/api-logs
```

Each API call produces a JSON file (can be 80KB+ due to full message history).
The bulk is in `request.messages` (conversation history). Trimmed structure:

```json
{
  "request": {
    "model": "coder-model",
    "messages": [
      { "role": "system|user|assistant", "content": "...", "tool_calls?": [...] }
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "tool_name",
          "description": "...",
          "parameters": { ... }      // schema sent to the model
        }
      }
    ]
  },
  "response": {
    "choices": [
      {
        "message": {
          "role": "assistant",
          "content": "...",          // text response (may be null)
          "tool_calls": [
            {
              "id": "call_...",
              "function": {
                "name": "tool_name",
                "arguments": "..."   // raw JSON string from the model
              }
            }
          ]
        }
      }
    ]
  }
}
```

Structured-output calls (those requesting a JSON schema, e.g. side queries via
`BaseLlmClient.generateJson`) deliver the schema as a synthetic tool named
`respond_in_schema` under `request.tools[0]` — _not_ under `response_format`,
which is null for OpenAI-compatible providers. The model's structured reply
lands in `tool_calls[0].function.arguments` instead of `message.content`.
Text-mode calls have no `tools` and use `message.content`.

### Token Usage Stats

Use `scripts/token-stats.py` to summarize token usage across recent API logs:

```bash
python3 .qwen/skills/e2e-testing/scripts/token-stats.py 20  # last 20 requests
```

Shows input, cached, and output tokens per request with cache hit rates. Useful
for verifying prompt caching behavior or investigating unexpected token counts.

## Test harnesses

### MCP Server Testing

For testing MCP tool behavior end-to-end, read `references/mcp-testing.md`. It
covers the setup gotchas (config location, git repo requirement) and includes
a reusable zero-dependency test server template in `scripts/mcp-test-server.js`.

### Mock OpenAI Server

For driving the CLI through scenarios that are hard to provoke against a real
model — specific error codes, malformed tool calls, deterministic multi-turn
loops, controlled `usage` blocks — read `references/mock-openai-server.md`.
It covers when to reach for a mock vs `--openai-logging`, how to point the
CLI at it, and patterns for specializing the zero-dependency template at
`scripts/mock-openai-server.js`.

## Tips

- Use interactive (tmux) mode when the bug involves permission prompts, slash
  commands, or keyboard interactions. Headless mode has no TUI — these don't
  exist there.
- Use interactive (tmux) mode for hang-related issues. Headless mode produces
  no output when the process stalls, giving you nothing to work with.
- Use `--approval-mode default` when testing permission rules. `yolo` bypasses
  rule evaluation entirely — it can't test whether a rule matches.
