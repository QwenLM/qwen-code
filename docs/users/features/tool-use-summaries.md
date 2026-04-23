# Tool-Use Summaries

Qwen Code can generate a short, git-commit-subject-style label after each tool batch completes, summarizing what the batch accomplished. The label appears inline in the transcript and replaces the generic `Tool × N` header in compact mode.

This is a UX aid for parallel tool calls: when the model fans out into several `Read` + `Grep` + `Bash` calls at once, the summary tells you the intent at a glance instead of forcing you to scan the tool list.

The feature is enabled by default and runs silently in the background. It requires a configured [fast model](./followup-suggestions#fast-model).

## What You See

### Full mode (default)

The summary appears as a dim badge line directly below the tool group:

```
╭──────────────────────────────────────────────╮
│ ✓  ReadFile a.txt                            │
│ ✓  ReadFile b.txt                            │
│ ✓  ReadFile c.txt                            │
│ ✓  ReadFile d.txt                            │
╰──────────────────────────────────────────────╯

 ● Read 4 text files
```

### Compact mode (`Ctrl+O` or `ui.compactMode: true`)

The label replaces the generic `Tool × N` header in the compact one-liner:

```
╭──────────────────────────────────────────────╮
│✓  Read txt files  · 4 tools                  │
│Press Ctrl+O to show full tool output         │
╰──────────────────────────────────────────────╯
```

The individual tool calls are still a keystroke away (`Ctrl+O` to toggle to full mode).

## How It Works

After a tool batch finalizes, Qwen Code fires a fire-and-forget call to the configured fast model with:

- The tool names, truncated arguments, and truncated results (each capped at 300 characters).
- The assistant's most recent text output (first 200 characters) as an intent prefix.
- A system prompt instructing the model to return a past-tense, 30-character label in git-commit-subject style.

The call runs in parallel with the next turn's API streaming, so its ~1s latency is hidden behind the main model's response. When the label resolves, it is appended to the transcript as a `tool_use_summary` entry.

Example labels: `Searched in auth/`, `Fixed NPE in UserService`, `Created signup endpoint`, `Read config.json`, `Ran failing tests`.

## When It Appears

The summary is generated when **all** of the following are true:

- `experimental.emitToolUseSummaries` is `true` (default).
- A `fastModel` is configured (via settings or `/model --fast`).
- At least one tool completed in the batch.
- The turn was not aborted before tool completion.
- The fast model returned a non-empty, non-error response.

Subagent tool calls do not trigger summary generation — only the main session's tool batches do.

## When It Doesn't Appear

The summary is silently skipped (no error, no UI change) when:

- No fast model is configured.
- The fast model call fails, times out, or returns empty.
- The model returned an obvious error-message-like string (e.g., `Error: ...`, `I cannot ...`) — filtered out by the client so the UI does not show misleading labels.
- The turn was aborted (`Ctrl+C`) before the model finished.

In all these cases, the tool group renders as it always has.

## Fast Model

The label is generated using the [fast model](./followup-suggestions#fast-model) — the same model you configure for prompt suggestions and speculative execution. Configure it via:

### Via command

```
/model --fast qwen3-coder-flash
```

### Via `settings.json`

```json
{
  "fastModel": "qwen3-coder-flash"
}
```

When no fast model is configured, summary generation is skipped entirely — the feature has no effect until you set one up.

## Configuration

These settings can be configured in `settings.json`:

| Setting                             | Type    | Default | Description                                                                                        |
| ----------------------------------- | ------- | ------- | -------------------------------------------------------------------------------------------------- |
| `experimental.emitToolUseSummaries` | boolean | `true`  | Master switch for summary generation. Turn off to disable the extra fast-model call.               |
| `fastModel`                         | string  | `""`    | Fast model used for summary generation (shared with prompt suggestions). Required; no-op if empty. |

### Environment override

`QWEN_CODE_EMIT_TOOL_USE_SUMMARIES` overrides the `experimental.emitToolUseSummaries` setting for the current session:

- `QWEN_CODE_EMIT_TOOL_USE_SUMMARIES=0` or `=false` — force off.
- `QWEN_CODE_EMIT_TOOL_USE_SUMMARIES=1` or `=true` — force on.
- Unset — use the `experimental.emitToolUseSummaries` setting.

### Example

```json
{
  "fastModel": "qwen3-coder-flash",
  "experimental": {
    "emitToolUseSummaries": true
  }
}
```

## Monitoring

Summary model usage appears in `/stats` output under the fast-model token totals, with the `prompt_id` `tool_use_summary_generation` so it can be distinguished from prompt suggestions and other background tasks.

## Cost

One fast-model call per qualifying tool batch. Input is a small fixed system prompt plus the truncated tool inputs/outputs (each capped at 300 characters per field). Output is a single short line (capped at 100 characters, typically 20 tokens or fewer). On a typical fast model this is roughly $0.001 per batch.

If you do not want the extra cost, turn the feature off via `experimental.emitToolUseSummaries: false` or `QWEN_CODE_EMIT_TOOL_USE_SUMMARIES=0`.

## Related

- [Compact Mode](../configuration/settings#ui.compactMode) — toggle with `Ctrl+O`; the summary replaces the generic tool-group header when compact mode is on.
- [Followup Suggestions](./followup-suggestions) — another fast-model-driven UX enhancement that shares the same `fastModel` setting.
