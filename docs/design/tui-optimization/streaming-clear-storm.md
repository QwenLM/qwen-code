# Streaming Clear-Storm Fix

## Scope

This document covers the supplemental fix for long assistant streaming output
that makes the main TUI flash, replay the banner, or duplicate visible history
while a response is still being generated.

It does not claim to close every TUI flicker class. Explicit screen refreshes
from resize, compact toggles, or deliberate static-output replacement still need
separate validation because those paths intentionally call the terminal clear
operation.

## User-Visible Problem

When an assistant response streams a long single paragraph or a long
single-line payload, the pending message can grow beyond the current terminal
height. With Ink 6.2.3, once the rendered dynamic output is at least as tall as
`stdout.rows`, Ink writes `clearTerminal` and replays the static output before
the next dynamic frame.

The visible result is a clear storm:

- the whole terminal flashes during the stream;
- the banner or previous static content is repeatedly replayed;
- the raw PTY stream grows much faster than the meaningful content;
- terminal recordings can look short or inconclusive if they do not also record
  the raw ANSI clear count.

## Source-Level Root Cause

The issue is triggered by this chain:

1. `packages/cli/src/ui/components/MainContent.tsx` keeps completed history in
   `<Static>` and renders the currently pending message dynamically.
2. `HistoryItemDisplay` routes pending assistant text to
   `ConversationMessages`.
3. `ConversationMessages` previously passed long pending text directly into
   `MarkdownDisplay`.
4. `MarkdownDisplay` bounded pending code blocks, but ordinary paragraphs and
   single-line text could still wrap into many visual rows.
5. Ink treats dynamic output taller than the terminal as unsafe to patch
   incrementally and emits `clearTerminal`, which is
   `ESC[2J ESC[3J ESC[H]`.

The important distinction is that the final transcript can be long, but the
live pending viewport must stay bounded. The fix therefore bounds only pending
assistant/thought rendering. Completed messages still render normally.

## Implementation

`packages/cli/src/ui/components/messages/ConversationMessages.tsx` now slices
pending markdown text by visual height before it reaches Ink/Yoga layout:

- it calculates visual rows using cached display width and Unicode code points;
- it preserves the newest tail of the stream, which is the part users need for
  live feedback;
- it renders a compact marker such as
  `... first N streaming lines hidden ...`;
- it only switches to the bounded plain-text preview while the item is pending
  and visually too tall;
- once the message is no longer pending, the full markdown content renders via
  the existing `MarkdownDisplay` path.

`packages/core/src/services/shellExecutionService.ts` also keeps the shell live
viewport from emitting resize-only reflow as new output. The render callback now
requires both a semantic viewport change and new renderable output before it
sends another live shell chunk. This prevents narrow-width soft wraps from being
misclassified as fresh shell output.

## Acceptance Metrics

The metric and UI capture must come from the same deterministic run.

Scenario:

- start a fake OpenAI-compatible streaming server;
- stream 220 chunks at 70 ms per chunk;
- each chunk is a long plain-text segment that wraps on an 88x26 terminal;
- disable synchronized-output wrapping so terminal capability hiding cannot mask
  the underlying Ink clear behavior;
- capture at least 40 frames during the stream and a final frame after idle.

Pass criteria for the fixed branch:

- `clearTerminalPairCount == 0` for the raw ANSI emitted after Enter;
- `finalDoneCount == 1` on the rendered terminal screen;
- `framesCaptured >= 40`;
- the GIF/screenshot sequence shows continuous bounded pending text rather than
  banner replay or repeated full-screen blanking.

Failure-first criteria for the base branch:

- `clearTerminalPairCount >= 1` in the same scenario proves the reproduction is
  real;
- the matching GIF/screenshot sequence should show at least one banner/static
  replay or visible full-screen refresh during streaming.

The key raw sequence is:

```text
ESC[2J ESC[3J ESC[H]
```

Counting only erase-line or cursor-up operations is not enough because normal
Ink patching uses those sequences as part of incremental redraw.

## Local Validation Command

Build the repository first:

```bash
npm run build && npm run bundle
```

Run the fixed-branch validation:

```bash
cd integration-tests/terminal-capture
npm run capture:streaming-clear-storm
```

Run a failure-first baseline with a separate checkout of `origin/main`:

```bash
QWEN_TUI_E2E_REPO=/path/to/main-checkout \
QWEN_TUI_E2E_OUT=/tmp/qwen-tui-streaming-clear-storm/main \
QWEN_TUI_E2E_MIN_CLEAR_PAIRS=1 \
QWEN_TUI_E2E_MAX_CLEAR_PAIRS=Infinity \
npm run capture:streaming-clear-storm
```

Run the fixed branch with the strict default:

```bash
QWEN_TUI_E2E_REPO=/path/to/fixed-checkout \
QWEN_TUI_E2E_OUT=/tmp/qwen-tui-streaming-clear-storm/fixed \
npm run capture:streaming-clear-storm
```

Each run writes `summary.json`, `stream.raw.ansi.log`, terminal screenshots, and
`streaming-clear-storm.gif` when either `ffmpeg` or Python/Pillow is available.
Set `QWEN_TUI_E2E_PYTHON=/path/to/python` if the default `python3` does not have
Pillow installed. Keep local absolute artifact paths out of GitHub comments; PR
descriptions should include only the metric values and uploaded/attached media.

## Validation Record

The supplemental PR was validated on April 27, 2026 with the same script,
prompt, fake streaming server, 88x26 terminal, and 55 captured frames on both
branches.

| Branch        | Expected                   | `clearTerminalPairCount` | `finalDoneCount` | Result     |
| ------------- | -------------------------- | -----------------------: | ---------------: | ---------- |
| `origin/main` | failure-first reproduction |                      427 |                1 | reproduced |
| fixed branch  | strict pass                |                        0 |                1 | passed     |

The side-by-side GIF should label the left side as `origin/main` and the right
side as the fixed branch, with the clear-pair count shown in the overlay.

## Review Notes

- This is a complete fix for the long assistant streaming clear-storm class
  because the pending dynamic render height is bounded below the terminal rows.
- It is not a complete fix for all flicker reports. Resize, compact-mode
  switching, tool detail expansion, and terminal-specific synchronized output
  behavior have different triggers and need their own metric-backed scenarios.
- Copying a heavily modified Ink fork is not the first choice here. The observed
  root cause is caused by an unbounded dynamic child. Bounding that child keeps
  the fix local, reviewable, and independent of Ink internals.
