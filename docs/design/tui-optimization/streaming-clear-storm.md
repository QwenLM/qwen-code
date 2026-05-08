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
narrow output: marker rows must be budgeted only on paths that actually render
them. Pending assistant/thought streaming now uses no live marker row at all,
while tool/static truncation paths still reserve a row when they show a
hidden-line banner.

The helper supports two modes:

- `overflowDirection: "top"` keeps the newest tail for streaming logs/output;
- `overflowDirection: "bottom"` keeps the beginning for task prompts.

### Pending Assistant/Thought Output

`ConversationMessages` uses the shared slicer only while the item is pending.
When the pending text exceeds the visual budget, the live viewport shows the
newest tail without a synthetic hidden-line marker. Completed assistant
messages still render through the existing full `MarkdownDisplay` path, so final
transcript fidelity is unchanged.

The visual budget comes from `AppContainer`'s measured
`availableTerminalHeight`, which already subtracts controls, footer, tab bar,
and static-history overhead. `ConversationMessages` therefore does not keep a
separate fixed four-row footer reserve. It slices with `reservedRows: 0` because
live pending output no longer renders a marker row.

The pre-sliced pending tail is also rendered through `MaxSizedBox` and capped to
a small live viewport. This is a second, actual-Ink-layout guard for the #3279
scrollback leak shown in narrow terminals: if source-text visual-height
estimation is still off because of wrapping, prefix width, or renderer layout
details, `MaxSizedBox` clips the plain pending tail before it reaches
log-update. The cap is intentionally lower than the whole terminal budget,
because recently committed Static prefix text can still be visible above the
pending tail during streaming; allowing the tail to consume the full dynamic
budget can still scroll marker/fence rows into the terminal scrollback.

The live pending preview intentionally does not render synthetic hidden-line
marker rows. Those markers are useful in final/static output, but in a
main-screen live renderer they can become their own repeated scrollback artifact
if the terminal scrolls while a frame is being patched. The preview also treats
unfinished fenced code blocks, Markdown tables, and structural Mermaid/table
tails as unstable suffixes, but it no longer hides them behind placeholders.
Instead it follows the Claude Code invariant observed in
`src/screens/REPL.tsx`: only complete source lines are shown live, while the
currently edited partial line is withheld until the next newline. Fence
delimiter rows are removed, source is rendered as bounded plain text during
streaming, and structural repeats are folded globally inside the current preview
window. Once the block closes or the response commits, the message still renders
through `MarkdownDisplay`, so stored transcript fidelity is preserved without
writing incomplete control/syntax rows into live scrollback on every frame.

The display guard also spans safe-split chunks from the same assistant turn.
Long responses are promoted as `gemini` followed by one or more
`gemini_content` items. A per-item duplicate cap is not enough in that shape:
each item can keep two repeated rows and the full terminal scrollback can still
accumulate a screen of duplicate table/prose rows. `MainContent` now passes the
previous assistant/thought chunk tail into the next continuation chunk, and
`ConversationMessages` applies the repeat budget across that boundary. Markdown
structure rows such as headings, table rows, table-shaped wrapped fragments, and
Mermaid diagram relationship/declaration rows are capped to one consecutive
visible row; generic prose is capped to two consecutive visible rows. This is a
display-layer guard: the stored response text is not rewritten by this UI
normalization.

Committed chunks that become empty after boundary blank trimming or cross-chunk
repeat folding return `null` instead of rendering an empty Static row. This
prevents blank-only safe-split chunks from leaving large vertical gaps in the
main screen.

The final 24/34-column iTerm2 reproductions showed one remaining architectural
limit: even when pending Markdown source is bounded, the main-screen Ink dynamic
region can still leave visual blank space between the last Static user prompt and
the bottom composer/loading controls. Hiding all live pending content avoided
duplicate scrollback, but it regressed the interaction: Mermaid/code appeared to
stop streaming and then arrived all at once. That trade-off was rejected.

The accepted behavior is:

- `Composer` always keeps the loading indicator, `esc to cancel`, input prompt,
  and footer visible so the pane does not look stalled or broken;
- `terminalWidth > 20` keeps bounded live pending assistant/thought preview,
  including complete lines inside an unclosed Mermaid fence;
- `terminalWidth <= 20` keeps only the Composer controls during response as an
  extreme fallback, because there is not enough width to show useful wrapped code
  without turning almost every token into a visual row;
- `WaitingForConfirmation` remains interactive, so tool confirmations and other
  explicit prompts are not hidden.

This keeps the stored transcript and final Markdown rendering unchanged, avoids
placeholder rows such as `... writing code block ...`, and restores Claude-like
quasi-streaming for the reproducible 24-column and 34-column panes without
copying Claude Code's custom renderer. Static notices were tested and rejected:
although they suppressed repeated live content, they left the pane looking blank
and removed the input affordance during long model/provider stalls.

When `QWEN_STREAM_DEBUG=1` is set, the renderer writes
`assistant_display_metrics` records. Each record contains repeat fingerprints
for the raw chunk, the displayed chunk, and the previous assistant chunk. This
is the primary local diagnostic for the latest "still has blank lines +
duplicate output" reports:

- raw repeat high, displayed repeat low: the provider/model emitted repeated
  rows, and the UI guard bounded what it displayed;
- raw repeat low, displayed repeat high: the renderer is still duplicating rows
  and the TUI fix is incomplete;
- raw repeat high in `content_buffer_metrics.rawEvent` with high
  `suppressedBytes`: the OpenAI-compatible converter trimmed cumulative or
  rolling-overlap provider chunks;
- raw repeat high with low `suppressedBytes`: the model itself generated a
  repeated phrase/table row, so this PR can bound the TUI display but cannot
  claim the model output is semantically fixed.

## PR Audit Summary

This PR is now locally and manually validated against the original narrow-pane
reproductions. The fixes that mattered were not a single tweak; they closed the
problem in two layers:

1. normalize and bound the streaming text before Ink sees it;
2. move waiting/live responsibility back into the main message area so narrow
   panes stop looking blank while the model is responding.

### Problems Closed By This PR

| Problem                                                            | Symptom                                                                    | Fix                                                                                                                                                                              |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Narrow-pane duplicate streaming output                             | Mermaid/table/Markdown rows reappear while the response is still streaming | delay `safe-split`, separate display/full buffers, overlap-aware normalization, and per-preview repeat folding                                                                   |
| Large runs of blank rows during streaming                          | visible blank area keeps growing as output continues                       | collapse blank rows in the display buffer and trim leading/trailing blank rows after visual slicing                                                                              |
| Unstable live preview for fenced/table/structured Markdown         | partial fences/tables cause preview churn or repeated structural rows      | treat unclosed fence/table/structural suffixes as unstable live tails and strip incomplete tail rows                                                                             |
| Waiting placeholder hides tool progress                            | UI shows only `Generating response...` while pending tool activity exists  | placeholder no longer short-circuits the whole pending region; non-assistant pending items still render                                                                          |
| Assistant has already started, but UI still looks stuck in waiting | first visible content arrived yet pane still shows waiting state           | waiting no longer depends on preview heuristics; it now uses `hasRenderablePendingAssistantSignal()`                                                                             |
| Long white gap at the start of narrow responses                    | top of pane stays empty while loading UI sits near the composer            | main content is explicit full-height/top-aligned, and ultra-narrow responding panes suppress the bottom loading indicator so waiting/live feedback returns to the message region |

### Changes That Actually Moved The Needle

#### 1. Streaming buffer and split strategy

Primary file: `packages/cli/src/ui/hooks/useGeminiStream.ts`

These changes were the core duplicate-output fix:

- separate `displayBuffer` from `fullBuffer`;
- defer `safe-split` in narrow/unstable tail cases;
- collapse repeated blank lines in the display path;
- normalize overlap before appending more live content.

Without this layer, narrow panes kept replaying older content as the live tail
and Static history boundary moved.

#### 2. Pending preview normalization before Ink layout

Primary file:
`packages/cli/src/ui/components/messages/ConversationMessages.tsx`

These changes were the core blank-line and structural-repeat fix:

- visual-height slicing before Ink/Yoga wrapping;
- strip unclosed fence/table/unstable structural suffixes;
- drop incomplete structural tail rows;
- trim boundary blank rows both before and after the slice.

This made the live pending preview materially more stable under narrow wrap.

#### 3. Waiting state decoupled from preview heuristics

Primary files:

- `packages/cli/src/ui/components/MainContent.tsx`
- `packages/cli/src/ui/components/HistoryItemDisplay.tsx`
- `packages/cli/src/ui/components/messages/ConversationMessages.tsx`

The introduction of `hasRenderablePendingAssistantSignal()` was a turning
point. It stopped using preview slicing decisions as the source of truth for
"has the assistant actually started rendering something the user can see?"

That directly reduced cases where content had arrived but the pane still looked
stuck on `Generating response...`.

#### 4. Waiting/live ownership moved back into the main message area

Primary files:

- `packages/cli/src/ui/components/MainContent.tsx`
- `packages/cli/src/ui/components/Composer.tsx`

This was the final fix for the user-visible white-gap problem:

- `MainContent` became an explicit full-height, top-aligned column container;
- in ultra-narrow responding panes, the bottom composer loading indicator stops
  dominating the waiting state;
- live/waiting feedback visually returns to the main transcript area.

This is the change that made the final manual validation pass feel "fixed",
rather than merely "less duplicated."

### Changes That Helped But Were Not Sufficient On Their Own

These changes were worth keeping, but they were not the full solution by
themselves:

1. blank-line collapse in the pending display buffer;
2. boundary blank trimming after slicing;
3. allowing `tool_group` and placeholder to coexist;
4. removing the synthetic `\n` that previously polluted
   `previousAssistantText`.

All four reduced false positives, repeat amplification, or UI incorrectness,
but none alone closed the narrow white-gap repro.

### Low-Value Or Later-Cleanup Candidates

The current recommendation is to keep the branch as-is for merge and, if
desired, follow up with a cleanup-only PR. Possible cleanup candidates:

1. the extra outer `flexGrow` wrapper in `DefaultAppLayout.tsx`, which may now
   be redundant because `MainContent` already claims the height it needs;
2. some `QWEN_STREAM_DEBUG` instrumentation, which was extremely useful during
   diagnosis but is not itself part of the user-facing fix;
3. threshold consolidation, because the branch now uses both ultra-narrow and
   composer-specific width gates.

### Revert Recommendation

Do **not** aggressively revert "small" changes from this PR just to reduce the
diff.

The final result depends on both of these layers being true at the same time:

1. upstream streaming text is normalized, deduped, height-bounded, and kept out
   of unstable structural states;
2. waiting/live rendering responsibilities are no longer split in a way that
   leaves narrow panes looking blank or stuck.

Removing either layer risks reintroducing:

- narrow-pane duplicate output;
- expanding blank rows in the live viewport;
- a long `Generating response...` stall even after visible content has arrived;
- hidden tool progress while the assistant is still waiting to show text.

### Audit Conclusion

This PR now closes the reproduced narrow-pane TUI issues that mattered most in
practice:

- duplicate streaming output;
- large blank-line amplification during live rendering;
- confusing start-of-response white gaps caused by waiting/live layout
  responsibilities.

The useful lesson from this audit is that the winning fix was not "better
Markdown trimming" alone. The branch became stable only when stream
normalization and layout responsibility were corrected together.

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
- pass also requires every captured live frame's xterm scrollback to contain
  zero pending hidden-line markers and zero raw ` ```mermaid ` fence
  delimiter rows, not only the final settled screen;
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
npm run capture:narrow-markdown-regression

QWEN_TUI_E2E_PYTHON=/path/to/python-with-pillow \
npm run capture:narrow-generic-repeat-stall-regression

QWEN_TUI_E2E_PYTHON=/path/to/python-with-pillow \
npm run capture:narrow-progressive-structure-stall-regression

QWEN_TUI_E2E_PYTHON=/path/to/python-with-pillow \
npm run capture:recovery-contained-replay-regression

QWEN_TUI_E2E_PYTHON=/path/to/python-with-pillow \
npm run capture:resize-clear-regression

QWEN_TUI_E2E_PYTHON=/path/to/python-with-pillow \
npm run capture:shell-reflow-regression
```

Run failure-first validation against a separate `origin/main` checkout:

```bash
QWEN_TUI_E2E_REPO=/path/to/main-checkout \
QWEN_TUI_E2E_OUT=<artifact-dir>/main-streaming \
QWEN_TUI_E2E_MIN_CLEAR_PAIRS=1 \
QWEN_TUI_E2E_MAX_CLEAR_PAIRS=Infinity \
QWEN_TUI_E2E_PYTHON=/path/to/python-with-pillow \
npm run capture:streaming-clear-storm

QWEN_TUI_E2E_REPO=/path/to/main-checkout \
QWEN_TUI_E2E_OUT=<artifact-dir>/main-narrow-streaming \
QWEN_TUI_E2E_MIN_CLEAR_PAIRS=1 \
QWEN_TUI_E2E_MAX_CLEAR_PAIRS=Infinity \
QWEN_TUI_E2E_PYTHON=/path/to/python-with-pillow \
npm run capture:narrow-streaming-regression

QWEN_TUI_E2E_REPO=/path/to/main-checkout \
QWEN_TUI_E2E_OUT=<artifact-dir>/main-narrow-markdown \
QWEN_TUI_E2E_MIN_CLEAR_PAIRS=1 \
QWEN_TUI_E2E_MAX_CLEAR_PAIRS=Infinity \
QWEN_TUI_E2E_PYTHON=/path/to/python-with-pillow \
npm run capture:narrow-markdown-regression

QWEN_TUI_E2E_REPO=/path/to/main-checkout \
QWEN_TUI_E2E_OUT=<artifact-dir>/main-generic-repeat \
QWEN_TUI_E2E_PYTHON=/path/to/python-with-pillow \
npm run capture:narrow-generic-repeat-stall-regression

QWEN_TUI_E2E_REPO=/path/to/main-checkout \
QWEN_TUI_E2E_OUT=<artifact-dir>/main-progressive-structure \
QWEN_TUI_E2E_PYTHON=/path/to/python-with-pillow \
npm run capture:narrow-progressive-structure-stall-regression

QWEN_TUI_E2E_REPO=/path/to/main-checkout \
QWEN_TUI_E2E_OUT=<artifact-dir>/main-recovery-contained \
QWEN_TUI_E2E_PYTHON=/path/to/python-with-pillow \
npm run capture:recovery-contained-replay-regression

QWEN_TUI_E2E_REPO=/path/to/main-checkout \
QWEN_TUI_E2E_OUT=<artifact-dir>/main-resize \
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

| Scenario                         | Branch       | Expected    | Metric                                              | Result |
| -------------------------------- | ------------ | ----------- | --------------------------------------------------- | ------ |
| Markdown safe split              | fixed branch | strict pass | code/table/list boundaries split outside open code  | passed |
| Pending assistant exact fit      | fixed branch | strict pass | six-row pending text in six-row budget is visible   | passed |
| Pending assistant overflow bound | fixed branch | strict pass | newest tail stays bounded without live marker rows  | passed |
| Pending assistant hard bound     | fixed branch | strict pass | actual Ink frame rows stay within height budget     | passed |
| Pending assistant live cap       | fixed branch | strict pass | tall terminal budgets still render <= 12 live rows  | passed |
| Pending live marker suppression  | fixed branch | strict pass | no synthetic marker rows in live pending preview    | passed |
| Pending live fence suppression   | fixed branch | strict pass | no raw fence delimiter rows in live pending preview | passed |

Additional Mermaid/narrow-scrollback E2E validation:

| Scenario                         | Branch       | Expected    | Clear pairs | Hidden markers | Raw mermaid fences | Frames | Result |
| -------------------------------- | ------------ | ----------- | ----------: | -------------: | -----------------: | -----: | ------ |
| Narrow Markdown + Mermaid resize | fixed branch | strict pass |           0 |              0 |                  0 |     93 | passed |

Revalidated after the Claude Code cross-check and live-preview suppression:

| Scenario                         | Branch       | Expected    | Clear pairs | Final hidden markers | Final raw fences | Max frame hidden markers | Max frame raw fences | Frames | Result |
| -------------------------------- | ------------ | ----------- | ----------: | -------------------: | ---------------: | -----------------------: | -------------------: | -----: | ------ |
| Narrow Markdown + Mermaid resize | fixed branch | strict pass |           0 |                    0 |                0 |                        0 |                    0 |     93 | passed |

### Blank-Tail Streaming Reproduction

Manual side-by-side testing found a second, more model-shaped trigger: the
duplicate scrollback did not reliably appear when text streamed continuously, and
it did not appear during a pure server/network stall. It reproduced when the
assistant had already emitted useful Markdown content and then streamed a long
tail of blank lines before the final done event. That tail made the bounded live
preview spend its budget on empty rows, pushing stable content into terminal
scrollback where repeated live frames became visible as duplicate Mermaid/list
lines.

Claude Code avoids the same shape by only rendering complete streaming lines and
by treating the current Markdown block as an unstable suffix. Qwen keeps the
existing plain-text pending preview, but applies the same principle locally:
trailing blank rows are not part of the useful live viewport. They are trimmed
before pending-height slicing, while the final committed assistant message still
renders through `MarkdownDisplay`.

New deterministic capture scenarios:

- `capture:narrow-markdown-stall-regression` streams deterministic Mermaid
  content, then holds the connection open. This verifies a pure stall is not the
  root cause.
- `capture:narrow-markdown-blank-tail-regression` streams the same content,
  appends 80 newline chunks, then holds the connection open. This is the
  failure-first reproduction for the manual "long blank screen, then repeated
  output" report.

Validation metric: six unique sentinel labels (`QWEN_A1` through `QWEN_F1`) are
present in the raw model payload. The final screen and every captured frame must
not show more than six sentinel occurrences; the post-done viewport must still
contain at least one sentinel occurrence so the fix is not hiding all useful
content.

| Scenario                   | Branch            | Expected                    | Final sentinel occurrences | Max frame sentinel occurrences | Post-done viewport min | Result |
| -------------------------- | ----------------- | --------------------------- | -------------------------: | -----------------------------: | ---------------------: | ------ |
| Narrow Markdown stall      | fixed branch      | pure stall does not repeat  |                          6 |                              6 |                      6 | passed |
| Narrow Markdown blank tail | before source fix | failure-first reproduction  |                         12 |                             12 |                      6 | failed |
| Narrow Markdown blank tail | fixed branch      | strict pass, no duplication |                          6 |                              6 |                      6 | passed |

Commands:

```bash
cd integration-tests/terminal-capture

QWEN_TUI_E2E_OUT=<artifact-dir>/narrow-markdown-stall \
  npm run capture:narrow-markdown-stall-regression

QWEN_TUI_E2E_OUT=<artifact-dir>/narrow-markdown-blank-tail-before \
  npm run capture:narrow-markdown-blank-tail-regression

QWEN_TUI_E2E_OUT=<artifact-dir>/narrow-markdown-blank-tail-after \
  npm run capture:narrow-markdown-blank-tail-regression
```

### Cumulative OpenAI-Compatible Delta Reproduction

The latest manual screenshots showed a different shape: output was not waiting
on a long blank tail, but repeated whole Markdown/table sections during normal
streaming. A controlled incremental table stream did not reproduce that class:
eight unique table sentinel rows remained eight rows in every captured frame.
That ruled out the bounded TUI renderer as the source of this specific
duplication.

The reproducible trigger is an OpenAI-compatible upstream that sends
`delta.content` as the accumulated full assistant text so far instead of the
next incremental suffix. Qwen previously appended every `delta.content` value
as if it were an incremental delta. In a narrow Markdown/table response, that
turns a source stream with eight unique rows into many repeated visible rows,
matching the user-visible screenshots where repeated `flowchart TD`,
`A[Text]`, or `Direction` table rows suddenly appear during otherwise normal
output.

`OpenAIContentConverter` now tracks text-delta state per request context and
normalizes cumulative text deltas to suffixes before they reach the Gemini
stream pipeline. Text and reasoning streams use separate state, and short exact
repeated chunks such as `ha`, `ha` are still preserved so ordinary model
repetition is not blindly removed.

The April 29 manual follow-up showed one more provider shape: each new chunk can
start with the already-emitted tail rather than with the full assistant text.
That rolling-overlap stream produces visible rows such as duplicated
`### 常用语法速` and repeated Markdown table prefixes even though the provider is
not technically sending a full cumulative delta. The converter therefore also
normalizes the longest suffix-prefix overlap between the emitted transcript and
the next raw chunk. The overlap guard is thresholded by byte length so very short
legitimate repetitions, such as `ha`, `ha`, remain intact.

The May 6 follow-up exposed a narrower split-boundary variant: by the time the
CLI receives the next content event, part of the previous assistant text may
already have moved from the pending buffer into `<Static>` through
`findLastSafeSplitPoint()`. Comparing a new event only with the current pending
tail can therefore miss a cumulative replay whose overlap spans the already
committed prefix plus the pending suffix. `useGeminiStream` now keeps a
full-turn text buffer alongside the pending buffer and applies a conservative
suffix-only overlap normalizer to normal content events. This UI-layer guard does
not use contained-prefix matching outside recovery, so a legitimate new sentence
that happens to repeat an earlier non-tail phrase is left unchanged.

When `QWEN_STREAM_DEBUG=1` is set, the converter also writes per-chunk
`stream_delta_metrics` records to the normal debug log. Those records include:

- `rawDeltaBytes`: bytes received from the provider for this chunk;
- `emittedDeltaBytes`: bytes forwarded to the Gemini stream after
  normalization;
- `suppressedBytes`: bytes removed as repeated cumulative prefix;
- `prefixOverlapBytes`: how many bytes matched the previously emitted text;
- `cumulativeDeltaCount` and `exactRepeatCount`: stream-level counters that
  distinguish cumulative provider behavior from normal incremental chunks.
- `overlapDeltaCount` and `overlapRepeatCount`: stream-level counters that
  distinguish rolling-overlap provider chunks from normal incremental chunks.

This makes source attribution easier:

- high `suppressedBytes` with `cumulativeDeltaCount > 0` means the provider is
  sending cumulative deltas and the converter is trimming them;
- high `suppressedBytes` with `overlapDeltaCount > 0` means the provider is
  sending rolling-overlap deltas and the converter is trimming the already
  emitted tail;
- `content_buffer_metrics.streamDeltaNormalization.action` equal to
  `overlap-suffix` or `stale` with nonzero `suppressedPrefixChars` means the UI
  trimmed a replay that crossed a safe-split boundary after part of the response
  had already moved into Static;
- repeated final text with low `suppressedBytes` usually means the model itself
  generated repeated content;
- source sentinel counts staying fixed while screen sentinel counts grow means
  the TUI renderer is duplicating output.

Validation metric: eight unique table sentinel labels
(`QWEN_TABLE_01` through `QWEN_TABLE_08`) are present in the fake model payload.
The final screen and every captured frame must not show more than eight sentinel
occurrences. The capture summary also reports amplification ratios:
`tableSentinelAmplificationRatio` and
`maxFrameTableSentinelAmplificationRatio`; values above `1` mean the terminal
screen contains more copies than the source payload.

| Scenario                               | Branch                | Expected                         | Final sentinel occurrences | Max frame sentinel occurrences | Amplification | Result |
| -------------------------------------- | --------------------- | -------------------------------- | -------------------------: | -----------------------------: | ------------: | ------ |
| Narrow Markdown table incremental      | fixed branch          | normal incremental stream stable |                          8 |                              8 |           1.0 | passed |
| Narrow Markdown table cumulative delta | before cumulative fix | failure-first reproduction       |                        112 |                            112 |          14.0 | failed |
| Narrow Markdown table cumulative delta | fixed branch          | strict pass, no duplicate append |                          8 |                              8 |           1.0 | passed |
| Narrow Markdown table rolling overlap  | fixed branch          | strict pass, no duplicate append |                          8 |                              8 |           1.0 | passed |

Commands:

```bash
cd integration-tests/terminal-capture

QWEN_TUI_E2E_OUT=<artifact-dir>/narrow-markdown-table \
  npm run capture:narrow-markdown-table-regression

QWEN_TUI_E2E_REPO=/path/to/before-cumulative-fix-checkout \
QWEN_TUI_E2E_OUT=<artifact-dir>/narrow-markdown-table-cumulative-before \
  npm run capture:narrow-markdown-table-cumulative-regression

QWEN_TUI_E2E_OUT=<artifact-dir>/narrow-markdown-table-cumulative-after \
  npm run capture:narrow-markdown-table-cumulative-regression

QWEN_TUI_E2E_OUT=<artifact-dir>/narrow-markdown-table-overlap-after \
  npm run capture:narrow-markdown-table-overlap-regression
```

### Inline Thinking Scrollback Reproduction

The April 29 manual reproduction showed many visible copies of a gray thinking
sentence such as `Since the user just asked me...`. The debug log and chat
recording proved this was not a model/source duplication:

- `stream_delta_metrics` reported `suppressedBytes=0` and
  `cumulativeDeltaCount=0`, so the OpenAI-compatible converter was receiving
  normal incremental deltas for this run.
- the persisted chat JSONL contained the phrase only once in the assistant
  thought payload;
- `history_item_text_metrics` for the displayed thinking item had
  `maxLineRepeatCount=1`, while the terminal scrollback visibly showed repeated
  wrapped rows;
- the same run emitted many `gemini_thought*` history items and many safe-split
  frames where `splitPoint=0`.

Root cause: Qwen rendered streamed thinking inline by default whenever compact
mode was off. On narrow terminals, those thinking rows behaved like ordinary
dynamic history. If the current Markdown block had no safe split point yet
(`findLastSafeSplitPoint()` returned `0` for an open code/table/list section),
the stream path could also append an empty Static item before re-rendering the
same live suffix. The source text was stable, but the terminal scrollback kept
capturing repeated live frames.

Fix:

- streamed thoughts now update the loading/thought state by default instead of
  being appended to history;
- a new `ui.inlineThinkingMode` setting defaults to `off`; setting it to `full`
  restores explicit inline thinking for users who want the old verbose view;
- `gemini`, `gemini_content`, `gemini_thought`, and
  `gemini_thought_content` safe-split paths suppress empty Static commits when
  `splitPoint=0`;
- `QWEN_STREAM_DEBUG=1` now emits `thought_stream_metrics` records. A healthy
  default run should show `action: 'state-only'` for streamed thoughts and
  should not show `history_commit_metrics` for `gemini_thought*` unless
  `ui.inlineThinkingMode` is explicitly set to `full`;
- `content_buffer_metrics` records now include
  `suppressedEmptyStaticCommit`. When that value is `true`, the renderer kept
  the suffix pending instead of appending an empty Static row.

Validation metric:

| Scenario                      | Branch       | Expected                                        | Metric                                                                      | Result                                     |
| ----------------------------- | ------------ | ----------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------ |
| Inline thinking default       | fixed branch | thinking updates status, not history scrollback | no rendered `gemini_thought*`; `thought_stream_metrics.action=state-only`   | unit-covered, manual revalidation required |
| Open-block safe split at zero | fixed branch | no empty Static item is appended                | `splitPoint=0` produces `suppressedEmptyStaticCommit=true` and no empty add | unit-covered, manual revalidation required |
| Reasoning scrollback capture  | fixed branch | hidden reasoning never reaches terminal frames  | final and max-frame reasoning sentinel occurrence count is `0`              | terminal-capture covered                   |

Manual revalidation command:

```bash
QWEN_STREAM_DEBUG=1 npm run dev
```

Deterministic terminal-capture command:

```bash
cd integration-tests/terminal-capture
QWEN_TUI_E2E_OUT=<artifact-dir>/reasoning-scrollback \
  npm run capture:reasoning-scrollback-regression
```

After reproducing the same narrow-terminal prompt, inspect the newest debug log:

```bash
rg -n "thought_stream_metrics|history_commit_metrics|content_buffer_metrics" ~/.qwen/debug/latest
```

Pass criteria:

- no `history_commit_metrics` entry has `itemType: 'gemini_thought'` or
  `itemType: 'gemini_thought_content'` in the default configuration;
- streamed thoughts log `action: 'state-only'`;
- safe-split frames with `splitPoint: 0` log
  `suppressedEmptyStaticCommit: true` and do not append empty history items;
- the persisted chat JSONL and visible terminal output no longer diverge by
  showing repeated thinking rows.

### Unclosed Code-Fence Live Preview Reproduction

The latest manual narrow-terminal reproduction showed many repeated
`classDiagram` rows while a Mermaid class diagram was still streaming. That is
the same scrollback-leak class as the earlier Mermaid examples, but the source
shape is slightly different: the unstable suffix is an open fenced code block.

Root cause: while a Markdown fence is open, rows inside that block are not yet a
stable Markdown block. Rendering those rows in the live pending region on every
frame lets terminals capture repeated copies in scrollback if the dynamic frame
is pushed above the viewport. Claude Code avoids this by treating the current
Markdown block as an unstable suffix.

Fix: the Qwen pending preview now treats the current unclosed fenced-code block
as a complete-line live preview. Stable text before the fence can still render
live, the fence delimiter itself is removed, and only complete code lines inside
the fence are shown. The currently edited partial line is withheld until it ends
with `\n`, which prevents half-written Mermaid/table rows from being repeatedly
patched into scrollback. After completion, the block is committed and rendered
through `MarkdownDisplay`; the stored transcript is not changed.

Follow-up manual testing also showed two related narrow-screen artifacts:

- a live response could appear after a large blank gap when the provider/model
  streamed blank rows before or after the useful text;
- repeated Markdown structure rows such as `### 语法参考` and
  `| 语法 | 说明 |` could be promoted into `<Static>` before the current
  streaming suffix settled.

Those blank rows are not intended UI. Pending preview now removes boundary blank
lines, collapses long blank runs, and sizes the live viewport to the rendered
visual rows instead of reserving a fixed twelve-row box for one-line content.
Unfinished Markdown table, Mermaid, and table-shaped structural suffixes remain
in the bounded live preview as complete-line plain text, while exact structural
repeats are capped globally to one visible row. `findLastSafeSplitPoint()` also
refuses to promote a prefix containing consecutive repeated structure rows into
`<Static>`, so unstable rows remain in the bounded live preview where they can be
folded without changing the stored transcript.

Validation metric:

The terminal-capture scenario streams a Chinese intro, opens a `mermaid` fenced
block, emits `classDiagram` plus six class sentinels, and then intentionally
stalls before sending the closing fence. During that pre-done stall, the live
terminal frames may show the complete code lines, but they must not amplify those
sentinels beyond the source count, must not show raw fence delimiters or hidden
marker rows, and must not perform a full-screen clear. After the fence closes,
the final committed message may show the code block once.

| Scenario                       | Branch       | Expected                                                                       | Metric                                                                                  | Result                          |
| ------------------------------ | ------------ | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------- |
| Unclosed Mermaid class diagram | fixed branch | complete code lines render live without fence rows                             | one `classDiagram` row in pending preview                                               | unit-covered                    |
| Open fence stall capture       | fixed branch | live code is visible before final commit and does not amplify source sentinels | `openFenceLivePreviewSeen=true`, `maxPreDoneFrameOpenFenceSentinelOccurrenceCount <= 6` | passed: `4` pre-done, `6` final |
| Structural repeat stall        | fixed branch | repeated structure rows are folded before done                                 | `maxPreDoneFrameStructuralRepeatOccurrenceCount <= 2`                                   | passed: `2` pre-done            |

Commands:

```bash
cd integration-tests/terminal-capture
QWEN_TUI_E2E_OUT=<artifact-dir>/open-fence-stall \
  npm run capture:narrow-open-fence-stall-regression

QWEN_TUI_E2E_OUT=<artifact-dir>/structural-repeat-stall \
  npm run capture:narrow-structural-repeat-stall-regression

QWEN_TUI_E2E_OUT=<artifact-dir>/progressive-structure-stall \
  npm run capture:narrow-progressive-structure-stall-regression

QWEN_TUI_E2E_OUT=<artifact-dir>/generic-repeat-stall \
  npm run capture:narrow-generic-repeat-stall-regression
```

Pass criteria:

- `openFenceSentinelExpectedCount` is `6`;
- `openFenceLivePreviewSeen` is `true`, proving the test did not pass by hiding
  live Mermaid/code until final commit;
- `maxPreDoneFrameOpenFenceSentinelOccurrenceCount` is at most `6`, matching the
  six source sentinel rows rather than multiplying them across frames;
- `openFenceSentinelOccurrenceCount` is at most `6` after the fence closes;
- `finalDoneCount` is `1`, proving the check did not pass by hiding the final
  answer.
- `structuralRepeatExpectedPreDoneCount` is `2`;
- `maxPreDoneFrameStructuralRepeatOccurrenceCount` is at most `2`. The final
  count can be higher when the fake provider intentionally sends repeated source
  rows; this metric only proves the live TUI no longer multiplies those rows or
  commits them into Static during the pre-done phase.

Debug criteria with `QWEN_STREAM_DEBUG=1`:

- `pending_preview_metrics.unclosedFenceStripped` flips to `true` while the
  fence is open, meaning the delimiter/partial-line part was handled before
  rendering;
- `strippedUnclosedFenceChars` and `strippedUnclosedFenceLines` grow as the
  in-progress code block streams;
- `strippedBoundaryBlankLines`, `collapsedBlankLines`, and
  `collapsedStructuralRepeatLines` explain why the live preview has fewer blank
  or repeated structure rows than the raw pending source;
- after the closing fence arrives, the final committed message can render the
  code block normally.

### Progressive Structure-Line Reproduction

The latest manual screenshot showed another narrow-streaming variant: the
screen contained a sequence of partial structure rows such as
`| \`flowchart TD/L`, then `| \`flowchart TD/LR/RL/BT\` |`, then the completed
row with `示例`. This is not an exact-line duplicate. It is a progressive
structure-line update leaking into terminal scrollback.

Fix:

- pending live preview keeps ordinary text responsive, but strips the final line
  when it is clearly an incomplete table row, such as a line that starts with
  `|` but has not closed with `|`;
- pending and committed display normalization folds consecutive structural
  prefix expansions, replacing the prior prefix row with the newest longer row
  when both rows belong to the same heading/table/Mermaid structure family.

Validation metric:

The `markdown-progressive-structure-stall` terminal-capture payload streams a
progressive heading and progressive table rows, then stalls before completion.
The raw source intentionally contains five structural sentinel occurrences, but
the live pre-done viewport should expose at most the two stable structure
families: title and table.

| Scenario                    | Branch       | Expected                   | Final structure rows | Max pre-done frame rows | Result |
| --------------------------- | ------------ | -------------------------- | -------------------: | ----------------------: | ------ |
| Progressive structure stall | main         | failure-first reproduction |                    5 |                       5 | failed |
| Progressive structure stall | fixed branch | prefix updates are folded  |                    2 |                       2 | passed |

Command:

```bash
cd integration-tests/terminal-capture
QWEN_TUI_E2E_OUT=<artifact-dir>/progressive-structure-stall \
  npm run capture:narrow-progressive-structure-stall-regression
```

Debug criteria with `QWEN_STREAM_DEBUG=1`:

- `pending_preview_metrics.strippedIncompleteLineChars > 0` when an unfinished
  table row is withheld from the live viewport;
- `pending_preview_metrics.collapsedStructuralRepeatLines > 0` when the
  progressive row prefixes are folded;
- `assistant_display_metrics.displayedText.maxConsecutiveLineRepeatCount`
  remains bounded even if raw stream text contains repeated structure prefixes.

### Cross-Chunk Generic Repeat Reproduction

The latest manual screenshots also showed repeated ordinary prose, for example
many copies of a sentence like `需要其他类型的 Mermaid 图`. This can be a real
model/provider repetition, but the TUI still must not amplify it by leaving two
copies in every safe-split chunk.

Validation metric:

The `markdown-generic-repeat-stall` terminal-capture payload sends fourteen
identical generic rows before the stream finishes. The display budget allows at
most two consecutive visible generic rows. The fixed branch must keep both the
live pre-done frames and the final viewport at or below that budget.

| Scenario             | Branch       | Expected                      | Final generic rows | Max pre-done frame rows | Result |
| -------------------- | ------------ | ----------------------------- | -----------------: | ----------------------: | ------ |
| Generic repeat stall | main         | failure-first reproduction    |                 14 |                      14 | failed |
| Generic repeat stall | fixed branch | display bounded to repeat cap |                  2 |                       2 | passed |

Command:

```bash
cd integration-tests/terminal-capture
QWEN_TUI_E2E_OUT=<artifact-dir>/generic-repeat-stall \
  npm run capture:narrow-generic-repeat-stall-regression
```

Debug criteria with `QWEN_STREAM_DEBUG=1`:

- `assistant_display_metrics.rawText.maxConsecutiveLineRepeatCount` shows the
  repeated source rows in the current chunk;
- `assistant_display_metrics.displayedText.maxConsecutiveLineRepeatCount`
  should be no higher than the display cap;
- `assistant_display_metrics.previousAssistantText` explains whether repeated
  rows crossed a `gemini_content` safe-split boundary;
- `history_item_text_metrics.hasPreviousAssistantText=true` on continuation
  chunks confirms the static/pending display path received the previous tail.

## Recovery Continuation Overlap

The remaining user-visible screenshots had a different signature from the
earlier Markdown preview bugs: the screen often stayed mostly blank while the
model was still running, then a previously streamed suffix appeared again many
times. That pattern matches output-token recovery rather than ordinary
Markdown wrapping.

Source path:

1. `GeminiChat.sendMessageStream()` retries with escalated output tokens when a
   stream ends with `MAX_TOKENS`.
2. If the escalated stream is still truncated, it appends an internal recovery
   user message and emits `Retry` with `isContinuation: true`.
3. The CLI keeps the pending assistant buffer for this continuation so the
   recovery can append to the partial answer.
4. Some providers start the recovery response by replaying the previous suffix
   despite the recovery prompt saying "resume directly". Without overlap
   normalization, the UI appends that replayed suffix and the final durable
   history also coalesces it naively.

Fix:

- while `Retry.isContinuation` is active, the live UI compares the incoming
  content delta with the existing pending buffer and drops a stale or
  suffix-overlapping prefix before appending it;
- when core coalesces `(user recovery, model continuation)` back into the
  preceding model turn, it uses the same overlap rule for the last text part and
  first continuation text part;
- if the recovery response restarts from an anchor inside the previous tail
  rather than from the exact last byte, the live UI and core history coalescer
  drop that contained-prefix replay as well;
- the recovery prompt now includes the exact previous response suffix and tells
  the model to output only text after that suffix, reducing provider/model
  tendency to replay already visible table/code/prose rows;
- this logic is intentionally scoped to recovery continuation so legitimate
  repeated content in a normal response is not rewritten.

Validation metric:

The `recovery-overlap` terminal-capture payload forces three OpenAI-compatible
requests:

1. the initial request ends with `finish_reason=length`;
2. the escalated request also ends with `finish_reason=length` after emitting
   `QWEN_TAIL`;
3. the recovery request starts by replaying `QWEN_TAIL`, then
   emits `QWEN_DONE` and `E2E_STREAM_DONE`.

The shared sentinel must appear exactly once both during live frames and in the
final settled screen.

`recovery-contained-replay` covers the second recovery shape seen in manual
testing: the recovery response starts from an anchor that appears inside the
previous tail rather than as an exact suffix-prefix overlap. It uses the same
pass metric as `recovery-overlap`.

| Scenario                    | Branch       | Expected                              | Metric                                     | Result               |
| --------------------------- | ------------ | ------------------------------------- | ------------------------------------------ | -------------------- |
| Recovery overlap regression | main         | failure-first reproduction            | `maxFrameRecoveryOverlapOccurrenceCount=2` | failed: `2`          |
| Recovery final transcript   | main         | failure-first reproduction            | `recoveryOverlapOccurrenceCount=2`         | failed: `2`          |
| Recovery overlap regression | fixed branch | replayed recovery suffix is not shown | `maxFrameRecoveryOverlapOccurrenceCount=1` | passed: `1`          |
| Recovery final transcript   | fixed branch | durable text stores the suffix once   | `recoveryOverlapOccurrenceCount=1`         | passed: `1`          |
| Recovery request path       | fixed branch | test really entered recovery          | `requestCount=3`, `finalDoneCount=1`       | passed: `3` requests |
| Recovery contained replay   | main         | failure-first reproduction            | `recoveryOverlapOccurrenceCount=2`         | failed: `2`          |
| Recovery contained replay   | fixed branch | contained replay prefix is dropped    | `recoveryOverlapOccurrenceCount=1`         | passed: `1`          |

Command:

```bash
cd integration-tests/terminal-capture
QWEN_TUI_E2E_OUT=<artifact-dir>/recovery-overlap \
  npm run capture:recovery-overlap-regression

QWEN_TUI_E2E_OUT=<artifact-dir>/recovery-contained-replay \
  npm run capture:recovery-contained-replay-regression
```

Debug criteria with `QWEN_STREAM_DEBUG=1`:

- direct stream diagnostics are also written to
  `~/.qwen/debug/tui-stream-<pid>.jsonl`; this file does not depend on the
  session-level `latest` symlink and is the preferred artifact for local
  reproduction;
- `stream_retry_metrics.isContinuation` must be `true` before the recovery
  delta;
- `continuation_delta_metrics.normalization.action` should be
  `overlap-suffix`, `contained-prefix-suffix`, or `stale` when the provider
  replays old text;
- `content_buffer_metrics.streamDeltaNormalization.suppressedPrefixChars`
  shows how much text was dropped from the replayed prefix.

## Claude Code Cross-Check

Claude Code does not avoid this class by relying on a larger per-message
truncate threshold. Its local source shows three renderer-level safeguards that
explain why repeated pending Markdown delimiters and hidden markers do not show
up in normal use:

- `src/screens/REPL.tsx` only exposes complete streaming lines to the message
  renderer: `visibleStreamingText` is truncated to the last newline before it is
  rendered. This avoids char-by-char source-line churn.
- `src/components/Markdown.tsx` uses `StreamingMarkdown`, which lexes Markdown
  from the current stable boundary and treats the last token as the growing
  block. `marked.lexer()` treats unclosed code fences as one Markdown token, so
  fence delimiters are structure rather than ordinary live text rows.
- `src/ink/log-update.ts` tracks whether a diff would touch rows that already
  moved into scrollback. If so, it emits an explicit reset instead of attempting
  an unreachable incremental patch.
- `src/ink/renderer.ts` and `src/ink/ink.tsx` make alt-screen frames a fixed
  viewport, clamp the cursor inside that viewport, and anchor the physical
  cursor before each diff. This prevents cursor-restore line feeds from pushing
  exactly-full frames into scrollback.

Those pieces are not a small drop-in dependency. Copying Claude's modified Ink
fork would import a renderer, frame model, terminal writer, selection/search
overlay, scrollbox behavior, and alt-screen lifecycle as one large maintenance
surface. The practical Qwen path is to port the narrow principles:

- live pending output must be a bounded viewport, not an ever-growing transcript;
- live pending output must not write synthetic truncation markers or Markdown
  delimiter rows that can become repeated scrollback artifacts;
- live pending output must ignore trailing blank rows while the model is still
  streaming, so an empty tail cannot become the live viewport;
- live pending output must treat the current unclosed fenced code block as an
  unstable suffix and keep it out of scrollback until the fence closes;
- streamed thinking should not be written into the main transcript by default;
  Claude keeps active thinking/status separate from the settled assistant
  transcript and collapses prior thinking in history;
- completed/stable content should move to `<Static>` and render with full
  Markdown fidelity;
- evidence must inspect live-frame scrollback, not only the final settled
  screen.

This PR implements the second and fourth principles directly on top of the
existing Qwen architecture, in addition to the earlier bounded live viewport and
Static commit split. A future architecture PR can explore a Claude-style
terminal renderer or alt-screen live region, but that is intentionally separate
from this targeted, metric-backed fix.

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

- 2026-05-06 latest local validation after complete-line live preview,
  turn-wide repeat de-amplification, measured pending viewport height, and
  full-turn suffix replay guard:
  - unit tests: `ConversationMessages.test.tsx`, `useGeminiStream.test.tsx`,
    `tuiStreamDiagnostics.test.ts`, and `markdownUtilities.test.ts` passed
    (`130` tests);
  - build and bundle passed; only existing vscode companion lint warnings were
    reported;
  - `/tmp/qwen-open-fence-live-preview/summary.json`: passed with
    `clearTerminalPairCount=0`,
    `maxPreDoneFrameOpenFenceSentinelOccurrenceCount=6`,
    `openFenceSentinelOccurrenceCount=6`, and amplification ratio `1`;
  - `/tmp/qwen-table-live-preview/summary.json`: passed with
    `clearTerminalPairCount=0`,
    `maxPreDoneFrameTableSentinelOccurrenceCount=6`,
    `tableSentinelOccurrenceCount=8`, and amplification ratio `1`;
  - `/tmp/qwen-structural-live-preview/summary.json`: passed with
    `clearTerminalPairCount=0`,
    `structuralRepeatOccurrenceCount=2`,
    `maxPreDoneFrameStructuralRepeatOccurrenceCount=2`;
  - `/tmp/qwen-blank-tail-live-preview/summary.json`: passed with
    `clearTerminalPairCount=0`,
    `maxFrameStallSentinelOccurrenceCount=6`,
    `minPostDoneViewportStallSentinelOccurrenceCount=6`, and no raw fence or
    hidden marker rows.
  - `/tmp/qwen-progressive-live-preview/summary.json`: passed with
    `clearTerminalPairCount=0`,
    `maxPreDoneFrameStructuralRepeatOccurrenceCount=2`, and amplification ratio
    `1` for progressive structure rows.
  - `/tmp/qwen-generic-repeat-live-preview/summary.json`: passed with
    `clearTerminalPairCount=0`,
    `maxPreDoneFrameGenericRepeatOccurrenceCount=2`, and amplification ratio
    `1` for non-structural prose repeats.
  - `/tmp/qwen-table-cumulative-after-structural-dedupe/summary.json` and
    `/tmp/qwen-table-overlap-after-structural-dedupe/summary.json`: both passed
    with `tableSentinelOccurrenceCount=8`,
    `maxPreDoneFrameTableSentinelOccurrenceCount=0`, and amplification ratio
    `1`.
  - `/tmp/qwen-structural-v4b/summary.json`: passed with
    `clearTerminalPairCount=0`,
    `structuralRepeatOccurrenceCount=2`,
    `maxPreDoneFrameStructuralRepeatOccurrenceCount=2`, and amplification ratio
    `1`.
  - `/tmp/qwen-generic-v4/summary.json`: passed with
    `clearTerminalPairCount=0`, `genericRepeatOccurrenceCount=2`,
    `maxPreDoneFrameGenericRepeatOccurrenceCount=2`, and amplification ratio
    `1`.
  - `/tmp/qwen-blank-tail-v4b/summary.json`: passed with
    `clearTerminalPairCount=0`, `stallSentinelOccurrenceCount=6`,
    `maxFrameStallSentinelOccurrenceCount=6`,
    `minPostDoneViewportStallSentinelOccurrenceCount=3`, and no raw fence or
    hidden marker rows.
- 2026-05-06 live repro update: `QWEN_STREAM_DEBUG=1 npm run dev` produced
  `~/.qwen/debug/tui-stream-27446.jsonl` for a narrow Mermaid response that
  still looked like duplicated output. The direct metrics showed no large
  content-layer duplication in that specific run: converter `rawDelta` and
  `emittedDelta` had low repeat counts, while terminal scrollback showed
  repeated-looking Markdown/table rows. The rendering fix now treats unclosed
  fenced blocks, unfinished tables, and mostly-structural Mermaid/table suffixes
  as complete-line live tails. They render as bounded plain text during
  streaming, with delimiters, partial rows, boundary blank rows, and amplified
  structural repeats removed before they reach Ink.
  Markdown table parsing also tolerates short separator rows, and
  `findLastSafeSplitPoint()` keeps table runs pending until a following
  blank/non-table line actually closes the table. Tables under 60 columns render
  in vertical key-value format instead of compressed horizontal boxes, matching
  the Claude-style principle of keeping narrow output readable rather than
  forcing a wide table into the viewport.
- 2026-05-06 second live repro update: a new narrow Mermaid run
  (`~/.qwen/debug/tui-stream-69876.jsonl`) still showed many `flowchart TD`
  rows in terminal scrollback. The reconstructed content contained only one
  `flowchart TD`, and the debug metrics showed no line-level content
  amplification. The remaining issue was a terminal scrollback leak combined
  with over-reserved live height: one or two rendered rows were being placed in a
  twelve-row dynamic region, creating the large blank gap shown in manual
  screenshots. The pending preview now uses actual visual-row height up to the
  bounded cap, while code/table/structure preview lines are complete-line,
  globally deduplicated, and clipped by `MaxSizedBox`.
- 2026-05-06 third live repro update: later logs showed a separate class where
  the provider/model text itself contained repeated structural/prose rows
  (`stream_delta_metrics.emittedText.maxLineRepeatCount > 1`) while each raw
  delta was incremental. This is not an ANSI replay and cannot be fixed by
  `clearTerminal` changes. The display layer now performs turn-wide
  de-amplification for both structural lines and ordinary prose repeats:
  structural rows are shown once, generic repeated rows are shown at most twice,
  and the raw history remains unchanged for diagnostics/transcript integrity.
  Runtime metrics now include `fixVersion: streaming-display-v4`, `cwd`,
  `sourceUrl`, and `pending_preview_metrics.previewViewport` so manual
  validation can prove that the running `npm run dev` process is using the
  current source and that a short preview is not reserving a large blank block.
- 2026-05-06 fourth live repro update: the user-provided stable reproduction
  was the active iTerm2 four-pane split, measured as `34x48 /dev/ttys008`.
  Running `QWEN_STREAM_DEBUG=1 npm run dev` in that exact pane still produced
  a long blank scrollback gap even after content-layer repeat and preview-height
  fixes. The authoritative iTerm2 `contents` metric showed
  `maxBlank=202`, `blankRuns[0].count=202`, `flowchartTD=2`, and
  `codePlaceholder=0`: the duplicated-looking text was no longer the dominant
  failure, but the main-screen live frame was still leaking empty rows before
  the final Static answer. The first ultra-narrow guard, which hid live pending
  content until final commit, reduced the blank/repeat class in three local
  iTerm2 runs but made the pane look inactive while the model was working.

  | Run                  | Terminal       | `maxBlank` | `blankRuns` | `flowchartTD` | `codePlaceholder` |
  | -------------------- | -------------- | ---------: | ----------: | ------------: | ----------------: |
  | before guard         | iTerm2 `34x48` |        202 |           1 |             2 |                 0 |
  | first guard capture  | iTerm2 `34x48` |          3 |           0 |             2 |                 0 |
  | first guard repeat 1 | iTerm2 `34x48` |          3 |           0 |             2 |                 0 |
  | first guard repeat 2 | iTerm2 `34x48` |          3 |           0 |             2 |                 0 |

  Local artifacts:
  - before guard: `/tmp/qwen-iterm-34x48-20260506-180150/summary.json`;
  - first guard capture:
    `/tmp/qwen-iterm-34x48-20260506-181620/summary.json`;
  - first guard repeats:
    `/tmp/qwen-iterm-34x48-repeat-20260506-182145/run1.summary.json` and
    `/tmp/qwen-iterm-34x48-repeat-20260506-182145/run2.summary.json`.

- 2026-05-06 fifth live repro update: manual validation then found two
  experience gaps in the first guard. First, hiding every live control from the
  start of the request made the pane look like it had stalled before the first
  model token. Second, adding a dynamic status/preview is not safe in this
  architecture: the diagnostic iTerm2 contents run
  `/tmp/qwen-iterm-34x48-quasi4-20260506-200019/summary.json` placed the status
  after a long empty region (`maxBlank=793`). Temporary or separate Static
  notices were also rejected because terminal-capture showed the final assistant
  message could be skipped (`finalDoneCount=0`) when Static append accounting
  changed.

  That hidden-live-content guard was later rejected as well: it fixed a metric
  but failed the human interaction test because Mermaid/code no longer appeared
  to stream. The accepted narrow-pane solution is therefore not a Static notice
  and not a broad `<=40` suppression. It keeps Composer visible while allowing
  bounded live assistant/thought preview in the reproducible 24/34-column panes:
  - `Composer` keeps the loading phrase, timer, `esc to cancel`, input prompt,
    and footer visible for the entire response;
  - complete lines inside unclosed Mermaid/code fences render as plain bounded
    live preview, with fence delimiters removed and partial tail lines withheld;
  - only the extreme `<=20` width fallback suppresses live assistant/thought
    preview, because useful code rows cannot fit there;
  - final assistant content still renders through the normal committed
    `HistoryItemDisplay` path, without `... writing code block ...`
    placeholders.

  Deterministic terminal-capture evidence at the same effective pane size:

  | Run                                     | Terminal | Frames | `finalDoneCount` | `clearTerminalPairCount` | Strict result |
  | --------------------------------------- | -------- | -----: | ---------------: | -----------------------: | ------------- |
  | persistent notice default               | `34x48`  |     93 |                1 |                        0 | passed        |
  | persistent notice progressive structure | `34x48`  |     93 |                1 |                        0 | passed        |

  Local artifacts:
  - default summary:
    `/tmp/qwen-terminal-capture-34x48-persistent-notice-20260506-203240/summary.json`;
  - default GIF:
    `/tmp/qwen-terminal-capture-34x48-persistent-notice-20260506-203240/streaming-clear-storm.gif`;
  - progressive structure summary:
    `/tmp/qwen-terminal-capture-34x48-persistent-notice-progressive-20260506-203417/summary.json`;
  - progressive structure GIF:
    `/tmp/qwen-terminal-capture-34x48-persistent-notice-progressive-20260506-203417/streaming-clear-storm.gif`.

  The macOS `screencapture` CLI returned black frames in this Codex process,
  likely because the process lacks Screen Recording permission, so real-iTerm
  proof uses iTerm2 `contents` metrics. The GIF evidence comes from
  `terminal-capture` with the same `34x48` terminal dimensions and the
  progressive Mermaid/table structure payload.

- 2026-05-07 revalidation after user-visible blank-screen feedback: the debug
  log (`~/.qwen/debug/tui-stream-35390.jsonl`) came from the real `24x28` iTerm
  pane. It showed `terminalWidth=24`, no pending preview metrics, and only final
  assistant display metrics, proving that the previous Static-notice /
  live-content-suppression guard itself caused the "blank screen, then all at
  once" Mermaid experience. The follow-up keeps Composer visible and restores
  bounded live preview for 24/34-column panes.

  | Run                     | Terminal | Frames | `finalDoneCount` | `clearTerminalPairCount` | Extra metric                                                                         |
  | ----------------------- | -------- | -----: | ---------------: | -----------------------: | ------------------------------------------------------------------------------------ |
  | open-fence live preview | `24x28`  |     93 |                1 |                        0 | `openFenceLivePreviewSeen=true`, `maxPreDoneFrameOpenFenceSentinelOccurrenceCount=4` |
  | open-fence live preview | `34x48`  |     63 |                1 |                        0 | `openFenceLivePreviewSeen=true`, `maxPreDoneFrameOpenFenceSentinelOccurrenceCount=4` |
  | structural repeat stall | `24x28`  |     63 |                1 |                        0 | `maxPreDoneFrameStructuralRepeatOccurrenceCount=0`                                   |

  Local artifacts:
  - `24x28` open-fence summary:
    `/tmp/qwen-terminal-capture-24x28-live-open-fence-wrapped-20260507-120212/summary.json`;
  - `24x28` open-fence GIF:
    `/tmp/qwen-terminal-capture-24x28-live-open-fence-wrapped-20260507-120212/streaming-clear-storm.gif`;
  - `34x48` open-fence summary:
    `/tmp/qwen-terminal-capture-34x48-live-open-fence-20260507-121546/summary.json`;
  - `34x48` open-fence GIF:
    `/tmp/qwen-terminal-capture-34x48-live-open-fence-20260507-121546/streaming-clear-storm.gif`;
  - `24x28` structural-repeat summary:
    `/tmp/qwen-terminal-capture-24x28-structural-repeat-20260507-121409/summary.json`.

- The streaming fix is complete for the reproduced assistant/thought
  clear-storm class because normal-width pending dynamic height is bounded below
  the terminal viewport before Ink layout, trailing blank streaming tails are
  removed before slicing, repeated structural/prose rows are de-amplified at
  display time, and 24/34-column panes now prove live Mermaid/code preview with
  `openFenceLivePreviewSeen=true`. The only remaining fallback is the
  `terminalWidth <= 20` extreme-width case, which keeps Composer visible instead
  of attempting unreadable live code rows.
- The #3279 narrow Markdown path is covered by three guards:
  structure-sensitive code/table/Mermaid content is not safe-split into
  append-only Static while it is still streaming; the remaining pending tail uses
  the measured dynamic height budget instead of a fixed footer reserve; and the
  pending tail is capped and clipped through `MaxSizedBox` as a hard
  actual-render-height guard.
- The latest repeated Mermaid/table screenshots added two more guards: repeated
  structural rows now use the same broad classifier for pending and committed
  display, including Mermaid relationship rows and table-shaped wrapped
  fragments; normal content events are also compared against the full assistant
  turn, not only the current pending tail, so a cumulative replay crossing a
  safe-split boundary is trimmed before display.
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
