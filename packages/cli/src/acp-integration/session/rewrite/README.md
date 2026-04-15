# Message Rewrite Middleware

> **⚠️ Temporary Solution — subject to change or removal at any time.**
>
> This is a stopgap implementation. We are considering a hook-based approach that would be more decoupled and extensible. Ideas and suggestions for a better design are very welcome.

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
