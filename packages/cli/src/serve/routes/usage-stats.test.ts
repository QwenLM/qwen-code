/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  getTokenUsageFilePath,
  Storage,
  type TokenUsageDailyByModel,
  type TokenUsageRecord,
  type UsageDashboardSources,
  type UsageSummaryRecord,
} from '@qwen-code/qwen-code-core';
import { registerUsageStatsRoutes } from './usage-stats.js';

const DAY = 86_400_000;

/** Session records with no ledger coverage — the fallback attribution path. */
function sources(
  records: UsageSummaryRecord[],
  ledgerDaily: TokenUsageDailyByModel = new Map(),
): UsageDashboardSources {
  return { records, ledgerDaily };
}

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
      loadSources: async () =>
        sources([
          rec({
            sessionId: 'a',
            timestamp: now,
            totalTokens: 42,
            inputTokens: 42,
          }),
        ]),
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
      loadSources: async () => {
        loads++;
        return sources([
          rec({ sessionId: 'a', timestamp: now, totalTokens: 10 }),
        ]);
      },
    });
    await request(app).get('/usage/dashboard?range=today');
    await request(app).get('/usage/dashboard?range=week');
    await request(app).get('/usage/dashboard?range=month');
    expect(loads).toBe(1); // range-independent cache
  });

  it('reuses a pending load for later requests even after the TTL elapses', async () => {
    let loads = 0;
    let resolveLoad: (r: UsageDashboardSources) => void = () => {};
    const gate = new Promise<UsageDashboardSources>((r) => {
      resolveLoad = r;
    });
    const now = Date.now();
    const app = mount({
      cacheTtlMs: 0, // TTL always elapsed — the old cache would reload each request
      loadSources: () => {
        loads++;
        return gate;
      },
    });
    // `.then` forces supertest to send now (it is otherwise lazy), so both
    // handlers reach getSources while the single load is still pending.
    const p1 = request(app)
      .get('/usage/dashboard')
      .then((r) => r);
    const p2 = request(app)
      .get('/usage/dashboard')
      .then((r) => r);
    await new Promise((r) => setTimeout(r, 200));
    resolveLoad(
      sources([rec({ sessionId: 'a', timestamp: now, totalTokens: 5 })]),
    );
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
    const app = mount({
      cacheTtlMs: 0,
      loadSources: async () => sources(records),
    });

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
      loadSources: async () => {
        loads++;
        if (loads === 1) throw new Error('boom');
        return sources([
          rec({ sessionId: 'a', timestamp: now, totalTokens: 7 }),
        ]);
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
      loadSources: async () =>
        sources([rec({ sessionId: 'a', timestamp: now })]),
    });
    const max = await request(app).get('/usage/dashboard?heatmapDays=99999');
    expect(max.body.heatmapDays).toBe(366);
    const min = await request(app).get('/usage/dashboard?heatmapDays=0');
    expect(min.body.heatmapDays).toBe(1);
    const def = await request(app).get('/usage/dashboard?heatmapDays=abc');
    expect(def.body.heatmapDays).toBe(183);
    const negative = await request(app).get('/usage/dashboard?heatmapDays=-5');
    expect(negative.body.heatmapDays).toBe(183);
    const fractional = await request(app).get(
      '/usage/dashboard?heatmapDays=1.5',
    );
    expect(fractional.body.heatmapDays).toBe(183);
    const trailingText = await request(app).get(
      '/usage/dashboard?heatmapDays=7junk',
    );
    expect(trailingText.body.heatmapDays).toBe(183);
    const exponent = await request(app).get('/usage/dashboard?heatmapDays=1e2');
    expect(exponent.body.heatmapDays).toBe(183);
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

  describe('runtime-scoped ledgers', () => {
    let roots: string;
    let originalRuntimeDir: string | undefined;

    const ledgerRow = (
      id: string,
      inputTokens: number,
      outputTokens: number,
      thoughtsTokens = 0,
      totalTokens = inputTokens + outputTokens,
    ): TokenUsageRecord => ({
      schemaVersion: 1,
      id,
      timestamp: '2026-05-25T10:00:00.000Z',
      localDate: '2026-05-25',
      localMonth: '2026-05',
      sessionId: id,
      model: 'qwen-max',
      authType: 'openai',
      source: 'main',
      inputTokens,
      outputTokens,
      cachedTokens: 0,
      thoughtsTokens,
      totalTokens,
      apiDurationMs: 50,
    });

    const seedLedger = (root: string, row: TokenUsageRecord): void => {
      Storage.runWithResolvedRuntimeBaseDir(root, () => {
        const file = getTokenUsageFilePath(row.localMonth);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(row) + '\n');
      });
    };

    beforeEach(() => {
      roots = fs.mkdtempSync(path.join(tmpHome, 'runtime-roots-'));
      originalRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
      Storage.setRuntimeBaseDir(null);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-05-25T10:00:00.000Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
      Storage.setRuntimeBaseDir(null);
      if (originalRuntimeDir === undefined)
        delete process.env['QWEN_RUNTIME_DIR'];
      else process.env['QWEN_RUNTIME_DIR'] = originalRuntimeDir;
    });

    it('reads a ledger from its owning runtime instead of the ambient route root', async () => {
      const owner = path.join(roots, 'owner');
      const ambient = path.join(roots, 'ambient');
      process.env['QWEN_RUNTIME_DIR'] = ambient;
      seedLedger(owner, ledgerRow('owned-request', 500, 100));
      expect(fs.existsSync(getTokenUsageFilePath('2026-05'))).toBe(false);

      const app = mount({ getLedgerRuntimeBaseDirs: () => [owner] });
      const res = await request(app).get('/usage/dashboard?range=today');

      expect(res.status).toBe(200);
      expect(res.body.summary).toMatchObject({
        totalTokens: 600,
        outputTokens: 100,
        requests: 1,
      });
    });

    it('merges the known runtime roots rather than selecting only one', async () => {
      const rootA = path.join(roots, 'a');
      const rootB = path.join(roots, 'b');
      process.env['QWEN_RUNTIME_DIR'] = path.join(roots, 'ambient');
      seedLedger(rootA, ledgerRow('request-a', 500, 100));
      seedLedger(rootB, ledgerRow('request-b', 800, 200));

      const app = mount({
        getLedgerRuntimeBaseDirs: () => [rootA, rootB, rootA],
      });
      const res = await request(app).get('/usage/dashboard?range=today');

      expect(res.status).toBe(200);
      expect(res.body.summary).toMatchObject({
        totalTokens: 1600,
        outputTokens: 300,
        requests: 2,
      });
    });

    it('falls back to global records when no ledger runtime is known', async () => {
      const ambient = path.join(roots, 'ambient');
      process.env['QWEN_RUNTIME_DIR'] = ambient;
      seedLedger(ambient, ledgerRow('unrelated-request', 9999, 0));
      const timestamp = Date.parse('2026-05-25T10:00:00.000Z');
      fs.writeFileSync(
        path.join(process.env['QWEN_HOME']!, 'usage_record.jsonl'),
        JSON.stringify(
          rec({
            sessionId: 'without-known-runtime',
            timestamp,
            totalTokens: 600,
            inputTokens: 500,
          }),
        ) + '\n',
      );

      const app = mount({ getLedgerRuntimeBaseDirs: () => [] });
      const res = await request(app).get('/usage/dashboard?range=today');

      expect(res.status).toBe(200);
      expect(res.body.summary.totalTokens).toBe(600);
      expect(res.body.summary.sessions).toBe(1);
    });

    it('does not replace records with the ledger of a different runtime', async () => {
      const ownedRoot = path.join(roots, 'owned');
      process.env['QWEN_RUNTIME_DIR'] = path.join(roots, 'ambient');
      seedLedger(ownedRoot, ledgerRow('owned-session', 500, 100));
      const timestamp = Date.parse('2026-05-25T10:00:00.000Z');
      const records = [
        rec({
          sessionId: 'owned-session',
          timestamp,
          totalTokens: 600,
          inputTokens: 500,
        }),
        rec({
          sessionId: 'session-without-known-runtime',
          timestamp: timestamp - 10_000,
          totalTokens: 900,
          inputTokens: 900,
        }),
      ];
      fs.writeFileSync(
        path.join(process.env['QWEN_HOME']!, 'usage_record.jsonl'),
        records.map((record) => JSON.stringify(record)).join('\n') + '\n',
      );

      const app = mount({ getLedgerRuntimeBaseDirs: () => [ownedRoot] });
      const res = await request(app).get('/usage/dashboard?range=today');

      expect(res.status).toBe(200);
      expect(res.body.summary.totalTokens).toBe(1500);
      expect(res.body.summary.sessions).toBe(2);
    });
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

  it('prefers ledger-day tokens over the session-record copy (real loader)', async () => {
    const now = Date.now();
    const key = (ms: number) => {
      const d = new Date(ms);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
        d.getDate(),
      ).padStart(2, '0')}`;
    };
    const today = key(now);
    const yesterday = key(now - DAY);

    // One run that ended today and carries its whole 900-token spend.
    fs.writeFileSync(
      path.join(process.env['QWEN_HOME']!, 'usage_record.jsonl'),
      JSON.stringify(
        rec({
          sessionId: 's1',
          timestamp: now,
          totalTokens: 900,
          inputTokens: 800,
        }),
      ) + '\n',
      'utf8',
    );

    // The same run's requests as the ledger recorded them, on the days they
    // actually happened (possibly in two different month files).
    const ledger = [
      { day: yesterday, ms: now - DAY, requests: 4, input: 600, output: 0 },
      { day: today, ms: now, requests: 2, input: 200, output: 100 },
    ];
    const usageDir = path.join(process.env['QWEN_HOME']!, 'usage');
    fs.mkdirSync(usageDir, { recursive: true });
    const byMonth = new Map<string, string[]>();
    let n = 0;
    for (const entry of ledger) {
      const month = entry.day.slice(0, 7);
      const lines = byMonth.get(month) ?? [];
      for (let i = 0; i < entry.requests; i++) {
        lines.push(
          JSON.stringify({
            schemaVersion: 1,
            id: `r${n++}`,
            timestamp: new Date(entry.ms).toISOString(),
            localDate: entry.day,
            localMonth: month,
            sessionId: 's1',
            model: 'qwen-max',
            authType: 'openai',
            source: 'main',
            inputTokens: entry.input / entry.requests,
            outputTokens: entry.output / entry.requests,
            cachedTokens: 0,
            thoughtsTokens: 0,
            totalTokens: (entry.input + entry.output) / entry.requests,
            apiDurationMs: 1,
          }),
        );
      }
      byMonth.set(month, lines);
    }
    for (const [month, lines] of byMonth) {
      fs.writeFileSync(
        path.join(usageDir, `token-usage-${month}.jsonl`),
        lines.join('\n') + '\n',
        'utf8',
      );
    }

    const app = mount({});
    const day = await request(app).get('/usage/dashboard?range=today');
    expect(day.status).toBe(200);
    // 300, not 900 (session end attribution) and not 1200 (both sources summed).
    expect(day.body.summary.totalTokens).toBe(300);
    expect(day.body.summary.requests).toBe(2);
    expect(day.body.summary.sessions).toBe(1);

    const week = await request(app).get('/usage/dashboard?range=week');
    expect(week.body.summary.totalTokens).toBe(900);
    expect(week.body.heatmap[yesterday].tokens).toBe(600);
    expect(week.body.heatmap[today].tokens).toBe(300);
  });

  it('replays a never-persisted transcript through the real route, read-only', async () => {
    // A daemon / Web Shell session that only exists as a transcript (no
    // usage_record.jsonl entry). The real loader must replay it and the route
    // must serve its totals without writing anything back to ~/.qwen.
    const now = Date.now();
    const chats = path.join(
      process.env['QWEN_HOME']!,
      'projects',
      'replay-proj',
      'chats',
    );
    fs.mkdirSync(chats, { recursive: true });
    const sessionId = 'sess-replay';
    // Spread the stamps across the elapsed part of today, clamped to local
    // midnight, so they sit inside [local midnight, now] in every timezone and
    // even in the first seconds after local midnight (a fixed "now - 60s"
    // offset would fall before local midnight there). at(3) stays `now`.
    const localMidnight = new Date(now).setHours(0, 0, 0, 0);
    const from = Math.max(localMidnight, now - 3 * 60_000);
    const at = (m: number) =>
      new Date(from + Math.floor(((now - from) * (m + 1)) / 4)).toISOString();
    const base = { sessionId, cwd: '/replay/proj' };
    const records = [
      {
        ...base,
        uuid: 'u1',
        parentUuid: null,
        timestamp: at(0),
        type: 'user',
        message: { role: 'user', content: 'hi' },
      },
      {
        ...base,
        uuid: 'u2',
        parentUuid: 'u1',
        timestamp: at(1),
        type: 'system',
        subtype: 'ui_telemetry',
        systemPayload: {
          uiEvent: {
            'event.name': 'qwen-code.api_response',
            'event.timestamp': at(1),
            response_id: 'r1',
            model: 'qwen-max',
            duration_ms: 1000,
            input_token_count: 600,
            output_token_count: 300,
            cached_content_token_count: 0,
            thoughts_token_count: 100,
            total_token_count: 1000,
            prompt_id: 'p1',
          },
        },
      },
      {
        ...base,
        uuid: 'u3',
        parentUuid: 'u2',
        timestamp: at(2),
        type: 'assistant',
        message: { role: 'assistant', content: 'ok' },
      },
    ];
    fs.writeFileSync(
      path.join(chats, `${sessionId}.jsonl`),
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );

    // cacheTtlMs: 0 forces the second GET to run the loader again; the default
    // 60s route cache would answer it from the first load's records and compare
    // a value with itself, never exercising the warm path.
    const app = mount({ cacheTtlMs: 0 }); // real loadUsageHistoryWithLive
    const cold = await request(app).get('/usage/dashboard?range=today');
    expect(cold.status).toBe(200);
    expect(cold.body.summary.totalTokens).toBe(1000);
    expect(cold.body.summary.sessions).toBe(1);

    // Grow the transcript, then reload: the warm path must rescan the changed
    // file and report the new total, not serve the stale first-load records.
    fs.appendFileSync(
      path.join(chats, `${sessionId}.jsonl`),
      JSON.stringify({
        ...base,
        uuid: 'u4',
        parentUuid: 'u3',
        timestamp: at(3),
        type: 'system',
        subtype: 'ui_telemetry',
        systemPayload: {
          uiEvent: {
            'event.name': 'qwen-code.api_response',
            'event.timestamp': at(3),
            response_id: 'r2',
            model: 'qwen-max',
            duration_ms: 500,
            input_token_count: 300,
            output_token_count: 150,
            cached_content_token_count: 0,
            thoughts_token_count: 50,
            total_token_count: 500,
            prompt_id: 'p2',
          },
        },
      }) + '\n',
    );
    const warm = await request(app).get('/usage/dashboard?range=today');
    expect(warm.body.summary.totalTokens).toBe(1500);
    expect(warm.body.summary.sessions).toBe(1);

    expect(
      fs.existsSync(path.join(process.env['QWEN_HOME']!, 'usage_record.jsonl')),
    ).toBe(false);
  });

  it('replays a transcript in the first seconds after local midnight', async () => {
    // Pin the clock at local 00:00:30 so the `today` window is only 30s wide.
    // A fixed "now - 60s" fixture would fall before local midnight and be
    // filtered out; the elapsed-day span must keep the stamps inside the window.
    // Fake only Date so supertest's real timers keep working.
    const localMidnight = new Date().setHours(0, 0, 0, 0);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(localMidnight + 30_000);
    try {
      const now = Date.now();
      const chats = path.join(
        process.env['QWEN_HOME']!,
        'projects',
        'midnight-proj',
        'chats',
      );
      fs.mkdirSync(chats, { recursive: true });
      const sessionId = 'sess-midnight';
      const from = Math.max(
        new Date(now).setHours(0, 0, 0, 0),
        now - 3 * 60_000,
      );
      const at = (m: number) =>
        new Date(from + Math.floor(((now - from) * (m + 1)) / 4)).toISOString();
      const base = { sessionId, cwd: '/midnight/proj' };
      const records = [
        {
          ...base,
          uuid: 'u1',
          parentUuid: null,
          timestamp: at(0),
          type: 'user',
          message: { role: 'user', content: 'hi' },
        },
        {
          ...base,
          uuid: 'u2',
          parentUuid: 'u1',
          timestamp: at(1),
          type: 'system',
          subtype: 'ui_telemetry',
          systemPayload: {
            uiEvent: {
              'event.name': 'qwen-code.api_response',
              'event.timestamp': at(1),
              response_id: 'r1',
              model: 'qwen-max',
              duration_ms: 1000,
              input_token_count: 600,
              output_token_count: 300,
              cached_content_token_count: 0,
              thoughts_token_count: 100,
              total_token_count: 1000,
              prompt_id: 'p1',
            },
          },
        },
        {
          ...base,
          uuid: 'u3',
          parentUuid: 'u2',
          timestamp: at(2),
          type: 'assistant',
          message: { role: 'assistant', content: 'ok' },
        },
      ];
      fs.writeFileSync(
        path.join(chats, `${sessionId}.jsonl`),
        records.map((r) => JSON.stringify(r)).join('\n') + '\n',
      );
      const app = mount({ cacheTtlMs: 0 });
      const res = await request(app).get('/usage/dashboard?range=today');
      expect(res.status).toBe(200);
      expect(res.body.summary.totalTokens).toBe(1000);
      expect(res.body.summary.sessions).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
