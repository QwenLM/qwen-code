# Virtualized History scroll scheduling

## Problem

Virtualized History scrolls inside Ink's alternate-screen viewport. Real PTY captures show that wheel deltas are preserved, but visible output is only about 13–17 FPS and the first response to a wheel event takes 32–72 ms. All figures in this doc are single-machine observations from one macOS host (real PTY at a 100x30 viewport, Node.js 22 runtime) and have not been independently reproduced; the capture scripts are not part of this tree.

The viewport currently waits a fresh 16 ms after the first event in every input burst before applying the accumulated scroll. A profiled Ink frame already costs about 35 ms in layout, composition, ANSI diffing, and terminal output. When the event loop becomes available after an over-budget frame, the extra fixed wait needlessly delays the next update.

## Evidence

- A real SGR wheel event moves exactly three terminal rows, matching `WHEEL_LINES_PER_TICK`; an 80-event burst preserves 239 of the expected 240 rows.
- A scroll-only Inspector capture attributes about 35 ms of CPU to each emitted frame. Mouse parsing is negligible compared with Ink/Yoga/output work.
- Synthetic real-Ink profiling shows a separate O(item-count) offsets rebuild for newly measured history rows. It worsens very large resumed histories, but it is not the cause of the low-FPS small-item-count PTY reproduction.
- Virtualized History deliberately enters the alternate screen (`?1049h`), so host terminal scrollback is unavailable by design.

## Change

Keep the existing accumulated wheel/drag intent and the once-per-frame cap, but make the coalescer leading-edge and deadline-aware:

1. The first scheduled update flushes immediately.
2. Further updates inside the same 16 ms window are combined and flush at the remaining deadline.
3. If the event loop was blocked past the deadline, the next update flushes immediately instead of starting another full 16 ms wait.
4. Cancellation still discards a pending trailing flush.

This removes avoidable scheduling latency without increasing scroll work above one application flush per frame window or dropping input delta.

## Relationship to the frame pacing doc

`docs/design/2026-08-21-vp-scroll-frame-pacing.md` kept the trailing-only coalescer and records that a leading-and-trailing variant was rejected because high-frequency direct-PTY testing showed path-dependent scroll distance through the dynamically measured list. This doc supersedes that bullet. The rejection no longer applies because the current scheduler does not change how far a burst scrolls — only when the first application happens. Wheel and drag intent accumulates in refs exactly as before, and every flush (leading or trailing) applies the same accumulated delta through a single `scrollBy`, then resets the accumulator. Total row delta is therefore independent of flush timing:

- The burst-preservation unit test (`preserves the full delta of a coalesced wheel burst`) asserts an exact 90-row delta across a coalesced 30-tick burst.
- The real PTY capture above preserves 239 of the expected 240 rows across an 80-event burst, and one SGR tick still moves exactly `WHEEL_LINES_PER_TICK` rows.

The residual path dependence the pacing doc observed is the height estimator discovering actual row heights for newly measured items (see Evidence); it is orthogonal to flush scheduling and remains a non-goal here. After this change, this doc is the authoritative statement on VP scroll input coalescing.

## Non-goals

- Pixel-smooth scrolling. SGR reports wheel direction, not pixel distance, and Ink renders terminal cells.
- Host scrollback while Virtualized History is enabled. Users who require native scrollback can set `ui.useTerminalBuffer` to `false` and restart.
- Enabling Ink incremental rendering or replacing the offset array with a new index structure. Both remain valid follow-up experiments, but have broader compatibility or complexity costs.

## Verification

- Unit-test immediate first flush, remaining-deadline scheduling, over-budget immediate flush, burst coalescing, and cancellation.
- Keep existing wheel-delta, scrollbar precedence, keyboard, and viewport tests green.
- Repeat the real PTY capture against the local candidate and compare first-output latency, sustained synchronized frames, and total row delta with the global 0.22.0 baseline.

Capture environment for the before/after comparison: a single macOS host, real PTY at a 100x30 viewport, Node.js 22-compatible workspace runtime, global Qwen Code 0.22.0 as the baseline, and the locally built candidate. Both captures used the same workload — an 80-event oscillating SGR wheel sequence. Recorded result of that comparison:

| Metric                                  | Before (global 0.22.0) | After (local candidate) |
| --------------------------------------- | ---------------------: | ----------------------: |
| First visible output after wheel input  |               29.01 ms |                11.11 ms |
| Sustained synchronized output           |              18.71 FPS |               31.75 FPS |
| Synchronized frames in the same capture |                     16 |                      25 |
| Wheel distance per SGR tick             |                 3 rows |                  3 rows |

These are the same single-machine, non-reproduced observations described in the Problem statement. Reproducing them requires the (uncommitted) capture harness plus a global 0.22.0 install; treat the numbers as directional until re-measured.
