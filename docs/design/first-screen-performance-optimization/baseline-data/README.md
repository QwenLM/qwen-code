# Baseline data — main HEAD before PR2-4 optimizations

Collected via `scripts/benchmark-startup.mjs` on this branch (PR0+1) before any of PR2/PR3/PR4 land. PR2-4 must compare against these numbers using Welch's t-test.

## Collection environment

- **Date**: 2026-05-09
- **Branch**: `feat/first-screen-performance-optimization`
- **Commit**: see git log of this branch when baseline was collected
- **Node**: v24.15.0
- **Platform**: macOS (`darwin arm64`) — MacBook M-series
- **Bundle**: `dist/cli.js` (production bundle, post-`npm run bundle`)
- **Profiler activation**: `QWEN_CODE_PROFILE_STARTUP=1` + `SANDBOX=1` (faked sandbox env)
- **Modes (both committed)**: non-interactive (`--prompt noop`) AND interactive (`--interactive` via node-pty pty allocation). Both run 4 fixtures × 30 samples.

## Per-fixture summary (p50, n=30)

### Non-interactive (`<fixture>.summary.json`)

| Fixture           | `processUptimeAtT0Ms` | `before_render` | `config_initialize_dur` | `mcp_first_tool` | `mcp_all_settled` | `gemini_tools_lag` |
| ----------------- | --------------------- | --------------- | ----------------------- | ---------------- | ----------------- | ------------------ |
| `no-mcp`          | 449                   | 79              | 24                      | —                | 94                | —                  |
| `one-fast-mcp`    | 459                   | 80              | 264                     | 336              | 336               | 8.8                |
| `three-mixed-mcp` | 462                   | 81              | **6679**                | 335              | **6734**          | **6425**           |
| `flaky-mcp`       | 456                   | 80              | **10045**               | —                | 10100             | —                  |

### Interactive (`<fixture>-interactive.summary.json`)

| Fixture           | `first_paint` | `input_enabled` | `config_initialize_dur` | `mcp_first_tool` | `mcp_all_settled` | `gemini_tools_lag` |
| ----------------- | ------------- | --------------- | ----------------------- | ---------------- | ----------------- | ------------------ |
| `no-mcp`          | 420           | 480             | 70                      | —                | 469               | —                  |
| `one-fast-mcp`    | 422           | 875             | 464                     | 866              | 866               | 9.9                |
| `three-mixed-mcp` | 423           | **7101**        | **6688**                | 872              | **7077**          | **6235**           |
| `flaky-mcp`       | 413           | **10483**       | **10081**               | —                | 10467             | —                  |

### Heisenberg (`heisenberg.summary.json`, profiler overhead)

`profiler-on-heap` vs `profiler-off`: Δp50 = -9 ms (-1.12%), Welch's t-test p = 0.092 — within noise band, methodology validated. See `heisenberg.report.md`.

(All numbers in ms.)

## What this tells us (interpretation, no decisions yet)

- **V8 module-eval (`processUptimeAtT0Ms` ≈ 450ms)** is the single biggest fixed cost. PR3 (入口动态 import + 冷路径裁剪) targets this directly.
- **`before_render` ≈ 80ms** is small; PR2 (loadSettingsAsync) + PR3 (initializeApp 并行化) target this. Realistic upside is 30-50ms p50.
- **`config_initialize_dur`** scales linearly with MCP discovery: 24ms (no MCP) → 264ms (1 fast) → 6.7s (1 slow + 2 fast) → 10s (1 hung server). PR4 makes this O(fast servers) instead of O(slowest server).
- **`gemini_tools_lag`**: in the three-mixed-mcp fixture, the model has to wait **6.4 seconds** after the first tool was registered to actually see new tools (because `setTools()` is only called once, when discovery globally settles). PR4's 16ms batch flush kills this dead time.

## How PR2-4 use this baseline

Each PR runs the same command:

```bash
scripts/benchmark-startup.mjs \
  --fixture <name> \
  --runs 30 \
  --out /tmp/<pr>-after \
  --baseline docs/design/first-screen-performance-optimization/baseline-data/<name>.summary.json
```

The resulting `.report.md` has Δp50 + Welch's t-test p-value + verdict (improve / regress / noise) per metric. A PR is valid only if:

1. No metric in any fixture regresses by > 5% p50.
2. The metric the PR claims to optimize improves with p < 0.05 AND p50 reduction ≥ 10% or ≥ 50ms.

Detailed criteria in `01-observability-baseline.md` § 3.

## Files

- `<fixture>.summary.json` — **committed.** Aggregated p50/p90/p99/mean/stdev per metric **plus the full 30-sample array** for each metric (needed for Welch's t-test in `--baseline` mode). PR2-4 reference these directly.
- `<fixture>.raw.jsonl` — _gitignored._ One line per run, full StartupReport JSON. ~50 KB per fixture; rerun the benchmark to regenerate when needed.
- `<fixture>.report.md` — _gitignored._ Human-readable markdown derived from `summary.json`. Regenerate by rerunning the benchmark, or write your own renderer.

See `baseline-data/.gitignore` for the exclusion pattern.
