# Tool-Use Summary Design

> Fast-model labels for parallel tool batches — motivation, competitive analysis with Claude Code, architecture, and the append-only-Static rationale that drove the current full-mode render.
>
> User documentation: [Tool-Use Summaries](../../users/features/tool-use-summaries.md).

## 1. Executive Summary

After each tool batch completes, Qwen Code fires a short fast-model call that returns a git-commit-subject-style label summarizing the batch. The label shows as an inline dim `● <label>` line in full mode and replaces the generic `Tool × N` header in compact mode. Generation runs fire-and-forget in parallel with the next turn's API stream, so its ~1s latency is hidden behind main-model streaming.

| Dimension             | Claude Code                                                           | Qwen Code                                                                                  |
| --------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Trigger point         | `query.ts` — after a tool batch finalizes                             | `useGeminiStream.ts` → `handleCompletedTools` — same lifecycle point                       |
| Generation model      | Haiku via `queryHaiku`                                                | Configured `fastModel` via `GeminiClient.generateContent`                                  |
| Subagent behavior     | `!toolUseContext.agentId` — main session only                         | Implicit — subagents run through `agents/runtime/`, not `useGeminiStream`                  |
| Scheduling            | Fire-and-forget, awaited right before the next turn's stream emits    | Fire-and-forget, appended to history when resolved                                         |
| Output shape          | `ToolUseSummaryMessage` yielded into the SDK stream                   | `HistoryItemToolUseSummary` added to UI history + factory exported for future SDK use      |
| Gate                  | `CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES` env, default **off**            | `experimental.emitToolUseSummaries` setting (default **on**) + env override                |
| Primary consumer      | Mobile / SDK clients                                                  | CLI compact mode + full mode, future SDK                                                   |
| Prompt                | Git-commit-subject, past tense, most distinctive noun (verbatim port) | Identical system prompt                                                                    |
| Input truncation      | 300 chars per tool field via `truncateJson`                           | Identical                                                                                  |
| Intent prefix         | First 200 chars of the assistant's last message                       | Identical                                                                                  |
| Prompt caching        | `enablePromptCaching: true` on the Haiku call                         | Not yet wired (forked-agent route available; flagged as future optimization)               |
| Label post-processing | Raw model text                                                        | `cleanSummary` (strips markdown, quotes, error-prefixes; caps at 100 chars, ReDoS-bounded) |
| Session persistence   | Stream-only; each session regenerates                                 | UI history only; `ChatRecordingService` does not persist `tool_use_summary` entries        |

## 2. Claude Code Implementation Analysis

### 2.1 Flow

Claude Code runs the tool loop in `query.ts`. After a tool batch executes and its results are normalized, the generator function forks a Haiku call, keeps the pending promise on `nextPendingToolUseSummary`, and continues with the next turn's API call. The Haiku latency (~1s) overlaps the main model's streaming (5–30s), so the user sees zero added latency. Right before emitting the next turn's content, the generator awaits the pending summary and yields a `tool_use_summary` message into the stream.

```
tool_batch_complete → fork queryHaiku (fire-and-forget)
                          ↓
               next_turn_stream_starts
                          ↓
       ← summary Promise resolves during streaming →
                          ↓
       await pendingToolUseSummary → yield ToolUseSummaryMessage
                          ↓
                continue with next turn
```

### 2.2 Key source files

| Component       | File                                                       | Key logic                                                                               |
| --------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Generator       | `services/toolUseSummary/toolUseSummaryGenerator.ts:45-97` | `generateToolUseSummary({ tools, signal, isNonInteractiveSession, lastAssistantText })` |
| Trigger         | `query.ts:1411-1482`                                       | Guard by `emitToolUseSummaries` gate + no-subagent; fork Haiku; carry promise           |
| Await + emit    | `query.ts:1055-1060`                                       | Await `pendingToolUseSummary` at next-turn boundary, yield message                      |
| Message factory | `utils/messages.ts:5105-5116`                              | `createToolUseSummaryMessage(summary, precedingToolUseIds)`                             |
| Feature gate    | `query/config.ts:23,36-38`                                 | `emitToolUseSummaries: isEnvTruthy(CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES)`                |

### 2.3 Design decisions

1. **Always generate when the gate is on, regardless of compact/detail state.** The summary is a stream-level artifact; the UI decides whether to render it.
2. **Emit as a first-class message type.** `tool_use_summary` sits alongside `user`, `assistant`, `tool_result` in the SDK stream with a `precedingToolUseIds` field for consumers to correlate against the batch.
3. **Subagents are excluded.** `!toolUseContext.agentId` — subagent output is aggregated upstream; individual subagent batches would produce noisy labels that never surface in the primary UI.
4. **Default off.** The env-only gate keeps cost at zero unless a downstream SDK consumer opts in. The CC terminal itself does not render the message.
5. **Input truncation at 300 chars per field.** Covers the dominant cost risk — a single large tool result blowing up the prompt — while keeping enough signal for the label.

## 3. Qwen Code Implementation

### 3.1 Flow

Qwen Code hooks the same lifecycle point (`useGeminiStream.handleCompletedTools`) but renders on both sides of `ui.compactMode` so the feature is useful to CLI users without any SDK plumbing.

```
tool_batch_complete (handleCompletedTools)
           ↓
  config.getEmitToolUseSummaries()?
           ↓
   fork generateToolUseSummary (fire-and-forget)
           ↓
  submitQuery() for next turn (streaming starts)
           ↓
   ← summary Promise resolves during streaming →
           ↓
  addItem({type:'tool_use_summary', summary, precedingToolUseIds})
           ↓
  HistoryItemDisplay renders:
    compactMode=false → ● <label> standalone line
    compactMode=true  → hidden; MainContent lookup injects into CompactToolGroupDisplay header
```

### 3.2 Key source files

| Component           | File                                                                  | Key logic                                                                 |
| ------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Service             | `packages/core/src/services/toolUseSummary.ts`                        | `generateToolUseSummary`, `truncateJson`, `cleanSummary`, message factory |
| Config gate         | `packages/core/src/config/config.ts:getEmitToolUseSummaries`          | Env override → settings → default (true)                                  |
| Trigger             | `packages/cli/src/ui/hooks/useGeminiStream.ts:handleCompletedTools`   | Fires fast-model call, addItem on resolve                                 |
| Full-mode render    | `packages/cli/src/ui/components/HistoryItemDisplay.tsx`               | Renders `● <label>` line when `!compactMode`                              |
| Compact-mode lookup | `packages/cli/src/ui/components/MainContent.tsx`                      | `summaryByCallId` map → `compactLabel` prop to each tool_group            |
| Compact header      | `packages/cli/src/ui/components/messages/CompactToolGroupDisplay.tsx` | Replaces default `Tool × N` with `<Summary> · N tools` when label present |
| Merge handling      | `packages/cli/src/ui/utils/mergeCompactToolGroups.ts`                 | Treats `tool_use_summary` as hidden-in-compact for adjacency              |
| UI type             | `packages/cli/src/ui/types.ts:HistoryItemToolUseSummary`              | `{ type: 'tool_use_summary', summary, precedingToolUseIds }`              |

### 3.3 The `<Static>` append-only constraint

The central architectural decision in this PR is **why the full-mode label is a standalone history item and not a decoration on the tool_group itself**.

Qwen Code renders the transcript via Ink's `<Static>`. Static is append-only: once an item is committed to the terminal buffer, Ink will not repaint that region unless `refreshStatic()` is called to clear and re-render the entire transcript. This is the performance model the CLI depends on — static items don't re-render on every keystroke.

Now consider the fast-model call's timing:

```
T0   tool batch completes, tool_group is pushed to history
T0+ε tool_group renders through <Static> and is committed to the buffer
T0+1s fast-model call resolves with a label
```

At T0+1s, we cannot retroactively add the label to the already-committed tool_group. Two options exist:

1. **Update the tool_group's props + call `refreshStatic()`.** Works, but causes a full transcript repaint on every batch — one of the most expensive UI operations in the app. Visible flash. Unacceptable for a cosmetic label.
2. **Render the summary as its own new history item appended _after_ the tool_group.** Static handles this natively — new items append cleanly, no repaint.

This PR takes option 2 in full mode. The `tool_use_summary` entry is a real history item, rendered as a single dim `● <label>` line by `HistoryItemDisplay`. No `refreshStatic` needed.

Compact mode is different because of `mergeCompactToolGroups`. When consecutive tool_groups merge, `MainContent` already calls `refreshStatic()` — that's an existing codepath, and it re-renders the merged group with the label looked up from history. So compact mode _does_ get the label as a header replacement. To avoid rendering the same label twice (once as the compact header, once as a trailing `● <label>` line), `HistoryItemDisplay` hides the standalone line when `compactMode` is true.

```
Full mode              Compact mode (with merge)
───────────            ─────────────────────────
[tool_group]           [merged tool_group — header replaced via lookup]
● <label>              (● <label> line is hidden)
```

### 3.4 Gate semantics

Three layers, resolved in order of precedence:

1. `QWEN_CODE_EMIT_TOOL_USE_SUMMARIES=0|1|true|false` — env override, highest priority.
2. `experimental.emitToolUseSummaries` in `settings.json` — default `true`.
3. Implicit skip — if `config.getFastModel()` returns `undefined`, generation is skipped regardless of the gate. No error, no user-visible change.

### 3.5 Output cleaning

`cleanSummary` runs on every model response before it is added to history:

1. Take the first line only (drops model reasoning preambles).
2. Strip bullet prefixes (`-`, `*`, `•`) — models sometimes return the label as a list item.
3. Strip surrounding quotes/backticks via a bounded `{1,10}` regex (CodeQL-safe; no real label has more than a handful of wrapping quotes).
4. Strip prefix labels (`Label:`, `Summary:`, `Result:`, `Output:`) that some models prepend.
5. Reject error-message shapes (`API error: ...`, `Error: ...`, `I cannot ...`, `I can't ...`, `Unable to ...`) — returns empty string so no history item is added.
6. Hard-cap length at 100 characters (mobile UI truncates around 30; the slack covers CJK phrases).

### 3.6 Telemetry

The summary generation call sets `promptId: 'tool_use_summary_generation'` so its token usage is accounted separately in `/stats`. This lets users see the exact incremental cost of the feature without conflating it with prompt suggestions or the main session's usage.

## 4. Deviations from Claude Code (and why)

| Deviation                                                                | Why                                                                                                                                                                                     |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Settings layer in addition to env gate                                   | Qwen Code renders the label in the CLI; users need a persistent switch, not a per-shell env export.                                                                                     |
| Default **on** instead of off                                            | Label is immediately user-visible in both display modes; users configuring `fastModel` are opting into fast-model features already.                                                     |
| Dedicated `cleanSummary` post-processing                                 | Qwen Code supports more heterogeneous providers than CC; some models prepend `Label:` or wrap in quotes. Normalizing at the boundary keeps the UI consistent.                           |
| Stores `HistoryItemToolUseSummary` rather than emitting a stream message | CLI-first implementation; the SDK-stream route is a future PR. The `ToolUseSummaryMessage` factory is already exported for that work.                                                   |
| Prompt caching not yet wired                                             | The fast model is often the same as the main model for users who haven't configured a separate one. Adding cache sharing requires routing via `forkedAgent.ts`; tracked as a follow-up. |
| Dual render paths (full-mode inline + compact-mode header)               | Qwen Code's default is `ui.compactMode: false`; without the inline full-mode render, the feature would be invisible to most users.                                                      |

## 5. Known limitations

- **No session persistence.** `tool_use_summary` is not written to the chat recording JSONL. Resuming a session loses labels; tool groups render with the generic header as a fallback. Low-priority: labels regenerate naturally as the user continues the session.
- **No SDK stream emission yet.** The message factory is exported, but the CLI does not yet feed `tool_use_summary` into the SDK bridge. Follow-up PR.
- **No prompt caching.** Each batch incurs a fresh input-token cost. Negligible in absolute terms (~300 tokens) but measurable if you run dozens of batches per turn.
- **Summary for merged compact groups picks the first contributing batch's label.** If a user fires ten dissimilar batches back-to-back (tight loop, not typical), the merged compact header will show only the leading batch's intent. Trade-off accepted: fanning out per-batch labels in a merged view is visually noisier than taking the first.
- **Fast model required.** Without a configured `fastModel`, generation is skipped. Falling back to the main model is deliberately disallowed to keep the cost profile bounded.

## 6. Future work

1. Wire `ToolUseSummaryMessage` into the SDK bridge so the existing factory gets used downstream.
2. Route generation via `forkedAgent.ts` with `enablePromptCaching` so repeated tool-name prefixes hit provider caches.
3. Optional: persist `tool_use_summary` entries to `ChatRecordingService` and replay on session resume.
4. Optional: per-tool-name label shortcuts (e.g., always `Read <filename>` for a single `read_file` call) as a pre-LLM fast path.
