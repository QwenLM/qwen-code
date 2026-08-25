# TUI render throughput

## Problem

The virtual-viewport TUI feels slow while typing and streaming. The existing 60 FPS Ink ceiling improved scrolling, but it does not reduce React work per update or the number of bytes sent to the terminal.

Profiling the current 0.22.0 bundle separates three costs:

1. Composer buffer changes invalidate the monolithic UI state context, which `MainContent` reads directly. About 213 paced characters caused 263 React commits. The baseline hook's component-level Fiber flags could not reliably attribute those commits to descendants.
2. Ink's default output path clears and rewrites the full viewport for small edits. A 120×40 synthetic workload emitted 5,158 bytes per typing or streaming frame; Ink's incremental mode emitted about 247–249 bytes.
3. Streaming state is flushed every 60 ms, which limits content updates to about 16.7 Hz before Ink's separate paint ceiling. This interval also preserves established buffering and cancellation boundaries, so it should not be changed until per-update work is reduced and measured.

## Design

Enable Ink incremental rendering only in virtual-viewport mode. Legacy mode retains its current output behavior. VP mode owns a fixed alternate-screen viewport and already has cursor-correctness coverage for both Ink output modes.

Keep `MainContent` as the public context-reading component, but move its history body behind a memoized component. The wrapper constructs a memoized slice containing only the 17 UI-state fields the history body consumes. Composer-only changes still update the small wrapper, while React's shallow prop comparison skips the history body when its inputs are unchanged.

This deliberately avoids splitting the shared context, changing public state types, adding a custom equality function, or changing scroll scheduling.

## Deferred work

After measuring the two changes together, evaluate whether streaming content can safely move from a 60 ms to roughly 33 ms flush interval. Accept that follow-up only if paired PTY runs show bounded CPU, output, and event-loop latency and the stream buffering/cancellation tests remain correct.

## Verification

- Add a render-options unit assertion for VP incremental output and its absence in legacy mode.
- Add a `MainContent` regression test proving a buffer-only provider update does not revisit `ScrollableList`, while an actual history input still can.
- Run cursor rendering coverage, the focused component/options tests, build, and typecheck.
- Repeat identical hook-off and hook-on PTY workloads for typing, streaming, PageUp/PageDown, wheel scrolling, and typing after a long response.

## Results

In the clean paired PTY run, paced typing reduced stdout bytes by 93.7%, CPU by 61.3%, and event-loop p95 by 66.0%. Typing after a long response reduced bytes by 89.0%, CPU by 69.4%, and event-loop p95 by 89.1%. Streaming CPU fell 52.3% and event-loop p95 fell 81.0% without changing the 60 ms content flush interval.

An identity-aware React hook confirmed that composer typing still updated the lightweight `MainContent` wrapper but rendered `MainContentView` only twice in the paced phase and once after the long response. History and Markdown descendants did not render during either input phase.
