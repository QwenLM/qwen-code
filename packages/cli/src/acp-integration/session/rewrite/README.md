# Message Rewrite Middleware

ACP message rewrite middleware that transforms raw agent output (internal reasoning + reply text) into user-friendly, business-oriented formats via LLM rewriting.

## Use Case

When a coding agent is integrated into vertical business scenarios (data analysis, ops, report generation, etc.), the raw output often contains technical details (file paths, tool calls, internal reasoning) that end users don't care about. By configuring a rewrite prompt, the output can be transformed into business-friendly language.

## How It Works

1. Original messages are **passed through as-is** — no modification
2. At the end of each turn (before tool calls / at response end), accumulated thought + message chunks are sent to a separate LLM call for rewriting
3. Rewritten text is appended as a new `agent_message_chunk` with `_meta.rewritten: true`
4. The client decides which version to display based on `_meta.rewritten`

## Configuration

Add to `settings.json`:

```json
{
  "messageRewrite": {
    "enabled": true,
    "target": "all",
    "promptFile": ".qwen/rewrite-prompt.txt",
    "model": "qwen3-plus",
    "contextTurns": 1
  }
}
```

## This Is a Temporary Solution

The current implementation lives as an ACP Session-layer middleware, coupling message interception with LLM call logic. We are also exploring a hook-based approach ([#3266](https://github.com/QwenLM/qwen-code/pull/3266) — PostTurn Hook), which would enable more decoupled turn-level post-processing and support use cases beyond rewriting. However, the hook-based approach still has some open issues, so we are using the ACP middleware approach for now.

We welcome discussion on more elegant alternatives, including but not limited to:

- Externalizing rewrite logic via PostTurn Hook, with the middleware only handling message routing
- Pluggable rewrite strategies (LLM / template / rule engine)
- Client-side rewriting (agent provides structured data, frontend decides how to present it)
