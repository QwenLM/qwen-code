# VP scroll frame pacing

## Problem

Mouse scrolling in the terminal-buffer UI is governed twice. `ScrollableList`
waits up to one 16 ms frame before committing accumulated wheel input, while
Ink independently limits terminal paints to its default 30 FPS. In a real
120x40 detached tmux run, the unchanged production bundle sustains roughly 26
FPS with a 43 ms median frame interval. Profiling shows terminal frame
composition and serialization dominate the active scroll window; Yoga layout
is a much smaller share.

## Change

Raise the terminal paint ceiling for VP scrolling without changing input
semantics:

- Pass `maxFps: 60` to Ink only when terminal-buffer mode is active. Preserve
  the existing 30 FPS default for legacy rendering.
- Keep the existing trailing 16 ms input coalescer. A leading-and-trailing
  variant was rejected because high-frequency direct-PTY testing showed
  path-dependent scroll distance through the dynamically measured list.

No rendering-library fork or virtual-list rewrite is part of the first pass.
Broader work is justified only if the measured result remains below the
acceptance threshold.

## Measurement

Run the unchanged baseline and candidate in alternating order with the same
large and small recorded sessions and 100 SGR wheel events. Keep the 120x40
detached tmux test for comparison, and add a 120x40 direct-PTY run that injects
one event every 5 ms; spawning `tmux send-keys` once per event takes roughly 45
ms on the test host and therefore caps the observable input-driven frame rate.
For each, record steady frame count, FPS, p50/p90 frame interval, bytes per
frame, event-injection duration, and final viewport position. Use at least three
runs per session and compare medians. Verify ordinary 50 ms wheel input ends at
the same viewport. For the 5 ms stress burst, verify every write succeeds and
use a controlled-height list test to assert the exact accumulated scroll delta:
the real history estimator starts unseen items at three rows, so rendering more
intermediate layouts can discover actual heights and legitimately change its
final content anchor.

The first pass is successful when both session sizes reach at least 45 FPS with
a p50 frame interval below 25 ms in the direct-PTY run, without dropping input,
changing ordinary-rate scroll behavior, or changing the recorded sessions. CPU
time and terminal bytes per second are guardrails: the higher frame rate must
not come from an unbounded render loop.

## Risks

60 FPS can increase total terminal output and CPU use during active scrolling.
The limit applies only to VP mode, and scroll events retain their existing
coalescing behavior. Keyboard behavior and non-VP output retain their current
scheduling.
