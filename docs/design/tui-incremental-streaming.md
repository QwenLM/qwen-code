# Incremental terminal streaming

[English](tui-incremental-streaming.md) | [简体中文](tui-incremental-streaming.zh-CN.md)

## Problem and evidence

Text still appears uneven after the first streaming-cadence change. Main-chat
events already have a 17 ms ordered buffer, and virtual Ink rendering already
targets 60 FPS. The growing Markdown fragment is reparsed on each update;
code lines and stable blocks can be highlighted or reconstructed repeatedly.

Local Grok Build source uses stable Markdown prefixes and a presentation
deadline anchored to the previous draw. A clock-only replay of an earlier
72-commit Qwen trace produces roughly 33 ms P95 gaps with Ink's existing
leading/trailing throttle and 19–20 ms with a fixed deadline. This establishes
a scheduling mechanism, not the current CLI's end-to-end improvement.

The current local baseline receives chunks approximately every 11–12 ms but
shows ASCII progress at 33/51 ms P50/P95. In a controlled component replay,
18 complete code lines are highlighted another 1296 times across 72 updates;
automatic-code React rendering has 14.81 ms P95. Its controlled sink callbacks
stay below 0.16 ms P95, which does not measure native terminal presentation.

Before implementation, capture the current bundled CLI with deterministic
chunk timing. Separate arrival, application update, React work, Ink drawing
and terminal output; a render callback runs before stdout writing and is not
a write-completion acknowledgement.

## Proposed changes

### Deadline-based drawing

Replace only the ordinary render throttle inside the existing Ink patch with
a scheduler anchored to the last actual invocation. A request draws immediately
when eligible; otherwise it schedules the earliest remaining deadline. Later
requests coalesce without extending that deadline. The callback reads the
latest tree, avoiding a queue of obsolete frame snapshots.

Keep the existing configured frame limit, unthrottled debug/reader paths,
Static immediate-render path, synchronized output and diff behavior. Preserve
flush/cancel behavior at explicit boundaries and unmount. Do not add a third
application timer, a new public Ink API, or artificial character playback.
Keep the ordered 17 ms stream buffer and its completion, tool, image, cancel,
retry and fallback flush/discard semantics. Preserve the initial 17 ms batch;
afterward, anchor the next buffered update to the last non-empty flush, rather
than waiting a full new window after the next arriving chunk. This avoids
turning an 11–12 ms chunk cadence into 22–24 ms state-update steps. Empty
flushes do not move the clock; retry/fallback discard resets it. A late chunk
after idle can update immediately, with all content/image parts enqueued
before the update is scheduled.

### Stable Markdown prefixes

During pending append-only text, retain parsed React nodes through conservative
complete block boundaries already understood by the existing parser. Continue
parsing only the changing tail, preserving original line keys, block counters,
copy indices and blank-line behavior. Do not split or freeze an open code,
math or table block. The existing parser remains the source of display rules.

Invalidate the cache when the prefix changes, content shrinks, rendering mode,
dimensions, colors, highlighter availability or copy-source context change,
or pending rendering ends.
Final rendering uses the complete existing path. Retained data belongs to the
current mounted message, with no global source-text cache. Native preview
clipping and virtual-list source selection retain their existing semantics.
While the highlighter is unavailable, freeze only prefixes without code so
code rendering can continue the loader's existing cooldown/retry behavior.

### Reuse completed code lines

Memoize highlighted code lines within each mounted code block. An unchanged line,
language, active theme and loaded highlighter reuse the same highlighted
content, while gutters can still change independently. Retain only results for
the current rendered lines, preserving the existing direct-row structure
required by MaxSizedBox's layout. The changing final
line is recalculated. Highlighter loading, theme/language changes and line
replacement invalidate the relevant result. Keep the current per-line grammar,
diagram fallback, truncation, numbering and selectable boundaries unchanged.

## Scope and implementation

Update the existing Ink patch, stream buffer scheduling, MarkdownDisplay,
CodeColorizer and focused
regression tests. Diagnostic scripts and raw traces live under ignored .qwen
or task-owned temporary directories. Add no permanent product telemetry,
provider/protocol change, configuration option, output worker or renderer
migration. Arena's committed-round display remains unchanged.

Grok's writer thread is a useful reference, but a new worker or cross-layer
write-ack protocol needs evidence that the terminal sink is the bottleneck.
This change first reduces scheduling jitter and repeated work using the
current renderer. Measurements may narrow the implementation further.

## Validation and acceptance

Run the global CLI for baseline context, then the unchanged local bundle and
rebuilt bundle with identical synthetic chunks. Cover steady and bursty ASCII,
Chinese, long paragraphs, open/closed code, Markdown tables/lists, reasoning
and tool transitions. Compare output-progress gaps and receive-to-output lag,
not just render-call counts. Record React, drawing and highlighter work
separately; use a slow-output diagnostic if sink delay is observed.

Acceptance requires a measurable reduction in uneven output gaps or repeated
render work, exact final text, and no added content delay. Preserve cancellation,
retry/fallback replacement, image ordering, narrow resizing, viewport detachment,
composer position and source-copy semantics. Verify full rendering after cache
invalidation and completion. Pure clock tests cover deadline/coalescing,
flush/cancel and cleanup; live renderer tests check actual output.

Exercise the code against a pristine Ink 7.0.3 installation with a clean patch
application. Run repository build/typecheck/bundle, focused unit tests, scoped
lint/format checks, two self-audit passes and independent review. Report native
Warp and platform coverage accurately; no fixed 60/120-visible-FPS claim.

## Open questions

The baseline will determine how much delay belongs to scheduling versus
Markdown/layout work. Sink-level backpressure is deferred unless the same
controlled replay identifies it as a material remaining bottleneck.
