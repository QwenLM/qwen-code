/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadUsageDashboard } from './usage-dashboard-service.js';
import type { UsageSummaryRecord } from './usageHistoryService.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface ModelTokens {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  thoughtsTokens: number;
  totalTokens: number;
  totalLatencyMs: number;
}

function rec(o: {
  sessionId: string;
  timestamp: number;
  project?: string;
  modelName?: string;
  model?: Partial<ModelTokens>;
  tools?: Partial<UsageSummaryRecord['tools']>;
  files?: { linesAdded: number; linesRemoved: number };
  skills?: UsageSummaryRecord['skills'];
}): UsageSummaryRecord {
  const m: ModelTokens = {
    requests: 1,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    thoughtsTokens: 0,
    totalTokens: 0,
    totalLatencyMs: 0,
    ...o.model,
  };
  return {
    version: 1,
    sessionId: o.sessionId,
    timestamp: o.timestamp,
    startTime: o.timestamp,
    project: o.project ?? '/project',
    durationMs: 0,
    totalLatencyMs: m.totalLatencyMs,
    models: { [o.modelName ?? 'qwen-max']: m },
    tools: {
      totalCalls: 0,
      totalSuccess: 0,
      totalFail: 0,
      byName: {},
      ...o.tools,
    },
    files: o.files ?? { linesAdded: 0, linesRemoved: 0 },
    ...(o.skills ? { skills: o.skills } : {}),
  };
}

/** Same local-date bucketing the service uses, so key assertions line up. */
function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

describe('loadUsageDashboard', () => {
  let tmpHome: string;
  let originalQwenHome: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-usage-dashboard-'));
    originalQwenHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = path.join(tmpHome, '.qwen');
    fs.mkdirSync(process.env['QWEN_HOME'], { recursive: true });
  });

  afterEach(() => {
    if (originalQwenHome === undefined) delete process.env['QWEN_HOME'];
    else process.env['QWEN_HOME'] = originalQwenHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function seed(records: UsageSummaryRecord[]): void {
    const file = path.join(process.env['QWEN_HOME']!, 'usage_record.jsonl');
    fs.writeFileSync(
      file,
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf8',
    );
  }

  it('flattens today totals across all sessions active today', async () => {
    const now = Date.now();
    seed([
      rec({
        sessionId: 'a',
        timestamp: now,
        model: {
          requests: 5,
          inputTokens: 1000,
          outputTokens: 200,
          cachedTokens: 960,
          thoughtsTokens: 50,
          totalTokens: 1250,
        },
        tools: { totalCalls: 10, totalSuccess: 8, totalFail: 2 },
        files: { linesAdded: 30, linesRemoved: 5 },
      }),
      rec({
        sessionId: 'b',
        timestamp: now,
        model: {
          requests: 3,
          inputTokens: 2000,
          outputTokens: 100,
          cachedTokens: 1800,
          thoughtsTokens: 0,
          totalTokens: 2100,
        },
        tools: { totalCalls: 4, totalSuccess: 4, totalFail: 0 },
        files: { linesAdded: 10, linesRemoved: 2 },
      }),
      // Yesterday's session must NOT count toward "today".
      rec({
        sessionId: 'c',
        timestamp: now - 1 * MS_PER_DAY,
        model: { totalTokens: 9999, inputTokens: 9999 },
      }),
    ]);

    const dash = await loadUsageDashboard();

    expect(dash.summary.sessions).toBe(2);
    expect(dash.summary.requests).toBe(8);
    expect(dash.summary.inputTokens).toBe(3000);
    expect(dash.summary.outputTokens).toBe(300);
    expect(dash.summary.cachedTokens).toBe(2760);
    expect(dash.summary.thoughtsTokens).toBe(50);
    expect(dash.summary.totalTokens).toBe(3350);
    expect(dash.summary.toolCalls).toBe(14);
    expect(dash.summary.linesAdded).toBe(40);
    expect(dash.summary.linesRemoved).toBe(7);
    expect(dash.summary.cacheReadRate).toBeCloseTo(2760 / 3000, 6);
  });

  it('scopes summary totals to the selected range (today / week / month)', async () => {
    const now = Date.now();
    seed([
      rec({
        sessionId: 'd0',
        timestamp: now,
        model: { totalTokens: 100, inputTokens: 100 },
      }),
      rec({
        sessionId: 'd5',
        timestamp: now - 5 * MS_PER_DAY,
        model: { totalTokens: 200, inputTokens: 200 },
      }),
      rec({
        sessionId: 'd20',
        timestamp: now - 20 * MS_PER_DAY,
        model: { totalTokens: 400, inputTokens: 400 },
      }),
    ]);

    const today = await loadUsageDashboard({ range: 'today' });
    expect(today.range).toBe('today');
    expect(today.summary.sessions).toBe(1);
    expect(today.summary.totalTokens).toBe(100);

    const week = await loadUsageDashboard({ range: 'week' });
    expect(week.range).toBe('week');
    expect(week.summary.sessions).toBe(2); // today + 5 days ago
    expect(week.summary.totalTokens).toBe(300);

    const month = await loadUsageDashboard({ range: 'month' });
    expect(month.range).toBe('month');
    expect(month.summary.sessions).toBe(3); // + 20 days ago
    expect(month.summary.totalTokens).toBe(700);

    // The heatmap window is independent of the summary range.
    expect(today.heatmap).toEqual(week.heatmap);
    expect(week.heatmap).toEqual(month.heatmap);
  });

  it('ranks per-model share and aggregates skills for the range', async () => {
    const now = Date.now();
    seed([
      rec({
        sessionId: 'a',
        timestamp: now,
        modelName: 'gpt-5.5',
        model: { inputTokens: 1000, cachedTokens: 920, totalTokens: 4000 },
        skills: {
          totalCalls: 3,
          totalSuccess: 3,
          totalFail: 0,
          byName: {
            qreview: { count: 2, success: 2, fail: 0 },
            simplify: { count: 1, success: 1, fail: 0 },
          },
        },
      }),
      rec({
        sessionId: 'b',
        timestamp: now,
        modelName: 'claude-opus-4-8',
        model: { inputTokens: 500, cachedTokens: 490, totalTokens: 1000 },
        skills: {
          totalCalls: 1,
          totalSuccess: 1,
          totalFail: 0,
          byName: { qreview: { count: 1, success: 1, fail: 0 } },
        },
      }),
    ]);

    const dash = await loadUsageDashboard({ range: 'today' });

    // Models sorted by tokens desc, with share + cache-read rate.
    expect(dash.models.map((m) => m.model)).toEqual([
      'gpt-5.5',
      'claude-opus-4-8',
    ]);
    expect(dash.models[0]!.totalTokens).toBe(4000);
    expect(dash.models[0]!.share).toBeCloseTo(4000 / 5000, 6);
    expect(dash.models[0]!.cacheReadRate).toBeCloseTo(920 / 1000, 6);
    expect(dash.models[1]!.share).toBeCloseTo(1000 / 5000, 6);

    // Skills aggregated across sessions, sorted by count desc.
    expect(dash.skills).toEqual([
      { name: 'qreview', count: 3 },
      { name: 'simplify', count: 1 },
    ]);
  });

  it('builds a continuous per-day series over the range window', async () => {
    const now = Date.now();
    seed([
      rec({ sessionId: 't1', timestamp: now, model: { totalTokens: 100 } }),
      rec({ sessionId: 't2', timestamp: now, model: { totalTokens: 50 } }),
      rec({
        sessionId: 'd3',
        timestamp: now - 3 * MS_PER_DAY,
        model: { totalTokens: 200 },
      }),
    ]);

    const dash = await loadUsageDashboard({ range: 'week' });
    // Continuous axis (zero-filled), ending today.
    const last = dash.daily[dash.daily.length - 1]!;
    expect(last.date).toBe(dayKey(now));
    expect(last.tokens).toBe(150); // two sessions today
    expect(last.sessions).toBe(2);
    const d3 = dash.daily.find((p) => p.date === dayKey(now - 3 * MS_PER_DAY));
    expect(d3?.tokens).toBe(200);
    expect(d3?.sessions).toBe(1);
    // A gap day between them is present with zeros.
    const d1 = dash.daily.find((p) => p.date === dayKey(now - 1 * MS_PER_DAY));
    expect(d1).toBeDefined();
    expect(d1?.tokens).toBe(0);
  });

  it('buckets tokens per local day within the trailing heatmap window', async () => {
    const now = Date.now();
    seed([
      rec({ sessionId: 't', timestamp: now, model: { totalTokens: 100 } }),
      rec({
        sessionId: 'old',
        timestamp: now - 200 * MS_PER_DAY,
        model: { totalTokens: 500 },
      }),
    ]);

    const dash = await loadUsageDashboard();
    // Default window ~183 days: the 200-day-old record is excluded.
    expect(dash.heatmapDays).toBe(183);
    expect(dash.heatmap[dayKey(now)]?.tokens).toBe(100);
    expect(dash.heatmap[dayKey(now - 200 * MS_PER_DAY)]).toBeUndefined();

    // A wider window pulls the old record back in.
    const wide = await loadUsageDashboard({ heatmapDays: 365 });
    expect(wide.heatmapDays).toBe(365);
    expect(wide.heatmap[dayKey(now - 200 * MS_PER_DAY)]?.tokens).toBe(500);
  });

  it('sums multiple sessions that land on the same day', async () => {
    const now = Date.now();
    seed([
      rec({ sessionId: 'x', timestamp: now, model: { totalTokens: 100 } }),
      rec({ sessionId: 'y', timestamp: now, model: { totalTokens: 250 } }),
    ]);
    const dash = await loadUsageDashboard();
    expect(dash.heatmap[dayKey(now)]?.tokens).toBe(350);
  });

  it('carries the per-day cache-read rate in each heatmap cell', async () => {
    const now = Date.now();
    seed([
      rec({
        sessionId: 'c',
        timestamp: now,
        model: { inputTokens: 1000, cachedTokens: 900, totalTokens: 1200 },
      }),
    ]);
    const dash = await loadUsageDashboard();
    const cell = dash.heatmap[dayKey(now)];
    expect(cell?.tokens).toBe(1200);
    expect(cell?.cacheReadRate).toBeCloseTo(0.9, 6);
  });

  it('returns zeros for an empty history', async () => {
    const dash = await loadUsageDashboard();
    expect(dash.summary.totalTokens).toBe(0);
    expect(dash.summary.sessions).toBe(0);
    expect(dash.summary.cacheReadRate).toBe(0);
    expect(dash.heatmap).toEqual({});
    expect(dash.models).toEqual([]);
    expect(dash.skills).toEqual([]);
    expect(typeof dash.generatedAt).toBe('string');
  });
});
