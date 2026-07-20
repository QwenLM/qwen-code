# Tool-Use Summaries

Qwen Code can generate a short, git-commit-subject-style label after each tool batch completes, summarizing what the batch accomplished. The label appears inline: for a completed tool group in the main view it replaces the generic `Tool × N` header; when the group is force-expanded (in the `Ctrl+O` full-detail transcript, or for error / user-initiated batches) it appears as a dim `● <label>` line below the group.

This is a UX aid for parallel tool calls: when the model fans out into several `Read` + `Grep` + `Bash` calls at once, the summary tells you the intent at a glance instead of forcing you to scan the tool list.

The feature is enabled by default and runs silently in the background. It requires a configured [fast model](./followup-suggestions#fast-model).

## What You See

### Main view (completed group)

In the main transcript, a completed collapsible batch folds into a single labeled row — the summary replaces the generic `Tool × N` header:

```
╭──────────────────────────────────────────────╮
│✓  Read 4 text files                          │
╰──────────────────────────────────────────────╯
```

The full per-tool output is a keystroke away: press `Ctrl+O` to open the full-detail transcript.

### Full-detail transcript (`Ctrl+O`) and force-expanded groups

When a group is force-expanded — in the `Ctrl+O` transcript, or for error / user-initiated batches in the main view — each tool renders individually and the summary appears as a dim badge line below the group:

```
╭──────────────────────────────────────────────╮
│ ✓  ReadFile a.txt                            │
│ ✓  ReadFile b.txt                            │
│ ✓  ReadFile c.txt                            │
│ ✓  ReadFile d.txt                            │
╰──────────────────────────────────────────────╯

 ● Read 4 text files
```

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

## Scope & lifecycle

Three points that tend to trip up a first read of this feature:

1. **One generation per batch, shared by both display modes.** The fast-model call happens exactly once in `handleCompletedTools` when a tool batch finalizes. Opening the `Ctrl+O` transcript afterwards does **not** trigger a new call — both the main view and the full-detail transcript read from the same `tool_use_summary` history entry that was captured the first time.
2. **No backfill on toggle or on session resume.** A `tool_group` that completed before the feature was enabled (or before you flipped the setting on, or in a resumed session — `ChatRecordingService` does not persist summary entries) will never get a label. There is no "sweep existing history" pass. If you turn this setting on mid-session, only _future_ batches will show a label; older groups keep the default rendering with no indicator that a label is missing.
3. **Main-agent batches only.** The trigger lives in the main session's turn loop (`useGeminiStream`), so:
   - ✅ Shell, MCP, file operations, and the `Task` / subagent tool _call itself_ (as it appears in the main batch) are summarized.
   - ❌ A subagent's **internal** tool batches (run through `packages/core/src/agents/runtime/`) are not summarized.

   An outer batch that _contains_ a `Task` tool will still be labeled, but the fast model sees only the subagent tool call and its aggregated output — not the individual tool calls inside the subagent. Expect labels like `Ran research-agent` or `Delegated file search` rather than `Searched 14 files`. This is intentional — summarizing subagent internals would multiply the fast-model cost and surface noise that never shows up in the primary UI.

## Display behavior

The main view already folds a completed collapsible batch into a single labeled row (`✓  Read 4 text files`) — the summary does the work of the old per-tool list. For full per-tool detail, press `Ctrl+O` to open the full-detail transcript, where each tool renders individually with the summary as a trailing `● <label>` line below the group.

```json
{
  "fastModel": "qwen3-coder-flash",
  "experimental": {
    "emitToolUseSummaries": true
  }
}
```

For small same-type batches (e.g. `Read × 3`) the expanded `● <label>` line can read as a restatement of the visible tool lines; if that matches your usual workflow you can turn the summary off entirely via `experimental.emitToolUseSummaries: false`.

## Monitoring

Summary model usage appears in `/stats` output under the fast-model token totals, with the `prompt_id` `tool_use_summary_generation` so it can be distinguished from prompt suggestions and other background tasks.

## Data flow & privacy

The summary call sends each successful tool's name, truncated `args`, and truncated result (each field capped at 300 characters) to the **fast model**, plus the first 200 characters of the assistant's most recent text as an intent prefix.

If your fast model is configured for the same provider/auth as your main session model, the data flows along the same boundary your main session already uses — no change in trust scope. If you have configured a fast model from a **different provider**, tool inputs and outputs (potentially including file contents read by `read_file`, command output from shell calls, or values surfaced through MCP tools) will be sent to that other provider as part of the summarization prompt. That is a strictly larger data-sharing scope than the main session alone.

If this matters for your workflow, you have two clean options:

- Configure `fastModel` to a model under the same provider as your main session, so the summary call doesn't cross any new auth/data boundary.
- Disable the feature entirely with `experimental.emitToolUseSummaries: false` (or `QWEN_CODE_EMIT_TOOL_USE_SUMMARIES=0`).

The 300-character per-field cap limits exposure but does not eliminate it — secrets discovered in tool output during the cap window can still be sent. Treat the fast model's data boundary the same way you treat the main model's.

## Cost

One fast-model call per qualifying tool batch. Input is a small fixed system prompt plus the truncated tool inputs/outputs (each capped at 300 characters per field). Output is a single short line (capped at 100 characters, typically 20 tokens or fewer). On a typical fast model this is roughly $0.001 per batch.

If you do not want the extra cost, turn the feature off via `experimental.emitToolUseSummaries: false` or `QWEN_CODE_EMIT_TOOL_USE_SUMMARIES=0`.

## Related

- [Full-detail transcript](../configuration/settings#ui) — press `Ctrl+O` to open the frozen full-detail transcript; the summary replaces the generic tool-group header for completed groups in the main view.
- [Followup Suggestions](./followup-suggestions) — another fast-model-driven UX enhancement that shares the same `fastModel` setting.
