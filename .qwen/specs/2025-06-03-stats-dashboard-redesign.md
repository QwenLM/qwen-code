# Stats Dashboard Redesign

## Overview

Redesign the `/stats` TUI dashboard to improve layout hierarchy, add efficiency metrics, tool usage details, and trend comparisons. The Session tab remains unchanged.

## Tab Structure

```
Tab 1: Session    (unchanged - live current-session metrics)
Tab 2: Activity   (time-based trends and usage patterns)
Tab 3: Efficiency (performance metrics and tool analysis)
```

## Time Range Selector

Cycle: `Today` → `Week` → `Month` → `All`

Triggered by pressing `r`. All data in Activity and Efficiency tabs is filtered by the selected range.

## Delta Calculation

Every KPI card shows a trend arrow comparing the current range against the previous equivalent range:

- Range = Today → compare today vs yesterday
- Range = Week → compare last 7 days vs the 7 days before that
- Range = Month → compare last 30 days vs the 30 days before that
- Range = All → no delta shown

Display: positive = green `▲ +12%`, negative = red `▼ -3%`. For latency, lower is better so the colors invert.

Implementation: load two time slices from `usage_record.jsonl`, aggregate each, compute percentage change.

## Activity Tab

Layout from top to bottom:

### 1. KPI Row

Three metrics in a horizontal row, each with value + delta arrow:

| Metric | Source | Example |
|--------|--------|---------|
| Sessions | `report.sessionCount` | `42 ▲+8` |
| Duration | `report.totalDurationMs` | `18h 32m ▲+2h` |
| Tokens | sum of `report.models[*].totalTokens` | `2.4m ▲+12%` |

### 2. Heatmap

- Full width, GitHub-style grid
- **Color intensity** = daily total token consumption (not session count)
- **Today's cell** = distinct border or marker character (e.g., `[ ]` instead of `  `, or a brighter outline color)
- Right-aligned metadata: `streak: 12d │ best: 23d`
- Legend row: `Less ░░░░░ More`
- Column labels: month abbreviations + day numbers
- Row labels: Mon / Wed / Fri (compact 3-row mode)
- Weeks shown: `min(26, max(8, floor((bodyWidth - 4) / 2)))`

### 3. Token Trend Chart

- Braille sub-pixel line chart (existing `buildLineChartData`)
- Single series: total tokens per day
- Height: 6 rows
- Month navigation with `←` `→` when range = `all`
- Month label: `← Jun 2025 →`

### 4. Project Ranking

Table showing top 5 projects:

```
  Project         Sessions   Tokens    Duration
  qwen-code       28         1.8m      12h
  web-app         10         420k       4h
  infra            4         180k       2h
```

Source: `report.projects` sorted by totalTokens descending.

## Efficiency Tab

Layout from top to bottom:

### 1. Performance Cards Row

Three boxed metric cards:

| Metric | Calculation | Source |
|--------|-------------|--------|
| Cache Hit Rate | `cachedTokens / inputTokens * 100` | `report.models[*].cachedTokens` / `inputTokens` |
| Tool Success Rate | `totalSuccess / totalCalls * 100` | `report.tools.totalSuccess` / `totalCalls` |
| Avg Latency | `totalLatencyMs / totalRequests` | Requires adding `totalLatencyMs` to persisted records OR computing from per-model data |

Each card shows: label, bold percentage/value, delta arrow.

Note on Avg Latency: The current `UsageSummaryRecord` does not persist latency data. Options:
1. Compute from live `SessionMetrics` for current session only (show "—" for historical)
2. Add `totalLatencyMs` field to the persisted record (migration: old records show "—")

**Decision: Option 2** — extend `UsageSummaryRecord` with optional `totalLatencyMs`. Old records without this field display "—" for latency delta.

### 2. Tool Leaderboard

Table showing top 8 tools by call count:

```
  Tool       Calls    Time      Success
  edit       847      42.3s     ██████████ 98%
  read       612       8.1s     ██████████ 99%
  bash       431      67.8s     █████████░ 89%
  glob       298       2.4s     ██████████ 99%
  grep       256       3.1s     █████████░ 97%
  write      189      12.5s     ██████████ 96%
  agent       45      89.2s     ████████░░ 82%
```

- Success rate visualized as a 10-char bar: filled `█` + empty `░`
- Color: green if ≥95%, orange if ≥80%, red if <80%
- Source: `report.tools.topTools` (already computed, but needs duration added)

Note: Current `topTools` in aggregated report only has `count, success, fail`. Need to add `totalDurationMs` per tool to the aggregation.

### 3. Model Comparison Table

```
  Model            Reqs    In/Out         Cache   Latency
  ● qwen-max      186     1.2m/340k      91%     2.1s
  ● qwen-plus     124     890k/210k      84%     1.2s
  ● qwen-turbo     67     310k/89k       72%     0.8s
```

- Sorted by totalTokens descending
- Color-coded dots (series colors)
- Cache column: green ≥85%, orange ≥70%, red <70%
- Source: `report.models`

### 4. Code Impact

Single-line summary:

```
  Code  +2,847 lines / -1,203 lines  net: +1,644
```

Source: `report.files.linesAdded`, `report.files.linesRemoved`.

## Keyboard Controls

| Key | Action |
|-----|--------|
| `Tab` / `Shift+Tab` | Switch between tabs |
| `r` | Cycle range: today → week → month → all |
| `←` / `h` | Previous month (chart navigation, range=all only) |
| `→` / `l` | Next month (chart navigation, range=all only) |
| `Esc` | Close dialog |

## Data Layer Changes

### UsageSummaryRecord v1 Extensions (backward-compatible)

Add optional fields to existing schema:

```typescript
interface UsageSummaryRecord {
  // ... existing fields ...
  totalLatencyMs?: number;  // NEW: sum of all API response latencies
  tools: {
    // ... existing fields ...
    byName: Record<string, {
      count: number;
      success: number;
      fail: number;
      totalDurationMs?: number;  // NEW: sum of tool execution time
    }>;
  };
}
```

### StatsData Extensions

```typescript
interface StatsData {
  // ... existing fields ...
  delta?: {
    sessions: number | null;      // percentage change
    duration: number | null;
    tokens: number | null;
    cacheRate: number | null;
    toolSuccess: number | null;
    avgLatency: number | null;
  };
  efficiency: {
    cacheHitRate: number;
    toolSuccessRate: number;
    avgLatencyMs: number | null;
  };
  toolLeaderboard: Array<{
    name: string;
    count: number;
    totalDurationMs: number;
    successRate: number;
  }>;
}
```

### Heatmap Data Change

Currently `buildHeatmapData` receives `Record<string, number>` where value = session count. Change to: value = total tokens for that day. The mapping to intensity levels (0-4) needs recalibration:

- 0: no usage
- 1: < 10k tokens
- 2: 10k - 50k tokens
- 3: 50k - 200k tokens
- 4: > 200k tokens

Thresholds should be computed dynamically based on the data distribution (percentile-based) rather than hardcoded, to adapt to different usage patterns.

### Today Highlight

In `buildHeatmapData`, mark today's cell with a special property. Render it with a distinct character or color attribute (e.g., bright white border characters `[▓]` instead of plain `▓▓`).

## Internationalization

All user-facing strings wrapped in `t()`. New i18n keys:

```
stats.activity          = "Activity"
stats.efficiency        = "Efficiency"
stats.today             = "Today"
stats.sessions          = "Sessions"
stats.duration          = "Duration"
stats.tokens            = "Tokens"
stats.cacheHitRate      = "Cache Hit Rate"
stats.toolSuccessRate   = "Tool Success"
stats.avgLatency        = "Avg Latency"
stats.toolLeaderboard   = "Tool Leaderboard"
stats.calls             = "Calls"
stats.time              = "Time"
stats.success           = "Success"
stats.models            = "Models"
stats.reqs              = "Reqs"
stats.cache             = "Cache"
stats.latency           = "Latency"
stats.codeImpact        = "Code Impact"
stats.net               = "net"
stats.streak            = "streak"
stats.best              = "best"
stats.tokenTrend        = "Token Trend"
stats.projects          = "Projects"
stats.project           = "Project"
```

## Files to Modify

| File | Change |
|------|--------|
| `packages/cli/src/ui/components/StatsDialog.tsx` | Replace OverviewTab and ModelsTab with ActivityTab and EfficiencyTab |
| `packages/core/src/services/usageHistoryService.ts` | Add delta calculation, extend aggregation for tool duration and latency |
| `packages/cli/src/ui/utils/statsDataService.ts` | Extend StatsData with efficiency and delta fields |
| `packages/cli/src/ui/utils/asciiCharts.ts` | Add today highlight to heatmap, adjust intensity mapping |
| `packages/core/src/telemetry/uiTelemetry.ts` | Ensure latency is captured in persistence path |
| `packages/cli/src/gemini.tsx` | Persist `totalLatencyMs` and per-tool duration in shutdown hook |
| `packages/cli/src/i18n/*.ts` | Add new translation keys |

## Out of Scope

- Cost estimation (requires user-configured pricing, can be added later)
- Per-file change tracking (not available in current data model)
- Context window usage / compression metrics (not tracked)
- Interactive drill-down into individual sessions
