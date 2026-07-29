# Full-turn multimodal routing

## Scope

This implements Phase 1 of #6988 only: when the primary model is text-only, an explicitly agent-capable vision model may handle the complete image-bearing turn.

It does not add persistent route state, session recovery, durable visual summaries, stable image references, historical media cleanup, or later image reinspection.

## Capability gate

Full-turn routing requires both image and agent capability:

```json
{
  "id": "vision-agent",
  "capabilities": {
    "vision": true,
    "agent": true
  }
}
```

Missing or false `agent` capability keeps the existing Vision Bridge transcription behavior.

## Routing

- If the primary accepts images, use the existing primary-model path.
- If the selected vision model is not agent-capable, transcribe through Vision Bridge and answer on the primary.
- If the selected vision model is agent-capable, keep the original image parts and set a turn-local exact model selector.
- The exact provider, model, and endpoint are reused for provider retries, tool execution, tool-result continuations, and blocking ACP Stop Hook continuations.
- Headless tool execution receives the same runtime view as the selected image model; queued notification and cron drains remain independent turns and do not inherit it.
- Configured fallback models are disabled for that turn. Failure to resolve the exact route fails closed instead of sending raw image data to the primary.
- The next independent user turn clears the selector and returns to the primary. Every model request, including side queries, receives only media modalities supported by its exact target.

The full-turn selector adds a trailing NUL marker to the existing `model\0baseUrl` representation. The chat layer removes that marker before model resolution. This keeps ordinary endpoint-qualified model selections on their existing behavior.

## Context limits

LLM-based automatic chat compression remains on the primary-model path. A full-turn route skips that compression because running primary-model compression while an image turn is owned by another provider would violate the exact-route guarantee. Existing local history microcompaction and image-payload slimming still apply, and request/cache copies retain only media modalities supported by their target model. An oversized full-turn request therefore fails on the selected model.

## Entry points

Phase 1 covers the interactive TUI, ACP, and non-interactive CLI.

Textual `@` paths are resolved to their canonical target before MIME detection, workspace checks, ignore filtering, and file reads. Both the user-supplied alias and canonical target must pass ignore filtering, so a symlink cannot disguise an ignored file or a non-image target.
