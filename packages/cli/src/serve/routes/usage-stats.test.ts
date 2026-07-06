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
import type { UsageDashboard } from '@qwen-code/qwen-code-core';
import { registerUsageStatsRoutes } from './usage-stats.js';

function fakeDashboard(overrides?: Partial<UsageDashboard>): UsageDashboard {
  return {
    generatedAt: '2026-07-06T00:00:00.000Z',
    range: 'today',
    summary: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      thoughtsTokens: 0,
      requests: 0,
      sessions: 0,
      toolCalls: 0,
      linesAdded: 0,
      linesRemoved: 0,
      cacheReadRate: 0,
    },
    models: [],
    skills: [],
    daily: [],
    heatmap: {},
    heatmapDays: 183,
    currentStreak: 0,
    longestStreak: 0,
    ...overrides,
  };
}

function mount(deps: Parameters<typeof registerUsageStatsRoutes>[1]) {
  const app = express();
  app.use(express.json());
  registerUsageStatsRoutes(app, deps);
  return app;
}

describe('usage-stats route (cache + clamping)', () => {
  it('serves the dashboard payload', async () => {
    const app = mount({
      loadDashboard: async () =>
        fakeDashboard({
          summary: { ...fakeDashboard().summary, totalTokens: 42 },
        }),
    });
    const res = await request(app).get('/usage/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.summary.totalTokens).toBe(42);
    expect(res.body.range).toBe('today');
    expect(res.body.heatmapDays).toBe(183);
  });

  it('scopes and caches per range; invalid range falls back to today', async () => {
    const seen: string[] = [];
    const app = mount({
      cacheTtlMs: 60_000,
      loadDashboard: async ({ range }) => {
        seen.push(range);
        return fakeDashboard({ range });
      },
    });
    await request(app).get('/usage/dashboard?range=week');
    await request(app).get('/usage/dashboard?range=month');
    await request(app).get('/usage/dashboard?range=week'); // cache hit
    await request(app).get('/usage/dashboard?range=bogus'); // -> today
    expect(seen).toEqual(['week', 'month', 'today']);
  });

  it('coalesces repeated requests within the TTL window (one load)', async () => {
    let calls = 0;
    const app = mount({
      cacheTtlMs: 60_000,
      loadDashboard: async () => {
        calls++;
        return fakeDashboard();
      },
    });
    await request(app).get('/usage/dashboard');
    await request(app).get('/usage/dashboard');
    expect(calls).toBe(1);
  });

  it('caches per heatmap window (distinct keys reload)', async () => {
    const seen: number[] = [];
    const app = mount({
      cacheTtlMs: 60_000,
      loadDashboard: async ({ heatmapDays }) => {
        seen.push(heatmapDays);
        return fakeDashboard({ heatmapDays });
      },
    });
    await request(app).get('/usage/dashboard?heatmapDays=183');
    await request(app).get('/usage/dashboard?heatmapDays=30');
    await request(app).get('/usage/dashboard?heatmapDays=183');
    expect(seen).toEqual([183, 30]); // third request is a 183 cache hit
  });

  it('does not cache a failed load (next request retries)', async () => {
    let calls = 0;
    const app = mount({
      cacheTtlMs: 60_000,
      loadDashboard: async () => {
        calls++;
        if (calls === 1) throw new Error('boom');
        return fakeDashboard({ currentStreak: 7 });
      },
    });
    const first = await request(app).get('/usage/dashboard');
    expect(first.status).toBe(500);
    expect(first.body.code).toBe('usage_dashboard_failed');

    const second = await request(app).get('/usage/dashboard');
    expect(second.status).toBe(200);
    expect(second.body.currentStreak).toBe(7);
    expect(calls).toBe(2);
  });

  it('clamps and defaults the heatmapDays query', async () => {
    const seen: number[] = [];
    const app = mount({
      cacheTtlMs: 0, // disable caching so every request reaches the loader
      loadDashboard: async ({ heatmapDays }) => {
        seen.push(heatmapDays);
        return fakeDashboard({ heatmapDays });
      },
    });
    await request(app).get('/usage/dashboard'); // absent -> default 183
    await request(app).get('/usage/dashboard?heatmapDays=99999'); // -> 366 max
    await request(app).get('/usage/dashboard?heatmapDays=0'); // -> 1 min
    await request(app).get('/usage/dashboard?heatmapDays=abc'); // -> default 183
    expect(seen).toEqual([183, 366, 1, 183]);
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
    const record = {
      version: 1,
      sessionId: 's1',
      timestamp: now,
      startTime: now,
      project: '/p',
      durationMs: 0,
      totalLatencyMs: 0,
      models: {
        'qwen-max': {
          requests: 4,
          inputTokens: 1000,
          outputTokens: 200,
          cachedTokens: 900,
          thoughtsTokens: 0,
          totalTokens: 1200,
          totalLatencyMs: 0,
        },
      },
      tools: { totalCalls: 6, totalSuccess: 6, totalFail: 0, byName: {} },
      files: { linesAdded: 12, linesRemoved: 3 },
    };
    fs.writeFileSync(
      path.join(process.env['QWEN_HOME']!, 'usage_record.jsonl'),
      JSON.stringify(record) + '\n',
      'utf8',
    );

    // No injected loader -> exercises the real core loadUsageDashboard.
    const app = mount({});
    const res = await request(app).get('/usage/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.range).toBe('today');
    expect(res.body.summary.requests).toBe(4);
    expect(res.body.summary.sessions).toBe(1);
    expect(res.body.summary.totalTokens).toBe(1200);
    expect(res.body.summary.toolCalls).toBe(6);
    expect(res.body.summary.cacheReadRate).toBeCloseTo(0.9, 6);
  });
});
