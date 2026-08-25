# Virtualized History scroll scheduling

## Problem

Virtualized History scrolls inside Ink's alternate-screen viewport. Real PTY captures show that wheel deltas are preserved, but visible output is only about 13–17 FPS and the first response to a wheel event takes 32–72 ms.

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

## Non-goals

- Pixel-smooth scrolling. SGR reports wheel direction, not pixel distance, and Ink renders terminal cells.
- Host scrollback while Virtualized History is enabled. Users who require native scrollback can set `ui.useTerminalBuffer` to `false` and restart.
- Enabling Ink incremental rendering or replacing the offset array with a new index structure. Both remain valid follow-up experiments, but have broader compatibility or complexity costs.

## Verification

- Unit-test immediate first flush, remaining-deadline scheduling, over-budget immediate flush, burst coalescing, and cancellation.
- Keep existing wheel-delta, scrollbar precedence, keyboard, and viewport tests green.
- Repeat the real PTY capture against the local candidate and compare first-output latency, sustained synchronized frames, and total row delta with the global 0.22.0 baseline.
