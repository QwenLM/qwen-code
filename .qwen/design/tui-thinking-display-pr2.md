# TUI Thinking Display PR2

## Summary

PR2 makes model thinking output transient in the interactive TUI and keeps two
reviewable display modes for comparison:

- `preview`: show a bounded one-to-two-line live preview while the model is
  thinking.
- `loading`: show only the existing loading status, timer, token estimate, and
  cancel affordance.

Both modes remove thinking text from persistent scrollback after the turn
finishes.

## Why

Persistent thinking rows make common sessions harder to scan. They consume
scrollback, often repeat information that appears again in the final answer, and
push the user-visible answer and tool output farther away from the current
prompt. The problem is most visible in long reasoning streams, thought-then-tool
turns, project inspections, file-read errors, and long streaming answers.

The goal is not to hide all progress feedback. Users should still know the model
is working, how long it has been running, roughly how much output is arriving,
and how to cancel. The change only narrows how much intermediate reasoning text
is retained.

## Source References

### Gemini CLI

Gemini CLI separates live thought status from persistent history. Its loading
indicator can surface a thought subject while the model is responding, and its
stream hook only writes full thinking entries to history behind an explicit
inline thinking mode. That pattern supports this PR's split between transient
live feedback and persistent conversation content.

### Claude Code

Claude Code keeps loading feedback in a compact spinner row with elapsed
thinking/status information. Thinking blocks are treated as a distinct message
class whose visibility is controlled by transcript/verbose behavior, and past
thinking can be hidden so normal scrollback remains focused on answers and tool
results. That reinforces the principle that thinking should not dominate the
default transcript.

## Display Modes

### `preview`

`preview` is the initial default because it preserves a small amount of visible
thinking context without keeping it in history. The preview chooses the first
available subject line, then the first distinct description line. Empty lines and
spinner-only dot lines are ignored. The preview is capped at two rendered text
rows and disappears when the turn finishes.

### `loading`

`loading` hides thinking text completely in the live loading row. The existing
spinner, elapsed time, token estimate, and cancel affordance remain visible. This
mode is useful for measuring the most compact experience without changing model
behavior or token accounting.

## Configuration

The interactive TUI reads the setting from `ui.thinkingDisplayMode`.

Supported values:

- `preview`
- `loading`

`QWEN_TUI_THINKING_DISPLAY` overrides the setting for local comparison runs.
Invalid values are ignored and fall back to the configured setting, then to the
default `preview`.

## Implementation Rules

- New thinking chunks update transient UI state only.
- New thinking chunks do not create `gemini_thought` or
  `gemini_thought_content` history items.
- Finished turns clear transient thinking state.
- Resumed interactive history does not restore thought parts into scrollback.
- Non-thinking content, tool calls, token statistics, model thinking controls,
  borders, SubAgent output, JSON mode, and color theme remain unchanged.

## Comparison Matrix

Use fixed terminal width `100` and the same prompt/output fixtures for baseline,
`preview`, and `loading`.

| Scenario               | Baseline Metric                               | Preview Target                                            | Loading Target                                           |
| ---------------------- | --------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------- |
| Simple Q&A             | persistent thinking rows present when emitted | persistent thinking rows = 0, max live thinking rows <= 2 | persistent thinking rows = 0, max live thinking rows = 0 |
| Long thinking stream   | scrollback grows with thinking chunks         | final scrollback removes thinking text                    | final scrollback removes thinking text                   |
| Thought then tool call | thought rows remain before tool output        | tool output remains unchanged, thought is transient       | tool output remains unchanged, no thought text shown     |
| File-read error        | thought can push error down                   | error content unchanged with fewer final rows             | error content unchanged with fewer final rows            |
| Project inspection     | thinking duplicates later summary             | answer/tool content unchanged, fewer final rows           | answer/tool content unchanged, fewer final rows          |
| Long streaming answer  | old thinking remains after answer             | final answer unchanged, thinking removed                  | final answer unchanged, thinking removed                 |

## Expected Effect

- Final persistent thinking rows: `0`.
- Maximum live thinking rows: `preview <= 2`, `loading = 0`.
- Final answer and tool content should be unchanged.
- Total visible rows after completion should be lower than baseline whenever the
  model emits thinking text.
- No scenario should gain final rows unless unrelated wrapping changes make that
  unavoidable.

## Test-Backed Metrics

The focused unit tests verify the comparison criteria that can be measured
without live model calls:

| Metric                                  | Preview                                   | Loading                               |
| --------------------------------------- | ----------------------------------------- | ------------------------------------- |
| New streamed thinking chunks in history | `0` pending/persistent thought rows       | `0` pending/persistent thought rows   |
| Live thinking text rows                 | At most two rows in the loading indicator | `0` thought-text rows                 |
| Finished turn thinking state            | Cleared after `Finished`                  | Cleared after `Finished`              |
| Resumed interactive history             | Thought parts omitted from scrollback     | Thought parts omitted from scrollback |

Full scenario row counts should be captured in the PR body with fixed-width TUI
fixtures before choosing whether `preview` or `loading` should remain the final
default.

## Out Of Scope

- Changing whether the model produces thinking.
- Removing tool borders or changing tool grouping.
- SubAgent rendering redesign.
- Theme or brand changes.
- JSON/non-interactive output behavior.
- Table, math, code block, or syntax highlighting behavior.
