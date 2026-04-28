# TUI Flicker And Narrow Output Fix

## Scope

This PR is the metric-backed follow-up to the earlier TUI flicker work. It
targets the remaining classes that were still reproducible with local evidence:

- long pending assistant/thought streaming output can grow taller than the
  terminal and make Ink clear the whole screen;
- narrow streaming Markdown can keep complete tables/lists/code blocks in the
  live pending region too long, so overflow falls back to a flat text tail
  instead of moving completed blocks into rendered Static history;
- terminal resize, view switches, compact-history replacement, rewind, auth
  refresh, resume, and editor-close refresh can force a static-history remount
  and emit a full-screen clear even when the user has not requested `/clear`;
- narrow shell output can reflow without new visible bytes and be re-emitted as
  fresh live output;
- high-volume live shell/tool text output and tmux spinner ticks can create
  avoidable redraw pressure even when the visible state is only progress;
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

### 2. Static Refresh Full-Screen Clear

`AppContainer` exposed a single `refreshStatic()` action that intentionally
wrote `ansiEscapes.clearTerminal` before bumping the static history key. That
action was used by resize, view switch, compact merge, compact-mode setting
changes, rewind, auth refresh, resume, and editor-close refresh. Those are
static-history replacement paths, but they are not user-requested terminal
resets. They could therefore clear the whole screen and scrollback while the
user was simply resizing, switching views, or expanding another TUI state.

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

### 5. High-Frequency Progress-Only Redraws

The user shell command path already throttles plain text live updates, and the
PTY viewport path is throttled/deduped in `ShellExecutionService`. The core
shell tool `updateOutput` callback still treated every data event as an
immediate UI update. That is unnecessary for plain text data bursts because the
final `ToolResult` carries the complete output after command completion.

Spinner ticks are another progress-only source. Inside tmux, frequent spinner
control sequences can disturb adjacent panes or text selection even when the
CLI itself is otherwise stable. Synchronized output intentionally stays disabled
inside tmux, so the spinner needs its own lower-frequency fallback.

### 6. Exactly-Fit Tool Output

`ToolMessage` pre-slices string results before they reach `MaxSizedBox`. The
first implementation always reserved one row for the hidden-line banner. That
was correct once content overflowed, but it treated exactly-fit output as
overflow too. A six-line result in a six-line budget lost the first visible line
and rendered a misleading hidden-line banner.

### 7. Narrow Streaming Markdown Pending Too Long

`useGeminiStream` commits stable assistant/thought prefixes to `<Static>` only
after `findLastSafeSplitPoint()` returns a safe boundary. The older helper only
recognized paragraph breaks. If a response streamed a table, list, or fenced
code block without a blank line before the next sentence, the entire block
stayed in the live pending message. When the terminal was narrow and the block
overflowed, `ConversationMessages` had to render the bounded tail as plain
wrapped text, losing table layout, code coloring, and other Markdown structure
until the response completed.

## Implementation

### Shared Visual-Height Slicing

`packages/cli/src/ui/utils/textUtils.ts` now exports
`sliceTextByVisualHeight()`. It counts both explicit newlines and soft wraps
using cached display width and Unicode code points, so a single long JSON,
base64 payload, or minified log line is bounded before it reaches Ink/Yoga.
Reserved rows are subtracted before the overflow decision. This matters in
narrow streaming: when overflow is real, the hidden-line marker must fit inside
the same dynamic height budget as the pending tail. Exactly-fit pending output
is checked with no reserved rows first; only overflowing output reserves the
single marker row.

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

The visual budget comes from `AppContainer`'s measured
`availableTerminalHeight`, which already subtracts controls, footer, tab bar,
and static-history overhead. `ConversationMessages` therefore does not keep a
separate fixed four-row footer reserve. It first checks exact fit with
`reservedRows: 0`; on true overflow it reruns the slicer with one reserved row
for the hidden-line marker.

### Streaming Markdown Safe Split

`findLastSafeSplitPoint()` now recognizes more completed Markdown block
boundaries before the unfinished tail:

- matched fenced code blocks, including backtick and tilde fences;
- table segments that include a separator row;
- consecutive Markdown list segments, including indented continuation lines;
- paragraph breaks outside fenced code blocks.

If the pending text still ends inside an open fenced block, the split point
remains before that block, preserving the existing safety invariant. Otherwise,
the newest completed table/list/code block can move into `<Static>` before the
next tail sentence finishes. This directly targets #3279 narrow Markdown
streaming: the live pending region is smaller, and completed blocks retain the
normal `MarkdownDisplay` rendering instead of degrading to flat wrapped text.

### Tool And Subagent Output

`ToolMessage` uses the same visual-height logic for string result display, so
long single-line outputs are sliced before Ink wraps them. `MaxSizedBox` still
owns the final visible-window rendering and hidden-line marker.

String output is checked for real overflow before reserving the hidden-line
banner row. Exactly-fit results render all lines without a synthetic
`... lines hidden ...` marker; overflowing results still reserve one banner row
before reaching `MaxSizedBox`.

`AgentExecutionDisplay` now derives prompt and tool-call limits from
`availableHeight`. Default and verbose modes remain expandable, but verbose is
bounded to the assigned dynamic budget instead of rendering an unbounded list.
Tool descriptions and subagent result snippets are truncated by visual width,
not raw UTF-16 length.

### Static Refresh Viewport Repaint

`AppContainer` no longer makes `refreshStatic()` a scrollback-clearing reset.
The action now performs a targeted viewport repaint:

```text
cursorTo(0, 0) + eraseDown
```

Then it remounts static history at the current width. This applies to resize,
view switches, compact-history replacement, compact-mode setting changes,
rewind, auth refresh, resume, and editor-close refresh. Active PTYs are still
resized so shell dimensions stay correct. Explicit `/clear` keeps its own
terminal reset path through `clearScreen()` and passes only a remount callback
to slash commands, so `/clear` does not emit a second `clearTerminal` write.

This does not copy or fork Ink. It keeps the existing `<Static>` architecture,
but prevents non-explicit refresh operations from clearing the entire terminal
and scrollback.

### Shell Live Reflow Gate

`ShellExecutionService` now tracks a `renderableOutputVersion`. Live viewport
emission requires both:

- a semantic viewport comparison change; and
- newly received renderable output since the previous emitted live chunk.

The default `showColor=false` path compares unwrapped logical lines, matching
the colored path. Resize-only soft-wrap changes do not emit new live chunks.

The core `ShellTool` live `updateOutput` path also throttles plain text data to
`OUTPUT_UPDATE_INTERVAL_MS` while keeping ANSI viewport updates immediate. This
matches the existing user-shell throttling policy: live output remains useful,
but high-volume text bursts no longer force a React render for every chunk. The
completed result remains exact because the final command result is still added
after the process exits.

### Tmux-Safe Spinner Fallback

`GeminiSpinner` keeps the normal Ink spinner outside tmux and keeps screen
reader text unchanged. When `TMUX` is present, it renders a fixed-width
three-character dots indicator and advances it every 750 ms. This borrows the
safe part of the Gemini CLI tmux-spinner proposal without changing Qwen's
synchronized-output allowlist or requiring terminal emulator support.

### Evidence Capture

`TerminalCapture` now supports:

- `startAutoFlush()` / `stopAutoFlush()` so screenshots/GIFs see near-real-time
  terminal repaint instead of only a settled screenshot-time flush;
- `resize(cols, rows)` so E2E can trigger real SIGWINCH behavior through the
  PTY and xterm viewport together.

The shell live-output reflow evidence is captured by a separate
`shell-reflow-regression.ts` script. That script exercises
`ShellExecutionService` directly rather than using the assistant streaming
server. This keeps the evidence aligned with the source path that owns the
narrow duplicate-output bug: the shell service emits live output events, and
the CLI renders those events inside the tool message.

## Acceptance Metrics

All metrics and GIF frames must come from the same deterministic run.
For resize evidence, a full-screen clear can be emitted and repainted between
two screenshot samples. The comparison GIF therefore must include the raw ANSI
clear metric/event annotation and the actual narrow-frame UI, so reviewers can
verify both the metric fix and the absence of garbled narrow output.

Evidence levels:

- raw ANSI metrics are authoritative for full-screen clear/flicker claims;
- event metrics are authoritative for shell live-output duplication claims;
- source-level unit tests are authoritative for exact-fit output, throttle, and
  terminal-specific fallback behavior;
- GIFs and videos are required for reviewer comprehension, but they are
  explanatory artifacts and must not be used without the matching metric from
  the same run.

### Streaming Clear-Storm Scenario

- fake OpenAI-compatible server streams 220 long text chunks at 70 ms/chunk;
- terminal size is 88x26;
- synchronized output is disabled;
- 93 frames are captured with live terminal flush enabled;
- pass requires `clearTerminalPairCount == 0`, `finalDoneCount == 1`, and at
  least 40 frames.

### Narrow Streaming Resize Scenario

- same fake streaming server and prompt as the streaming clear-storm scenario;
- terminal starts at 52x26, then resizes during active streaming through
  44 -> 52 -> 68 -> 44 -> 52 -> 68 columns;
- this validates the pending assistant/thought path under narrow panes and
  drag-resize while output is actively streaming;
- pass requires the same raw clear metric as streaming clear-storm, plus a GIF
  that visibly contrasts the old unbounded narrow output with the bounded fixed
  preview while resize is happening.

This scenario is not the proof for shell live-output duplication. The old GIF
could show raw clear metrics, but it could not reliably show the shell-specific
duplicate viewport event. The shell-specific proof is the next scenario.

### Narrow Markdown Streaming Scenario

- stream a deterministic response containing a fenced code block, a Markdown
  table, and a list without blank-line separators before the following tail;
- run in a narrow terminal where the full pending content would exceed the
  dynamic budget;
- pass requires completed code/table/list blocks to be committed before the
  tail and rendered through `MarkdownDisplay`, while the live pending tail stays
  bounded by `availableTerminalHeight`;
- source-level proof is `findLastSafeSplitPoint()` coverage for closed
  code/table/list boundaries plus pending exact-fit/overflow coverage in
  `ConversationMessages`.

### Shell Live Reflow Scenario

- `ShellExecutionService` starts a PTY at 24x8 and runs a deterministic command
  that prints one long line;
- after the first real live-output event, the PTY is resized 24 -> 12 -> 18;
- the command then emits only carriage returns (`\r`), which do not add new
  visible characters;
- on the unfixed path, the soft-wrap segmentation change is emitted as an
  extra live-output event, so the UI can append a duplicate-looking block;
- on the fixed path, resize-only reflow is ignored until new renderable bytes
  arrive;
- pass requires `resizeOnlyDataEventCount == 0` on the fixed branch and, for a
  failure-first comparison run, `resizeOnlyDataEventCount >= 1` on the base
  branch.

The comparison GIF intentionally renders the live-output event stream:

- left side: the base branch receives `event #2: resize-only duplicate`;
- right side: the fixed branch shows `no resize-only event emitted`.

That visual difference maps directly to the metric. If the left side does not
show a second resize-only event, the test has not reproduced the narrow shell
duplication bug and should not be used as evidence for that issue.

### Shell Text Throttle Scenario

- simulate multiple shell `data` events arriving inside one
  `OUTPUT_UPDATE_INTERVAL_MS` window;
- pass requires the first text event to update immediately, intermediate text
  events inside the window to stay silent, and the next event after the interval
  to publish the latest live text;
- final command output is still verified through the resolved `ToolResult`, so
  throttling cannot drop transcript content.

### Tmux Spinner Scenario

- run `GeminiSpinner` with `TMUX` set;
- pass requires the rendered spinner to use the low-frequency dots fallback
  rather than the normal high-frequency Ink spinner;
- this is a redraw-pressure reduction, not a claim that tmux is covered by
  synchronized output.

### Resize Clear-Regression Scenario

- start the normal interactive TUI with a fake OpenAI-compatible endpoint;
- wait for the prompt;
- resize 88x26 -> 62x26 -> 100x26 through the PTY;
- synchronized output is disabled;
- 50 frames are captured with live terminal flush enabled;
- pass requires `clearTerminalPairCount == 0`, prompt still visible, no garbled
  narrow header in the GIF, annotated resize clear events absent on the fixed
  side, and at least 30 frames.

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
npm run capture:narrow-streaming-regression

QWEN_TUI_E2E_PYTHON=/path/to/python-with-pillow \
npm run capture:resize-clear-regression

QWEN_TUI_E2E_PYTHON=/path/to/python-with-pillow \
npm run capture:shell-reflow-regression
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
QWEN_TUI_E2E_OUT=/tmp/qwen-tui/main-narrow-streaming \
QWEN_TUI_E2E_MIN_CLEAR_PAIRS=1 \
QWEN_TUI_E2E_MAX_CLEAR_PAIRS=Infinity \
QWEN_TUI_E2E_PYTHON=/path/to/python-with-pillow \
npm run capture:narrow-streaming-regression

QWEN_TUI_E2E_REPO=/path/to/main-checkout \
QWEN_TUI_E2E_OUT=/tmp/qwen-tui/main-resize \
QWEN_TUI_E2E_MIN_CLEAR_PAIRS=1 \
QWEN_TUI_E2E_MAX_CLEAR_PAIRS=Infinity \
QWEN_TUI_E2E_PYTHON=/path/to/python-with-pillow \
npm run capture:resize-clear-regression

QWEN_TUI_E2E_BASE_REPO=/path/to/main-checkout \
QWEN_TUI_E2E_PYTHON=/path/to/python-with-pillow \
npm run capture:shell-reflow-regression
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

| Scenario                  | Branch        | Expected                   | `clearTerminalPairCount` | `clearScreenCodeCount` | Frames | Result     |
| ------------------------- | ------------- | -------------------------- | -----------------------: | ---------------------: | -----: | ---------- |
| Streaming                 | `origin/main` | failure-first reproduction |                      427 |                    854 |     93 | reproduced |
| Streaming                 | fixed branch  | strict pass                |                        0 |                      0 |     93 | passed     |
| Narrow streaming + resize | `origin/main` | failure-first reproduction |                      498 |                    996 |     93 | reproduced |
| Narrow streaming + resize | fixed branch  | strict pass                |                        0 |                      0 |     93 | passed     |
| Resize                    | `origin/main` | failure-first reproduction |                        2 |                      4 |     50 | reproduced |
| Resize                    | fixed branch  | strict pass                |                        0 |                      0 |     50 | passed     |

Shell live-output reflow has a different metric because the bug is not a raw
screen-clear sequence. It is an extra live-output event produced after a
resize-only soft-wrap change.

| Scenario          | Branch        | Expected                   | Data events | Resize-only events | Result     |
| ----------------- | ------------- | -------------------------- | ----------: | -----------------: | ---------- |
| Shell live reflow | `origin/main` | failure-first reproduction |           2 |                  1 | reproduced |
| Shell live reflow | fixed branch  | strict pass                |           1 |                  0 | passed     |

Revalidated on April 28, 2026 after the exact-fit tool-output fix and the
`refreshStatic()` semantic change from full-screen clear to viewport repaint.

| Scenario                  | Branch       | Expected    | `clearTerminalPairCount` | `clearScreenCodeCount` | Frames | Result |
| ------------------------- | ------------ | ----------- | -----------------------: | ---------------------: | -----: | ------ |
| Streaming                 | fixed branch | strict pass |                        0 |                      0 |     93 | passed |
| Narrow streaming + resize | fixed branch | strict pass |                        0 |                      0 |     93 | passed |
| Resize/static refresh     | fixed branch | strict pass |                        0 |                      0 |     50 | passed |

| Scenario          | Branch       | Expected    | Data events | Resize-only events | Result |
| ----------------- | ------------ | ----------- | ----------: | -----------------: | ------ |
| Shell live reflow | fixed branch | strict pass |           1 |                  0 | passed |

Additional source-level regressions validated on April 28, 2026:

| Scenario            | Branch       | Expected    | Metric                                  | Result |
| ------------------- | ------------ | ----------- | --------------------------------------- | ------ |
| Shell text throttle | fixed branch | strict pass | first update immediate, burst collapsed | passed |
| Tmux spinner        | fixed branch | strict pass | fixed-width dots fallback under `TMUX`  | passed |

Additional source-level revalidation after the April 28 optimization pass:

| Scenario               | Branch       | Expected    | Metric                                         | Result |
| ---------------------- | ------------ | ----------- | ---------------------------------------------- | ------ |
| Rewind static refresh  | fixed branch | strict pass | viewport repaint, no `clearTerminal`           | passed |
| Shell final transcript | fixed branch | strict pass | throttled live text, complete final output     | passed |
| Tmux spinner cadence   | fixed branch | strict pass | 750 ms frame transition under fixed-width dots | passed |

Additional review follow-up validation for #3279:

| Scenario                         | Branch       | Expected    | Metric                                             | Result |
| -------------------------------- | ------------ | ----------- | -------------------------------------------------- | ------ |
| Markdown safe split              | fixed branch | strict pass | code/table/list boundaries split outside open code | passed |
| Pending assistant exact fit      | fixed branch | strict pass | six-row pending text in six-row budget is visible  | passed |
| Pending assistant overflow bound | fixed branch | strict pass | only one marker row is reserved on real overflow   | passed |

## Gemini CLI Cross-Check

The Gemini CLI scan supports the same direction, but also warns against copying a
large renderer wholesale:

- Gemini's `TerminalBuffer` PR (`google-gemini/gemini-cli#24512`) separates
  static history from dynamic controls to reduce flicker, but the default was
  later turned back off in `#24873` because long histories regressed. For Qwen,
  a terminal-buffer style renderer should remain a later feature-flagged
  experiment, not part of this PR.
- Gemini's resize work (`#18969`, `#21924`) targets destructive clears and
  resize-time history churn. Qwen's current fix follows the smaller proven part:
  non-explicit `refreshStatic()` no longer emits `clearTerminal`, and resize has
  a raw ANSI clear metric.
- Gemini's copy-mode stabilization (`#22584`) uses a freeze-frame approach:
  fixed controls height and paused nonessential dynamic widgets. The same idea is
  the preferred follow-up for any remaining ctrl+f/detail/copy interaction
  jitter in Qwen.
- Gemini's shell-output PRs (`#25461`, `#25643`) throttle high-volume text data
  while preserving final output. Qwen now applies the same policy to the core
  shell tool and already applies it to the user-shell path.
- Gemini's tmux spinner PR (`#22067`) avoids high-frequency spinner redraws
  inside tmux. Qwen now uses a local tmux-safe dots fallback while keeping
  synchronized output disabled in tmux by default.

## Review Notes

- The streaming fix is complete for the reproduced assistant/thought
  clear-storm class because pending dynamic height is bounded below the
  terminal viewport before Ink layout.
- The #3279 narrow Markdown path is covered by two guards: complete
  code/table/list blocks leave the pending region earlier, and the remaining
  pending tail uses the measured dynamic height budget instead of a fixed
  footer reserve.
- The static refresh fix replaces non-explicit `clearTerminal` refresh paths
  with a viewport repaint. This covers resize, view switch, compact replacement,
  rewind, auth/resume, and editor-close refresh while keeping `/clear` explicit.
  A pure remount removal was not correct because stale `<Static>` output could
  remain visible after width changes or view replacement.
- The shell reflow fix must be validated with shell live-output events, not the
  assistant streaming clear-storm GIF. The latter proves dynamic-height
  bounding and raw clear suppression; the former proves narrow shell duplicate
  output is no longer emitted.
- Tool and subagent detail paths are bounded by visual height/width, including
  single long lines, so they do not depend on explicit newline count. Exactly-fit
  string output is not pre-sliced into a false hidden-line state.
- High-frequency shell text and tmux spinner updates are now treated as
  redraw-pressure sources. They are throttled or downgraded without changing
  final transcript/output fidelity.
- Copying a heavily modified Ink fork is not the preferred fix for these
  reproductions. The verified root causes are unbounded dynamic children and a
  full-screen static refresh; local bounding plus targeted viewport repaint is
  smaller, testable, and easier to keep aligned with upstream Ink.
