# Stats Dashboard Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Overview and Models tabs in the `/stats` TUI with an Activity tab (time-based trends) and an Efficiency tab (performance metrics and tool analysis).

**Architecture:** Extend the data layer (`usageHistoryService`, `statsDataService`) with delta calculation, tool duration, and latency fields. Replace the two UI tab components in `StatsDialog.tsx`. Change the heatmap from session-count to token-based with today highlight.

**Tech Stack:** TypeScript, Ink/React, Vitest, braille ASCII charts

---

### Task 1: Extend UsageSummaryRecord with latency and tool duration

**Files:**
- Modify: `packages/core/src/services/usageHistoryService.ts:16-44`
- Modify: `packages/core/src/services/usageHistoryService.ts:111-158` (metricsToUsageRecord)
- Test: `packages/core/src/services/usageHistoryService.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/services/usageHistoryService.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { metricsToUsageRecord } from './usageHistoryService.js';
import type { SessionMetrics } from '../telemetry/uiTelemetry.js';
import { ToolCallDecision } from '../telemetry/tool-call-decision.js';

function makeMetrics(): SessionMetrics {
  return {
    models: {
      'qwen-max': {
        api: { totalRequests: 5, totalErrors: 0, totalLatencyMs: 9500 },
        tokens: { prompt: 1000, candidates: 500, total: 1500, cached: 800, thoughts: 0 },
        bySource: {},
      },
    },
    tools: {
      totalCalls: 10,
      totalSuccess: 9,
      totalFail: 1,
      totalDurationMs: 5000,
      totalDecisions: {
        [ToolCallDecision.ACCEPT]: 5,
        [ToolCallDecision.REJECT]: 1,
        [ToolCallDecision.MODIFY]: 0,
        [ToolCallDecision.AUTO_ACCEPT]: 4,
      },
      byName: {
        edit: { count: 6, success: 6, fail: 0, durationMs: 3000, decisions: { [ToolCallDecision.ACCEPT]: 3, [ToolCallDecision.REJECT]: 0, [ToolCallDecision.MODIFY]: 0, [ToolCallDecision.AUTO_ACCEPT]: 3 } },
        bash: { count: 4, success: 3, fail: 1, durationMs: 2000, decisions: { [ToolCallDecision.ACCEPT]: 2, [ToolCallDecision.REJECT]: 1, [ToolCallDecision.MODIFY]: 0, [ToolCallDecision.AUTO_ACCEPT]: 1 } },
      },
    },
    files: { totalLinesAdded: 50, totalLinesRemoved: 10 },
  };
}

describe('metricsToUsageRecord', () => {
  it('includes totalLatencyMs from all models', () => {
    const record = metricsToUsageRecord('s1', '/proj', 1000, 2000, makeMetrics());
    expect(record.totalLatencyMs).toBe(9500);
  });

  it('includes per-tool totalDurationMs in byName', () => {
    const record = metricsToUsageRecord('s1', '/proj', 1000, 2000, makeMetrics());
    expect(record.tools.byName['edit']!.totalDurationMs).toBe(3000);
    expect(record.tools.byName['bash']!.totalDurationMs).toBe(2000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/services/usageHistoryService.test.ts`
Expected: FAIL — `totalLatencyMs` is undefined, `totalDurationMs` missing from byName entries.

- [ ] **Step 3: Extend the interface and implementation**

In `packages/core/src/services/usageHistoryService.ts`, update `UsageSummaryRecord`:

```typescript
export interface UsageSummaryRecord {
  version: 1;
  sessionId: string;
  timestamp: number;
  startTime: number;
  project: string;
  durationMs: number;
  totalLatencyMs?: number;
  models: Record<
    string,
    {
      requests: number;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      thoughtsTokens: number;
      totalTokens: number;
    }
  >;
  tools: {
    totalCalls: number;
    totalSuccess: number;
    totalFail: number;
    byName: Record<string, { count: number; success: number; fail: number; totalDurationMs?: number }>;
  };
  files: {
    linesAdded: number;
    linesRemoved: number;
  };
}
```

Update `metricsToUsageRecord` to populate the new fields:

```typescript
export function metricsToUsageRecord(
  sessionId: string,
  project: string,
  startTime: number,
  endTime: number,
  metrics: SessionMetrics,
): UsageSummaryRecord {
  const models: UsageSummaryRecord['models'] = {};
  let totalLatencyMs = 0;
  for (const [name, m] of Object.entries(metrics.models)) {
    totalLatencyMs += m.api.totalLatencyMs;
    models[name] = {
      requests: m.api.totalRequests,
      inputTokens: m.tokens.prompt,
      outputTokens: m.tokens.candidates,
      cachedTokens: m.tokens.cached,
      thoughtsTokens: m.tokens.thoughts,
      totalTokens:
        m.tokens.total ||
        m.tokens.prompt + m.tokens.candidates + m.tokens.thoughts,
    };
  }
  const toolsByName: UsageSummaryRecord['tools']['byName'] = {};
  for (const [name, stats] of Object.entries(metrics.tools.byName)) {
    toolsByName[name] = {
      count: stats.count,
      success: stats.success,
      fail: stats.fail,
      totalDurationMs: stats.durationMs,
    };
  }
  return {
    version: 1,
    sessionId,
    timestamp: endTime,
    startTime,
    project,
    durationMs: endTime - startTime,
    totalLatencyMs,
    models,
    tools: {
      totalCalls: metrics.tools.totalCalls,
      totalSuccess: metrics.tools.totalSuccess,
      totalFail: metrics.tools.totalFail,
      byName: toolsByName,
    },
    files: {
      linesAdded: metrics.files.totalLinesAdded,
      linesRemoved: metrics.files.totalLinesRemoved,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run src/services/usageHistoryService.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/services/usageHistoryService.ts packages/core/src/services/usageHistoryService.test.ts
git commit -m "feat(stats): extend UsageSummaryRecord with latency and tool duration"
```

---

### Task 2: Add delta calculation and aggregation extensions

**Files:**
- Modify: `packages/core/src/services/usageHistoryService.ts:283-394` (aggregateUsage)
- Test: `packages/core/src/services/usageHistoryService.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/services/usageHistoryService.test.ts`:

```typescript
import { aggregateUsage, type UsageSummaryRecord, type TimeRange } from './usageHistoryService.js';

function makeRecord(overrides: Partial<UsageSummaryRecord> = {}): UsageSummaryRecord {
  return {
    version: 1,
    sessionId: 's1',
    timestamp: Date.now(),
    startTime: Date.now() - 60000,
    project: '/proj',
    durationMs: 60000,
    totalLatencyMs: 2000,
    models: {
      'qwen-max': {
        requests: 3,
        inputTokens: 1000,
        outputTokens: 500,
        cachedTokens: 800,
        thoughtsTokens: 0,
        totalTokens: 1500,
      },
    },
    tools: {
      totalCalls: 5,
      totalSuccess: 4,
      totalFail: 1,
      byName: {
        edit: { count: 3, success: 3, fail: 0, totalDurationMs: 1500 },
        bash: { count: 2, success: 1, fail: 1, totalDurationMs: 3000 },
      },
    },
    files: { linesAdded: 20, linesRemoved: 5 },
    ...overrides,
  };
}

describe('aggregateUsage', () => {
  it('includes totalLatencyMs in aggregated result', () => {
    const records = [makeRecord({ totalLatencyMs: 2000 }), makeRecord({ totalLatencyMs: 3000 })];
    const report = aggregateUsage(records, 'all');
    expect(report.totalLatencyMs).toBe(5000);
  });

  it('includes totalDurationMs per tool in topTools', () => {
    const records = [makeRecord()];
    const report = aggregateUsage(records, 'all');
    const editTool = report.tools.topTools.find((t) => t.name === 'edit');
    expect(editTool!.totalDurationMs).toBe(1500);
  });

  it('computes totalRequests in aggregated result', () => {
    const records = [makeRecord(), makeRecord()];
    const report = aggregateUsage(records, 'all');
    expect(report.totalRequests).toBe(6);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && npx vitest run src/services/usageHistoryService.test.ts`
Expected: FAIL — `totalLatencyMs`, `totalDurationMs` on topTools, and `totalRequests` don't exist on the report.

- [ ] **Step 3: Extend AggregatedReport and aggregateUsage**

Update `AggregatedReport` interface:

```typescript
export interface AggregatedReport {
  timeRange: TimeRange;
  periodStart: Date;
  periodEnd: Date;
  sessionCount: number;
  totalDurationMs: number;
  totalLatencyMs: number;
  totalRequests: number;
  models: Record<
    string,
    {
      requests: number;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      thoughtsTokens: number;
      totalTokens: number;
    }
  >;
  tools: {
    totalCalls: number;
    totalSuccess: number;
    totalFail: number;
    topTools: Array<{
      name: string;
      count: number;
      success: number;
      fail: number;
      totalDurationMs: number;
    }>;
  };
  files: {
    linesAdded: number;
    linesRemoved: number;
  };
  projects: Array<{
    path: string;
    sessionCount: number;
    totalDurationMs: number;
    totalInputTokens: number;
    totalOutputTokens: number;
  }>;
}
```

Update `aggregateUsage` function body — add accumulators:

```typescript
export function aggregateUsage(
  records: UsageSummaryRecord[],
  range: TimeRange,
): AggregatedReport {
  const { start, end } = getTimeRangeBounds(range);
  const filtered = records.filter((r) => {
    const ts = r.timestamp;
    return ts >= start.getTime() && ts <= end.getTime();
  });

  const models: AggregatedReport['models'] = {};
  let totalCalls = 0;
  let totalSuccess = 0;
  let totalFail = 0;
  let totalDurationMs = 0;
  let totalLatencyMs = 0;
  let totalRequests = 0;
  let linesAdded = 0;
  let linesRemoved = 0;
  const toolCounts = new Map<
    string,
    { count: number; success: number; fail: number; totalDurationMs: number }
  >();
  const projectMap = new Map<
    string,
    {
      sessionCount: number;
      totalDurationMs: number;
      totalInputTokens: number;
      totalOutputTokens: number;
    }
  >();

  for (const r of filtered) {
    totalDurationMs += r.durationMs;
    totalLatencyMs += r.totalLatencyMs ?? 0;
    totalCalls += r.tools.totalCalls;
    totalSuccess += r.tools.totalSuccess;
    totalFail += r.tools.totalFail;
    linesAdded += r.files.linesAdded;
    linesRemoved += r.files.linesRemoved;

    for (const [name, m] of Object.entries(r.models)) {
      totalRequests += m.requests;
      const existing = models[name];
      if (existing) {
        existing.requests += m.requests;
        existing.inputTokens += m.inputTokens;
        existing.outputTokens += m.outputTokens;
        existing.cachedTokens += m.cachedTokens;
        existing.thoughtsTokens += m.thoughtsTokens;
        existing.totalTokens += m.totalTokens;
      } else {
        models[name] = { ...m };
      }
    }

    for (const [name, stats] of Object.entries(r.tools.byName)) {
      const existing = toolCounts.get(name);
      if (existing) {
        existing.count += stats.count;
        existing.success += stats.success;
        existing.fail += stats.fail;
        existing.totalDurationMs += stats.totalDurationMs ?? 0;
      } else {
        toolCounts.set(name, {
          count: stats.count,
          success: stats.success,
          fail: stats.fail,
          totalDurationMs: stats.totalDurationMs ?? 0,
        });
      }
    }

    let sessionInput = 0;
    let sessionOutput = 0;
    for (const m of Object.values(r.models)) {
      sessionInput += m.inputTokens;
      sessionOutput += m.outputTokens;
    }
    const proj = projectMap.get(r.project);
    if (proj) {
      proj.sessionCount++;
      proj.totalDurationMs += r.durationMs;
      proj.totalInputTokens += sessionInput;
      proj.totalOutputTokens += sessionOutput;
    } else {
      projectMap.set(r.project, {
        sessionCount: 1,
        totalDurationMs: r.durationMs,
        totalInputTokens: sessionInput,
        totalOutputTokens: sessionOutput,
      });
    }
  }

  const topTools = [...toolCounts.entries()]
    .map(([name, stats]) => ({ name, ...stats }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const projects = [...projectMap.entries()]
    .map(([p, stats]) => ({ path: p, ...stats }))
    .sort(
      (a, b) =>
        b.totalInputTokens +
        b.totalOutputTokens -
        (a.totalInputTokens + a.totalOutputTokens),
    );

  return {
    timeRange: range,
    periodStart: start,
    periodEnd: end,
    sessionCount: filtered.length,
    totalDurationMs,
    totalLatencyMs,
    totalRequests,
    models,
    tools: { totalCalls, totalSuccess, totalFail, topTools },
    files: { linesAdded, linesRemoved },
    projects,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && npx vitest run src/services/usageHistoryService.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/services/usageHistoryService.ts packages/core/src/services/usageHistoryService.test.ts
git commit -m "feat(stats): add latency/duration/requests to aggregated report"
```

---

### Task 3: Add delta calculation to statsDataService

**Files:**
- Modify: `packages/cli/src/ui/utils/statsDataService.ts`
- Test: `packages/cli/src/ui/utils/statsDataService.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/ui/utils/statsDataService.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import type { UsageSummaryRecord } from '@qwen-code/qwen-code-core';

// Mock loadUsageHistory to return controlled data
vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...orig,
    loadUsageHistory: vi.fn(),
  };
});

import { loadUsageHistory } from '@qwen-code/qwen-code-core';
import { loadStatsData } from './statsDataService.js';

const mockedLoad = vi.mocked(loadUsageHistory);

function makeRecord(ts: number, tokens: number): UsageSummaryRecord {
  return {
    version: 1,
    sessionId: `s-${ts}`,
    timestamp: ts,
    startTime: ts - 60000,
    project: '/proj',
    durationMs: 60000,
    totalLatencyMs: 2000,
    models: {
      'qwen-max': {
        requests: 2,
        inputTokens: tokens,
        outputTokens: tokens / 2,
        cachedTokens: tokens * 0.8,
        thoughtsTokens: 0,
        totalTokens: tokens * 1.5,
      },
    },
    tools: {
      totalCalls: 5,
      totalSuccess: 4,
      totalFail: 1,
      byName: { edit: { count: 5, success: 4, fail: 1, totalDurationMs: 1000 } },
    },
    files: { linesAdded: 10, linesRemoved: 5 },
  };
}

describe('loadStatsData delta', () => {
  it('computes delta for week range', async () => {
    const now = Date.now();
    const inThisWeek = now - 2 * 24 * 60 * 60 * 1000;
    const inPrevWeek = now - 10 * 24 * 60 * 60 * 1000;
    mockedLoad.mockResolvedValue([
      makeRecord(inThisWeek, 1000),
      makeRecord(inPrevWeek, 500),
    ]);
    const data = await loadStatsData('week');
    expect(data.delta).toBeDefined();
    expect(data.delta!.tokens).toBeGreaterThan(0);
  });

  it('returns no delta for all range', async () => {
    mockedLoad.mockResolvedValue([makeRecord(Date.now(), 1000)]);
    const data = await loadStatsData('all');
    expect(data.delta).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && npx vitest run src/ui/utils/statsDataService.test.ts`
Expected: FAIL — `delta` property doesn't exist on StatsData.

- [ ] **Step 3: Extend StatsData and implement delta calculation**

Update `packages/cli/src/ui/utils/statsDataService.ts`:

Add to `StatsData` interface:

```typescript
export interface StatsData {
  report: AggregatedReport;
  heatmap: Record<string, number>;
  currentStreak: number;
  longestStreak: number;
  activeDays: number;
  totalDays: number;
  mostActiveDay: { date: string; count: number } | null;
  longestSession: { durationMs: number; date: string } | null;
  favoriteModel: string | null;
  tokensPerDay: Array<{ date: string; model: string; tokens: number }>;
  delta: {
    sessions: number | null;
    duration: number | null;
    tokens: number | null;
    cacheRate: number | null;
    toolSuccess: number | null;
    avgLatency: number | null;
  } | null;
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

Add a helper function for delta:

```typescript
function computeDelta(
  current: AggregatedReport,
  previous: AggregatedReport,
): StatsData['delta'] {
  const pctChange = (cur: number, prev: number): number | null => {
    if (prev === 0) return cur > 0 ? 100 : null;
    return ((cur - prev) / prev) * 100;
  };

  let curTokens = 0, prevTokens = 0;
  let curInput = 0, prevInput = 0;
  let curCached = 0, prevCached = 0;
  for (const m of Object.values(current.models)) {
    curTokens += m.totalTokens;
    curInput += m.inputTokens;
    curCached += m.cachedTokens;
  }
  for (const m of Object.values(previous.models)) {
    prevTokens += m.totalTokens;
    prevInput += m.inputTokens;
    prevCached += m.cachedTokens;
  }

  const curCacheRate = curInput > 0 ? (curCached / curInput) * 100 : 0;
  const prevCacheRate = prevInput > 0 ? (prevCached / prevInput) * 100 : 0;
  const curToolSuccess = current.tools.totalCalls > 0
    ? (current.tools.totalSuccess / current.tools.totalCalls) * 100 : 0;
  const prevToolSuccess = previous.tools.totalCalls > 0
    ? (previous.tools.totalSuccess / previous.tools.totalCalls) * 100 : 0;
  const curLatency = current.totalRequests > 0
    ? current.totalLatencyMs / current.totalRequests : null;
  const prevLatency = previous.totalRequests > 0
    ? previous.totalLatencyMs / previous.totalRequests : null;

  return {
    sessions: pctChange(current.sessionCount, previous.sessionCount),
    duration: pctChange(current.totalDurationMs, previous.totalDurationMs),
    tokens: pctChange(curTokens, prevTokens),
    cacheRate: curCacheRate - prevCacheRate,
    toolSuccess: curToolSuccess - prevToolSuccess,
    avgLatency: curLatency !== null && prevLatency !== null
      ? curLatency - prevLatency : null,
  };
}
```

Add a helper to get previous range bounds:

```typescript
function getPreviousRangeBounds(range: TimeRange): { start: Date; end: Date } | null {
  if (range === 'all') return null;
  const { start, end } = getTimeRangeBounds(range);
  const durationMs = end.getTime() - start.getTime();
  return {
    start: new Date(start.getTime() - durationMs),
    end: new Date(start.getTime()),
  };
}
```

Update `loadStatsData` to compute delta, efficiency, and toolLeaderboard:

```typescript
export async function loadStatsData(
  range: TimeRange,
  currentSession?: UsageSummaryRecord,
): Promise<StatsData> {
  const persisted = await loadUsageHistory();
  const records = currentSession ? [...persisted, currentSession] : persisted;
  const report = aggregateUsage(records, range);
  const { start, end } = getTimeRangeBounds(range);

  // Delta
  let delta: StatsData['delta'] = null;
  const prevBounds = getPreviousRangeBounds(range);
  if (prevBounds) {
    const prevFiltered = records.filter(
      (r) => r.timestamp >= prevBounds.start.getTime() && r.timestamp < prevBounds.end.getTime(),
    );
    const prevReport = aggregateUsage(prevFiltered, 'all');
    delta = computeDelta(report, prevReport);
  }

  // Efficiency
  let totalInput = 0, totalCached = 0;
  for (const m of Object.values(report.models)) {
    totalInput += m.inputTokens;
    totalCached += m.cachedTokens;
  }
  const efficiency: StatsData['efficiency'] = {
    cacheHitRate: totalInput > 0 ? (totalCached / totalInput) * 100 : 0,
    toolSuccessRate: report.tools.totalCalls > 0
      ? (report.tools.totalSuccess / report.tools.totalCalls) * 100 : 0,
    avgLatencyMs: report.totalRequests > 0
      ? report.totalLatencyMs / report.totalRequests : null,
  };

  // Tool leaderboard
  const toolLeaderboard = report.tools.topTools.slice(0, 8).map((t) => ({
    name: t.name,
    count: t.count,
    totalDurationMs: t.totalDurationMs,
    successRate: t.count > 0 ? (t.success / t.count) * 100 : 0,
  }));

  // ... rest of existing code (heatmap, streaks, etc.) ...

  const filtered = records.filter(
    (r) => r.timestamp >= start.getTime() && r.timestamp <= end.getTime(),
  );
  const heatmap = buildHeatmap(records, start, end);
  const heatmapDates = Object.keys(heatmap);
  const { currentStreak, longestStreak } = calculateStreaks(heatmapDates);

  const firstDate = heatmapDates.sort()[0];
  const activeDays = heatmapDates.length;
  let totalDays = 0;
  if (firstDate) {
    totalDays = Math.max(
      1,
      Math.ceil(
        (end.getTime() - new Date(firstDate).getTime()) / (1000 * 60 * 60 * 24),
      ) + 1,
    );
  }

  let mostActiveDay: StatsData['mostActiveDay'] = null;
  for (const [date, count] of Object.entries(heatmap)) {
    if (!mostActiveDay || count > mostActiveDay.count) {
      mostActiveDay = { date, count };
    }
  }

  let longestSession: StatsData['longestSession'] = null;
  for (const r of filtered) {
    if (!longestSession || r.durationMs > longestSession.durationMs) {
      longestSession = {
        durationMs: r.durationMs,
        date: new Date(r.timestamp).toISOString().split('T')[0]!,
      };
    }
  }

  let favoriteModel: string | null = null;
  let maxTokens = 0;
  for (const [name, m] of Object.entries(report.models)) {
    if (m.totalTokens > maxTokens) {
      maxTokens = m.totalTokens;
      favoriteModel = name;
    }
  }

  const tokensPerDay = buildTokensPerDay(records, start, end);

  return {
    report,
    heatmap,
    currentStreak,
    longestStreak,
    activeDays,
    totalDays,
    mostActiveDay,
    longestSession,
    favoriteModel,
    tokensPerDay,
    delta,
    efficiency,
    toolLeaderboard,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/cli && npx vitest run src/ui/utils/statsDataService.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/ui/utils/statsDataService.ts packages/cli/src/ui/utils/statsDataService.test.ts
git commit -m "feat(stats): add delta calculation, efficiency metrics, tool leaderboard to StatsData"
```

---

### Task 4: Change heatmap to token-based with today highlight

**Files:**
- Modify: `packages/cli/src/ui/utils/statsDataService.ts:69-82` (buildHeatmap)
- Modify: `packages/cli/src/ui/utils/asciiCharts.ts` (HeatmapCell interface + buildHeatmapData)

- [ ] **Step 1: Change buildHeatmap to sum tokens instead of counting sessions**

In `packages/cli/src/ui/utils/statsDataService.ts`, update `buildHeatmap`:

```typescript
function buildHeatmap(
  records: UsageSummaryRecord[],
  start: Date,
  end: Date,
): Record<string, number> {
  const heatmap: Record<string, number> = {};
  for (const r of records) {
    if (r.timestamp < start.getTime() || r.timestamp > end.getTime()) continue;
    const ts = new Date(r.timestamp);
    const key = `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, '0')}-${String(ts.getDate()).padStart(2, '0')}`;
    let totalTokens = 0;
    for (const m of Object.values(r.models)) {
      totalTokens += m.totalTokens || m.inputTokens + m.outputTokens;
    }
    heatmap[key] = (heatmap[key] || 0) + totalTokens;
  }
  return heatmap;
}
```

- [ ] **Step 2: Add `isToday` flag to HeatmapCell**

In `packages/cli/src/ui/utils/asciiCharts.ts`, update the interface:

```typescript
export interface HeatmapCell {
  char: string;
  intensity: HeatmapIntensity;
  isToday?: boolean;
}
```

In `buildHeatmapData`, after computing each cell, mark today:

```typescript
// Inside the while loop, after creating the cell:
const todayKey = formatDateKey(new Date());
// ...
const isToday = key === todayKey;
grid[row]!.push({ char: HEATMAP_CHARS[level]!, intensity: level, isToday });
```

- [ ] **Step 3: Render today's cell distinctly in StatsDialog.tsx**

In `StatsDialog.tsx`, inside the `HeatmapView` component's cell render:

```typescript
{row.cells.map((cell, ci) => (
  <Text
    key={ci}
    backgroundColor={HEATMAP_COLORS[cell.intensity]}
    bold={cell.isToday}
    underline={cell.isToday}
  >
    {cell.isToday ? '▪▪' : cell.char}
  </Text>
))}
```

- [ ] **Step 4: Verify visually by running `npm run dev` and opening `/stats`**

Run: `npm run dev` then type `/stats` and switch to Activity tab.
Expected: Heatmap shows token-based intensity, today's cell has `▪▪` marker with bold+underline.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/ui/utils/statsDataService.ts packages/cli/src/ui/utils/asciiCharts.ts packages/cli/src/ui/components/StatsDialog.tsx
git commit -m "feat(stats): token-based heatmap with today highlight"
```

---

### Task 5: Add 'today' to TimeRange and update range cycle

**Files:**
- Modify: `packages/core/src/services/usageHistoryService.ts:46,253-281`
- Modify: `packages/cli/src/ui/components/StatsDialog.tsx:34`

- [ ] **Step 1: Verify 'today' is already in the TimeRange type**

Check that `type TimeRange = 'today' | 'week' | 'month' | 'all'` already exists (added in current code at line 46). It does. The `getTimeRangeBounds` function already handles the `'today'` case.

- [ ] **Step 2: Update RANGE_CYCLE in StatsDialog.tsx**

```typescript
const RANGE_CYCLE: TimeRange[] = ['today', 'week', 'month', 'all'];
```

Update `getRangeLabel`:

```typescript
function getRangeLabel(range: string): string {
  const labels: Record<string, string> = {
    today: t('Today'),
    all: t('All time'),
    week: t('Last 7 days'),
    month: t('Last 30 days'),
  };
  return labels[range] ?? range;
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/ui/components/StatsDialog.tsx
git commit -m "feat(stats): add 'today' to range cycle"
```

---

### Task 6: Implement ActivityTab component

**Files:**
- Modify: `packages/cli/src/ui/components/StatsDialog.tsx`

- [ ] **Step 1: Replace OverviewTab with ActivityTab**

Remove the entire `OverviewTab` component and replace with `ActivityTab`:

```typescript
const ActivityTab: React.FC<{
  data: StatsData;
  bodyWidth: number;
  chartMonthOffset: number;
  range: TimeRange;
}> = ({ data, bodyWidth, chartMonthOffset, range }) => {
  const heatmapWeeks = Math.min(
    26,
    Math.max(8, Math.floor((bodyWidth - 4) / 2)),
  );
  const col1Width = Math.floor(bodyWidth / 3);

  let totalTokens = 0;
  for (const m of Object.values(data.report.models)) {
    totalTokens += m.totalTokens;
  }

  const dailyTotals = new Map<string, number>();
  for (const d of data.tokensPerDay) {
    dailyTotals.set(d.date, (dailyTotals.get(d.date) || 0) + d.tokens);
  }
  const allDates = [...dailyTotals.keys()].sort();
  const availableMonths = [...new Set(allDates.map((d) => d.slice(0, 7)))]
    .sort()
    .reverse();
  const clampedOffset = Math.min(
    chartMonthOffset,
    Math.max(0, availableMonths.length - 1),
  );
  const chartMonth =
    range === 'all' && availableMonths.length > 0
      ? availableMonths[clampedOffset]!
      : null;
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const chartMonthLabel = chartMonth
    ? `${monthNames[Number(chartMonth.slice(5, 7)) - 1]} ${chartMonth.slice(0, 4)}`
    : null;
  const canGoLeft = clampedOffset < availableMonths.length - 1;
  const canGoRight = clampedOffset > 0;
  const filteredData = chartMonth
    ? [...dailyTotals.entries()].filter(([d]) => d.startsWith(chartMonth))
    : [...dailyTotals.entries()];
  const totalSeries = [
    { label: t('Total'), data: filteredData.map(([date, value]) => ({ date, value })) },
  ];
  const overviewChart = buildLineChartData(totalSeries, bodyWidth, 6);

  return (
    <Box flexDirection="column">
      {/* KPI Row */}
      <Box flexDirection="row" marginBottom={1}>
        <Box width={col1Width}>
          <Text color={theme.text.secondary}>{t('Sessions')} </Text>
          <Text bold color={theme.text.primary}>{data.report.sessionCount}</Text>
          {data.delta?.sessions != null && (
            <Text color={data.delta.sessions >= 0 ? theme.status.success : theme.status.error}>
              {' '}{data.delta.sessions >= 0 ? '▲' : '▼'}{Math.abs(data.delta.sessions).toFixed(0)}%
            </Text>
          )}
        </Box>
        <Box width={col1Width}>
          <Text color={theme.text.secondary}>{t('Duration')} </Text>
          <Text bold color={theme.text.primary}>{fmtDurationShort(data.report.totalDurationMs)}</Text>
          {data.delta?.duration != null && (
            <Text color={data.delta.duration >= 0 ? theme.status.success : theme.status.error}>
              {' '}{data.delta.duration >= 0 ? '▲' : '▼'}{Math.abs(data.delta.duration).toFixed(0)}%
            </Text>
          )}
        </Box>
        <Box>
          <Text color={theme.text.secondary}>{t('Tokens')} </Text>
          <Text bold color={theme.status.warning}>{fmtTokens(totalTokens)}</Text>
          {data.delta?.tokens != null && (
            <Text color={data.delta.tokens >= 0 ? theme.status.success : theme.status.error}>
              {' '}{data.delta.tokens >= 0 ? '▲' : '▼'}{Math.abs(data.delta.tokens).toFixed(0)}%
            </Text>
          )}
        </Box>
      </Box>

      {/* Heatmap */}
      <Box>
        <HeatmapView data={data} weeks={heatmapWeeks} monthOffset={clampedOffset} />
        <Box marginLeft={2} flexDirection="column">
          <Box>
            <Text color={theme.text.secondary}>{t('streak')}: </Text>
            <Text color={theme.status.success} bold>{data.currentStreak}d</Text>
          </Box>
          <Box>
            <Text color={theme.text.secondary}>{t('best')}: </Text>
            <Text color={theme.status.warning} bold>{data.longestStreak}d</Text>
          </Box>
        </Box>
      </Box>

      {/* Token Trend */}
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text bold color={theme.text.primary}>{t('Token Trend')}</Text>
          {chartMonthLabel && (
            <Text color={theme.text.accent}>
              {'  '}{canGoLeft ? '← ' : '  '}{chartMonthLabel}{canGoRight ? ' →' : ''}
            </Text>
          )}
        </Box>
        {overviewChart ? (
          <>
            {overviewChart.rows.map((row, ri) => (
              <Box key={ri}>
                <Text color={theme.text.secondary}>{row.yLabel}{row.border}</Text>
                {row.cells.map((cell, ci) => (
                  <Text key={ci} color={cell.seriesIndex >= 0 ? theme.text.accent : theme.text.secondary}>
                    {cell.char}
                  </Text>
                ))}
              </Box>
            ))}
            <Box>
              <Text color={theme.text.secondary}>{overviewChart.xAxisRow.yLabel}{overviewChart.xAxisRow.border}</Text>
              {overviewChart.xAxisRow.cells.map((cell, ci) => (
                <Text key={ci} color={theme.text.secondary}>{cell.char}</Text>
              ))}
            </Box>
            <Box>
              <Text color={theme.text.secondary}>{overviewChart.xLabelRow.yLabel}{overviewChart.xLabelRow.border}</Text>
              {overviewChart.xLabelRow.cells.map((cell, ci) => (
                <Text key={ci} color={theme.text.secondary}>{cell.char}</Text>
              ))}
            </Box>
          </>
        ) : (
          <Text color={theme.text.secondary}>{'  '}{t('(no data)')}</Text>
        )}
      </Box>

      {/* Project Ranking */}
      {data.report.projects.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={theme.text.primary}>{t('Projects')}</Text>
          <TableRow cells={[
            { text: '  ' + t('Project'), width: 22, color: theme.text.secondary },
            { text: t('Sessions'), width: 10, color: theme.text.secondary },
            { text: t('Tokens'), width: 10, color: theme.text.secondary },
            { text: t('Duration'), width: 10, color: theme.text.secondary },
          ]} />
          {data.report.projects.slice(0, 5).map((proj) => {
            const name = proj.path.split('/').pop() || proj.path;
            const tokens = proj.totalInputTokens + proj.totalOutputTokens;
            return (
              <TableRow key={proj.path} cells={[
                { text: '  ' + name.slice(0, 18), width: 22, color: theme.text.primary },
                { text: String(proj.sessionCount), width: 10, color: theme.text.primary },
                { text: fmtTokens(tokens), width: 10, color: theme.status.warning },
                { text: fmtDurationShort(proj.totalDurationMs), width: 10, color: theme.text.secondary },
              ]} />
            );
          })}
        </Box>
      )}
    </Box>
  );
};
```

- [ ] **Step 2: Update tab references in StatsDialog render**

Replace `activeTab === 'overview'` with `activeTab === 'activity'` and update props to pass the new `ActivityTab` component. Update `TAB_DEFS`:

```typescript
type StatsTab = 'session' | 'activity' | 'efficiency';

const TAB_DEFS: Array<{ tab: StatsTab; label: () => string }> = [
  { tab: 'session', label: () => t('Session') },
  { tab: 'activity', label: () => t('Activity') },
  { tab: 'efficiency', label: () => t('Efficiency') },
];
```

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/ui/components/StatsDialog.tsx
git commit -m "feat(stats): implement ActivityTab with KPI deltas, heatmap, trend, projects"
```

---

### Task 7: Implement EfficiencyTab component

**Files:**
- Modify: `packages/cli/src/ui/components/StatsDialog.tsx`

- [ ] **Step 1: Replace ModelsTab with EfficiencyTab**

Remove the `ModelsTab` and `ChartView` components. Add `EfficiencyTab`:

```typescript
function fmtSuccessBar(rate: number): string {
  const filled = Math.round(rate / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

function getSuccessColor(rate: number): string {
  if (rate >= 95) return theme.status.success;
  if (rate >= 80) return theme.status.warning;
  return theme.status.error;
}

function getCacheColor(rate: number): string {
  if (rate >= 85) return theme.status.success;
  if (rate >= 70) return theme.status.warning;
  return theme.status.error;
}

const EfficiencyTab: React.FC<{
  data: StatsData;
  bodyWidth: number;
}> = ({ data, bodyWidth }) => {
  const cardWidth = Math.floor((bodyWidth - 4) / 3);

  const modelEntries = Object.entries(data.report.models).sort(
    (a, b) => b[1].totalTokens - a[1].totalTokens,
  );

  return (
    <Box flexDirection="column">
      {/* Performance Cards */}
      <Box flexDirection="row" marginBottom={1}>
        <Box width={cardWidth} flexDirection="column" borderStyle="single" borderColor={theme.border.default} paddingX={1}>
          <Text color={theme.text.secondary}>{t('Cache Hit Rate')}</Text>
          <Text bold color={getCacheColor(data.efficiency.cacheHitRate)}>
            {data.efficiency.cacheHitRate.toFixed(1)}%
          </Text>
          {data.delta?.cacheRate != null && (
            <Text color={data.delta.cacheRate >= 0 ? theme.status.success : theme.status.error}>
              {data.delta.cacheRate >= 0 ? '▲' : '▼'} {Math.abs(data.delta.cacheRate).toFixed(1)}%
            </Text>
          )}
        </Box>
        <Box width={cardWidth} flexDirection="column" borderStyle="single" borderColor={theme.border.default} paddingX={1} marginLeft={1}>
          <Text color={theme.text.secondary}>{t('Tool Success')}</Text>
          <Text bold color={getSuccessColor(data.efficiency.toolSuccessRate)}>
            {data.efficiency.toolSuccessRate.toFixed(1)}%
          </Text>
          {data.delta?.toolSuccess != null && (
            <Text color={data.delta.toolSuccess >= 0 ? theme.status.success : theme.status.error}>
              {data.delta.toolSuccess >= 0 ? '▲' : '▼'} {Math.abs(data.delta.toolSuccess).toFixed(1)}%
            </Text>
          )}
        </Box>
        <Box width={cardWidth} flexDirection="column" borderStyle="single" borderColor={theme.border.default} paddingX={1} marginLeft={1}>
          <Text color={theme.text.secondary}>{t('Avg Latency')}</Text>
          <Text bold color={theme.text.accent}>
            {data.efficiency.avgLatencyMs != null
              ? `${(data.efficiency.avgLatencyMs / 1000).toFixed(1)}s`
              : '—'}
          </Text>
          {data.delta?.avgLatency != null && (
            <Text color={data.delta.avgLatency <= 0 ? theme.status.success : theme.status.error}>
              {data.delta.avgLatency <= 0 ? '▲' : '▼'} {Math.abs(data.delta.avgLatency / 1000).toFixed(1)}s
            </Text>
          )}
        </Box>
      </Box>

      {/* Tool Leaderboard */}
      {data.toolLeaderboard.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={theme.text.primary}>{t('Tool Leaderboard')}</Text>
          <TableRow cells={[
            { text: '  ' + t('Tool'), width: 12, color: theme.text.secondary },
            { text: t('Calls'), width: 8, color: theme.text.secondary },
            { text: t('Time'), width: 9, color: theme.text.secondary },
            { text: t('Success'), width: 20, color: theme.text.secondary },
          ]} />
          {data.toolLeaderboard.map((tool) => (
            <TableRow key={tool.name} cells={[
              { text: '  ' + tool.name.slice(0, 10), width: 12, color: theme.text.accent },
              { text: String(tool.count), width: 8, color: theme.text.primary },
              { text: `${(tool.totalDurationMs / 1000).toFixed(1)}s`, width: 9, color: theme.text.secondary },
              { text: `${fmtSuccessBar(tool.successRate)} ${tool.successRate.toFixed(0)}%`, width: 20, color: getSuccessColor(tool.successRate) },
            ]} />
          ))}
        </Box>
      )}

      {/* Model Comparison */}
      {modelEntries.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={theme.text.primary}>{t('Models')}</Text>
          <TableRow cells={[
            { text: '  ' + t('Model'), width: 20, color: theme.text.secondary },
            { text: t('Reqs'), width: 7, color: theme.text.secondary },
            { text: 'In/Out', width: 14, color: theme.text.secondary },
            { text: t('Cache'), width: 7, color: theme.text.secondary },
            { text: t('Latency'), width: 8, color: theme.text.secondary },
          ]} />
          {modelEntries.map(([name, m], i) => {
            const cacheRate = m.inputTokens > 0 ? (m.cachedTokens / m.inputTokens) * 100 : 0;
            const latency = data.report.totalLatencyMs > 0 && m.requests > 0
              ? `${((data.report.totalLatencyMs / data.report.totalRequests) / 1000).toFixed(1)}s`
              : '—';
            return (
              <TableRow key={name} cells={[
                { text: `● ${name.slice(0, 17)}`, width: 20, color: SERIES_COLORS[i % SERIES_COLORS.length] },
                { text: String(m.requests), width: 7, color: theme.text.primary },
                { text: `${fmtTokens(m.inputTokens)}/${fmtTokens(m.outputTokens)}`, width: 14, color: theme.text.primary },
                { text: `${cacheRate.toFixed(0)}%`, width: 7, color: getCacheColor(cacheRate) },
                { text: latency, width: 8, color: theme.text.accent },
              ]} />
            );
          })}
        </Box>
      )}

      {/* Code Impact */}
      {(data.report.files.linesAdded > 0 || data.report.files.linesRemoved > 0) && (
        <Box>
          <Text bold color={theme.text.primary}>{t('Code Impact')}  </Text>
          <Text color={theme.status.success}>+{data.report.files.linesAdded.toLocaleString()}</Text>
          <Text color={theme.text.primary}> / </Text>
          <Text color={theme.status.error}>-{data.report.files.linesRemoved.toLocaleString()}</Text>
          <Text color={theme.text.secondary}>  {t('net')}: </Text>
          <Text color={theme.status.success}>
            +{(data.report.files.linesAdded - data.report.files.linesRemoved).toLocaleString()}
          </Text>
        </Box>
      )}
    </Box>
  );
};
```

- [ ] **Step 2: Wire EfficiencyTab into the main render**

In the `StatsDialog` render body, replace `activeTab === 'models'` with:

```typescript
{activeTab === 'efficiency' && !loading && data && (
  <EfficiencyTab data={data} bodyWidth={bodyWidth} />
)}
```

Remove the `chartFilter` state and the `e` key handler (no longer needed).

Update the hints text:

```typescript
{activeTab === 'session'
  ? t('tab · esc')
  : t('tab · r dates · ←→ month · esc')}
```

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/ui/components/StatsDialog.tsx
git commit -m "feat(stats): implement EfficiencyTab with perf cards, tool leaderboard, models"
```

---

### Task 8: Add i18n keys

**Files:**
- Modify: `packages/cli/src/i18n/mustTranslateKeys.ts`

- [ ] **Step 1: Add new translation keys**

Add the new keys to the must-translate list (the `t()` function uses the key itself as the English fallback, so no separate English file is needed):

```typescript
// In mustTranslateKeys.ts, add to the array:
'Activity',
'Efficiency',
'Today',
'Cache Hit Rate',
'Tool Success',
'Avg Latency',
'Tool Leaderboard',
'Calls',
'Time',
'Reqs',
'Cache',
'Latency',
'Code Impact',
'net',
'streak',
'best',
'Token Trend',
```

- [ ] **Step 2: Run the i18n tests**

Run: `cd packages/cli && npx vitest run src/i18n/`
Expected: PASS (or check what the test expects — may need to update snapshot)

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/i18n/mustTranslateKeys.ts
git commit -m "feat(stats): add i18n keys for new dashboard tabs"
```

---

### Task 9: Clean up unused code and verify

**Files:**
- Modify: `packages/cli/src/ui/components/StatsDialog.tsx`

- [ ] **Step 1: Remove dead code**

Remove the `ChartView` component (was only used by ModelsTab). Remove `ModelStatsDisplay` import if present. Remove unused `chartFilter` state variable and related key handlers.

- [ ] **Step 2: Run typecheck**

Run: `cd packages/cli && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Run existing tests**

Run: `cd packages/cli && npx vitest run`
Expected: All pass (fix any snapshot updates with `--update` if needed).

- [ ] **Step 4: Visual verification**

Run: `npm run dev`, then type `/stats`:
- Verify Session tab unchanged
- Verify Activity tab shows KPI row with deltas, token heatmap with today highlight, sparkline, projects
- Verify Efficiency tab shows performance cards, tool leaderboard with bars, model table, code impact
- Verify `r` cycles through today/week/month/all
- Verify ←→ navigates months in chart

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/ui/components/StatsDialog.tsx
git commit -m "refactor(stats): remove dead ChartView/ModelsTab code"
```
