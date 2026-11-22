/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildUsageDashboard,
  buildUsageDayTable,
  loadUsageDashboard,
  recordTouchesLedgerDays,
} from './usage-dashboard-service.js';
import type { UsageSummaryRecord } from './usageHistoryService.js';
import type {
  TokenUsageDailyByModel,
  TokenUsageDayModelTotals,
} from './tokenUsageService.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface ModelTokens {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  thoughtsTokens: number;
  totalTokens: number;
  totalLatencyMs: number;
  errors?: number;
  errorLatencyMs?: number;
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

/** One ledger day/model bucket; `total` defaults to input + output. */
function ledgerDay(
  model: string,
  o: {
    requests: number;
    inputTokens: number;
    outputTokens?: number;
    cachedTokens?: number;
    thoughtsTokens?: number;
    totalTokens?: number;
    apiDurationMs?: number;
  },
): Map<string, TokenUsageDayModelTotals> {
  const outputTokens = o.outputTokens ?? 0;
  return new Map([
    [
      model,
      {
        requests: o.requests,
        inputTokens: o.inputTokens,
        outputTokens,
        cachedTokens: o.cachedTokens ?? 0,
        thoughtsTokens: o.thoughtsTokens ?? 0,
        totalTokens: o.totalTokens ?? o.inputTokens + outputTokens,
        apiDurationMs: o.apiDurationMs ?? 0,
      },
    ],
  ]);
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

  /**
   * Plant a transcript-only (never-persisted, e.g. daemon / Web Shell) session
   * timestamped now, so it lands in the `today` window when replayed.
   */
  function plantTranscript(sessionId: string, totalTokens: number): void {
    const cwd = '/daemon/project';
    const ts = new Date().toISOString();
    const chatsDir = path.join(
      process.env['QWEN_HOME']!,
      'projects',
      'daemon-project',
      'chats',
    );
    fs.mkdirSync(chatsDir, { recursive: true });
    const records = [
      {
        sessionId,
        cwd,
        uuid: 'u1',
        parentUuid: null,
        timestamp: ts,
        type: 'user',
        message: { role: 'user', content: 'hi' },
      },
      {
        sessionId,
        cwd,
        uuid: 'u2',
        parentUuid: 'u1',
        timestamp: ts,
        type: 'system',
        subtype: 'ui_telemetry',
        systemPayload: {
          uiEvent: {
            'event.name': 'qwen-code.api_response',
            'event.timestamp': ts,
            response_id: 'r1',
            model: 'qwen-max',
            duration_ms: 1200,
            input_token_count: totalTokens * 0.6,
            output_token_count: totalTokens * 0.4,
            cached_content_token_count: 0,
            thoughts_token_count: 0,
            total_token_count: totalTokens,
            prompt_id: 'p1',
          },
        },
      },
      {
        sessionId,
        cwd,
        uuid: 'u3',
        parentUuid: 'u2',
        timestamp: ts,
        type: 'assistant',
        message: { role: 'assistant', content: 'ok' },
      },
    ];
    fs.writeFileSync(
      path.join(chatsDir, `${sessionId}.jsonl`),
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
  }

  it('today totals include a daemon / Web Shell transcript session, not just the persisted file', async () => {
    // Guards the wiring: loadUsageDashboard must read the live-merging loader,
    // so a session that only lives in a transcript (never persisted by /clear)
    // still counts. A revert to the persisted-only loader would drop it.
    seed([
      rec({
        sessionId: 'persisted',
        timestamp: Date.now(),
        model: { totalTokens: 1000, inputTokens: 1000 },
      }),
    ]);
    plantTranscript('daemon-live', 1600);

    const dash = await loadUsageDashboard({ range: 'today' });

    expect(dash.summary.sessions).toBe(2);
    expect(dash.summary.totalTokens).toBe(2600);
  });

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
    // Session 'a' reports thoughts apart from output, so its output tile carries
    // both (200 + 50); 'b' has none. Input + output still equals the total.
    expect(dash.summary.outputTokens).toBe(350);
    expect(dash.summary.cachedTokens).toBe(2760);
    expect(dash.summary.thoughtsTokens).toBe(50);
    expect(dash.summary.totalTokens).toBe(3350);
    expect(dash.summary.toolCalls).toBe(14);
    expect(dash.summary.linesAdded).toBe(40);
    expect(dash.summary.linesRemoved).toBe(7);
    expect(dash.summary.cacheReadRate).toBeCloseTo(2760 / 3000, 6);
  });

  it('counts reasoning once in the output total under either provider convention', async () => {
    const now = Date.now();
    seed([
      // Chat-completions convention: total is input + output because the output
      // count already carries the reasoning tokens.
      rec({
        sessionId: 'output-includes-thoughts',
        timestamp: now,
        modelName: 'via-openai',
        model: {
          requests: 2,
          inputTokens: 1000,
          outputTokens: 200,
          thoughtsTokens: 50,
          totalTokens: 1200,
        },
      }),
      // Gemini convention: thoughts are reported apart from the output count.
      rec({
        sessionId: 'output-excludes-thoughts',
        timestamp: now,
        modelName: 'via-gemini',
        model: {
          requests: 1,
          inputTokens: 2000,
          outputTokens: 100,
          thoughtsTokens: 40,
          totalTokens: 2140,
        },
      }),
    ]);

    const dash = await loadUsageDashboard();

    expect(dash.summary.outputTokens).toBe(340);
    // The raw reasoning count stays available on its own field.
    expect(dash.summary.thoughtsTokens).toBe(90);
    expect(dash.summary.inputTokens + dash.summary.outputTokens).toBe(
      dash.summary.totalTokens,
    );
  });

  it('replaces a ledger-covered day instead of adding the session-record copy', () => {
    const now = Date.now();
    // The same run appears in both sources: the session summary carries it once
    // and the ledger carries its requests again. Summing them would double it.
    const records = [
      rec({
        sessionId: 's',
        timestamp: now,
        model: {
          requests: 10,
          inputTokens: 1000,
          outputTokens: 100,
          totalTokens: 1100,
        },
        tools: { totalCalls: 7, totalSuccess: 7, totalFail: 0 },
      }),
    ];
    const ledger: TokenUsageDailyByModel = new Map([
      [
        dayKey(now),
        ledgerDay('qwen-max', {
          requests: 3,
          inputTokens: 300,
          outputTokens: 30,
        }),
      ],
    ]);

    const dash = buildUsageDashboard(records, { range: 'today' }, ledger);

    expect(dash.summary.totalTokens).toBe(330);
    expect(dash.summary.requests).toBe(3);
    // Session-granular tiles the ledger cannot supply stay on the records.
    expect(dash.summary.sessions).toBe(1);
    expect(dash.summary.toolCalls).toBe(7);
  });

  it('preserves other models whose records are not covered by the ledger', () => {
    const timestamp = Date.now();
    const record = rec({
      sessionId: 'mixed-models',
      timestamp,
      model: { requests: 1, inputTokens: 500, totalTokens: 500 },
    });
    record.models['other-model'] = { ...record.models['qwen-max']! };
    const ledgerDaily: TokenUsageDailyByModel = new Map([
      [
        dayKey(timestamp),
        ledgerDay('qwen-max', { requests: 1, inputTokens: 100 }),
      ],
    ]);

    expect(recordTouchesLedgerDays(record, ledgerDaily)).toBe(false);
    const summary = buildUsageDashboard(
      [record],
      { range: 'today' },
      ledgerDaily,
    ).summary;
    expect(summary.totalTokens).toBe(600);
    expect(summary.requests).toBe(2);
  });

  it('keeps a covered model failures beside an uncovered sibling model', () => {
    const timestamp = Date.now();
    const record = rec({
      sessionId: 'mixed-model-failure',
      timestamp,
      model: {
        requests: 2,
        inputTokens: 120,
        totalTokens: 120,
        totalLatencyMs: 200,
        errors: 1,
        errorLatencyMs: 150,
      },
    });
    record.models['other-model'] = {
      ...rec({
        sessionId: record.sessionId,
        timestamp,
        model: { requests: 1, totalTokens: 500 },
      }).models['qwen-max']!,
    };
    const ledger: TokenUsageDailyByModel = new Map([
      [
        dayKey(timestamp),
        ledgerDay('qwen-max', {
          requests: 1,
          inputTokens: 120,
          apiDurationMs: 50,
        }),
      ],
    ]);

    const table = buildUsageDayTable([record], ledger);

    expect(table.get(dayKey(timestamp))?.get('qwen-max')).toMatchObject({
      requests: 2,
      totalTokens: 120,
      apiDurationMs: 200,
    });
    expect(table.get(dayKey(timestamp))?.get('other-model')).toMatchObject({
      requests: 1,
      totalTokens: 500,
    });
  });

  it('retains failed requests and their duration beside successful ledger usage', () => {
    const timestamp = Date.now();
    const records = [
      rec({
        sessionId: 'success-and-failure',
        timestamp,
        model: {
          requests: 2,
          inputTokens: 120,
          totalTokens: 120,
          totalLatencyMs: 200,
          errors: 1,
          errorLatencyMs: 150,
        },
      }),
    ];
    const ledger: TokenUsageDailyByModel = new Map([
      [
        dayKey(timestamp),
        ledgerDay('qwen-max', {
          requests: 1,
          inputTokens: 120,
          apiDurationMs: 50,
        }),
      ],
    ]);

    const table = buildUsageDayTable(records, ledger);

    expect(table.get(dayKey(timestamp))?.get('qwen-max')).toMatchObject({
      requests: 2,
      totalTokens: 120,
      apiDurationMs: 200,
    });
    for (let i = 0; i < 3; i++) {
      expect(
        buildUsageDashboard(records, { range: 'today' }, ledger).summary
          .requests,
      ).toBe(2);
    }
    expect(ledger.get(dayKey(timestamp))?.get('qwen-max')).toMatchObject({
      requests: 1,
      totalTokens: 120,
      apiDurationMs: 50,
    });
  });

  it('keeps a cross-day record with failures when successful ledger coverage is absent', () => {
    const timestamp = Date.now();
    const record = rec({
      sessionId: 'failure-without-success-coverage',
      timestamp,
      model: {
        requests: 2,
        inputTokens: 120,
        totalTokens: 120,
        totalLatencyMs: 200,
        errors: 1,
        errorLatencyMs: 75,
      },
    });
    record.startTime = timestamp - MS_PER_DAY;

    const table = buildUsageDayTable([record], new Map());

    expect(table.get(dayKey(timestamp))?.get('qwen-max')).toMatchObject({
      requests: 2,
      totalTokens: 120,
      apiDurationMs: 200,
    });
  });

  it('counts supplemental API usage without inventing another ended run', () => {
    const timestamp = Date.now();
    const records = [
      {
        ...rec({ sessionId: 'ended-run', timestamp }),
        runScoped: true,
        durationMs: 1000,
        models: {
          'qwen-max': {
            requests: 1,
            inputTokens: 100,
            outputTokens: 0,
            cachedTokens: 0,
            thoughtsTokens: 0,
            totalTokens: 100,
          },
        },
      },
      {
        ...rec({ sessionId: 'ended-run', timestamp: timestamp + 1000 }),
        transcriptRebuild: true,
        transcriptSupplement: true,
        durationMs: 10_000,
        models: {
          'qwen-max': {
            requests: 1,
            inputTokens: 500,
            outputTokens: 0,
            cachedTokens: 0,
            thoughtsTokens: 0,
            totalTokens: 500,
          },
        },
      },
    ];

    const dashboard = buildUsageDashboard(records, { range: 'today' });

    expect(dashboard.summary.sessions).toBe(1);
    expect(dashboard.summary.requests).toBe(2);
    expect(dashboard.summary.totalTokens).toBe(600);
    expect(
      dashboard.daily.find((d) => d.date === dayKey(timestamp))?.sessions,
    ).toBe(1);
  });

  it('attributes tokens to the day each response happened, not the session end', () => {
    const now = Date.now();
    const yesterday = now - MS_PER_DAY;
    // One session that ran across midnight and ended today.
    const records = [
      rec({
        sessionId: 's',
        timestamp: now,
        model: {
          requests: 6,
          inputTokens: 800,
          outputTokens: 100,
          totalTokens: 900,
        },
      }),
    ];
    const ledger: TokenUsageDailyByModel = new Map([
      [
        dayKey(yesterday),
        ledgerDay('qwen-max', { requests: 4, inputTokens: 600 }),
      ],
      [
        dayKey(now),
        ledgerDay('qwen-max', {
          requests: 2,
          inputTokens: 200,
          outputTokens: 100,
        }),
      ],
    ]);

    // Without the ledger the whole session lands on its end day.
    const legacy = buildUsageDashboard(records, { range: 'today' });
    expect(legacy.summary.totalTokens).toBe(900);

    const today = buildUsageDashboard(records, { range: 'today' }, ledger);
    expect(today.summary.totalTokens).toBe(300);
    expect(today.summary.requests).toBe(2);

    const week = buildUsageDashboard(records, { range: 'week' }, ledger);
    expect(week.summary.totalTokens).toBe(900);
    expect(week.daily.find((d) => d.date === dayKey(yesterday))?.tokens).toBe(
      600,
    );
    expect(week.daily.find((d) => d.date === dayKey(now))?.tokens).toBe(300);
    expect(week.heatmap[dayKey(yesterday)]?.tokens).toBe(600);
  });

  it('keeps record-derived totals when the ledger cannot be read at all', async () => {
    // A regular file where the usage directory belongs makes the ledger
    // enumeration fail with ENOTDIR. That must not blank the dashboard: the
    // session records loaded fine, so they still supply every tile.
    fs.writeFileSync(
      path.join(process.env['QWEN_HOME']!, 'usage'),
      'not a directory',
      'utf8',
    );
    seed([
      rec({
        sessionId: 'a',
        timestamp: Date.now(),
        model: { totalTokens: 1200, inputTokens: 1200 },
      }),
    ]);

    const dash = await loadUsageDashboard({ range: 'today' });

    expect(dash.summary.totalTokens).toBe(1200);
  });

  it('counts a boundary-day session beside its tokens instead of reporting zero', () => {
    const now = Date.now();
    // 00:00:00.001 local on the day the 30-day window starts: inside the day
    // window, outside the rolling millisecond window.
    const boundary = new Date(now - 30 * MS_PER_DAY);
    boundary.setHours(0, 0, 0, 1);
    const records = [
      rec({
        sessionId: 'boundary',
        timestamp: boundary.getTime(),
        model: { requests: 1, inputTokens: 500, totalTokens: 500 },
        tools: { totalCalls: 7, totalSuccess: 6, totalFail: 1 },
        files: { linesAdded: 9, linesRemoved: 2 },
        skills: {
          totalCalls: 2,
          totalSuccess: 2,
          totalFail: 0,
          byName: { review: { count: 2, success: 2, fail: 0 } },
        },
      }),
    ];

    const dash = buildUsageDashboard(records, { range: 'month' });

    expect(dash.summary.totalTokens).toBe(500);
    expect(dash.summary.sessions).toBe(1);
    expect(dash.summary.toolCalls).toBe(7);
    expect(dash.summary.linesAdded).toBe(9);
    expect(dash.summary.linesRemoved).toBe(2);
    expect(dash.skills).toEqual([{ name: 'review', count: 2 }]);
    expect(dash.daily[0]).toEqual({
      date: dayKey(boundary.getTime()),
      tokens: 500,
      sessions: 1,
    });
  });

  it('sorts ledger keys once for all record span checks', () => {
    const ledgerDaily: TokenUsageDailyByModel = new Map([
      ['2026-11-12', ledgerDay('qwen-max', { requests: 1, inputTokens: 100 })],
    ]);
    const keys = vi.spyOn(ledgerDaily, 'keys');
    try {
      const table = buildUsageDayTable(
        [
          rec({
            sessionId: 'covered',
            timestamp: Date.parse('2026-11-12T12:00:00Z'),
            model: { inputTokens: 500, totalTokens: 500 },
          }),
          rec({
            sessionId: 'uncovered',
            timestamp: Date.parse('2026-11-13T12:00:00Z'),
            model: { inputTokens: 100, totalTokens: 100 },
          }),
        ],
        ledgerDaily,
      );
      expect(keys).toHaveBeenCalledTimes(1);
      expect(table.get('2026-11-13')?.get('qwen-max')?.totalTokens).toBe(100);
    } finally {
      keys.mockRestore();
    }
  });

  it('drops a run whose span touches a ledger day even if it ends on an uncovered day', () => {
    const now = Date.now();
    const yesterday = now - MS_PER_DAY;
    // Spent yesterday, exited after midnight: the record carries the whole run
    // on today's timestamp while the ledger already counted it yesterday.
    const records = [
      {
        ...rec({
          sessionId: 'cross-midnight',
          timestamp: now,
          model: { requests: 6, inputTokens: 600, totalTokens: 600 },
        }),
        startTime: yesterday,
      },
    ];
    const ledger: TokenUsageDailyByModel = new Map([
      [
        dayKey(yesterday),
        ledgerDay('qwen-max', { requests: 6, inputTokens: 600 }),
      ],
    ]);

    const week = buildUsageDashboard(records, { range: 'week' }, ledger);
    expect(week.summary.totalTokens).toBe(600);
    expect(week.summary.requests).toBe(6);
    expect(week.heatmap[dayKey(yesterday)]?.tokens).toBe(600);
    expect(week.heatmap[dayKey(now)]).toBeUndefined();
    // Tokens follow the request day; the session series explicitly means runs
    // ended on that day, so this cross-midnight run stays on its end day.
    expect(week.daily.find((d) => d.date === dayKey(yesterday))?.sessions).toBe(
      0,
    );
    expect(week.daily.find((d) => d.date === dayKey(now))?.sessions).toBe(1);

    const today = buildUsageDashboard(records, { range: 'today' }, ledger);
    expect(today.summary.totalTokens).toBe(0);
    expect(today.summary.requests).toBe(0);

    // With no ledger at all the record still supplies its tokens.
    const noLedger = buildUsageDashboard(records, { range: 'week' });
    expect(noLedger.summary.totalTokens).toBe(600);
  });

  it('keeps session-record tokens for days the ledger does not cover', () => {
    const now = Date.now();
    const old = now - 40 * MS_PER_DAY;
    const records = [
      rec({
        sessionId: 'old',
        timestamp: old,
        model: { requests: 2, inputTokens: 500, totalTokens: 500 },
      }),
    ];
    const ledger: TokenUsageDailyByModel = new Map([
      [dayKey(now), ledgerDay('qwen-max', { requests: 1, inputTokens: 70 })],
    ]);

    const dash = buildUsageDashboard(records, { range: 'month' }, ledger);

    // The 40-day-old session is outside the 30-day summary but inside the
    // default heatmap, which must not lose pre-ledger history.
    expect(dash.summary.totalTokens).toBe(70);
    expect(dash.heatmap[dayKey(old)]?.tokens).toBe(500);
    expect(dash.heatmap[dayKey(now)]?.tokens).toBe(70);
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
