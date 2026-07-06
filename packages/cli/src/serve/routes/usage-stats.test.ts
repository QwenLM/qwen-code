/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { UsageSummaryRecord } from '@qwen-code/qwen-code-core';
import { registerUsageStatsRoutes } from './usage-stats.js';

const DAY = 86_400_000;

function rec(o: {
  sessionId: string;
  timestamp: number;
  totalTokens?: number;
  inputTokens?: number;
  cachedTokens?: number;
}): UsageSummaryRecord {
  const total = o.totalTokens ?? 0;
  return {
    version: 1,
    sessionId: o.sessionId,
    timestamp: o.timestamp,
    startTime: o.timestamp,
    project: '/p',
    durationMs: 0,
    totalLatencyMs: 0,
    models: {
      'qwen-max': {
        requests: 1,
        inputTokens: o.inputTokens ?? total,
        outputTokens: 0,
        cachedTokens: o.cachedTokens ?? 0,
        thoughtsTokens: 0,
        totalTokens: total,
        totalLatencyMs: 0,
      },
    },
    tools: { totalCalls: 0, totalSuccess: 0, totalFail: 0, byName: {} },
    files: { linesAdded: 0, linesRemoved: 0 },
  };
}

function mount(deps: Parameters<typeof registerUsageStatsRoutes>[1]) {
  const app = express();
  app.use(express.json());
  registerUsageStatsRoutes(app, deps);
  return app;
}

describe('usage-stats route (cache + range + clamping)', () => {
  it('builds and serves the dashboard from loaded history', async () => {
    const now = Date.now();
    const app = mount({
      loadHistory: async () => [
        rec({
          sessionId: 'a',
          timestamp: now,
          totalTokens: 42,
          inputTokens: 42,
        }),
      ],
    });
    const res = await request(app).get('/usage/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.range).toBe('today');
    expect(res.body.summary.totalTokens).toBe(42);
    expect(res.body.heatmapDays).toBe(183);
  });

  it('loads the history once across Today/7D/30D toggles', async () => {
    let loads = 0;
    const now = Date.now();
    const app = mount({
      cacheTtlMs: 60_000,
      loadHistory: async () => {
        loads++;
        return [rec({ sessionId: 'a', timestamp: now, totalTokens: 10 })];
      },
    });
    await request(app).get('/usage/dashboard?range=today');
    await request(app).get('/usage/dashboard?range=week');
    await request(app).get('/usage/dashboard?range=month');
    expect(loads).toBe(1); // range-independent cache
  });

  it('reuses a pending load for later requests even after the TTL elapses', async () => {
    let loads = 0;
    let resolveLoad: (r: UsageSummaryRecord[]) => void = () => {};
    const gate = new Promise<UsageSummaryRecord[]>((r) => {
      resolveLoad = r;
    });
    const now = Date.now();
    const app = mount({
      cacheTtlMs: 0, // TTL always elapsed — the old cache would reload each request
      loadHistory: () => {
        loads++;
        return gate;
      },
    });
    // `.then` forces supertest to send now (it is otherwise lazy), so both
    // handlers reach getRecords while the single load is still pending.
    const p1 = request(app)
      .get('/usage/dashboard')
      .then((r) => r);
    const p2 = request(app)
      .get('/usage/dashboard')
      .then((r) => r);
    await new Promise((r) => setTimeout(r, 20));
    resolveLoad([rec({ sessionId: 'a', timestamp: now, totalTokens: 5 })]);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(loads).toBe(1); // pending load shared, not restarted past the TTL
  });

  it('scopes totals by range; invalid range falls back to today', async () => {
    const now = Date.now();
    const records = [
      rec({ sessionId: 'today', timestamp: now, totalTokens: 100 }),
      rec({ sessionId: 'd5', timestamp: now - 5 * DAY, totalTokens: 200 }),
    ];
    const app = mount({ cacheTtlMs: 0, loadHistory: async () => records });

    const today = await request(app).get('/usage/dashboard?range=today');
    expect(today.body.range).toBe('today');
    expect(today.body.summary.totalTokens).toBe(100);

    const week = await request(app).get('/usage/dashboard?range=week');
    expect(week.body.range).toBe('week');
    expect(week.body.summary.totalTokens).toBe(300); // today + 5d ago

    const bogus = await request(app).get('/usage/dashboard?range=bogus');
    expect(bogus.body.range).toBe('today');
    expect(bogus.body.summary.totalTokens).toBe(100);
  });

  it('does not cache a failed load (next request retries)', async () => {
    let loads = 0;
    const now = Date.now();
    const app = mount({
      cacheTtlMs: 60_000,
      loadHistory: async () => {
        loads++;
        if (loads === 1) throw new Error('boom');
        return [rec({ sessionId: 'a', timestamp: now, totalTokens: 7 })];
      },
    });
    const first = await request(app).get('/usage/dashboard');
    expect(first.status).toBe(500);
    expect(first.body.code).toBe('usage_dashboard_failed');

    const second = await request(app).get('/usage/dashboard');
    expect(second.status).toBe(200);
    expect(second.body.summary.totalTokens).toBe(7);
    expect(loads).toBe(2);
  });

  it('clamps the heatmapDays query', async () => {
    const now = Date.now();
    const app = mount({
      cacheTtlMs: 60_000,
      loadHistory: async () => [rec({ sessionId: 'a', timestamp: now })],
    });
    const max = await request(app).get('/usage/dashboard?heatmapDays=99999');
    expect(max.body.heatmapDays).toBe(366);
    const min = await request(app).get('/usage/dashboard?heatmapDays=0');
    expect(min.body.heatmapDays).toBe(1);
    const def = await request(app).get('/usage/dashboard?heatmapDays=abc');
    expect(def.body.heatmapDays).toBe(183);
  });
});

describe('usage-stats route (real loader against seeded history)', () => {
  let tmpHome: string;
  let originalQwenHome: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-usage-route-'));
    originalQwenHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = path.join(tmpHome, '.qwen');
    fs.mkdirSync(process.env['QWEN_HOME'], { recursive: true });
  });

  afterEach(() => {
    if (originalQwenHome === undefined) delete process.env['QWEN_HOME'];
    else process.env['QWEN_HOME'] = originalQwenHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns real aggregated totals from usage_record.jsonl', async () => {
    const now = Date.now();
    fs.writeFileSync(
      path.join(process.env['QWEN_HOME']!, 'usage_record.jsonl'),
      JSON.stringify(
        rec({
          sessionId: 's1',
          timestamp: now,
          totalTokens: 1200,
          inputTokens: 1000,
          cachedTokens: 900,
        }),
      ) + '\n',
      'utf8',
    );

    // No injected loader -> exercises the real core loadUsageHistory.
    const app = mount({});
    const res = await request(app).get('/usage/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.range).toBe('today');
    expect(res.body.summary.totalTokens).toBe(1200);
    expect(res.body.summary.sessions).toBe(1);
    expect(res.body.summary.cacheReadRate).toBeCloseTo(0.9, 6);
  });
});
