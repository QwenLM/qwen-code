# Message Rewrite Middleware

> **⚠️ Temporary Solution — subject to change or removal at any time.**
>
> This is a stopgap implementation. We are exploring a hook-based approach ([#3266](https://github.com/QwenLM/qwen-code/pull/3266) — PostTurn Hook) that would be more decoupled and extensible. The hook approach still has open issues, so we are using this ACP middleware for now.
>
> We welcome discussion on more elegant alternatives, including but not limited to:
>
> - Externalizing rewrite logic via PostTurn Hook, with the middleware only handling message routing
> - Pluggable rewrite strategies (LLM / template / rule engine)
> - Client-side rewriting (agent provides structured data, frontend decides how to present it)

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
