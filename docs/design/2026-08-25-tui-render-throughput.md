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

After measuring the two changes together, evaluate whether streaming content can safely move from a 60 ms to roughly 33 ms flush interval. Accept that follow-up only if a paired PTY re-run against the baseline recorded in Results shows bounded CPU, output, and event-loop latency and the stream buffering/cancellation tests remain correct.

## Verification

- Add a render-options unit assertion for VP incremental output and its absence in legacy mode.
- Add a `MainContent` regression test proving a buffer-only provider update does not revisit `ScrollableList`, while an actual history input still can.
- Run cursor rendering coverage, the focused component/options tests, build, and typecheck.
- Repeat identical hook-off and hook-on PTY workloads for typing, streaming, PageUp/PageDown, wheel scrolling, and typing after a long response.

## Results

### Measurement setup

- Variants: the pre-change base build (control) versus this PR built and bundled from commit `712ea6d50a` (candidate), both from the same lockfile.
- Host: macOS, idle system. Paired runs were collected serially. Hook-off runs were the authoritative source for CPU, stdout volume, event-loop lag, and input latency; React instrumentation perturbs timing and ran separately.
- Driver: the bundled CLI in a deterministic 100×32 PTY against a local fake OpenAI-compatible SSE provider emitting 180 Markdown chunks at 10 ms intervals. Workloads: burst paste, 213 paced input characters, streamed Markdown, 24 PageUp/PageDown keys, 200 SGR wheel events, and 112 paced characters after the long response was visible.
- Driver script: [`scripts/benchmark-tui-pty.mjs`](../../scripts/benchmark-tui-pty.mjs) implements this protocol (PTY driver, fake SSE provider, workload phases, and the per-phase metric collection) so paired re-runs — including the deferred-work acceptance criterion below — have a shared reference to execute against. The tables in this document record the original paired runs.

### Paired PTY results

| Phase                                          | Writes, before → after | stdout bytes, before → after |                    CPU, before → after |         Event-loop p95, before → after |
| ---------------------------------------------- | ---------------------: | ---------------------------: | -------------------------------------: | -------------------------------------: |
| 212-character burst paste                      |                  3 → 3 |         3,315 → 851 (-74.3%) | Not compared due async snapshot timing | Not compared due async snapshot timing |
| Paced input, 213 characters                    |      204 → 216 (+5.9%) |    218,833 → 13,710 (-93.7%) |                2,258 → 873 ms (-61.3%) |               12.65 → 4.30 ms (-66.0%) |
| Streaming Markdown                             |     171 → 213 (+24.6%) |   254,033 → 162,989 (-35.8%) |              2,197 → 1,049 ms (-52.3%) |               18.77 → 3.57 ms (-81.0%) |
| 24 PageUp/PageDown keys                        |        45 → 48 (+6.7%) |     70,338 → 57,460 (-18.3%) |                  739 → 342 ms (-53.8%) |               25.02 → 4.15 ms (-83.4%) |
| 200 wheel events                               |       21 → 33 (+57.1%) |     33,430 → 41,565 (+24.3%) |                  351 → 131 ms (-62.8%) |               11.30 → 3.11 ms (-72.4%) |
| Paced input after long history, 112 characters |      99 → 119 (+20.2%) |    151,754 → 16,765 (-89.0%) |                1,040 → 319 ms (-69.4%) |               15.47 → 1.69 ms (-89.1%) |

Incremental rendering allows more small writes but sharply reduces the size and CPU cost of input frames. Wheel scrolling is the output-volume exception (writes and bytes increase) while CPU and event-loop lag still improve substantially. Input latency: the empty-history median increased by about 2 ms; its p95/max and every measured long-history latency improved.

The full report — input-latency tables, identity-aware React attribution per phase, additional verification, and remaining scope (Windows and Linux interactive PTY behavior was not measured) — is recorded in the PR's E2E test report comment: https://github.com/QwenLM/qwen-code/pull/9970#issuecomment-5403787518

### Outcome

In the clean paired PTY run, paced typing reduced stdout bytes by 93.7%, CPU by 61.3%, and event-loop p95 by 66.0%. Typing after a long response reduced bytes by 89.0%, CPU by 69.4%, and event-loop p95 by 89.1%. Streaming CPU fell 52.3% and event-loop p95 fell 81.0% without changing the 60 ms content flush interval.

An identity-aware React hook confirmed that composer typing still updated the lightweight `MainContent` wrapper but rendered `MainContentView` only twice in the paced phase and once after the long response. History and Markdown descendants did not render during either input phase.
