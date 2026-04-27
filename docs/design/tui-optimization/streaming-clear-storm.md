# TUI Flicker And Narrow Output Fix

## Scope

This PR is the metric-backed follow-up to the earlier TUI flicker work. It
targets the remaining classes that were still reproducible with local evidence:

- long pending assistant/thought streaming output can grow taller than the
  terminal and make Ink clear the whole screen;
- terminal resize can force a static-history remount and emit a full-screen
  clear even when the user has not requested `/clear`;
- narrow shell output can reflow without new bytes and look like fresh live
  output;
- expanded subagent detail can exceed its assigned tool-message budget.

The PR does not rely on terminal emulator support to hide the problem. The E2E
scripts disable synchronized output and count raw ANSI clear sequences from the
same run that produces the GIF frames.

## Source-Level Root Causes

### 1. Pending Assistant Output Clear Storm

`MainContent` renders committed history in Ink `<Static>` and the current
pending assistant item dynamically. Before this fix, `ConversationMessages`
sent long pending text directly to `MarkdownDisplay`. Long paragraphs and
single-line payloads could wrap into more visual rows than `stdout.rows`.

Ink treats dynamic output that is taller than the terminal as unsafe to patch
incrementally. It then emits:

```text
ESC[2J ESC[3J ESC[H]
```

That sequence clears the screen, resets scrollback, moves the cursor home, and
then replays static output. The user-visible result is a banner/history replay
while the model is still streaming.

### 2. Resize-Triggered Static Refresh

`AppContainer` previously watched `terminalWidth` and called `refreshStatic()`
after a short debounce. `refreshStatic()` intentionally writes
`ansiEscapes.clearTerminal` before bumping the static history key. That was safe
for explicit history replacement, but resize is not an explicit replacement
operation. A simple narrow/wide resize produced full-screen clear sequences.

### 3. Narrow Shell Reflow

The shell runner stores live output in a headless xterm. When terminal width
changes, soft-wrapped visual rows can change even when no new renderable bytes
arrived. The shell live renderer must not treat that resize-only reflow as a new
output chunk.

### 4. Subagent Detail Expansion

`AgentExecutionDisplay` supports compact/default/verbose detail modes. The
expanded modes previously had fixed item limits but did not derive their budget
from the `availableHeight` assigned by `ToolGroupMessage`. In a small terminal,
expanded detail could still occupy too much dynamic space.

## Implementation

### Shared Visual-Height Slicing

`packages/cli/src/ui/utils/textUtils.ts` now exports
`sliceTextByVisualHeight()`. It counts both explicit newlines and soft wraps
using cached display width and Unicode code points, so a single long JSON,
base64 payload, or minified log line is bounded before it reaches Ink/Yoga.

The helper supports two modes:

- `overflowDirection: "top"` keeps the newest tail for streaming logs/output;
- `overflowDirection: "bottom"` keeps the beginning for task prompts.

### Pending Assistant/Thought Output

`ConversationMessages` uses the shared slicer only while the item is pending.
When the pending text exceeds the visual budget, the live viewport shows the
newest tail plus a marker such as:

```text
... first N streaming lines hidden ...
```

Completed assistant messages still render through the existing full
`MarkdownDisplay` path, so final transcript fidelity is unchanged.

### Tool And Subagent Output

`ToolMessage` uses the same visual-height logic for string result display, so
long single-line outputs are sliced before Ink wraps them. `MaxSizedBox` still
owns the final visible-window rendering and hidden-line marker.

`AgentExecutionDisplay` now derives prompt and tool-call limits from
`availableHeight`. Default and verbose modes remain expandable, but verbose is
bounded to the assigned dynamic budget instead of rendering an unbounded list.
Tool descriptions and subagent result snippets are truncated by visual width,
not raw UTF-16 length.

### Resize Clear Removal

`AppContainer` no longer calls `refreshStatic()` solely because
`terminalWidth` changed. Active PTYs are still resized so shell dimensions stay
correct. Explicit replacement flows such as `/clear`, compact-mode replacement,
rewind, and view switches still own their clear/remount behavior.

### Shell Live Reflow Gate

`ShellExecutionService` now tracks a `renderableOutputVersion`. Live viewport
emission requires both:

- a semantic viewport comparison change; and
- newly received renderable output since the previous emitted live chunk.

The default `showColor=false` path compares unwrapped logical lines, matching
the colored path. Resize-only soft-wrap changes do not emit new live chunks.

### Evidence Capture

`TerminalCapture` now supports:

- `startAutoFlush()` / `stopAutoFlush()` so screenshots/GIFs see near-real-time
  terminal repaint instead of only a settled screenshot-time flush;
- `resize(cols, rows)` so E2E can trigger real SIGWINCH behavior through the
  PTY and xterm viewport together.

## Acceptance Metrics

All metrics and GIF frames must come from the same deterministic run.

### Streaming Clear-Storm Scenario

- fake OpenAI-compatible server streams 220 long text chunks at 70 ms/chunk;
- terminal size is 88x26;
- synchronized output is disabled;
- 93 frames are captured with live terminal flush enabled;
- pass requires `clearTerminalPairCount == 0`, `finalDoneCount == 1`, and at
  least 40 frames.

### Resize Clear-Regression Scenario

- start the normal interactive TUI with a fake OpenAI-compatible endpoint;
- wait for the prompt;
- resize 88x26 -> 62x26 -> 100x26 through the PTY;
- synchronized output is disabled;
- 50 frames are captured with live terminal flush enabled;
- pass requires `clearTerminalPairCount == 0`, prompt still visible, and at
  least 30 frames.

## Local Validation Commands

Build the bundle first:

```bash
npm run build && npm run bundle
```

Run strict fixed-branch validation:

```bash
cd integration-tests/terminal-capture
QWEN_TUI_E2E_PYTHON=/path/to/python-with-pillow \
npm run capture:streaming-clear-storm

QWEN_TUI_E2E_PYTHON=/path/to/python-with-pillow \
npm run capture:resize-clear-regression
```

Run failure-first validation against a separate `origin/main` checkout:

```bash
QWEN_TUI_E2E_REPO=/path/to/main-checkout \
QWEN_TUI_E2E_OUT=/tmp/qwen-tui/main-streaming \
QWEN_TUI_E2E_MIN_CLEAR_PAIRS=1 \
QWEN_TUI_E2E_MAX_CLEAR_PAIRS=Infinity \
QWEN_TUI_E2E_PYTHON=/path/to/python-with-pillow \
npm run capture:streaming-clear-storm

QWEN_TUI_E2E_REPO=/path/to/main-checkout \
QWEN_TUI_E2E_OUT=/tmp/qwen-tui/main-resize \
QWEN_TUI_E2E_MIN_CLEAR_PAIRS=1 \
QWEN_TUI_E2E_MAX_CLEAR_PAIRS=Infinity \
QWEN_TUI_E2E_PYTHON=/path/to/python-with-pillow \
npm run capture:resize-clear-regression
```

Each run writes:

- `summary.json`;
- raw ANSI delta log;
- per-frame PNG screenshots;
- scenario GIF when `ffmpeg` or Python/Pillow is available.

Keep local absolute artifact paths out of GitHub PR descriptions. Upload the
generated GIFs to GitHub first, then insert only GitHub attachment URLs.

## Validation Record

Validated on April 27, 2026 with the same scripts, prompt, fake server, terminal
sizes, live flush mode, and synchronized output disabled.

| Scenario  | Branch        | Expected                   | `clearTerminalPairCount` | `clearScreenCodeCount` | Frames | Result     |
| --------- | ------------- | -------------------------- | -----------------------: | ---------------------: | -----: | ---------- |
| Streaming | `origin/main` | failure-first reproduction |                      427 |                    854 |     93 | reproduced |
| Streaming | fixed branch  | strict pass                |                        0 |                      0 |     93 | passed     |
| Resize    | `origin/main` | failure-first reproduction |                        2 |                      4 |     50 | reproduced |
| Resize    | fixed branch  | strict pass                |                        0 |                      0 |     50 | passed     |

## Review Notes

- The streaming fix is complete for the reproduced assistant/thought
  clear-storm class because pending dynamic height is bounded below the
  terminal viewport before Ink layout.
- The resize fix removes the automatic resize-only clear path. Explicit
  replacement operations still clear intentionally and should be validated by
  their own UX-specific tests if their behavior changes.
- Tool and subagent detail paths are bounded by visual height/width, including
  single long lines, so they do not depend on explicit newline count.
- Copying a heavily modified Ink fork is not the preferred fix for these
  reproductions. The verified root causes are unbounded dynamic children and a
  resize-only static refresh; local bounding plus targeted clear removal is
  smaller, testable, and easier to keep aligned with upstream Ink.
