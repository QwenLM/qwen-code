# Token usage trend and model colors

[English](token-usage-trend.md) | [简体中文](token-usage-trend.zh-CN.md)

## Status and scope

Implemented in two steps:

- **Step 1 (#16108, frontend only):** request success rate, session output speed, a categorical model palette and a per-model share bar.
- **Step 2 (this change):** per-request timing samples and failure records in core and on the daemon stats route, plus a speed and first-token timeline in Web Shell Token Usage.

This design builds on [Per-model generation timing](model-generation-timing.md) and [Token usage hierarchy](token-usage-hierarchy.md). CLI `/stats` is out of scope.

## Problem

1. Each model showed only its average output speed. A slowdown in the middle of a session, a few slow outliers, and a steady low speed all produced the same number.
2. The daemon counted failed API calls per model (`api.totalErrors`), but the panel never showed them. A model that kept hitting 429s or timeouts looked healthy.
3. Models were hard to tell apart. The first two palette colors were both blue (`#4b67ff` / `#4f94e7`, OKLab ΔE 12.3 for normal vision, below the 15 floor). Every share bar faded from the same blue, and the cards had no other color.

## Design

### D1 — Success rate (step 1)

Success rate = `(totalRequests − totalErrors) / totalRequests`, for the session and per model. Every failed attempt counts, retries included, which matches the existing counter. Internal prompts stay included, as in `totalRequests`. A tooltip on the label states this. Rates below 100% never round up to 100%: anything between 99.95% and 100% shows as 99.9%. Status: 100% shows a check, below 100% a warning, below 90% an error. Each status comes with an icon and text, never color alone, and uses the theme's `--success-color`, `--warning-color` and `--error-color`.

### D2 — Model colors (step 1)

Six categorical colors with separate steps for light and dark: blue, orange, aqua, violet, magenta, yellow. Light: `#2a78d6 #eb6834 #1baf7a #6250d6 #e87ba4 #eda100`. Dark: `#3987e5 #d95926 #199e70 #9085e9 #d55181 #c98500`. Adjacent pairs keep OKLab ΔE ≥ 9 under protanopia, deuteranopia and tritanopia, and ≥ 15 for normal vision. A model's slot is the order it was first used, which is the daemon's key order for `models`, not its rank by tokens. A model therefore keeps its color when the ranking changes. The seventh and later models share a neutral gray instead of a generated hue. Color marks identity only: share bar segments, the legend swatch, the card's left strip, and the timeline's dots and lines. All text keeps the text colors.

### D3 — Per-request samples in core (step 2)

`StatsModelMetrics` gains two optional fields, filled only in session buckets that feed the stats route:

- `timingSamples`: one entry per timed, non-internal response, under the same rules as `generation`: `{ at, ttftMs, generationMs, outputTokens, source? }`, oldest first. Only the latest `MAX_TIMING_SAMPLES` (200) are kept.
- `failures`: `byKind` counts every failed call by HTTP status code, else error type, else `unknown`. `recent` holds the latest `MAX_FAILURE_SAMPLES` (50) as `{ at, kind, source? }`. `byKind` is a null-prototype map, and stays one after snapshot/restore.

`at` comes from the event's `event.timestamp`, which falls back to the current time. Session replay feeds stored `ui_telemetry` events back through `addEvent`, so a resumed session rebuilds its timeline from history. Events recorded before `generation_ms` existed still carry no timing, as before. As with `generation`, neither field is added to `models`, which is also written to managed usage records with closed key sets.

### D4 — Stats route fields (step 2)

`GET /session/:id/stats` copies `timingSamples` (when non-empty) and `failures` into `models[name]`. `ServeSessionStatsModelMetrics` and `DaemonSessionStatsModelMetrics` declare both as optional. Older daemons omit them, and the panel then shows no timeline or spread. A full poll every 2 s carries at most 200 timing and 50 failure entries per model.

### D5 — Speed timeline (step 2)

When any model has samples or failures, a "Speed over time" card appears between the overview and "By model":

- The x-axis is wall-clock time. Each request is a dot in its model's color, and a line traces the median of its five neighbors to show the trend without following every outlier.
- A toggle switches the y-axis between output speed (tok/s) and first-token latency (s). The chart has one axis at a time. A sample's speed is its output tokens over TTFT plus generation time ([Output speed over the full request](output-speed-full-request.md)), so every sample with output tokens appears in both views; one without output tokens appears in the first-token view only.
- Failed requests appear as red × marks in a strip under the plot, in both views.
- Hovering or touching shows the nearest request in a tooltip, with crosshair and highlight: model, time, subagent, speed, first token, and output tokens with the time from request to last visible output; for a failure, its kind.
- With two or more models, a legend doubles as a series toggle. Hiding the last visible series shows all again.
- The SVG's accessible name summarizes the metric and each visible model's median.

### D6 — Card spread and failure kinds (step 2)

Each model card with at least two rate-measurable samples shows a dot strip of every sample's output speed. It has a p10–p90 band and a p50 tick, on one scale shared by all cards, followed by `p50 · p10–p90 tok/s`. The existing average output speed in the timing grid stays. A model with failures lists them by kind, for example `Failed: 429 ×2 · timeout ×1`, most frequent first.

## Compatibility

- All new fields are optional and additive. Older daemons render as before step 2.
- The timeline holds the most recent 200 timed responses per model. Older ones still count toward every aggregate.
- A managed session restored through `restoreSessionModelMetrics` does not get samples back, the same as per-model timing.

## Out of scope

- Separating retries from final failures, and excluding internal prompts from the success rate.
- Incremental (`since`) polling of samples.
- Timelines in CLI `/stats`.

## Validation

- **Core:** samples are recorded with event time, subagent source and the 200 cap; untimed, internal and session-less events are skipped; failures are keyed by status code, then error type, then `unknown`, including `__proto__`, and capped at 50 while the counts keep growing; `byKind` stays null-prototype after snapshot/restore.
- **CLI:** the stats extension method returns `timingSamples` and `failures`, and omits them when empty.
- **Web Shell unit:** dots per model in each view, the 50 ms window excluded from speed, failure marks, the accessible summary, legend toggling, nearest-point and failure tooltips, card spread quantiles, failure kinds in Chinese, and no timeline without samples.
- **Web Shell E2E (Chromium):** 1200px/390px, en/zh-CN, light/dark. The timeline renders with the model colors, the tooltip opens on hover and tap, and the ×-mark count matches the failures.

## Open questions

None.
