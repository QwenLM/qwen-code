/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  metricsToUsageRecord,
  aggregateUsage,
  loadUsageHistory,
  persistSessionUsage,
} from './usageHistoryService.js';
import { ToolCallDecision } from '../telemetry/tool-call-decision.js';
import type { SessionMetrics } from '../telemetry/uiTelemetry.js';
import type { UsageSummaryRecord } from './usageHistoryService.js';

function makeMetrics(overrides?: Partial<SessionMetrics>): SessionMetrics {
  return {
    models: {
      'qwen-max': {
        api: {
          totalRequests: 5,
          totalErrors: 0,
          totalLatencyMs: 3200,
        },
        tokens: {
          prompt: 1000,
          candidates: 500,
          total: 1500,
          cached: 200,
          thoughts: 100,
        },
        bySource: {},
      },
    },
    tools: {
      totalCalls: 10,
      totalSuccess: 8,
      totalFail: 2,
      totalDurationMs: 5000,
      totalDecisions: {
        [ToolCallDecision.ACCEPT]: 5,
        [ToolCallDecision.REJECT]: 1,
        [ToolCallDecision.MODIFY]: 0,
        [ToolCallDecision.AUTO_ACCEPT]: 4,
      },
      byName: {
        edit: {
          count: 6,
          success: 5,
          fail: 1,
          durationMs: 3000,
          decisions: {
            [ToolCallDecision.ACCEPT]: 3,
            [ToolCallDecision.REJECT]: 1,
            [ToolCallDecision.MODIFY]: 0,
            [ToolCallDecision.AUTO_ACCEPT]: 2,
          },
        },
        bash: {
          count: 4,
          success: 3,
          fail: 1,
          durationMs: 2000,
          decisions: {
            [ToolCallDecision.ACCEPT]: 2,
            [ToolCallDecision.REJECT]: 0,
            [ToolCallDecision.MODIFY]: 0,
            [ToolCallDecision.AUTO_ACCEPT]: 2,
          },
        },
      },
    },
    files: {
      totalLinesAdded: 50,
      totalLinesRemoved: 10,
    },
    ...overrides,
  };
}

describe('metricsToUsageRecord', () => {
  it('populates totalLatencyMs from sum of model api.totalLatencyMs', () => {
    const metrics = makeMetrics({
      models: {
        'qwen-max': {
          api: { totalRequests: 3, totalErrors: 0, totalLatencyMs: 2000 },
          tokens: {
            prompt: 500,
            candidates: 200,
            total: 700,
            cached: 0,
            thoughts: 0,
          },
          bySource: {},
        },
        'qwen-turbo': {
          api: { totalRequests: 2, totalErrors: 1, totalLatencyMs: 1500 },
          tokens: {
            prompt: 300,
            candidates: 100,
            total: 400,
            cached: 50,
            thoughts: 0,
          },
          bySource: {},
        },
      },
    });

    const record = metricsToUsageRecord(
      'session-1',
      '/project',
      1000,
      5000,
      metrics,
    );

    expect(record.totalLatencyMs).toBe(3500); // 2000 + 1500
  });

  it('populates totalDurationMs for each tool in byName', () => {
    const metrics = makeMetrics();

    const record = metricsToUsageRecord(
      'session-2',
      '/project',
      1000,
      6000,
      metrics,
    );

    expect(record.tools.byName['edit']).toEqual({
      count: 6,
      success: 5,
      fail: 1,
      totalDurationMs: 3000,
    });
    expect(record.tools.byName['bash']).toEqual({
      count: 4,
      success: 3,
      fail: 1,
      totalDurationMs: 2000,
    });
  });

  it('sets totalLatencyMs to 0 when no models present', () => {
    const metrics = makeMetrics({ models: {} });

    const record = metricsToUsageRecord(
      'session-3',
      '/project',
      0,
      1000,
      metrics,
    );

    expect(record.totalLatencyMs).toBe(0);
  });

  it('preserves existing fields correctly alongside new fields', () => {
    const metrics = makeMetrics();

    const record = metricsToUsageRecord(
      'session-4',
      '/my/project',
      1000,
      4000,
      metrics,
    );

    expect(record.version).toBe(1);
    expect(record.sessionId).toBe('session-4');
    expect(record.project).toBe('/my/project');
    expect(record.durationMs).toBe(3000);
    expect(record.totalLatencyMs).toBe(3200);
    expect(record.tools.totalCalls).toBe(10);
    expect(record.tools.totalSuccess).toBe(8);
    expect(record.tools.totalFail).toBe(2);
    expect(record.files.linesAdded).toBe(50);
    expect(record.files.linesRemoved).toBe(10);
  });
});

function makeRecord(
  overrides?: Partial<UsageSummaryRecord>,
): UsageSummaryRecord {
  return {
    version: 1,
    sessionId: 'sess-1',
    timestamp: Date.now(),
    startTime: Date.now() - 60000,
    project: '/my/project',
    durationMs: 60000,
    totalLatencyMs: 2000,
    models: {
      'qwen-max': {
        requests: 3,
        inputTokens: 1000,
        outputTokens: 500,
        cachedTokens: 100,
        thoughtsTokens: 50,
        totalTokens: 1550,
      },
    },
    tools: {
      totalCalls: 5,
      totalSuccess: 4,
      totalFail: 1,
      byName: {
        edit: { count: 3, success: 2, fail: 1, totalDurationMs: 1500 },
        bash: { count: 2, success: 2, fail: 0, totalDurationMs: 800 },
      },
    },
    files: {
      linesAdded: 20,
      linesRemoved: 5,
    },
    ...overrides,
  };
}

describe('aggregateUsage', () => {
  it('accumulates totalLatencyMs from records', () => {
    const records = [
      makeRecord({ totalLatencyMs: 2000 }),
      makeRecord({ totalLatencyMs: 3000 }),
    ];

    const report = aggregateUsage(records, 'all');

    expect(report.totalLatencyMs).toBe(5000);
  });

  it('handles records without totalLatencyMs (backward compat)', () => {
    const r1 = makeRecord({ totalLatencyMs: 1500 });
    const r2 = makeRecord({ totalLatencyMs: undefined });

    const report = aggregateUsage([r1, r2], 'all');

    expect(report.totalLatencyMs).toBe(1500);
  });

  it('accumulates totalRequests by summing model requests', () => {
    const records = [
      makeRecord({
        models: {
          'qwen-max': {
            requests: 3,
            inputTokens: 100,
            outputTokens: 50,
            cachedTokens: 0,
            thoughtsTokens: 0,
            totalTokens: 150,
          },
          'qwen-turbo': {
            requests: 2,
            inputTokens: 80,
            outputTokens: 40,
            cachedTokens: 0,
            thoughtsTokens: 0,
            totalTokens: 120,
          },
        },
      }),
      makeRecord({
        models: {
          'qwen-max': {
            requests: 4,
            inputTokens: 200,
            outputTokens: 100,
            cachedTokens: 0,
            thoughtsTokens: 0,
            totalTokens: 300,
          },
        },
      }),
    ];

    const report = aggregateUsage(records, 'all');

    // 3 + 2 + 4 = 9
    expect(report.totalRequests).toBe(9);
  });

  it('includes totalDurationMs in topTools', () => {
    const records = [
      makeRecord({
        tools: {
          totalCalls: 5,
          totalSuccess: 4,
          totalFail: 1,
          byName: {
            edit: { count: 3, success: 2, fail: 1, totalDurationMs: 1500 },
            bash: { count: 2, success: 2, fail: 0, totalDurationMs: 800 },
          },
        },
      }),
      makeRecord({
        tools: {
          totalCalls: 3,
          totalSuccess: 3,
          totalFail: 0,
          byName: {
            edit: { count: 2, success: 2, fail: 0, totalDurationMs: 1000 },
            grep: { count: 1, success: 1, fail: 0, totalDurationMs: 200 },
          },
        },
      }),
    ];

    const report = aggregateUsage(records, 'all');

    const editTool = report.tools.topTools.find((t) => t.name === 'edit');
    expect(editTool).toBeDefined();
    expect(editTool!.totalDurationMs).toBe(2500); // 1500 + 1000

    const bashTool = report.tools.topTools.find((t) => t.name === 'bash');
    expect(bashTool).toBeDefined();
    expect(bashTool!.totalDurationMs).toBe(800);

    const grepTool = report.tools.topTools.find((t) => t.name === 'grep');
    expect(grepTool).toBeDefined();
    expect(grepTool!.totalDurationMs).toBe(200);
  });

  it('handles tools without totalDurationMs (backward compat)', () => {
    const records = [
      makeRecord({
        tools: {
          totalCalls: 2,
          totalSuccess: 2,
          totalFail: 0,
          byName: {
            edit: { count: 2, success: 2, fail: 0 },
          },
        },
      }),
    ];

    const report = aggregateUsage(records, 'all');

    const editTool = report.tools.topTools.find((t) => t.name === 'edit');
    expect(editTool).toBeDefined();
    expect(editTool!.totalDurationMs).toBe(0);
  });

  it('returns zero for all new fields when no records match', () => {
    const report = aggregateUsage([], 'all');

    expect(report.totalLatencyMs).toBe(0);
    expect(report.totalRequests).toBe(0);
    expect(report.tools.topTools).toEqual([]);
  });
});

// Regression coverage for issue #4994: opening /stats during the first-ever
// turn followed by /clear or process exit used to write the same sessionId
// twice into usage_record.jsonl, permanently inflating every aggregate 2x.
describe('loadUsageHistory + persistSessionUsage (issue #4994 regression)', () => {
  let tmpHome: string;
  let originalQwenHome: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-usage-history-'));
    originalQwenHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = path.join(tmpHome, '.qwen');
    fs.mkdirSync(process.env['QWEN_HOME'], { recursive: true });
  });

  afterEach(() => {
    if (originalQwenHome === undefined) delete process.env['QWEN_HOME'];
    else process.env['QWEN_HOME'] = originalQwenHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function plantChatJsonl(sessionId: string, tokens: number) {
    const cwd = '/repro/project';
    const start = new Date('2026-06-11T00:00:00Z').toISOString();
    const mid = new Date('2026-06-11T00:01:00Z').toISOString();
    const end = new Date('2026-06-11T00:02:00Z').toISOString();
    const projDir = path.join(
      process.env['QWEN_HOME']!,
      'projects',
      'repro-project',
    );
    fs.mkdirSync(path.join(projDir, 'chats'), { recursive: true });
    const records = [
      {
        sessionId,
        cwd,
        uuid: 'u1',
        parentUuid: null,
        timestamp: start,
        type: 'user',
        message: { role: 'user', content: 'hi' },
      },
      {
        sessionId,
        cwd,
        uuid: 'u2',
        parentUuid: 'u1',
        timestamp: mid,
        type: 'system',
        subtype: 'ui_telemetry',
        systemPayload: {
          uiEvent: {
            'event.name': 'qwen-code.api_response',
            'event.timestamp': mid,
            response_id: 'r1',
            model: 'qwen-max',
            duration_ms: 1200,
            input_token_count: tokens * 0.6,
            output_token_count: tokens * 0.3,
            cached_content_token_count: 0,
            thoughts_token_count: tokens * 0.1,
            total_token_count: tokens,
            prompt_id: 'p1',
          },
        },
      },
      {
        sessionId,
        cwd,
        uuid: 'u3',
        parentUuid: 'u2',
        timestamp: end,
        type: 'assistant',
        message: { role: 'assistant', content: 'ok' },
      },
    ];
    fs.writeFileSync(
      path.join(projDir, 'chats', `${sessionId}.jsonl`),
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
  }

  function makeLiveMetrics(tokens: number): SessionMetrics {
    return {
      models: {
        'qwen-max': {
          api: { totalRequests: 1, totalErrors: 0, totalLatencyMs: 1200 },
          tokens: {
            prompt: tokens * 0.6,
            candidates: tokens * 0.3,
            total: tokens,
            cached: 0,
            thoughts: tokens * 0.1,
          },
          bySource: {},
        },
      },
      tools: {
        totalCalls: 0,
        totalSuccess: 0,
        totalFail: 0,
        totalDurationMs: 0,
        totalDecisions: {
          [ToolCallDecision.ACCEPT]: 0,
          [ToolCallDecision.REJECT]: 0,
          [ToolCallDecision.MODIFY]: 0,
          [ToolCallDecision.AUTO_ACCEPT]: 0,
        },
        byName: {},
      },
      files: { totalLinesAdded: 0, totalLinesRemoved: 0 },
    };
  }

  it('read-side: dedups duplicate sessionId records already on disk (last-wins)', async () => {
    // Simulate a usage_record.jsonl already corrupted by the pre-fix bug:
    // two records with the same sessionId.
    const sessionId = 'sess-dup-1';
    const usagePath = path.join(
      process.env['QWEN_HOME']!,
      'usage_record.jsonl',
    );
    const rec = (totalTokens: number) => ({
      version: 1 as const,
      sessionId,
      timestamp: Date.now(),
      startTime: Date.now() - 60000,
      project: '/p',
      durationMs: 60000,
      totalLatencyMs: 1200,
      models: {
        'qwen-max': {
          requests: 1,
          inputTokens: totalTokens * 0.6,
          outputTokens: totalTokens * 0.3,
          cachedTokens: 0,
          thoughtsTokens: totalTokens * 0.1,
          totalTokens,
        },
      },
      tools: { totalCalls: 0, totalSuccess: 0, totalFail: 0, byName: {} },
      files: { linesAdded: 0, linesRemoved: 0 },
    });
    fs.writeFileSync(
      usagePath,
      JSON.stringify(rec(1000)) + '\n' + JSON.stringify(rec(1600)) + '\n',
    );

    const records = await loadUsageHistory();

    expect(records).toHaveLength(1);
    // Last-wins: the second record (1600 tokens) survives.
    expect(records[0]!.models['qwen-max']!.totalTokens).toBe(1600);

    const report = aggregateUsage(records, 'all');
    expect(report.sessionCount).toBe(1);
  });

  it('write-side: rebuildFromSessionJsonl skips the in-progress session when currentSessionId is passed', async () => {
    const sessionId = 'sess-in-progress';
    plantChatJsonl(sessionId, 1600);
    const usagePath = path.join(
      process.env['QWEN_HOME']!,
      'usage_record.jsonl',
    );

    // First /stats open during the live session.
    const first = await loadUsageHistory(sessionId);
    expect(first).toHaveLength(1);
    // Critically: the file must NOT contain the in-progress session.
    expect(fs.existsSync(usagePath)).toBe(false);

    // /clear or process exit writes the authoritative record exactly once.
    persistSessionUsage({
      sessionId,
      startTime: new Date('2026-06-11T00:00:00Z'),
      endTime: new Date('2026-06-11T00:02:00Z'),
      project: '/repro/project',
      metrics: makeLiveMetrics(1600),
    });
    const lines = fs.readFileSync(usagePath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);

    // Subsequent /stats open after session end aggregates exactly one record.
    const second = await loadUsageHistory();
    expect(second).toHaveLength(1);
    const report = aggregateUsage(second, 'all');
    expect(report.sessionCount).toBe(1);
    let totalTokens = 0;
    for (const m of Object.values(report.models)) totalTokens += m.totalTokens;
    expect(totalTokens).toBe(1600);
  });

  it('end-to-end: /stats during first turn + /clear must not 2x the session', async () => {
    const sessionId = 'sess-e2e';
    plantChatJsonl(sessionId, 1600);

    // Step 1: open /stats (first time) during the live session.
    await loadUsageHistory(sessionId);

    // Step 2: /clear or exit.
    persistSessionUsage({
      sessionId,
      startTime: new Date('2026-06-11T00:00:00Z'),
      endTime: new Date('2026-06-11T00:02:00Z'),
      project: '/repro/project',
      metrics: makeLiveMetrics(1600),
    });

    // Step 3: re-open /stats.
    const records = await loadUsageHistory();
    const report = aggregateUsage(records, 'all');

    expect(report.sessionCount).toBe(1);
    let totalTokens = 0;
    for (const m of Object.values(report.models)) totalTokens += m.totalTokens;
    expect(totalTokens).toBe(1600);
  });
});
