# TUI Thinking Display PR2

## Summary

PR2 makes model thinking a collapsible history block in the interactive TUI,
matching the pattern used by Claude Code:

- While thinking: reasoning streams into the pending area (height-limited) with
  a `✦` prefix in secondary color, above the answer.
- When thinking ends: the block collapses to a single line
  `∴ Thinking (ctrl+o to expand)` in the committed history.
- Ctrl+O toggles expansion of committed thinking blocks.

The spinner row shows only status phrase, timer, token estimate, and cancel
affordance — no thinking preview text.

## Why

Persistent thinking rows make common sessions harder to scan. They consume
scrollback, often repeat information that appears again in the final answer, and
push the user-visible answer and tool output farther away from the current
prompt. At the same time, completely hiding reasoning removes useful context that
users may want to review.

The collapsible-block approach keeps reasoning accessible without cluttering the
default view: collapsed by default, expandable on demand with Ctrl+O.

## Source References

### Claude Code

Claude Code renders thinking as a collapsible block in conversation history.
Completed thinking collapses to `∴ Thinking (ctrl+o to expand)` (dim, italic).
Pressing Ctrl+O expands to show the full reasoning with `∴ Thinking…` header and
dimmed markdown content. This pattern informs this PR's collapsed/expanded
states.

### Gemini CLI

Gemini CLI separates live thought status from persistent history. Its loading
indicator surfaces a thought subject while the model is responding, and thinking
is treated as transient live feedback. This PR takes the thought-as-history
approach instead, but shares the principle that the spinner row should remain
compact.

## Display States

### Streaming (pending, height-limited)

While the model is thinking, reasoning text streams into a `gemini_thought`
history item in the pending area. The pending area is height-constrained by
`constrainHeight` / `availableTerminalHeight` through `MarkdownDisplay`, the
same mechanism used for streaming answer content. This prevents long reasoning
from consuming the entire viewport.

The reasoning renders with a `✦` prefix in secondary (dim) color, visually
distinct from the answer's accent-colored `✦`.

### Committed — collapsed (default)

When the answer or a tool call begins, the pending thought item is committed to
Static history via `addItem`. In the committed state, the default render is a
single collapsed line:

```
∴ Thinking (ctrl+o to expand)
```

This line uses dim italic styling. The `gemini_thought_content` continuation
items are hidden when collapsed.

### Committed — expanded (Ctrl+O)

Pressing Ctrl+O sets `compactMode = true`, which triggers a Static remount. The
thinking block then renders the full reasoning as dimmed markdown, matching the
streaming view but without height limiting. `gemini_thought_content` items are
also shown.

Note: Ctrl+O also affects tool group compacting. The semantic is intentionally
shared — `compactMode` controls visibility of verbose detail for both thinking
and tool output.

## Configuration

No new settings are introduced. The previous `ui.thinkingDisplayMode` and
`QWEN_TUI_THINKING_DISPLAY` have been removed.

Ctrl+O = `TOGGLE_COMPACT_MODE` persists as `ui.compactMode` (existing setting).

## Implementation

### useGeminiStream.ts

- `pendingThoughtItem` state (via `useStateAndRef`) accumulates streamed
  reasoning as a `gemini_thought` history item.
- `handleThoughtEvent` updates both the transient `thought` (for window title)
  and `pendingThoughtItem` (for history rendering).
- `commitPendingThought` calls `addItem` to move the thought into committed
  history, then clears the pending state. Called on Content, ToolCallRequest,
  Finished, UserCancelled, and Error transitions.
- `pendingHistoryItems` includes `pendingThoughtItem` before `pendingHistoryItem`
  so reasoning renders above the streaming answer.

### ConversationMessages.tsx

- `ThinkMessage` renders three states:
  - `isPending` → full markdown (height-limited by pending area)
  - `!isPending && !expanded` → collapsed one-line `∴ Thinking (ctrl+o to expand)`
  - `!isPending && expanded` → full markdown (no height limit)
- `ThinkMessageContent` hides when collapsed, shows when pending or expanded.

### HistoryItemDisplay.tsx

- `gemini_thought` / `gemini_thought_content` always render (removed
  `!compactMode` gate).
- `expanded={compactMode}` passed to `ThinkMessage` / `ThinkMessageContent`.

### LoadingIndicator.tsx

- Removed `thought`, `thinkingDisplayMode`, `getThoughtPreviewText`,
  `normalizeThoughtLines`.
- Shows only `currentLoadingPhrase` + timer + tokens + cancel.

## Out Of Scope

- Restoring thought blocks on session resume (kept as not-restored).
- Changing whether the model produces thinking.
- Tool group compact behavior changes.
- SubAgent rendering redesign.
- Theme or brand changes.
- JSON/non-interactive output behavior.
