# Web Shell streaming render performance

## Problem

Thinking and assistant deltas currently wake the transcript on every animation
frame. Each accepted snapshot runs transcript projection and downstream list
work, while the growing Markdown document is parsed again at every streaming
flush. Although `ChatEditor` is memoized, this main-thread work still competes
with editor input and becomes increasingly expensive as the active response
grows.

## Evidence

The transcript projector is linear, but browser profiling with 50,000 retained
messages attributes only 2.5% of sampled time to projection. The dominant
104 ms long task spends 52.1 ms in `applyTurnCollapse`; repeated full-history
derivation in `MessageList` also includes final-answer collection, agent
grouping, pinning, and display-index generation.

After the tail-only path, two CPU samples reduced `applyTurnCollapse` from
467.8 ms total self time to 26.7–51.5 ms, final-answer collection from 247.2 ms
to 11.4–26.9 ms, grouping from 54 ms to 2.4–7.6 ms, and display-index
generation from 67.5 ms to 3.7–12 ms. The mock SSE disconnected after replay
in that rerun, so these samples establish hotspot reduction but are not used as
end-to-end completion or long-task acceptance evidence.

Markdown has the opposite shape: every streamed append changes the complete
source string and reparses the complete growing document. Throttling bounds how
often that happens but not the cost of each parse.

## Design

1. Batch provider transcript events into a 16 ms macrotask window, with
   synchronous flushes before control and terminal events and when the stream
   ends. Downstream, coalesce transcript notifications and admit at most one
   snapshot every 50 ms.
2. Defer transcript snapshots with session and block-index identities. Urgent
   editor work can commit against the previous snapshot, while session switches
   and same-session store resets immediately reject stale deferred blocks.
3. Preserve normalized tool-content references with a `WeakMap`, allowing the
   existing row comparator's JSON cache to avoid reserializing unchanged
   historical tool output.
4. Keep the thinking elapsed timer alive across streamed content appends.
5. Keep live Markdown for short responses so closed charts and ordinary
   formatting retain their existing behavior. Once a streaming document
   exceeds a fixed parse budget, render its throttled source as escaped plain
   text with preserved whitespace. When streaming ends, render the complete
   Markdown once. This bounds repeated parsing while only delaying formatting
   for responses large enough to cause the observed problem.
6. Preserve projected history object identity when every prior transcript block
   is unchanged and only the final ordinary streaming text block grows. Reuse
   completed-history `MessageList` derivations under the same narrow condition,
   replacing only the rendered tail row. Any earlier block change, terminal
   transition, tool/background update, usage change, translation change, or
   view-option change takes the existing full calculation path.

## Non-goals

- No general incremental transcript projector. Projection is not the measured
  bottleneck, and the narrow tail path avoids new invalidation machinery.
- No incremental Markdown AST or Web Worker. Plain streaming text removes the
  repeated parse with less code and no cross-thread serialization.
- No changes to daemon event ordering, transcript persistence, or public block
  shapes.

## Verification

- Unit tests cover notification coalescing, the 50 ms window, cancellation,
  session switching, stable projection identity, streamed-tail rendering and
  invalidation, stable tool normalization, timer reuse, and the
  streaming-text-to-settled-Markdown transition.
- `npm run test:e2e:perf --workspace=@qwen-code/web-shell` deterministically
  replays 5,000 historical turns, streams 400 Markdown-heavy chunks while
  typing, verifies the final output and composer contents, and records input
  latency and browser long-task metrics in the Playwright report.
