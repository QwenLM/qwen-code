/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const { debugMock } = vi.hoisted(() => ({ debugMock: vi.fn() }));

// The factory intercepts every `createDebugLogger` caller in this module
// graph, not just usageHistoryService: jsonl-utils builds its own logger and
// calls warn/error on the tolerant-parse and read paths. A partial mock turns
// those into `TypeError: ... is not a function`, so the whole DebugLogger
// interface has to be here.
vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: () => ({
    isEnabled: () => false,
    debug: debugMock,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  metricsToUsageRecord as toRecord,
  aggregateUsage,
  dedupBySessionId,
  deduplicateIdentifiedRootHistory,
  getTimeRangeBounds,
  metricsToRunUsageRecord,
  getTranscriptScope,
  loadUsageHistory,
  loadUsageHistoryWithLive,
  persistSessionUsage,
  persistUsageBeforeTranscriptDeletion,
  prepareUsageBeforeTranscriptDeletion,
  commitUsageBeforeTranscriptDeletion,
  _resetReplayCacheForTest,
  identifiedConsumptionKey,
} from './usageHistoryService.js';
import { ToolCallDecision } from '../telemetry/tool-call-decision.js';
import { SessionService } from './sessionService.js';
import {
  buildUsageDashboard,
  loadUsageDashboardSources,
  localDateKey,
} from './usage-dashboard-service.js';
import { UiTelemetryService } from '../telemetry/uiTelemetry.js';
import type { SessionMetrics, UiEvent } from '../telemetry/uiTelemetry.js';
import type { UsageSummaryRecord } from './usageHistoryService.js';

/** ToolCallDecision counts: accept, reject, modify, auto-accept. */
const decisions = (
  accept: number,
  reject: number,
  modify: number,
  autoAccept: number,
) => ({
  [ToolCallDecision.ACCEPT]: accept,
  [ToolCallDecision.REJECT]: reject,
  [ToolCallDecision.MODIFY]: modify,
  [ToolCallDecision.AUTO_ACCEPT]: autoAccept,
});

// SessionMetrics model entry: api [requests, errors, latencyMs], tokens
// [prompt, candidates, total, cached, thoughts].
const modelMetrics = (
  [totalRequests, totalErrors, totalLatencyMs]: number[],
  [prompt, candidates, total, cached, thoughts]: number[],
) => ({
  api: { totalRequests, totalErrors, totalLatencyMs },
  tokens: { prompt, candidates, total, cached, thoughts },
  bySource: {},
});

function makeMetrics(overrides?: Partial<SessionMetrics>): SessionMetrics {
  return {
    models: {
      'qwen-max': modelMetrics([5, 0, 3200], [1000, 500, 1500, 200, 100]),
    },
    tools: {
      totalCalls: 10,
      totalSuccess: 8,
      totalFail: 2,
      totalDurationMs: 5000,
      totalDecisions: decisions(5, 1, 0, 4),
      byName: {
        edit: {
          count: 6,
          success: 5,
          fail: 1,
          durationMs: 3000,
          decisions: decisions(3, 1, 0, 2),
        },
        bash: {
          count: 4,
          success: 3,
          fail: 1,
          durationMs: 2000,
          decisions: decisions(2, 0, 0, 2),
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
        'qwen-max': modelMetrics([3, 0, 2000], [500, 200, 700, 0, 0]),
        'qwen-turbo': modelMetrics([2, 1, 1500], [300, 100, 400, 50, 0]),
      },
    });

    const record = toRecord('session-1', '/project', 1000, 5000, metrics);

    expect(record.totalLatencyMs).toBe(3500); // 2000 + 1500
  });

  it('populates totalDurationMs for each tool in byName', () => {
    const metrics = makeMetrics();

    const record = toRecord('session-2', '/project', 1000, 6000, metrics);

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

    const record = toRecord('session-3', '/project', 0, 1000, metrics);

    expect(record.totalLatencyMs).toBe(0);
  });

  it('preserves existing fields correctly alongside new fields', () => {
    const metrics = makeMetrics();

    const record = toRecord('session-4', '/my/project', 1000, 4000, metrics);

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

  it('copies SessionMetrics.skills into the persisted record', () => {
    const skills = {
      totalCalls: 3,
      totalSuccess: 3,
      totalFail: 0,
      byName: {
        qreview: { count: 2, success: 2, fail: 0 },
        simplify: { count: 1, success: 1, fail: 0 },
      },
    };
    // A clone, so the expectation cannot share a reference with the input.
    const metrics = makeMetrics({ skills: structuredClone(skills) });
    const record = toRecord('s', '/p', 0, 1000, metrics);
    expect(record.skills).toEqual(skills);
  });

  it('omits skills when SessionMetrics has none', () => {
    const record = toRecord('s', '/p', 0, 1000, makeMetrics());
    expect(record.skills).toBeUndefined();
  });

  it('persists successful request identities separately from failures', () => {
    const telemetry = new UiTelemetryService();
    telemetry.addEvent({
      'event.name': 'qwen-code.api_response',
      execution_id: 'successful-call',
      model: 'qwen-max',
      duration_ms: 10,
      input_token_count: 100,
      output_token_count: 0,
      cached_content_token_count: 0,
      thoughts_token_count: 0,
      total_token_count: 100,
    } as UiEvent);
    telemetry.addEvent({
      'event.name': 'qwen-code.api_error',
      execution_id: 'failed-call',
      model: 'qwen-max',
      duration_ms: 20,
      error_message: 'failed',
    } as UiEvent);

    const record = toRecord('s', '/p', 0, 1000, telemetry.getLiveMetrics());

    expect(record.requestExecutionIds).toEqual([
      'failed-call',
      'successful-call',
    ]);
    expect(record.successfulRequestExecutionIds).toEqual(['successful-call']);
    expect(record.models['qwen-max']).toMatchObject({ requests: 2, errors: 1 });
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

/** A per-model usage entry with no cached tokens. */
const modelUsage = (
  requests: number,
  inputTokens: number,
  outputTokens: number,
  totalTokens: number,
  thoughtsTokens = 0,
) => ({
  requests,
  inputTokens,
  outputTokens,
  cachedTokens: 0,
  thoughtsTokens,
  totalTokens,
});

const totalTokensOf = (report: ReturnType<typeof aggregateUsage>) =>
  Object.values(report.models).reduce((sum, m) => sum + m.totalTokens, 0);

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
          'qwen-max': modelUsage(3, 100, 50, 150),
          'qwen-turbo': modelUsage(2, 80, 40, 120),
        },
      }),
      makeRecord({ models: { 'qwen-max': modelUsage(4, 200, 100, 300) } }),
    ];

    const report = aggregateUsage(records, 'all');

    // 3 + 2 + 4 = 9
    expect(report.totalRequests).toBe(9);
  });

  it('includes totalDurationMs in topTools', () => {
    const records = [
      makeRecord(), // default tools: edit 1500 ms, bash 800 ms
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

    // edit: 1500 + 1000
    for (const [name, ms] of [
      ['edit', 2500],
      ['bash', 800],
      ['grep', 200],
    ] as const) {
      const tool = report.tools.topTools.find((t) => t.name === name);
      expect(tool).toBeDefined();
      expect(tool!.totalDurationMs).toBe(ms);
    }
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

/** Points QWEN_HOME at a fresh temp dir for each case; returns its getter. */
function useTempQwenHome(prefix: string) {
  let tmpHome: string;
  let originalQwenHome: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    originalQwenHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = path.join(tmpHome, '.qwen');
    fs.mkdirSync(process.env['QWEN_HOME'], { recursive: true });
  });

  afterEach(() => {
    if (originalQwenHome === undefined) delete process.env['QWEN_HOME'];
    else process.env['QWEN_HOME'] = originalQwenHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  return () => tmpHome;
}

const usagePath = () =>
  path.join(process.env['QWEN_HOME']!, 'usage_record.jsonl');
const usageLines = () =>
  fs.readFileSync(usagePath(), 'utf8').trim().split('\n');

// Writes $QWEN_HOME/projects/<project>/chats/<sessionId>.jsonl: a user turn
// at 00:00 of `day`, an api_response telemetry event worth `tokens` at 00:01
// (when given), and an assistant turn at 00:02 (when `assistant`).
function writeTranscript(
  project: string,
  sessionId: string,
  opts: {
    cwd: string;
    day: string;
    durationMs: number;
    tokens?: number;
    assistant?: boolean;
    executionId?: string;
  },
): string {
  const dir = path.join(
    process.env['QWEN_HOME']!,
    'projects',
    project,
    'chats',
  );
  fs.mkdirSync(dir, { recursive: true });
  const at = (minute: number) => `${opts.day}T00:0${minute}:00.000Z`;
  const base = { sessionId, cwd: opts.cwd };
  const { tokens } = opts;
  const records: unknown[] = [
    {
      ...base,
      uuid: 'u1',
      parentUuid: null,
      timestamp: at(0),
      type: 'user',
      message: { role: 'user', content: 'hi' },
    },
  ];
  if (tokens !== undefined) {
    records.push({
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
          ...(opts.executionId ? { execution_id: opts.executionId } : {}),
          duration_ms: opts.durationMs,
          input_token_count: tokens * 0.6,
          output_token_count: tokens * 0.3,
          cached_content_token_count: 0,
          thoughts_token_count: tokens * 0.1,
          total_token_count: tokens,
          prompt_id: 'p1',
        },
      },
    });
  }
  if (opts.assistant) {
    records.push({
      ...base,
      uuid: 'u3',
      parentUuid: 'u2',
      timestamp: at(2),
      type: 'assistant',
      message: { role: 'assistant', content: 'ok' },
    });
  }
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(
    filePath,
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
  return filePath;
}

function writeSessionTranscript(
  cwd: string,
  sessionId: string,
  opts: Omit<Parameters<typeof writeTranscript>[2], 'cwd'>,
): string {
  const filePath = new SessionService(cwd, {
    runtimeBaseDir: process.env['QWEN_HOME']!,
  }).getSessionTranscriptPath(sessionId);
  return writeTranscript(
    path.basename(path.dirname(path.dirname(filePath))),
    sessionId,
    { ...opts, cwd },
  );
}

function appendNativeResponse(
  filePath: string,
  sessionId: string,
  timestamp: string,
  executionId: string | undefined,
  tokens = 500,
): UiEvent {
  const event = {
    'event.name': 'qwen-code.api_response',
    'event.timestamp': timestamp,
    response_id: executionId,
    execution_id: executionId,
    model: 'qwen-max',
    duration_ms: 700,
    input_token_count: tokens * 0.6,
    output_token_count: tokens * 0.3,
    cached_content_token_count: 0,
    thoughts_token_count: tokens * 0.1,
    total_token_count: tokens,
    prompt_id: executionId,
  } as UiEvent;
  fs.appendFileSync(
    filePath,
    JSON.stringify({
      sessionId,
      cwd: '/repro/project',
      uuid: executionId,
      parentUuid: 'u3',
      timestamp,
      type: 'system',
      subtype: 'ui_telemetry',
      systemPayload: { uiEvent: event },
    }) + '\n',
  );
  return event;
}

function appendNativeToolCall(
  filePath: string,
  sessionId: string,
  timestamp: string,
  linesAdded: number,
  linesRemoved: number,
  outerTimestamp = timestamp,
): void {
  fs.appendFileSync(
    filePath,
    `${JSON.stringify({
      sessionId,
      cwd: '/repro/project',
      timestamp: outerTimestamp,
      type: 'system',
      subtype: 'ui_telemetry',
      systemPayload: {
        uiEvent: {
          'event.name': 'qwen-code.tool_call',
          'event.timestamp': timestamp,
          call_id: `tool-${timestamp}`,
          function_name: 'edit',
          function_args: { file_path: '/repro/project/demo.ts' },
          duration_ms: 20,
          success: true,
          metadata: {
            model_added_lines: linesAdded,
            model_removed_lines: linesRemoved,
          },
        },
      },
    })}\n`,
  );
}

// Regression coverage for issue #4994: opening /stats during the first-ever
// turn followed by /clear or process exit used to write the same sessionId
// twice into usage_record.jsonl, permanently inflating every aggregate 2x.
describe('loadUsageHistory + persistSessionUsage (issue #4994 regression)', () => {
  useTempQwenHome('qwen-usage-history-');
  beforeEach(() => {
    debugMock.mockClear();
  });

  const plantChatJsonl = (sessionId: string, tokens: number) =>
    writeTranscript('repro-project', sessionId, {
      cwd: '/repro/project',
      day: '2026-06-11',
      durationMs: 1200,
      tokens,
      assistant: true,
    });

  // What /clear or process exit writes for the planted 1600-token session.
  const persistLive = (sessionId: string, tokens = 1600) =>
    persistSessionUsage({
      sessionId,
      startTime: new Date('2026-06-11T00:00:00Z'),
      endTime: new Date('2026-06-11T00:02:00Z'),
      project: '/repro/project',
      metrics: {
        models: {
          'qwen-max': modelMetrics(
            [1, 0, 1200],
            [tokens * 0.6, tokens * 0.3, tokens, 0, tokens * 0.1],
          ),
        },
        tools: {
          totalCalls: 0,
          totalSuccess: 0,
          totalFail: 0,
          totalDurationMs: 0,
          totalDecisions: decisions(0, 0, 0, 0),
          byName: {},
        },
        files: { totalLinesAdded: 0, totalLinesRemoved: 0 },
      },
    });

  it('read-side: dedups duplicate sessionId records already on disk (last-wins)', async () => {
    // A usage_record.jsonl already corrupted by the pre-fix bug.
    seedPersisted([
      persistedRec('sess-dup-1', 1000, true),
      persistedRec('sess-dup-1', 1600, true),
    ]);

    const records = await loadUsageHistory();

    expect(records).toHaveLength(1);
    // Last-wins: the second record (1600 tokens) survives.
    expect(records[0]!.models['qwen-max']!.totalTokens).toBe(1600);

    const report = aggregateUsage(records, 'all');
    expect(report.sessionCount).toBe(1);
  });

  it('write-side: rebuildFromSessionJsonl skips the in-progress session when skipSessionInRebuild is passed', async () => {
    const sessionId = 'sess-in-progress';
    plantChatJsonl(sessionId, 1600);

    // First /stats open during the live session.
    const first = await loadUsageHistory(sessionId);
    expect(first).toHaveLength(1);
    // Critically: the file must NOT contain the in-progress session.
    expect(fs.existsSync(usagePath())).toBe(false);

    // /clear or process exit writes the authoritative record exactly once.
    persistLive(sessionId);
    expect(usageLines()).toHaveLength(1);

    // Subsequent /stats open after session end aggregates exactly one record.
    const second = await loadUsageHistory();
    expect(second).toHaveLength(1);
    const report = aggregateUsage(second, 'all');
    expect(report.sessionCount).toBe(1);
    expect(totalTokensOf(report)).toBe(1600);
  });

  it('read-only: persistRebuild:false rebuilds without writing usage_record.jsonl', async () => {
    const sessionId = 'sess-readonly';
    plantChatJsonl(sessionId, 1600);

    // The daemon dashboard loads read-only: it rebuilds + returns data but must
    // not write to ~/.qwen on a GET.
    const records = await loadUsageHistory(undefined, {
      persistRebuild: false,
    });
    expect(records).toHaveLength(1);
    expect(records[0]!.sessionId).toBe(sessionId);
    expect(fs.existsSync(usagePath())).toBe(false);

    // The default (persisting) load still migrates the rebuilt records to disk.
    await loadUsageHistory();
    expect(fs.existsSync(usagePath())).toBe(true);
  });

  it('rebuild excludes the prompt ledger sidecar from transcript enumeration', async () => {
    plantChatJsonl('sess-real', 1600);
    // The ledger sidecar shares the chats dir and ends in `.jsonl`; a
    // summarizable transcript renamed to the sidecar name would surface as a
    // second session if it were ingested.
    fs.renameSync(
      plantChatJsonl('sess-ghost', 800),
      planted('sess-real.ledger'),
    );

    const records = await loadUsageHistory(undefined, {
      persistRebuild: false,
    });
    expect(records).toHaveLength(1);
    expect(records[0]!.sessionId).toBe('sess-real');
  });

  it('end-to-end: /stats during first turn + /clear must not 2x the session', async () => {
    const sessionId = 'sess-e2e';
    plantChatJsonl(sessionId, 1600);

    // Step 1: open /stats (first time) during the live session.
    await loadUsageHistory(sessionId);

    // Step 2: /clear or exit.
    persistLive(sessionId);

    // Step 3: re-open /stats.
    const records = await loadUsageHistory();
    const report = aggregateUsage(records, 'all');

    expect(report.sessionCount).toBe(1);
    expect(totalTokensOf(report)).toBe(1600);
  });

  // loadUsageHistoryWithLive: the daemon usage-dashboard loader. Unlike
  // loadUsageHistory (persisted file verbatim when non-empty), it unions the
  // persisted history with a replay of recent transcripts so daemon / Web Shell
  // and in-progress sessions — which only the TUI /clear path ever persists —
  // are counted. See issue: Web Shell "today" undercounted ~20x.
  function planted(sessionId: string): string {
    return path.join(
      process.env['QWEN_HOME']!,
      'projects',
      'repro-project',
      'chats',
      `${sessionId}.jsonl`,
    );
  }
  function seedPersisted(records: UsageSummaryRecord[]) {
    fs.writeFileSync(
      usagePath(),
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
  }
  // `split` spreads the tokens 60/30/10 over input/output/thoughts instead of
  // all to input.
  function persistedRec(sessionId: string, totalTokens: number, split = false) {
    const [input, output, thoughts] = split
      ? [totalTokens * 0.6, totalTokens * 0.3, totalTokens * 0.1]
      : [totalTokens, 0, 0];
    return {
      version: 1 as const,
      sessionId,
      timestamp: Date.now(),
      startTime: Date.now() - 60000,
      project: '/p',
      durationMs: 60000,
      totalLatencyMs: 1200,
      models: {
        'qwen-max': modelUsage(1, input, output, totalTokens, thoughts),
      },
      tools: { totalCalls: 0, totalSuccess: 0, totalFail: 0, byName: {} },
      files: { linesAdded: 0, linesRemoved: 0 },
    };
  }
  /** Ages a planted transcript well past the default trailing window. */
  function ageTranscript(sessionId: string) {
    const stale = Date.now() - 100 * 24 * 60 * 60 * 1000;
    fs.utimesSync(planted(sessionId), stale / 1000, stale / 1000);
  }

  it('withLive: unions a never-persisted (daemon) session with the persisted history', async () => {
    // Persisted: a finalized TUI session. Transcript-only: a daemon / Web Shell
    // session that /clear never wrote to usage_record.jsonl.
    seedPersisted([persistedRec('sess-persisted', 1000)]);
    plantChatJsonl('sess-daemon', 1600);

    const merged = await loadUsageHistoryWithLive();
    const ids = merged.map((r) => r.sessionId).sort();
    expect(ids).toEqual(['sess-daemon', 'sess-persisted']);

    // 1000 persisted + 1600 replayed from the daemon transcript.
    expect(totalTokensOf(aggregateUsage(merged, 'all'))).toBe(2600);

    // Read-only: the persisted file must still hold only the original record.
    expect(usageLines()).toHaveLength(1);
  });

  it('withLive: a persisted session with a live transcript is not double-counted (persisted wins)', async () => {
    // Same project and sessionId in both sources must keep the persisted value.
    seedPersisted([
      { ...persistedRec('sess-both', 1000), project: '/repro/project' },
    ]);
    plantChatJsonl('sess-both', 1600);

    const merged = await loadUsageHistoryWithLive();
    expect(merged).toHaveLength(1);
    expect(merged[0]!.sessionId).toBe('sess-both');
    expect(merged[0]!.models['qwen-max']!.totalTokens).toBe(1000);
  });

  it('withLive: preserves a prior transcript beside a disjoint run-scoped record', async () => {
    const sessionId = 'sess-transcript-and-later-run';
    plantChatJsonl(sessionId, 1000);
    const runStart = Date.parse('2026-06-11T01:00:00Z');
    seedPersisted([runRec(sessionId, 200, runStart, runStart + 60_000)]);

    const merged = await loadUsageHistoryWithLive({ sinceMs: 0 });

    expect(merged.some((r) => r.transcriptRebuild === true)).toBe(true);
    expect(merged).toHaveLength(2);
    expect(totalTokensOf(aggregateUsage(merged, 'all'))).toBe(1200);
  });

  it('discovers never-persisted daemon usage beyond a known run project', async () => {
    const knownSession = 'known-project-session';
    const daemonSession = 'other-project-daemon';
    const knownProject = '/a/project';
    const service = new SessionService(knownProject, {
      runtimeBaseDir: process.env['QWEN_HOME']!,
    });
    const knownTranscript = service.getSessionTranscriptPath(knownSession);
    writeTranscript(
      path.basename(path.dirname(path.dirname(knownTranscript))),
      knownSession,
      {
        cwd: knownProject,
        day: '2026-06-11',
        durationMs: 1200,
        tokens: 1000,
        assistant: true,
      },
    );
    writeTranscript('other-daemon-project', daemonSession, {
      cwd: '/other/project',
      day: '2026-06-11',
      durationMs: 1200,
      tokens: 500,
      assistant: true,
    });
    const runStart = Date.parse('2026-06-12T00:00:00Z');
    seedPersisted([
      {
        ...runRec(knownSession, 200, runStart, runStart + 60_000),
        project: knownProject,
      },
    ]);

    const records = await loadUsageHistoryWithLive({ sinceMs: 0 });
    const report = aggregateUsage(records, 'all');

    expect(report.sessionCount).toBe(3);
    expect(totalTokensOf(report)).toBe(1700);
    expect(
      records.some(
        (record) =>
          record.sessionId === daemonSession && record.transcriptRebuild,
      ),
    ).toBe(true);
    expect(usageLines()).toHaveLength(1);
  });

  it('loadUsageHistory: rebuilds only known run-scoped transcripts without discovering other sessions', async () => {
    const sessionId = 'sess-known-run-history';
    plantChatJsonl(sessionId, 1000);
    plantChatJsonl('sess-never-persisted', 777);
    const runStart = Date.parse('2026-06-11T01:00:00Z');
    seedPersisted([runRec(sessionId, 200, runStart, runStart + 60_000)]);

    const records = await loadUsageHistory();

    expect(records).toHaveLength(2);
    expect(records.every((r) => r.sessionId === sessionId)).toBe(true);
    expect(records.some((r) => r.transcriptRebuild === true)).toBe(true);
    expect(totalTokensOf(aggregateUsage(records, 'all'))).toBe(1200);
    // A boundary-limited supplement is in-memory, not another authoritative
    // full-session snapshot to append on disk.
    expect(usageLines()).toHaveLength(1);
  });

  it('uses verified project paths for scoped reads without discovering other sessions', async () => {
    const sessionId = 'known-project-run';
    const project = process.cwd();
    const service = new SessionService(project, {
      runtimeBaseDir: process.env['QWEN_HOME']!,
    });
    const filePath = service.getSessionTranscriptPath(sessionId);
    writeTranscript(
      path.basename(path.dirname(path.dirname(filePath))),
      sessionId,
      {
        cwd: project,
        day: '2026-06-11',
        durationMs: 1200,
        tokens: 1000,
        assistant: true,
      },
    );
    expect(fs.existsSync(filePath)).toBe(true);
    const start = Date.parse('2026-06-12T00:00:00Z');
    seedPersisted([
      { ...runRec(sessionId, 200, start, start + 60_000), project },
    ]);
    const projectsDir = path.join(process.env['QWEN_HOME']!, 'projects');
    const directorySpy = vi.spyOn(fs, 'readdirSync');
    const openSpy = vi.spyOn(fs.promises, 'open');
    try {
      for (let i = 0; i < 2; i++) {
        const records = await loadUsageHistory();
        expect(totalTokensOf(aggregateUsage(records, 'all'))).toBe(1200);
      }
      expect(
        openSpy.mock.calls.filter(([openedPath]) => openedPath === filePath),
      ).toHaveLength(1);
      expect(directorySpy).not.toHaveBeenCalledWith(projectsDir);
      // A different caller root does not disqualify durable metadata paths.
      const mismatch = await loadUsageHistory(undefined, {
        projectRoot: path.join(project, 'another-workspace'),
      });
      expect(totalTokensOf(aggregateUsage(mismatch, 'all'))).toBe(1200);
      expect(
        openSpy.mock.calls.filter(([openedPath]) => openedPath === filePath),
      ).toHaveLength(1);
      expect(directorySpy).not.toHaveBeenCalledWith(projectsDir);
    } finally {
      directorySpy.mockRestore();
      openSpy.mockRestore();
    }
    expect(usageLines()).toHaveLength(1);
  });

  it('uses every verified project path for multi-project scoped reads', async () => {
    const start = Date.parse('2026-06-12T00:00:00Z');
    const fixtures = [
      { sessionId: 'scope-alpha', project: '/alpha/project', tokens: 600 },
      { sessionId: 'scope-beta', project: '/beta/project', tokens: 900 },
    ].map(({ sessionId, project, tokens }) => {
      const filePath = new SessionService(project, {
        runtimeBaseDir: process.env['QWEN_HOME']!,
      }).getSessionTranscriptPath(sessionId);
      writeTranscript(
        path.basename(path.dirname(path.dirname(filePath))),
        sessionId,
        {
          cwd: project,
          day: '2026-06-11',
          durationMs: 1200,
          tokens,
          assistant: true,
        },
      );
      return {
        filePath,
        record: {
          ...runRec(sessionId, tokens, start, start + 60_000),
          project,
        },
      };
    });
    writeTranscript('unlisted-project', 'unlisted-session', {
      cwd: '/unlisted/project',
      day: '2026-06-11',
      durationMs: 1200,
      tokens: 700,
    });
    seedPersisted(fixtures.map(({ record }) => record));
    const projectsDir = path.join(process.env['QWEN_HOME']!, 'projects');
    const directorySpy = vi.spyOn(fs, 'readdirSync');
    const openSpy = vi.spyOn(fs.promises, 'open');
    const selectedPaths = new Set(fixtures.map(({ filePath }) => filePath));
    try {
      for (let i = 0; i < 2; i++) {
        const records = await loadUsageHistory();
        expect(records.map(({ sessionId }) => sessionId).sort()).toEqual([
          'scope-alpha',
          'scope-alpha',
          'scope-beta',
          'scope-beta',
        ]);
        expect(totalTokensOf(aggregateUsage(records, 'all'))).toBe(3000);
      }
      expect(
        openSpy.mock.calls.filter(([openedPath]) =>
          selectedPaths.has(String(openedPath)),
        ),
      ).toHaveLength(2);
      expect(directorySpy).not.toHaveBeenCalledWith(projectsDir);
    } finally {
      directorySpy.mockRestore();
      openSpy.mockRestore();
    }
    expect(usageLines()).toHaveLength(2);
  });

  it('discovers an unmapped session beside a verified project path', async () => {
    const start = Date.parse('2026-06-12T00:00:00Z');
    const resolvedProject = '/resolved/project';
    const unmappedProject = '/unmapped/project';
    const resolvedId = 'resolved-session';
    const unmappedId = 'unmapped-session';
    const resolvedFile = new SessionService(resolvedProject, {
      runtimeBaseDir: process.env['QWEN_HOME']!,
    }).getSessionTranscriptPath(resolvedId);
    const unmappedFile = new SessionService(unmappedProject, {
      runtimeBaseDir: process.env['QWEN_HOME']!,
    }).getSessionTranscriptPath(unmappedId);
    writeTranscript(
      path.basename(path.dirname(path.dirname(resolvedFile))),
      resolvedId,
      {
        cwd: resolvedProject,
        day: '2026-06-11',
        durationMs: 1200,
        tokens: 600,
        assistant: true,
      },
    );
    writeTranscript(
      path.basename(path.dirname(path.dirname(unmappedFile))),
      unmappedId,
      {
        cwd: unmappedProject,
        day: '2026-06-11',
        durationMs: 1200,
        tokens: 900,
        assistant: true,
      },
    );
    writeTranscript('unlisted-project', 'unlisted-session', {
      cwd: '/unlisted/project',
      day: '2026-06-11',
      durationMs: 1200,
      tokens: 700,
    });
    seedPersisted([
      {
        ...runRec(resolvedId, 600, start, start + 60_000),
        project: resolvedProject,
      },
    ]);
    const projectsDir = path.join(process.env['QWEN_HOME']!, 'projects');
    const directorySpy = vi.spyOn(fs, 'readdirSync');
    const openSpy = vi.spyOn(fs.promises, 'open');
    const selectedPaths = new Set([resolvedFile, unmappedFile]);
    try {
      for (let i = 0; i < 2; i++) {
        const records = await loadUsageHistory(unmappedId);
        expect(records.map(({ sessionId }) => sessionId).sort()).toEqual([
          'resolved-session',
          'resolved-session',
          'unmapped-session',
        ]);
        expect(totalTokensOf(aggregateUsage(records, 'all'))).toBe(2100);
      }
      expect(openSpy).toHaveBeenCalledWith(resolvedFile, expect.anything());
      expect(openSpy).toHaveBeenCalledWith(unmappedFile, expect.anything());
      expect(
        openSpy.mock.calls.filter(([openedPath]) =>
          selectedPaths.has(String(openedPath)),
        ),
      ).toHaveLength(2);
      expect(directorySpy).toHaveBeenCalledWith(projectsDir);
    } finally {
      directorySpy.mockRestore();
      openSpy.mockRestore();
    }
    expect(usageLines()).toHaveLength(1);
  });

  it('retains discovery and distinct project records for ambiguous ids', async () => {
    const sessionId = 'ambiguous-scoped-session';
    const start = Date.parse('2026-06-12T00:00:00Z');
    const records = ['/a/project', '/z/project'].map((project) => {
      const filePath = new SessionService(project, {
        runtimeBaseDir: process.env['QWEN_HOME']!,
      }).getSessionTranscriptPath(sessionId);
      writeTranscript(
        path.basename(path.dirname(path.dirname(filePath))),
        sessionId,
        {
          cwd: project,
          day: '2026-06-11',
          durationMs: 1200,
          tokens: project === '/a/project' ? 1000 : 2000,
          assistant: true,
        },
      );
      return {
        filePath,
        record: { ...runRec(sessionId, 200, start, start + 60_000), project },
      };
    });
    seedPersisted(records.map(({ record }) => record));
    const projectsDir = path.join(process.env['QWEN_HOME']!, 'projects');
    const directorySpy = vi.spyOn(fs, 'readdirSync');
    try {
      const result = await loadUsageHistory();
      expect(totalTokensOf(aggregateUsage(result, 'all'))).toBe(3400);
      expect(result.find((record) => record.transcriptRebuild)?.project).toBe(
        '/a/project',
      );
      expect(directorySpy).toHaveBeenCalledWith(projectsDir);
    } finally {
      directorySpy.mockRestore();
    }
  });

  it('withLive preserves equal session ids belonging to distinct projects', async () => {
    const sessionId = '11111111-1111-4111-8111-111111111111';
    for (const [project, tokens, executionId] of [
      ['/project/a', 100, 'request-a'],
      ['/project/b', 200, 'request-b'],
    ] as const) {
      const transcript = new SessionService(project, {
        runtimeBaseDir: process.env['QWEN_HOME']!,
      }).getSessionTranscriptPath(sessionId);
      writeTranscript(
        path.basename(path.dirname(path.dirname(transcript))),
        sessionId,
        {
          cwd: project,
          day: '2026-06-11',
          durationMs: 1200,
          tokens,
          executionId,
          assistant: true,
        },
      );
    }

    const records = await loadUsageHistoryWithLive({
      qwenHomeDir: process.env['QWEN_HOME']!,
      persistedRecords: [],
    });

    expect(records.map((record) => record.project).sort()).toEqual([
      '/project/a',
      '/project/b',
    ]);
    expect(totalTokensOf(aggregateUsage(records, 'all'))).toBe(300);
  });

  it('withLive scopes replay windows by project for a reused session id', async () => {
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const at = (time: string) => Date.parse(`2026-06-11T${time}:00.000Z`);
    let aTranscript = '';
    for (const project of ['/project/a', '/project/b']) {
      const transcript = new SessionService(project, {
        runtimeBaseDir: process.env['QWEN_HOME']!,
      }).getSessionTranscriptPath(sessionId);
      if (project === '/project/a') aTranscript = transcript;
      writeTranscript(
        path.basename(path.dirname(path.dirname(transcript))),
        sessionId,
        { cwd: project, day: '2026-06-11', durationMs: 1200, assistant: true },
      );
    }
    appendNativeResponse(
      aTranscript,
      sessionId,
      '2026-06-11T00:30:00.000Z',
      'request-a-late',
    );
    seedPersisted([
      {
        ...runRec(sessionId, 100, at('00:10'), at('00:20')),
        project: '/project/a',
      },
      {
        ...runRec(sessionId, 200, at('01:00'), at('02:00')),
        project: '/project/b',
      },
    ]);

    const records = await loadUsageHistoryWithLive({ sinceMs: 0 });

    const supplement = records.find(
      (record) => record.transcriptSupplement === true,
    );
    expect(supplement?.project).toBe('/project/a');
    expect(supplement?.requestExecutionIds).toEqual(['request-a-late']);
    expect(totalTokensOf(aggregateUsage(records, 'all'))).toBe(800);
  });

  it('withLive validates covered transcripts once before reusing metadata', async () => {
    const sessionId = 'covered-transcript';
    const project = '/repro/project';
    const filePath = new SessionService(project, {
      runtimeBaseDir: process.env['QWEN_HOME']!,
    }).getSessionTranscriptPath(sessionId);
    writeTranscript(
      path.basename(path.dirname(path.dirname(filePath))),
      sessionId,
      {
        cwd: project,
        day: '2026-06-11',
        durationMs: 1200,
        tokens: 1000,
        assistant: true,
      },
    );
    seedPersisted([
      {
        ...persistedRec(sessionId, 1000),
        project,
        startTime: Date.parse('2026-06-11T00:00:00.000Z'),
        timestamp: Date.parse('2026-06-11T00:02:00.000Z'),
      },
    ]);
    const statSpy = vi.spyOn(fs, 'statSync');
    const openSpy = vi.spyOn(fs.promises, 'open');
    try {
      const first = await loadUsageHistoryWithLive({ sinceMs: 0 });
      expect(first.map((record) => record.project)).toEqual([project]);
      expect(getTranscriptScope(first)?.root).toBe(process.env['QWEN_HOME']);
      expect(
        getTranscriptScope(first)
          ?.pathsBySessionId.get(sessionId)
          ?.has(filePath),
      ).toBe(true);
      const second = await loadUsageHistoryWithLive({ sinceMs: 0 });
      expect(second).toEqual(first);
      expect(
        getTranscriptScope(second)
          ?.pathsBySessionId.get(sessionId)
          ?.has(filePath),
      ).toBe(true);
      expect(
        statSpy.mock.calls.filter(([path]) => path === filePath),
      ).toHaveLength(2);
      expect(
        openSpy.mock.calls.filter(([path]) => path === filePath),
      ).toHaveLength(1);
      appendNativeResponse(
        filePath,
        sessionId,
        '2026-06-11T00:03:00.000Z',
        'covered-transcript-appended',
        500,
      );
      const third = await loadUsageHistoryWithLive({ sinceMs: 0 });
      expect(totalTokensOf(aggregateUsage(third, 'all'))).toBe(1500);
      expect(
        statSpy.mock.calls.filter(([path]) => path === filePath),
      ).toHaveLength(3);
      expect(
        openSpy.mock.calls.filter(([path]) => path === filePath),
      ).toHaveLength(2);
    } finally {
      statSpy.mockRestore();
      openSpy.mockRestore();
    }
  });

  it('withLive: with a persisted base, the trailing window excludes stale transcripts (sinceMs:0 includes them)', async () => {
    // A persisted base means the window engages (old days come from the file).
    seedPersisted([persistedRec('sess-persisted', 500)]);
    plantChatJsonl('sess-old', 1600);
    ageTranscript('sess-old');

    // Default window: the stale, never-persisted transcript is not replayed.
    const windowed = await loadUsageHistoryWithLive();
    expect(windowed.map((r) => r.sessionId)).toEqual(['sess-persisted']);
    // An unbounded window picks it back up alongside the persisted record.
    const all = await loadUsageHistoryWithLive({ sinceMs: 0 });
    expect(all.map((r) => r.sessionId).sort()).toEqual([
      'sess-old',
      'sess-persisted',
    ]);
  });

  it('withLive: with no persisted base, replays full history (no silent trailing-window truncation)', async () => {
    // No usage_record.jsonl: nothing else covers old history, so an old
    // transcript must still be replayed rather than truncated by the window.
    plantChatJsonl('sess-old', 1600);
    ageTranscript('sess-old');

    const merged = await loadUsageHistoryWithLive();
    expect(merged.map((r) => r.sessionId)).toEqual(['sess-old']);
  });

  it('withLive: read-only rebuild — never writes usage_record.jsonl', async () => {
    plantChatJsonl('sess-daemon-only', 1600);

    const merged = await loadUsageHistoryWithLive();
    expect(merged.map((r) => r.sessionId)).toEqual(['sess-daemon-only']);
    expect(fs.existsSync(usagePath())).toBe(false);
  });

  it('withLive: all sessions persisted (empty rebuild) returns the persisted records as-is', async () => {
    // Common case: no live transcripts at all, only the persisted file.
    seedPersisted([persistedRec('sess-only', 500)]);

    const merged = await loadUsageHistoryWithLive();
    expect(merged).toHaveLength(1);
    expect(merged[0]!.sessionId).toBe('sess-only');
    expect(merged[0]!.models['qwen-max']!.totalTokens).toBe(500);
  });

  it('withLive: a corrupt usage_record.jsonl falls back to a full transcript replay', async () => {
    // No usable persisted base (garbage file) — the loader must still surface
    // the daemon transcript rather than returning nothing.
    fs.writeFileSync(usagePath(), '{ this is not valid json\nalso broken}\n');
    plantChatJsonl('sess-daemon', 1600);

    const merged = await loadUsageHistoryWithLive();
    expect(merged.map((r) => r.sessionId)).toEqual(['sess-daemon']);
    // The garbage lines must be recovered by the tolerant JSONL parse, not by
    // loadUsageHistoryWithLive's catch-all: a throwing `jsonl.read` would reach
    // that catch and log here, hiding the regression behind a green test.
    expect(debugMock).not.toHaveBeenCalledWith(
      expect.stringContaining('failed to read usage file'),
    );
  });

  it.skipIf(process.platform === 'win32')(
    'withLive: skips and logs non-regular transcript entries',
    async () => {
      // Phase 1's statSync refuses this FIFO before any read — the log asserted
      // below pins that skip. statSync is not mocked here, so the open is never
      // reached. The fd-level isFile() recheck covers a file swapped in AFTER
      // Phase 1 — see 'settles and skips a FIFO swapped in after the Phase-1
      // stat'. Observed in the wild from a test-suite leftover. The mkfifo call
      // is skipped on Windows, matching storage.test.ts.
      plantChatJsonl('sess-real', 1600);
      const fifoPath = planted('sess-fifo');
      const mkfifo = spawnSync('mkfifo', [fifoPath], { stdio: 'inherit' });
      expect(mkfifo.status).toBe(0);
      const danglingPath = planted('dangling');
      fs.symlinkSync(
        path.join(path.dirname(danglingPath), 'missing'),
        danglingPath,
      );

      const merged = await loadUsageHistoryWithLive();
      expect(merged.map((r) => r.sessionId)).toEqual(['sess-real']);
      expect(debugMock).toHaveBeenCalledWith(
        `rebuildFromSessionJsonl: skipping non-regular entry ${fifoPath}`,
      );
      expect(debugMock).toHaveBeenCalledWith(
        expect.stringContaining(
          `rebuildFromSessionJsonl: cannot stat ${danglingPath}`,
        ),
      );
    },
  );

  /** A run-scoped record covering [startMs, endMs]. */
  const runRec = (
    sessionId: string,
    totalTokens: number,
    startMs: number,
    endMs: number,
  ) => ({
    ...persistedRec(sessionId, totalTokens),
    startTime: startMs,
    timestamp: endMs,
    durationMs: endMs - startMs,
    runScoped: true,
  });

  const DAY = 24 * 60 * 60 * 1000;
  const t0 = Date.parse('2026-06-01T00:00:00Z');

  it('migrates older sessions before excluding the current session from durable writes', async () => {
    plantChatJsonl('older-session', 1000);

    const records = await loadUsageHistory('current-session');

    expect(records).toHaveLength(1);
    expect(records[0]!.sessionId).toBe('older-session');
    expect(records[0]!.transcriptRebuild).toBe(true);
    expect(records[0]!.models['qwen-max']!.totalTokens).toBe(1000);
    expect(usageLines()).toHaveLength(1);
  });

  it('uses actual header projects before applying cold candidate windows', async () => {
    const sessionId = 'cold-candidate-two-projects';
    const projectA = '/cold-candidate/project-a';
    const projectB = '/cold-candidate/project-b';
    seedPersisted([
      {
        ...runRec(
          sessionId,
          200,
          Date.parse('2026-07-01T00:00:30.000Z'),
          Date.parse('2026-07-01T02:00:00.000Z'),
        ),
        project: projectA,
      },
    ]);
    writeTranscript('cold-candidate-b', sessionId, {
      cwd: projectB,
      day: '2026-07-01',
      durationMs: 1000,
      tokens: 300,
    });

    const records = await loadUsageHistoryWithLive({ sinceMs: 0 });

    expect(totalTokensOf(aggregateUsage(records, 'all'))).toBe(500);
    expect(
      records.find((record) => record.project === projectB)?.models['qwen-max']
        ?.totalTokens,
    ).toBe(300);
  });

  it('loads persisted usage from the explicitly selected runtime root', async () => {
    seedPersisted([persistedRec('ambient-only', 100)]);
    const explicitRoot = path.join(
      process.env['QWEN_HOME']!,
      'explicit-runtime',
    );
    fs.mkdirSync(explicitRoot, { recursive: true });
    fs.writeFileSync(
      path.join(explicitRoot, 'usage_record.jsonl'),
      `${JSON.stringify(persistedRec('selected-root-only', 200))}\n`,
    );
    const records = await loadUsageHistoryWithLive({
      qwenHomeDir: explicitRoot,
      sinceMs: 0,
    });
    expect(records.map((record) => record.sessionId)).toEqual([
      'selected-root-only',
    ]);
  });

  it('does not assign future ownership to a non-finite persisted clock', async () => {
    const sessionId = 'malformed-future-clock';
    const project = '/malformed/future-clock';
    const readAt = Date.parse('2026-07-02T00:02:20.000Z');
    seedPersisted([
      {
        ...persistedRec(sessionId, 100, true),
        project,
        startTime: readAt - 120_000,
        timestamp: 'not-a-date',
        runScoped: true,
        requestExecutionIds: ['owned-response'],
      } as unknown as UsageSummaryRecord,
    ]);
    writeTranscript('malformed-future-clock', sessionId, {
      cwd: project,
      day: '2026-07-02',
      durationMs: 1_000,
      tokens: 100,
      executionId: 'owned-response',
    });
    const control = await loadUsageHistoryWithLive({
      qwenHomeDir: process.env['QWEN_HOME']!,
      persistedRecords: [],
      sinceMs: 0,
      readAt,
    });
    expect(control).toHaveLength(1);
    for (const [loader, records] of [
      [
        'ordinary',
        await loadUsageHistory(undefined, { persistRebuild: false, readAt }),
      ],
      ['live', await loadUsageHistoryWithLive({ sinceMs: 0, readAt })],
    ] as const) {
      expect({ loader, count: records.length }).toEqual({ loader, count: 1 });
      expect(records[0]).toMatchObject({
        transcriptRebuild: true,
        models: { 'qwen-max': { requests: 1, totalTokens: 100 } },
      });
    }
  });

  it('isolates malformed persisted owner identities from valid history', async () => {
    const valid = { ...persistedRec('valid-owner', 100), project: '/valid' };
    const malformedOwner = { toString: null, valueOf: null };
    fs.writeFileSync(
      usagePath(),
      [
        JSON.stringify(valid),
        JSON.stringify({ ...valid, sessionId: malformedOwner }),
        JSON.stringify({ ...valid, project: malformedOwner }),
      ].join('\n') + '\n',
    );

    const history = await loadUsageHistory();
    const live = await loadUsageHistoryWithLive({ sinceMs: 0 });
    const sources = await loadUsageDashboardSources([]);
    expect(history).toMatchObject([{ sessionId: 'valid-owner' }]);
    expect(live).toMatchObject([{ sessionId: 'valid-owner' }]);
    expect(sources.records).toMatchObject([{ sessionId: 'valid-owner' }]);
    expect(
      buildUsageDashboard(
        sources.records,
        { range: 'all' },
        sources.ledgerDaily,
        sources.runtimeScopes,
      ).summary,
    ).toMatchObject({ totalTokens: 100, requests: 1 });
  });

  it('keeps the latest cumulative snapshot across the ended/future partition', async () => {
    const now = Date.now();
    seedPersisted([
      {
        ...persistedRec('legacy-future-snapshot', 1000),
        timestamp: now - 1_000,
      },
      {
        ...persistedRec('legacy-future-snapshot', 1600),
        startTime: now,
        timestamp: now + 60_000,
      },
    ]);
    for (const records of [
      await loadUsageHistory(undefined, {
        persistRebuild: false,
        readAt: now,
      }),
      await loadUsageHistoryWithLive({ sinceMs: 0, readAt: now }),
    ]) {
      expect(records).toHaveLength(1);
      expect(records[0]?.timestamp).toBe(now + 60_000);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(now + 60_000);
      try {
        expect(totalTokensOf(aggregateUsage(records, 'all'))).toBe(1600);
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it('treats null model metrics as incomplete identity evidence', () => {
    const malformed = {
      ...persistedRec('null-model-metrics', 100),
      requestExecutionIds: ['known-id'],
      models: { 'qwen-max': null },
    } as unknown as UsageSummaryRecord;
    expect(identifiedConsumptionKey(malformed)).toBeUndefined();
  });

  it('skips transcript indexing when a legacy record has no project', async () => {
    seedPersisted([
      {
        ...persistedRec('missing-project', 100),
        transcriptRebuild: true,
        project: undefined,
      } as unknown as UsageSummaryRecord,
      {
        ...persistedRec('healthy-legacy', 200),
        transcriptRebuild: true,
      },
    ]);
    const records = await loadUsageHistory(undefined, {
      persistRebuild: false,
    });
    expect(records).toHaveLength(2);
    expect(
      records.find((record) => record.sessionId === 'healthy-legacy'),
    ).toMatchObject({ models: { 'qwen-max': { totalTokens: 200 } } });
  });

  it('keeps a single ended/future partition when the clock crosses the record', async () => {
    const timestamp = Date.now() + 120_000;
    const record = {
      ...persistedRec('clock-partition', 100),
      startTime: timestamp - 1_000,
      timestamp,
      runScoped: true,
      requestExecutionIds: ['clock-partition-response'],
    };
    seedPersisted([record]);
    const clock = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(timestamp - 1)
      .mockReturnValueOnce(timestamp - 1)
      .mockReturnValueOnce(timestamp - 1)
      .mockReturnValue(timestamp);
    try {
      const records = await loadUsageHistory(undefined, {
        persistRebuild: false,
      });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        sessionId: 'clock-partition',
        timestamp,
      });
    } finally {
      clock.mockRestore();
    }
  });

  it.each(['not-an-array', { 0: 'owned', length: 1 }])(
    'retains future records with malformed requestExecutionIds: %j',
    async (malformedIds) => {
      const record = {
        ...persistedRec('malformed-future', 100),
        timestamp: Date.now() + 60_000,
        runScoped: true,
        requestExecutionIds: malformedIds as unknown as string[],
      };
      seedPersisted([record]);
      await expect(loadUsageHistory()).resolves.toHaveLength(1);
      await expect(loadUsageHistoryWithLive()).resolves.toHaveLength(1);
    },
  );

  it('retains the richer complete file payload in either root order', () => {
    const makeRecord = (files: { linesAdded: number; linesRemoved: number }) =>
      ({
        ...persistedRec('shared-file-observation', 100),
        project: '/shared/file-observation',
        startTime: 1000,
        timestamp: 1100,
        durationMs: 100,
        runScoped: true,
        requestExecutionIds: ['shared-file-response'],
        successfulRequestExecutionIds: ['shared-file-response'],
        files,
      }) as UsageSummaryRecord;
    for (const variants of [
      [
        [10, 0],
        [5, 20],
      ],
      [
        [5, 20],
        [10, 0],
      ],
    ] as const) {
      const histories = variants.map(([added, removed]) => [
        makeRecord({ linesAdded: added, linesRemoved: removed }),
      ]);
      deduplicateIdentifiedRootHistory(histories);
      const merged = histories.flat();
      expect(merged).toHaveLength(1);
      expect(merged[0]!.files).toEqual({
        linesAdded: 5,
        linesRemoved: 20,
      });
      expect(merged[0]!.models['qwen-max']!.totalTokens).toBe(100);
    }
  });

  it('adversarial: pure durable copies retain the selected later clock in either root order', () => {
    const sessionId = 'durable-copy-clock';
    const project = '/durable/copy-clock';
    const copy = (
      startTime: number,
      timestamp: number,
    ): UsageSummaryRecord => ({
      ...persistedRec(sessionId, 100, true),
      project,
      startTime,
      timestamp,
      durationMs: timestamp - startTime,
      runScoped: true,
      requestExecutionIds: ['same-durable-response'],
      successfulRequestExecutionIds: ['same-durable-response'],
    });
    const early = copy(
      Date.parse('2026-06-11T00:00:00.000Z'),
      Date.parse('2026-06-11T00:01:00.000Z'),
    );
    const late = copy(
      Date.parse('2026-06-12T00:02:00.000Z'),
      Date.parse('2026-06-12T00:04:00.000Z'),
    );

    for (const ordered of [
      [early, late],
      [late, early],
    ]) {
      const histories = [ordered.map((record) => structuredClone(record))];
      deduplicateIdentifiedRootHistory(histories);
      expect(histories.flat()).toHaveLength(1);
      expect(histories[0]![0]).toMatchObject({
        timestamp: late.timestamp,
        startTime: late.startTime,
        durationMs: late.durationMs,
        models: { 'qwen-max': { requests: 1, totalTokens: 100 } },
      });
      expect(new Date(histories[0]![0]!.timestamp).toISOString()).toBe(
        '2026-06-12T00:04:00.000Z',
      );
    }
  });

  it('adversarial: native copies use the newest fully valid clock in either root order', () => {
    const sessionId = 'native-copy-clock';
    const project = '/native/copy-clock';
    const copy = (
      timestamp: number,
      startTime = timestamp - 60_000,
    ): UsageSummaryRecord => ({
      ...persistedRec(sessionId, 100, true),
      project,
      startTime,
      timestamp,
      durationMs: timestamp - startTime,
      transcriptRebuild: true,
      requestExecutionIds: ['same-native-response'],
      successfulRequestExecutionIds: ['same-native-response'],
    });
    const early = copy(Date.parse('2026-06-11T00:01:00.000Z'));
    const late = copy(Date.parse('2026-06-12T00:02:00.000Z'));
    const invalid = copy(3000, NaN);

    for (const ordered of [
      [invalid, early, late],
      [late, invalid, early],
    ]) {
      const histories = [ordered.map((record) => structuredClone(record))];
      deduplicateIdentifiedRootHistory(histories);
      expect(histories.flat()).toHaveLength(1);
      expect(histories[0]![0]).toMatchObject({
        timestamp: late.timestamp,
        startTime: late.startTime,
        durationMs: late.durationMs,
        transcriptRebuild: true,
        models: { 'qwen-max': { requests: 1, totalTokens: 100 } },
      });
      expect(new Date(histories[0]![0]!.timestamp).toISOString()).toBe(
        '2026-06-12T00:02:00.000Z',
      );
    }
  });

  it('adversarial: tied copies retain the richer tool and skill details in either root order', () => {
    const sessionId = 'identified-rich-details';
    const project = '/identified/rich-details';
    const richTools: UsageSummaryRecord['tools'] = {
      totalCalls: 1,
      totalSuccess: 1,
      totalFail: 0,
      byName: {
        edit: { count: 1, success: 1, fail: 0, totalDurationMs: 25 },
      },
    };
    const richSkills: NonNullable<UsageSummaryRecord['skills']> = {
      totalCalls: 1,
      totalSuccess: 1,
      totalFail: 0,
      byName: { qreview: { count: 1, success: 1, fail: 0 } },
    };
    const copy = (
      rich: boolean,
      emptySkills: UsageSummaryRecord['skills'] | undefined,
    ): UsageSummaryRecord => ({
      ...persistedRec(sessionId, 100, true),
      project,
      startTime: 1000,
      timestamp: 1100,
      durationMs: 100,
      runScoped: true,
      requestExecutionIds: ['same-detail-response'],
      successfulRequestExecutionIds: ['same-detail-response'],
      tools: rich
        ? structuredClone(richTools)
        : { totalCalls: 1, totalSuccess: 1, totalFail: 0, byName: {} },
      ...(rich
        ? { skills: structuredClone(richSkills) }
        : emptySkills
          ? { skills: structuredClone(emptySkills) }
          : {}),
    });

    for (const emptySkills of [
      { totalCalls: 1, totalSuccess: 1, totalFail: 0, byName: {} },
      undefined,
    ] as const) {
      for (const ordered of [
        [copy(false, emptySkills), copy(true, emptySkills)],
        [copy(true, emptySkills), copy(false, emptySkills)],
      ]) {
        const histories = [ordered];
        deduplicateIdentifiedRootHistory(histories);
        const merged = histories.flat();
        expect(merged).toHaveLength(1);
        expect(merged[0]!.tools).toEqual(richTools);
        expect(merged[0]!.skills).toEqual(richSkills);
        const report = aggregateUsage(merged, 'all');
        expect(report.totalRequests).toBe(1);
        expect(totalTokensOf(report)).toBe(100);
        expect(report.tools.topTools).toEqual([
          {
            name: 'edit',
            count: 1,
            success: 1,
            fail: 0,
            totalDurationMs: 25,
          },
        ]);
        expect(report.skills.topSkills).toEqual([
          { name: 'qreview', count: 1, success: 1, fail: 0 },
        ]);
      }
    }
  });

  it('does not inherit success evidence from conflicting copies', () => {
    const makeRecord = (
      sessionId: string,
      successfulRequestExecutionIds?: string[],
    ): UsageSummaryRecord => {
      const base = persistedRec(sessionId, 100);
      return {
        ...base,
        project: '/shared/success-evidence',
        startTime: 1000,
        timestamp: 1100,
        durationMs: 100,
        runScoped: true,
        requestExecutionIds: ['a', 'b', 'c'],
        ...(successfulRequestExecutionIds
          ? { successfulRequestExecutionIds }
          : {}),
        models: {
          'qwen-max': {
            ...base.models['qwen-max']!,
            requests: 3,
            errors: 1,
          },
        },
      };
    };
    for (const records of [
      [
        makeRecord('sync-set-one', ['a', 'b']),
        makeRecord('sync-set-one', ['b', 'c']),
        makeRecord('sync-set-one'),
      ],
      [
        makeRecord('sync-set-two', ['b', 'c']),
        makeRecord('sync-set-two', ['a', 'b']),
        makeRecord('sync-set-two'),
      ],
    ]) {
      const histories = records.map((record) => [record]);
      deduplicateIdentifiedRootHistory(histories);
      const merged = histories.flat();
      expect(merged).toHaveLength(1);
      expect(merged[0]!.successfulRequestExecutionIds).toBeUndefined();
      expect('successfulRequestExecutionIds' in merged[0]!).toBe(false);
    }
  });

  it('deduplicates future persisted runs while preserving an earlier run', async () => {
    const now = Date.now();
    const future = {
      ...persistedRec('future-duplicate', 100),
      startTime: now,
      timestamp: now + 60_000,
      runScoped: true,
      requestExecutionIds: ['future-duplicate-response'],
    };
    seedPersisted([
      {
        ...persistedRec('previous-ended', 100),
        timestamp: now - 1_000,
        runScoped: true,
        requestExecutionIds: ['previous-ended-response'],
      },
      future,
      { ...future, models: structuredClone(future.models) },
    ]);
    for (const records of [
      await loadUsageHistory(),
      await loadUsageHistoryWithLive(),
    ]) {
      expect(records).toHaveLength(2);
      expect(
        records.filter((record) => record.sessionId === 'future-duplicate'),
      ).toHaveLength(1);
    }
  });

  it('suppresses a future-owned tool-only replay after the run ends', async () => {
    const now = Date.parse('2026-07-02T00:02:20.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    const sessionId = 'future-tool-only';
    const project = '/future/tool-only';
    const executionId = 'future-tool-response';
    seedPersisted([
      {
        ...persistedRec(sessionId, 100),
        project,
        startTime: now,
        timestamp: now + 60_000,
        runScoped: true,
        requestExecutionIds: [executionId],
        successfulRequestExecutionIds: [executionId],
        tools: {
          totalCalls: 1,
          totalSuccess: 1,
          totalFail: 0,
          byName: {
            edit: { count: 1, success: 1, fail: 0, totalDurationMs: 20 },
          },
        },
        files: { linesAdded: 7, linesRemoved: 3 },
      },
    ]);
    const file = writeTranscript('future-tool-only', sessionId, {
      cwd: project,
      day: '2026-07-02',
      durationMs: 1_000,
    });
    appendNativeResponse(
      file,
      sessionId,
      new Date(now + 1_000).toISOString(),
      executionId,
      100,
    );
    fs.appendFileSync(
      file,
      `${JSON.stringify({
        sessionId,
        cwd: project,
        timestamp: new Date(now + 2_000).toISOString(),
        type: 'system',
        subtype: 'ui_telemetry',
        systemPayload: {
          uiEvent: {
            'event.name': 'qwen-code.tool_call',
            'event.timestamp': new Date(now + 2_000).toISOString(),
            call_id: 'future-tool-call',
            function_name: 'edit',
            function_args: { file_path: `${project}/edit.ts` },
            duration_ms: 20,
            success: true,
            metadata: { model_added_lines: 7, model_removed_lines: 3 },
          },
        },
      })}\n`,
    );
    try {
      const cached = await loadUsageDashboardSources();
      vi.setSystemTime(now + 60_000);
      const after = buildUsageDashboard(
        cached.records,
        { range: 'all' },
        cached.ledgerDaily,
      ).summary;
      expect(after).toMatchObject({
        sessions: 1,
        requests: 1,
        totalTokens: 100,
        toolCalls: 1,
        linesAdded: 7,
        linesRemoved: 3,
      });
      const fresh = await loadUsageHistoryWithLive({ sinceMs: 0 });
      expect(fresh).toHaveLength(1);
      expect(fresh[0]).toMatchObject({
        sessionId,
        tools: { totalCalls: 1 },
        files: { linesAdded: 7, linesRemoved: 3 },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains only the independent past response beside a future-owned run', async () => {
    const sessionId = 'future-mixed-history';
    const project = '/future/mixed-history';
    const ownedId = 'owned-past-response';
    const independentId = 'independent-past-response';
    const now = Date.parse('2026-07-02T00:02:20.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    seedPersisted([
      {
        ...persistedRec(sessionId, 100),
        project,
        timestamp: now + 60_000,
        startTime: now,
        runScoped: true,
        requestExecutionIds: [ownedId, ''],
        successfulRequestExecutionIds: [ownedId],
      },
    ]);
    const file = writeTranscript('future-mixed-history', sessionId, {
      cwd: project,
      day: '2026-07-02',
      durationMs: 100,
      tokens: 100,
      executionId: ownedId,
    });
    appendNativeResponse(
      file,
      sessionId,
      '2026-07-02T00:01:30.000Z',
      independentId,
      100,
    );
    appendNativeResponse(
      file,
      sessionId,
      '2026-07-02T00:01:40.000Z',
      undefined,
      100,
    );
    try {
      const records = await loadUsageHistoryWithLive({ sinceMs: 0 });
      expect(records).toHaveLength(2);
      expect(
        records.filter((record) =>
          record.requestExecutionIds?.includes(ownedId),
        ),
      ).toHaveLength(1);
      expect(
        records.find((record) =>
          record.requestExecutionIds?.includes(independentId),
        ),
      ).toMatchObject({
        requestExecutionIds: [independentId],
        models: { 'qwen-max': { totalTokens: 200, requests: 2 } },
      });
      vi.setSystemTime(now + 60_000);
      expect(aggregateUsage(records, 'all')).toMatchObject({
        totalRequests: 3,
        models: { 'qwen-max': { totalTokens: 300, requests: 3 } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['request identity', { requestExecutionIds: ['future-response'] }],
    [
      'success identity',
      { successfulRequestExecutionIds: ['future-response'] },
    ],
    ['rebuild provenance', { transcriptRebuild: true }],
  ] satisfies Array<[string, Partial<UsageSummaryRecord>]>)(
    'uses cumulative last-wins for a future snapshot with %s',
    async (_label, fields) => {
      const future = {
        ...persistedRec('cumulative-future', 2000, true),
        project: '/future/cumulative',
        startTime: 1100,
        timestamp: 2000,
        ...fields,
      };
      seedPersisted([
        {
          ...persistedRec('cumulative-future', 1000, true),
          project: '/future/cumulative',
          startTime: 900,
          timestamp: 1000,
        },
        future,
      ]);
      for (const records of [
        await loadUsageHistory(undefined, {
          persistRebuild: false,
          readAt: 1500,
        }),
        await loadUsageHistoryWithLive({ sinceMs: 0, readAt: 1500 }),
      ]) {
        expect(records).toHaveLength(1);
        expect(records).toMatchObject([
          {
            timestamp: 2000,
            models: { 'qwen-max': { totalTokens: 2000 } },
          },
        ]);
      }
    },
  );

  it('does not let a future record bypass ended-run partitioning in the fast path', async () => {
    seedPersisted([
      {
        ...persistedRec('fast-future-owner', 1),
        project: '/fast/future-owner',
        startTime: 0,
        timestamp: 900,
        transcriptRebuild: true,
      },
      {
        ...persistedRec('fast-future-owner', 2),
        project: '/fast/future-owner',
        startTime: 1000,
        timestamp: 1200,
        runScoped: true,
      },
      {
        ...persistedRec('fast-future-owner', 3),
        project: '/fast/future-owner',
        startTime: 1100,
        timestamp: 2000,
        runScoped: true,
      },
    ]);
    const records = await loadUsageHistory(undefined, {
      persistRebuild: false,
      readAt: 1500,
    });
    expect(records).toHaveLength(3);
    expect(totalTokensOf(aggregateUsage(records, 'all'))).toBe(6);
    expect(records.find((record) => record.timestamp === 1200)).toBeDefined();
  });

  it('keeps replay-only reads free of durable future snapshots', async () => {
    seedPersisted([
      {
        ...persistedRec('future-replay-only', 100),
        timestamp: 2000,
      },
    ]);
    await expect(
      loadUsageHistoryWithLive({
        sinceMs: 0,
        readAt: 1500,
        includePersistedRecords: false,
      }),
    ).resolves.toEqual([]);
    await expect(
      loadUsageHistoryWithLive({ sinceMs: 0, readAt: 1500 }),
    ).resolves.toHaveLength(1);
  });

  it('adversarial: an identified future cumulative snapshot covers its older run delta', async () => {
    const sessionId = 'identified-future-cumulative';
    const project = '/future/identified-cumulative';
    const delta = {
      ...persistedRec(sessionId, 100, true),
      project,
      startTime: 2000,
      timestamp: 2100,
      durationMs: 100,
      runScoped: true,
      requestExecutionIds: ['a'],
      successfulRequestExecutionIds: ['a'],
    };
    const cumulative = {
      ...persistedRec(sessionId, 250, true),
      project,
      startTime: 1900,
      timestamp: 2200,
      durationMs: 300,
      requestExecutionIds: ['a', 'b'],
      successfulRequestExecutionIds: ['a', 'b'],
      models: { 'qwen-max': modelUsage(2, 150, 75, 250, 25) },
    };
    seedPersisted([delta, cumulative]);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1500);
    let dashboardRecords: UsageSummaryRecord[];
    try {
      dashboardRecords = (await loadUsageDashboardSources()).records;
    } finally {
      vi.useRealTimers();
    }

    for (const [loader, records] of [
      [
        'ordinary',
        await loadUsageHistory(undefined, {
          persistRebuild: false,
          readAt: 1500,
        }),
      ],
      ['live', await loadUsageHistoryWithLive({ sinceMs: 0, readAt: 1500 })],
      ['dashboard', dashboardRecords],
    ] as const) {
      expect({ loader, count: records.length }).toEqual({ loader, count: 1 });
      expect({ loader, record: records[0] }).toMatchObject({
        loader,
        record: {
          project,
          timestamp: 2200,
          requestExecutionIds: ['a', 'b'],
          models: { 'qwen-max': { requests: 2, totalTokens: 250 } },
        },
      });
      expect(records[0]!.runScoped).toBeUndefined();
      expect(aggregateUsage(records, 'all')).toMatchObject({
        totalRequests: 2,
        models: { 'qwen-max': { requests: 2, totalTokens: 250 } },
      });
    }

    seedPersisted([
      delta,
      {
        ...cumulative,
        requestExecutionIds: ['b', 'c'],
        successfulRequestExecutionIds: ['b', 'c'],
      },
    ]);
    const distinct = await loadUsageHistoryWithLive({
      sinceMs: 0,
      readAt: 1500,
    });
    expect(distinct).toHaveLength(2);
    expect(aggregateUsage(distinct, 'all')).toMatchObject({
      totalRequests: 3,
      models: { 'qwen-max': { requests: 3, totalTokens: 350 } },
    });
  });

  it('uses a newer unidentified cumulative future over an older native snapshot', async () => {
    const sessionId = 'ended-native-then-future-snapshot';
    const project = '/future/ended-native-then-future-snapshot';
    seedPersisted([
      {
        ...persistedRec(sessionId, 100, true),
        project,
        startTime: 1000,
        timestamp: 1100,
        durationMs: 100,
        transcriptRebuild: true,
      },
      {
        ...persistedRec(sessionId, 200),
        project,
        startTime: 1900,
        timestamp: 2000,
        durationMs: 100,
      },
    ]);
    for (const records of [
      await loadUsageHistory(undefined, {
        persistRebuild: false,
        readAt: 1500,
      }),
      await loadUsageHistoryWithLive({ sinceMs: 0, readAt: 1500 }),
    ]) {
      expect(records).toMatchObject([
        {
          timestamp: 2000,
          models: { 'qwen-max': { totalTokens: 200 } },
        },
      ]);
      expect(totalTokensOf(aggregateUsage(records, 'all'))).toBe(200);
    }
  });

  it('reduces future native snapshots with matching run deltas once', async () => {
    const project = '/future/native-and-delta';
    const base = {
      ...persistedRec('future-native-delta', 100, true),
      project,
      startTime: 2000,
      timestamp: 2100,
      durationMs: 100,
      requestExecutionIds: ['same-future-response'],
      successfulRequestExecutionIds: ['same-future-response'],
    };
    const native = {
      ...base,
      transcriptRebuild: true,
      tools: {
        totalCalls: 1,
        totalSuccess: 1,
        totalFail: 0,
        byName: {
          edit: { count: 1, success: 1, fail: 0, totalDurationMs: 20 },
        },
      },
      files: { linesAdded: 7, linesRemoved: 3 },
    };
    const delta = { ...base, runScoped: true };
    seedPersisted([native, delta]);
    for (const records of [
      await loadUsageHistory(undefined, {
        persistRebuild: false,
        readAt: 1500,
      }),
      await loadUsageHistoryWithLive({ sinceMs: 0, readAt: 1500 }),
    ]) {
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        transcriptRebuild: true,
        models: { 'qwen-max': { requests: 1, totalTokens: 100 } },
        tools: { totalCalls: 1 },
        files: { linesAdded: 7, linesRemoved: 3 },
      });
    }
    seedPersisted([
      native,
      {
        ...delta,
        requestExecutionIds: ['different-future-response'],
        successfulRequestExecutionIds: ['different-future-response'],
      },
    ]);
    const distinct = await loadUsageHistoryWithLive({
      sinceMs: 0,
      readAt: 1500,
    });
    expect(distinct).toHaveLength(2);
    expect(totalTokensOf(aggregateUsage(distinct, 'all'))).toBe(200);
  });

  it('retains a run delta over a future cumulative snapshot without losing older runs', async () => {
    const project = '/future/cumulative-with-delta';
    seedPersisted([
      {
        ...persistedRec('previous-independent-run', 500),
        project,
        startTime: 1000,
        timestamp: 1200,
        runScoped: true,
      },
      {
        ...persistedRec('future-cumulative-delta', 1000),
        project,
        startTime: 1000,
        timestamp: 2000,
      },
      {
        ...persistedRec('future-cumulative-delta', 2000),
        project,
        startTime: 1100,
        timestamp: 2100,
        runScoped: true,
      },
    ]);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1500);
    let dashboardRecords: UsageSummaryRecord[];
    try {
      dashboardRecords = (
        await loadUsageDashboardSources([process.env['QWEN_HOME']!])
      ).records;
    } finally {
      vi.useRealTimers();
    }
    for (const [loader, records] of [
      [
        'ordinary',
        await loadUsageHistory(undefined, {
          persistRebuild: false,
          readAt: 1500,
        }),
      ],
      ['live', await loadUsageHistoryWithLive({ sinceMs: 0, readAt: 1500 })],
      ['dashboard', dashboardRecords],
    ] as const) {
      expect({ loader, count: records.length }).toEqual({
        loader,
        count: 2,
      });
      expect({
        loader,
        previousRuns: records.filter(
          (record) => record.sessionId === 'previous-independent-run',
        ).length,
      }).toEqual({ loader, previousRuns: 1 });
      expect({
        loader,
        futureTimes: records
          .filter((record) => record.sessionId === 'future-cumulative-delta')
          .map((record) => record.timestamp),
      }).toEqual({ loader, futureTimes: [2100] });
      expect({
        loader,
        totalTokens: totalTokensOf(aggregateUsage(records, 'all')),
      }).toEqual({ loader, totalTokens: 2500 });
    }
  });

  it('clamps an out-of-order transcript header to a zero duration', async () => {
    const sessionId = 'out-of-order-native-header';
    const project = '/repro/project';
    const file = writeSessionTranscript(project, sessionId, {
      day: '2026-07-02',
      durationMs: 100,
      tokens: 100,
    });
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    const header = JSON.parse(lines[0]!) as { timestamp: string };
    header.timestamp = '2026-07-03T00:00:00.000Z';
    lines[0] = JSON.stringify(header);
    fs.writeFileSync(file, `${lines.join('\n')}\n`);

    const records = await loadUsageHistoryWithLive({
      sinceMs: 0,
      readAt: Date.parse('2026-07-04T00:00:00.000Z'),
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      project,
      transcriptRebuild: true,
      startTime: Date.parse('2026-07-02T00:01:00.000Z'),
      timestamp: Date.parse('2026-07-02T00:01:00.000Z'),
      durationMs: 0,
      models: { 'qwen-max': { requests: 1, totalTokens: 100 } },
    });
  });

  it('adversarial: recovers an invalid header clock from counted native events', async () => {
    const sessionId = 'invalid-header-event-clock';
    const project = '/repro/project';
    const file = writeSessionTranscript(project, sessionId, {
      day: '2026-07-02',
      durationMs: 100,
      tokens: 100,
    });
    appendNativeToolCall(file, sessionId, '2026-07-02T00:03:00.000Z', 7, 3);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    const header = JSON.parse(lines[0]!) as { timestamp: string };
    header.timestamp = 'not-a-timestamp';
    lines[0] = JSON.stringify(header);
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    const readAt = Date.parse('2026-07-04T00:00:00.000Z');

    for (const [loader, records] of [
      [
        'ordinary',
        await loadUsageHistory(undefined, {
          persistRebuild: false,
          readAt,
        }),
      ],
      ['live', await loadUsageHistoryWithLive({ sinceMs: 0, readAt })],
    ] as const) {
      expect({ loader, count: records.length }).toEqual({ loader, count: 1 });
      expect(records[0]).toMatchObject({
        project,
        transcriptRebuild: true,
        startTime: Date.parse('2026-07-02T00:01:00.000Z'),
        timestamp: Date.parse('2026-07-02T00:03:00.000Z'),
        durationMs: 120_000,
        models: { 'qwen-max': { requests: 1, totalTokens: 100 } },
        tools: {
          totalCalls: 1,
          byName: {
            edit: { count: 1, success: 1, fail: 0, totalDurationMs: 20 },
          },
        },
        files: { linesAdded: 7, linesRemoved: 3 },
      });
    }
  });

  it('retains tool observations after an invalid trailing timestamp', async () => {
    const sessionId = 'invalid-tail-with-tools';
    const project = '/repro/project';
    const file = writeSessionTranscript(project, sessionId, {
      day: '2026-07-02',
      durationMs: 100,
    });
    appendNativeToolCall(file, sessionId, '2026-07-02T00:01:00.000Z', 7, 3);
    fs.appendFileSync(
      file,
      `${JSON.stringify({
        sessionId,
        cwd: project,
        timestamp: 'not-a-timestamp',
        type: 'user',
        message: { role: 'user', content: 'tail' },
      })}\n`,
    );

    const records = await loadUsageHistoryWithLive({
      sinceMs: 0,
      readAt: Date.parse('2026-07-04T00:00:00.000Z'),
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      project,
      transcriptRebuild: true,
      durationMs: 60_000,
      tools: { totalCalls: 1 },
      files: { linesAdded: 7, linesRemoved: 3 },
    });
  });

  it('preserves a legacy supplement when the persisted run end is corrupt', async () => {
    const sessionId = 'legacy-corrupt-end-supplement';
    const project = '/legacy/corrupt-end-supplement';
    const startTime = Date.parse('2026-07-02T00:02:00.000Z');
    const readAt = Date.parse('2026-07-02T00:03:00.000Z');
    seedPersisted([
      {
        ...persistedRec(sessionId, 200),
        project,
        startTime,
        timestamp: 'not-a-date' as unknown as number,
        runScoped: true,
      },
    ]);
    const file = writeSessionTranscript(project, sessionId, {
      day: '2026-07-02',
      durationMs: 100,
      tokens: 100,
      executionId: 'prior-independent-response',
    });
    appendNativeResponse(
      file,
      sessionId,
      '2026-07-02T00:02:30.000Z',
      'partially-visible-run-response',
      50,
    );
    for (const records of [
      await loadUsageHistory(undefined, {
        persistRebuild: false,
        readAt,
      }),
      await loadUsageHistoryWithLive({ sinceMs: 0, readAt }),
    ]) {
      expect(aggregateUsage(records, 'all')).toMatchObject({
        totalRequests: 2,
        models: { 'qwen-max': { totalTokens: 300 } },
      });
      expect(
        records.find((record) =>
          record.requestExecutionIds?.includes('prior-independent-response'),
        ),
      ).toBeDefined();
    }
    expect(usageLines()).toHaveLength(1);
  });

  it('does not assign future ownership to a non-finite JSON timestamp', async () => {
    const sessionId = 'non-finite-json-clock';
    const project = '/repro/project';
    const responseId = 'non-finite-json-response';
    const readAt = Date.parse('2026-07-02T00:02:20.000Z');
    seedPersisted([
      {
        ...persistedRec(sessionId, 100, true),
        project,
        startTime: readAt - 60_000,
        timestamp: 1,
        runScoped: true,
        requestExecutionIds: [responseId],
        successfulRequestExecutionIds: [responseId],
      },
    ]);
    const corrupted = fs
      .readFileSync(usagePath(), 'utf8')
      .replace('"timestamp":1', '"timestamp":1e400');
    expect(corrupted).toContain('1e400');
    fs.writeFileSync(usagePath(), corrupted);
    writeSessionTranscript(project, sessionId, {
      day: '2026-07-02',
      durationMs: 100,
      tokens: 100,
      executionId: responseId,
    });

    for (const records of [
      await loadUsageHistory(undefined, {
        persistRebuild: false,
        readAt,
      }),
      await loadUsageHistoryWithLive({ sinceMs: 0, readAt }),
    ]) {
      expect(records).toMatchObject([
        {
          project,
          transcriptRebuild: true,
          models: { 'qwen-max': { requests: 1, totalTokens: 100 } },
        },
      ]);
    }
    expect(fs.readFileSync(usagePath(), 'utf8')).toBe(corrupted);
  });

  it('retains corrupted persisted timestamps without a transcript', async () => {
    const sessionId = 'durable-corrupt-clock';
    const readAt = Date.parse('2026-07-02T00:02:20.000Z');
    seedPersisted([
      {
        ...persistedRec(sessionId, 100, true),
        project: '/repro/project',
        startTime: readAt - 60_000,
        timestamp: 'not-a-date' as unknown as number,
        runScoped: true,
        requestExecutionIds: ['corrupt-clock-response'],
      },
    ]);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(readAt);
    let dashboardRecords: UsageSummaryRecord[];
    try {
      dashboardRecords = (
        await loadUsageDashboardSources([process.env['QWEN_HOME']!])
      ).records;
    } finally {
      vi.useRealTimers();
    }
    for (const records of [
      await loadUsageHistory(undefined, { persistRebuild: false, readAt }),
      await loadUsageHistoryWithLive({ sinceMs: 0, readAt }),
      dashboardRecords,
    ]) {
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        sessionId,
        models: { 'qwen-max': { totalTokens: 100 } },
      });
    }
  });

  it('keeps an earlier tool beside a future-owned out-of-order response', async () => {
    const sessionId = 'out-of-order-future-owned-tool';
    const startTime = Date.parse('2026-07-02T00:02:20.000Z');
    seedPersisted([
      {
        ...persistedRec(sessionId, 100, true),
        project: '/repro/project',
        startTime,
        timestamp: startTime + 60_000,
        runScoped: true,
        requestExecutionIds: ['owned-response'],
        successfulRequestExecutionIds: ['owned-response'],
      },
    ]);
    const file = writeTranscript('out-of-order-future-owned-tool', sessionId, {
      cwd: '/repro/project',
      day: '2026-07-02',
      durationMs: 100,
    });
    appendNativeToolCall(
      file,
      sessionId,
      new Date(startTime - 20_000).toISOString(),
      4,
      2,
    );
    appendNativeResponse(
      file,
      sessionId,
      new Date(startTime - 10_000).toISOString(),
      'owned-response',
      100,
    );
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(startTime);
    try {
      const records = await loadUsageHistoryWithLive({
        sinceMs: 0,
        readAt: startTime,
      });
      expect(records).toHaveLength(2);
      vi.setSystemTime(startTime + 60_000);
      expect(aggregateUsage(records, 'all')).toMatchObject({
        tools: { totalCalls: 1 },
        files: { linesAdded: 4, linesRemoved: 2 },
        models: { 'qwen-max': { totalTokens: 100, requests: 1 } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  describe('future-owned tools with older history', () => {
    const project = '/repro/project';
    const readAt = Date.parse('2026-07-02T00:02:20.000Z');
    const futureStart = readAt - 20_000;
    const futureEnd = readAt + 40_000;

    function futureWithOneTool(sessionId: string): UsageSummaryRecord {
      return {
        ...persistedRec(sessionId, 100, true),
        project,
        startTime: futureStart,
        timestamp: futureEnd,
        durationMs: futureEnd - futureStart,
        runScoped: true,
        requestExecutionIds: ['future-owned-response'],
        successfulRequestExecutionIds: ['future-owned-response'],
        tools: {
          totalCalls: 1,
          totalSuccess: 1,
          totalFail: 0,
          byName: {
            edit: { count: 1, success: 1, fail: 0, totalDurationMs: 20 },
          },
        },
        files: { linesAdded: 7, linesRemoved: 3 },
      };
    }

    it('uses a valid inner timestamp to exclude a future response', async () => {
      const sessionId = 'future-inner-timestamp-boundary';
      const file = writeSessionTranscript(project, sessionId, {
        day: '2026-07-02',
        durationMs: 100,
        tokens: 100,
        executionId: 'old-response',
      });
      const futureTimestamp = '2026-07-02T00:03:00.000Z';
      appendNativeResponse(
        file,
        sessionId,
        futureTimestamp,
        'future-response',
        200,
      );
      const rows = fs
        .readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      for (const row of rows) {
        if (row['timestamp'] === futureTimestamp) {
          row['timestamp'] = 'not-a-timestamp';
        }
      }
      fs.writeFileSync(
        file,
        `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
      );

      const records = await loadUsageHistory(undefined, {
        persistRebuild: false,
        readAt,
        beforeMsBySession: new Map([
          [sessionId, Date.parse('2026-07-02T00:02:00.000Z')],
        ]),
      });
      expect(records).toMatchObject([
        {
          transcriptRebuild: true,
          requestExecutionIds: ['old-response'],
          models: { 'qwen-max': { requests: 1, totalTokens: 100 } },
        },
      ]);
    });

    it('retains earlier tools beside an unreadable future-owned response', async () => {
      const sessionId = 'future-unreadable-owned-response';
      const responseId = 'unreadable-future-owned-response';
      seedPersisted([
        {
          ...persistedRec(sessionId, 100, true),
          project,
          startTime: futureStart,
          timestamp: futureEnd,
          runScoped: true,
          requestExecutionIds: [responseId],
          successfulRequestExecutionIds: [responseId],
        },
      ]);
      const file = writeSessionTranscript(project, sessionId, {
        day: '2026-07-02',
        durationMs: 100,
      });
      appendNativeToolCall(file, sessionId, '2026-07-02T00:01:00.000Z', 4, 2);
      appendNativeResponse(file, sessionId, 'not-a-timestamp', responseId, 100);

      const records = await loadUsageHistoryWithLive({
        sinceMs: 0,
        readAt,
      });
      expect(records).toHaveLength(2);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(futureEnd);
      try {
        expect(aggregateUsage(records, 'all')).toMatchObject({
          totalRequests: 1,
          tools: { totalCalls: 1 },
          files: { linesAdded: 4, linesRemoved: 2 },
          models: { 'qwen-max': { requests: 1, totalTokens: 100 } },
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not let a negative future start erase older independent usage', async () => {
      const sessionId = 'future-negative-start';
      seedPersisted([
        {
          ...futureWithOneTool(sessionId),
          startTime: -1,
          durationMs: NaN,
        },
      ]);
      const file = writeSessionTranscript(project, sessionId, {
        day: '2026-07-02',
        durationMs: 100,
        tokens: 100,
        executionId: 'independent-before-negative-start',
      });
      appendNativeToolCall(file, sessionId, '2026-07-02T00:01:00.000Z', 4, 2);
      const records = await loadUsageHistoryWithLive({
        sinceMs: 0,
        readAt,
      });
      expect(records).toHaveLength(2);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(futureEnd);
      try {
        expect(aggregateUsage(records, 'all')).toMatchObject({
          totalRequests: 2,
          tools: { totalCalls: 2 },
          files: { linesAdded: 11, linesRemoved: 5 },
          models: { 'qwen-max': { requests: 2, totalTokens: 200 } },
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps independent tools whose timestamps cannot be established', async () => {
      const sessionId = 'future-tool-unknown-timestamp';
      const readAt = Date.parse('2026-07-02T00:02:20.000Z');
      seedPersisted([
        {
          ...persistedRec(sessionId, 100, true),
          project: '/repro/project',
          startTime: NaN,
          timestamp: readAt + 60_000,
          runScoped: true,
          requestExecutionIds: ['unknown-clock-owned-response'],
          successfulRequestExecutionIds: ['unknown-clock-owned-response'],
        },
      ]);
      const file = writeTranscript('future-tool-unknown-timestamp', sessionId, {
        cwd: '/repro/project',
        day: '2026-07-02',
        durationMs: 100,
        tokens: 100,
        executionId: 'unknown-clock-owned-response',
      });
      appendNativeToolCall(file, sessionId, 'not-a-timestamp', 4, 2);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(readAt);
      try {
        const records = await loadUsageHistoryWithLive({ sinceMs: 0, readAt });
        expect(records).toHaveLength(2);
        vi.setSystemTime(readAt + 60_000);
        expect(aggregateUsage(records, 'all')).toMatchObject({
          tools: { totalCalls: 1 },
          files: { linesAdded: 4, linesRemoved: 2 },
          models: { 'qwen-max': { requests: 1, totalTokens: 100 } },
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps an older API response without duplicating future tools', async () => {
      const sessionId = 'future-mixed-owned-tools';
      seedPersisted([futureWithOneTool(sessionId)]);
      const file = writeTranscript('future-mixed-owned-tools', sessionId, {
        cwd: project,
        day: '2026-07-02',
        durationMs: 100,
        tokens: 100,
        executionId: 'older-independent-response',
      });
      appendNativeResponse(
        file,
        sessionId,
        new Date(readAt + 10_000).toISOString(),
        'future-owned-response',
        100,
      );
      appendNativeToolCall(
        file,
        sessionId,
        new Date(readAt + 20_000).toISOString(),
        7,
        3,
      );
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(readAt);
      try {
        const records = await loadUsageHistoryWithLive({
          sinceMs: 0,
          readAt,
        });
        expect(records).toHaveLength(2);
        vi.setSystemTime(futureEnd);
        expect(aggregateUsage(records, 'all')).toMatchObject({
          totalRequests: 2,
          tools: { totalCalls: 1 },
          files: { linesAdded: 7, linesRemoved: 3 },
          models: { 'qwen-max': { totalTokens: 200, requests: 2 } },
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('retains older tools while excluding duplicate future tools', async () => {
      const sessionId = 'future-owned-tools-older-tools';
      seedPersisted([futureWithOneTool(sessionId)]);
      const file = writeTranscript(
        'future-owned-tools-older-tools',
        sessionId,
        {
          cwd: project,
          day: '2026-07-02',
          durationMs: 100,
        },
      );
      appendNativeToolCall(file, sessionId, '2026-07-02T00:01:00.000Z', 4, 2);
      appendNativeResponse(
        file,
        sessionId,
        new Date(readAt + 10_000).toISOString(),
        'future-owned-response',
        100,
      );
      appendNativeToolCall(
        file,
        sessionId,
        new Date(readAt + 20_000).toISOString(),
        7,
        3,
      );
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(readAt);
      try {
        const records = await loadUsageHistoryWithLive({
          sinceMs: 0,
          readAt,
        });
        expect(records).toHaveLength(2);
        vi.setSystemTime(futureEnd);
        expect(aggregateUsage(records, 'all')).toMatchObject({
          totalRequests: 1,
          tools: { totalCalls: 2 },
          files: { linesAdded: 11, linesRemoved: 5 },
          models: { 'qwen-max': { totalTokens: 100, requests: 1 } },
        });
      } finally {
        vi.useRealTimers();
      }
    });
    it('uses a valid duration to bound future tools when startTime is invalid', async () => {
      const sessionId = 'future-tool-derived-clock';
      seedPersisted([{ ...futureWithOneTool(sessionId), startTime: NaN }]);
      const file = writeSessionTranscript(project, sessionId, {
        day: '2026-07-02',
        durationMs: 100,
      });
      appendNativeToolCall(file, sessionId, '2026-07-02T00:01:00.000Z', 4, 2);
      appendNativeResponse(
        file,
        sessionId,
        new Date(readAt + 10_000).toISOString(),
        'future-owned-response',
        100,
      );
      appendNativeToolCall(
        file,
        sessionId,
        new Date(readAt + 20_000).toISOString(),
        7,
        3,
      );
      const records = await loadUsageHistoryWithLive({
        sinceMs: 0,
        readAt,
      });
      expect(records).toHaveLength(2);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(futureEnd);
      try {
        expect(aggregateUsage(records, 'all')).toMatchObject({
          totalRequests: 1,
          tools: { totalCalls: 2 },
          files: { linesAdded: 11, linesRemoved: 5 },
          models: { 'qwen-max': { totalTokens: 100, requests: 1 } },
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not infer tool ownership without a valid future time window', async () => {
      const sessionId = 'future-tool-no-valid-clock';
      seedPersisted([
        {
          ...futureWithOneTool(sessionId),
          startTime: NaN,
          durationMs: NaN,
        },
      ]);
      const file = writeSessionTranscript(project, sessionId, {
        day: '2026-07-02',
        durationMs: 100,
      });
      appendNativeToolCall(
        file,
        sessionId,
        new Date(readAt + 20_000).toISOString(),
        7,
        3,
      );
      const records = await loadUsageHistoryWithLive({
        sinceMs: 0,
        readAt,
      });
      expect(records).toHaveLength(2);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(futureEnd);
      try {
        expect(aggregateUsage(records, 'all')).toMatchObject({
          tools: { totalCalls: 2 },
          files: { linesAdded: 14, linesRemoved: 6 },
          models: { 'qwen-max': { totalTokens: 100, requests: 1 } },
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('restricts old supplemental replay to the verified project path', async () => {
    const sessionId = 'supplemental-same-session-other-project';
    const project = '/supplemental/session-a';
    const otherProject = '/supplemental/session-b';
    const readAt = Date.parse('2026-07-02T00:02:20.000Z');
    const responseId = 'supplemental-project-a-response';
    seedPersisted([
      {
        ...persistedRec(sessionId, 100, true),
        project,
        startTime: readAt - 60_000,
        timestamp: readAt + 60_000,
        runScoped: true,
        requestExecutionIds: [responseId],
        successfulRequestExecutionIds: [responseId],
      },
    ]);
    const otherFile = writeSessionTranscript(otherProject, sessionId, {
      day: '2026-06-11',
      durationMs: 100,
      tokens: 1000,
      executionId: 'other-project-response',
    });
    const oldTime = (readAt - 100 * DAY) / 1000;
    fs.utimesSync(otherFile, oldTime, oldTime);
    const open = vi.spyOn(fs.promises, 'open');
    try {
      const bounded = await loadUsageHistoryWithLive({ readAt });
      expect(bounded).toMatchObject([
        { project, models: { 'qwen-max': { totalTokens: 100 } } },
      ]);
      expect(
        open.mock.calls.filter(([file]) => file === otherFile),
      ).toHaveLength(0);

      const unbounded = await loadUsageHistoryWithLive({
        sinceMs: 0,
        readAt,
      });
      expect(totalTokensOf(aggregateUsage(unbounded, 'all'))).toBe(1100);
      expect(
        unbounded.find((record) => record.project === otherProject),
      ).toMatchObject({ transcriptRebuild: true });
      expect(usageLines()).toHaveLength(1);
    } finally {
      open.mockRestore();
    }
  });

  it('rejects a supplemental transcript whose real header owns another project', async () => {
    const sessionId = 'supplemental-header-project-mismatch';
    const project = '/supplemental/header-a';
    const headerProject = '/supplemental/header-b';
    const file = new SessionService(project, {
      runtimeBaseDir: process.env['QWEN_HOME']!,
    }).getSessionTranscriptPath(sessionId);
    const readAt = Date.parse('2026-07-02T00:02:20.000Z');
    seedPersisted([
      {
        ...persistedRec(sessionId, 100, true),
        project,
        startTime: readAt - 60_000,
        timestamp: readAt + 60_000,
        runScoped: true,
        requestExecutionIds: ['header-owned-future-response'],
        successfulRequestExecutionIds: ['header-owned-future-response'],
      },
    ]);
    const actual = writeTranscript(
      path.basename(path.dirname(path.dirname(file))),
      sessionId,
      {
        cwd: headerProject,
        day: '2026-06-11',
        durationMs: 100,
        tokens: 1000,
        executionId: 'mismatched-project-response',
      },
    );
    const oldTime = (readAt - 100 * DAY) / 1000;
    fs.utimesSync(actual, oldTime, oldTime);
    const open = vi.spyOn(fs.promises, 'open');
    try {
      const records = await loadUsageHistoryWithLive({ readAt });
      expect(open.mock.calls.some(([path]) => path === file)).toBe(true);
      expect(records).toMatchObject([
        { project, models: { 'qwen-max': { totalTokens: 100 } } },
      ]);
      expect(usageLines()).toHaveLength(1);
    } finally {
      open.mockRestore();
    }
  });

  it('does not select between projects on a shared sanitized supplemental path', async () => {
    const sessionId = 'supplemental-colliding-path';
    const projectA = '/supplemental/project!same';
    const projectB = '/supplemental/project@same';
    const file = new SessionService(projectA, {
      runtimeBaseDir: process.env['QWEN_HOME']!,
    }).getSessionTranscriptPath(sessionId);
    expect(
      new SessionService(projectB, {
        runtimeBaseDir: process.env['QWEN_HOME']!,
      }).getSessionTranscriptPath(sessionId),
    ).toBe(file);
    const readAt = Date.parse('2026-07-02T00:02:20.000Z');
    const records = [100, 200].map((totalTokens, index) => ({
      ...persistedRec(sessionId, totalTokens, true),
      project: index === 0 ? projectA : projectB,
      startTime: readAt - 60_000,
      timestamp: readAt + 60_000,
      runScoped: true as const,
      requestExecutionIds: [`colliding-future-response-${index}`],
      successfulRequestExecutionIds: [`colliding-future-response-${index}`],
    }));
    seedPersisted(records);
    writeTranscript(
      path.basename(path.dirname(path.dirname(file))),
      sessionId,
      {
        cwd: projectB,
        day: '2026-06-11',
        durationMs: 100,
        tokens: 1000,
        executionId: 'colliding-path-older-response',
      },
    );
    const oldTime = (readAt - 100 * DAY) / 1000;
    fs.utimesSync(file, oldTime, oldTime);
    const open = vi.spyOn(fs.promises, 'open');
    try {
      const bounded = await loadUsageHistoryWithLive({ readAt });
      expect(totalTokensOf(aggregateUsage(bounded, 'all'))).toBe(300);
      expect(open.mock.calls.some(([path]) => path === file)).toBe(false);

      const unbounded = await loadUsageHistoryWithLive({
        sinceMs: 0,
        readAt,
      });
      expect(totalTokensOf(aggregateUsage(unbounded, 'all'))).toBe(1300);
      expect(usageLines()).toHaveLength(2);
    } finally {
      open.mockRestore();
    }
  });

  it('does not trust an unverified cached project when sanitized paths collide', async () => {
    const sessionId = 'cold-cache-sanitized-project-collision';
    const projectA = '/supplemental/cold!project';
    const projectB = '/supplemental/cold@project';
    const readAt = Date.parse('2026-07-02T00:02:20.000Z');
    seedPersisted([
      {
        ...persistedRec(sessionId, 100),
        project: projectA,
        startTime: readAt - 70_000,
        timestamp: readAt - 60_000,
      },
    ]);
    const file = new SessionService(projectA, {
      runtimeBaseDir: process.env['QWEN_HOME']!,
    }).getSessionTranscriptPath(sessionId);
    expect(
      new SessionService(projectB, {
        runtimeBaseDir: process.env['QWEN_HOME']!,
      }).getSessionTranscriptPath(sessionId),
    ).toBe(file);
    writeTranscript(
      path.basename(path.dirname(path.dirname(file))),
      sessionId,
      {
        cwd: projectB,
        day: '2026-07-02',
        durationMs: 100,
        tokens: 300,
      },
    );
    const open = vi.spyOn(fs.promises, 'open');
    try {
      const first = await loadUsageHistoryWithLive({
        sinceMs: 0,
        readAt,
      });
      const second = await loadUsageHistoryWithLive({
        sinceMs: 0,
        readAt,
      });
      for (const records of [first, second]) {
        expect(totalTokensOf(aggregateUsage(records, 'all'))).toBe(400);
        expect(
          records.find((record) => record.project === projectB),
        ).toMatchObject({ transcriptRebuild: true });
      }
      expect(open.mock.calls.filter(([path]) => path === file)).toHaveLength(2);
    } finally {
      open.mockRestore();
    }
  });

  it('retains independent activity between two future-owned runs', async () => {
    const sessionId = 'future-owned-run-gaps';
    const project = '/future/owned-run-gaps';
    const at = (minute: number, second = 0) =>
      Date.parse(
        `2026-07-02T00:0${minute}:${String(second).padStart(2, '0')}.000Z`,
      );
    const readAt = at(1, 30);
    seedPersisted([
      {
        ...persistedRec(sessionId, 100, true),
        project,
        startTime: at(2),
        timestamp: at(3),
        runScoped: true,
        requestExecutionIds: ['future-gap-first'],
        successfulRequestExecutionIds: ['future-gap-first'],
      },
      {
        ...persistedRec(sessionId, 100, true),
        project,
        startTime: at(5),
        timestamp: at(6),
        runScoped: true,
        requestExecutionIds: ['future-gap-second'],
        successfulRequestExecutionIds: ['future-gap-second'],
      },
    ]);
    const file = writeTranscript('future-owned-run-gaps', sessionId, {
      cwd: project,
      day: '2026-07-02',
      durationMs: 100,
      tokens: 100,
      executionId: 'before-future-gaps',
      assistant: true,
    });
    appendNativeResponse(
      file,
      sessionId,
      '2026-07-02T00:02:30.000Z',
      'future-gap-first',
      100,
    );
    appendNativeResponse(
      file,
      sessionId,
      '2026-07-02T00:05:30.000Z',
      'future-gap-second',
      100,
    );
    const gapEvent = {
      sessionId,
      cwd: project,
      timestamp: '2026-07-02T00:04:00.000Z',
      type: 'system',
      subtype: 'ui_telemetry',
      systemPayload: {
        uiEvent: {
          'event.name': 'qwen-code.api_response',
          'event.timestamp': '2026-07-02T00:04:00.000Z',
          response_id: 'between-future-gaps',
          execution_id: 'between-future-gaps',
          model: 'qwen-max',
          input_token_count: 125,
          output_token_count: 0,
          cached_content_token_count: 0,
          thoughts_token_count: 0,
          total_token_count: 125,
        },
      },
    };
    fs.appendFileSync(file, `${JSON.stringify(gapEvent)}\n`);
    appendNativeToolCall(
      file,
      sessionId,
      '2026-07-02T00:04:00.000Z',
      4,
      2,
      '2026-07-02T00:02:30.000Z',
    );
    const withinFuture = structuredClone(gapEvent);
    withinFuture.timestamp = '2026-07-02T00:02:40.000Z';
    const uiEvent = withinFuture.systemPayload.uiEvent;
    uiEvent['event.timestamp'] = withinFuture.timestamp;
    uiEvent.execution_id = 'independent-inside-future-window';
    uiEvent.response_id = uiEvent.execution_id;
    uiEvent.model = 'qwen-turbo';
    uiEvent.input_token_count = 200;
    uiEvent.total_token_count = 200;
    fs.appendFileSync(file, `${JSON.stringify(withinFuture)}\n`);

    const records = await loadUsageHistoryWithLive({ sinceMs: 0, readAt });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at(7));
    try {
      expect(aggregateUsage(records, 'all')).toMatchObject({
        totalRequests: 5,
        tools: { totalCalls: 1 },
        models: { 'qwen-turbo': { totalTokens: 200 } },
        files: { linesAdded: 4, linesRemoved: 2 },
      });
      expect(
        buildUsageDashboard(records, { range: 'all' }, new Map()).summary,
      ).toMatchObject({
        totalTokens: 625,
        requests: 5,
        toolCalls: 1,
        linesAdded: 4,
        linesRemoved: 2,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an independent gap tool beside an out-of-order owned response', async () => {
    const sessionId = 'future-out-of-order-gap-tool';
    const project = '/future/out-of-order-gap-tool';
    const readAt = Date.parse('2026-07-02T00:01:40.000Z');
    const gapToolAt = Date.parse('2026-07-02T00:04:00.000Z');
    seedPersisted([
      {
        ...persistedRec(sessionId, 100, true),
        project,
        startTime: Date.parse('2026-07-02T00:02:00.000Z'),
        timestamp: Date.parse('2026-07-02T00:03:00.000Z'),
        runScoped: true,
        requestExecutionIds: ['out-of-order-owned-response'],
      },
      {
        ...persistedRec(sessionId, 100, true),
        project,
        startTime: Date.parse('2026-07-02T00:05:00.000Z'),
        timestamp: Date.parse('2026-07-02T00:06:00.000Z'),
        runScoped: true,
        requestExecutionIds: ['second-owned-response'],
      },
    ]);
    const file = writeTranscript(sessionId, sessionId, {
      cwd: project,
      day: '2026-07-02',
      durationMs: 100,
    });
    appendNativeResponse(
      file,
      sessionId,
      '2026-07-02T00:01:30.000Z',
      'out-of-order-owned-response',
      100,
    );
    appendNativeResponse(
      file,
      sessionId,
      '2026-07-02T00:05:30.000Z',
      'second-owned-response',
      100,
    );
    appendNativeToolCall(file, sessionId, '2026-07-02T00:04:00.000Z', 4, 2);

    const records = await loadUsageHistoryWithLive({ sinceMs: 0, readAt });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(gapToolAt + 180_000);
    try {
      expect(aggregateUsage(records, 'all')).toMatchObject({
        totalRequests: 2,
        tools: { totalCalls: 1 },
        files: { linesAdded: 4, linesRemoved: 2 },
      });
      expect(
        buildUsageDashboard(records, { range: 'all' }, new Map()).summary,
      ).toMatchObject({ toolCalls: 1, linesAdded: 4, linesRemoved: 2 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an independent response inside nested future windows', async () => {
    const sessionId = 'nested-future-owned-windows';
    const project = '/future/nested-windows';
    const readAt = Date.parse('2026-07-02T00:02:30.000Z');
    const futureRun = (id: string, startTime: string, endTime: string) => ({
      ...persistedRec(sessionId, 100, true),
      project,
      startTime: Date.parse(startTime),
      timestamp: Date.parse(endTime),
      runScoped: true,
      requestExecutionIds: [id],
      successfulRequestExecutionIds: [id],
    });
    seedPersisted([
      futureRun(
        'outer-future-window',
        '2026-07-02T00:02:00.000Z',
        '2026-07-02T00:10:00.000Z',
      ),
      futureRun(
        'inner-future-window',
        '2026-07-02T00:04:00.000Z',
        '2026-07-02T00:06:00.000Z',
      ),
    ]);
    const file = writeTranscript('nested-future-windows', sessionId, {
      cwd: project,
      day: '2026-07-02',
      durationMs: 100,
    });
    appendNativeResponse(
      file,
      sessionId,
      '2026-07-02T00:02:30.000Z',
      'outer-future-window',
      100,
    );
    appendNativeResponse(
      file,
      sessionId,
      '2026-07-02T00:04:30.000Z',
      'inner-future-window',
      100,
    );
    appendNativeResponse(
      file,
      sessionId,
      '2026-07-02T00:08:00.000Z',
      'independent-nested-response',
      50,
    );

    const records = await loadUsageHistoryWithLive({ sinceMs: 0, readAt });
    expect(records).toHaveLength(3);
    expect(
      records.some((record) =>
        record.requestExecutionIds?.includes('independent-nested-response'),
      ),
    ).toBe(true);
    expect(aggregateUsage(records, 'all')).toMatchObject({
      totalRequests: 3,
      models: { 'qwen-max': { totalTokens: 250 } },
    });
  });

  it('replays a response after its future-owner snapshot is removed', async () => {
    const sessionId = 'future-owner-cache-removal';
    const project = '/future/owner-cache-removal';
    const readAt = Date.parse('2026-07-02T00:02:20.000Z');
    seedPersisted([
      {
        ...persistedRec(sessionId, 100),
        project,
        startTime: readAt,
        timestamp: readAt + 60_000,
        runScoped: true,
        requestExecutionIds: ['removed-future-response'],
        successfulRequestExecutionIds: ['removed-future-response'],
      },
    ]);
    writeTranscript('future-owner-cache-removal', sessionId, {
      cwd: project,
      day: '2026-07-02',
      durationMs: 100,
      tokens: 100,
      executionId: 'removed-future-response',
    });

    const cached = await loadUsageHistoryWithLive({ sinceMs: 0, readAt });
    expect(cached).toHaveLength(1);
    fs.rmSync(usagePath());
    const afterRemoval = await loadUsageHistoryWithLive({
      sinceMs: 0,
      readAt,
    });
    expect(afterRemoval).toHaveLength(1);
    expect(totalTokensOf(aggregateUsage(afterRemoval, 'all'))).toBe(100);
    expect(afterRemoval[0]?.requestExecutionIds).toEqual([
      'removed-future-response',
    ]);
  });

  it('preserves replay ownership for a future-ended run', async () => {
    const sessionId = 'future-ended-owned-session';
    const project = '/repro/project';
    const futureResponse = 'future-response';
    const now = Date.parse('2026-07-02T00:02:20.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    seedPersisted([
      {
        ...persistedRec(sessionId, 100),
        project,
        startTime: now,
        timestamp: now + 60_000,
        durationMs: 60_000,
        runScoped: true,
        requestExecutionIds: [futureResponse],
        successfulRequestExecutionIds: [futureResponse],
      },
    ]);
    writeTranscript('future-owned-session', sessionId, {
      cwd: project,
      day: '2026-07-02',
      durationMs: 1000,
      tokens: 100,
      executionId: futureResponse,
    });
    const oldSession = 'unrelated-old-session';
    const oldFile = writeTranscript('unrelated-old-session', oldSession, {
      cwd: '/unrelated/old-project',
      day: '2026-05-01',
      durationMs: 1000,
      tokens: 200,
      executionId: 'unrelated-old-response',
    });
    const oldTime = now - 60 * DAY;
    fs.utimesSync(oldFile, new Date(oldTime), new Date(oldTime));
    const open = vi.spyOn(fs.promises, 'open');
    try {
      expect(await loadUsageHistory()).toHaveLength(1);
      expect(await loadUsageHistoryWithLive()).toHaveLength(1);
      expect(
        open.mock.calls.filter(([file]) =>
          String(file).endsWith(`${oldSession}.jsonl`),
        ),
      ).toHaveLength(0);
      expect(usageLines()).toHaveLength(1);
      const sources = await loadUsageDashboardSources();
      expect(
        buildUsageDashboard(
          sources.records,
          { range: 'all' },
          sources.ledgerDaily,
          sources.runtimeScopes,
        ).summary,
      ).toMatchObject({
        totalTokens: 100,
        requests: 1,
        sessions: 0,
        toolCalls: 0,
      });
      // Explicit unbounded discovery still finds unrelated daemon history,
      // but does not resurrect the future-owned response.
      const unbounded = await loadUsageHistoryWithLive({ sinceMs: 0 });
      expect(unbounded).toHaveLength(2);
      expect(
        unbounded.find((record) => record.sessionId === oldSession),
      ).toMatchObject({ transcriptRebuild: true });
      const retainedFuture = unbounded.find(
        (record) => record.sessionId === sessionId,
      );
      expect(retainedFuture).toMatchObject({
        timestamp: now + 60_000,
        requestExecutionIds: [futureResponse],
      });
      expect(retainedFuture?.transcriptRebuild).not.toBe(true);
    } finally {
      open.mockRestore();
      vi.useRealTimers();
    }
  });

  it('keeps unrelated transcript caches warm beside a future-owned replay', async () => {
    const futureSession = 'cache-future-owner';
    const otherSession = 'cache-future-unrelated';
    const futureProject = '/cache/future-owner';
    const otherProject = '/cache/future-unrelated';
    const readAt = Date.parse('2026-07-02T00:02:20.000Z');
    const responseId = 'cache-future-owned-response';
    seedPersisted([
      {
        ...persistedRec(futureSession, 100, true),
        project: futureProject,
        startTime: readAt - 10_000,
        timestamp: readAt + 60_000,
        runScoped: true,
        requestExecutionIds: [responseId],
        successfulRequestExecutionIds: [responseId],
      },
    ]);
    writeSessionTranscript(futureProject, futureSession, {
      day: '2026-07-02',
      durationMs: 100,
      tokens: 100,
      executionId: responseId,
    });
    const otherFile = writeSessionTranscript(otherProject, otherSession, {
      day: '2026-07-02',
      durationMs: 100,
      tokens: 300,
      executionId: 'cache-unrelated-response',
    });
    const open = vi.spyOn(fs.promises, 'open');
    try {
      const first = await loadUsageHistoryWithLive({
        sinceMs: 0,
        readAt,
      });
      const second = await loadUsageHistoryWithLive({
        sinceMs: 0,
        readAt,
      });
      expect(second).toEqual(first);
      expect(totalTokensOf(aggregateUsage(second, 'all'))).toBe(400);
      expect(
        open.mock.calls.filter(([file]) => file === otherFile),
      ).toHaveLength(1);
      expect(usageLines()).toHaveLength(1);
    } finally {
      open.mockRestore();
    }
  });

  it('keeps an unrecorded project transcript warm across live reads', async () => {
    const sessionId = 'unrecorded-project-cache';
    const persisted = {
      ...runRec(
        sessionId,
        200,
        Date.parse('2026-07-01T01:00:00.000Z'),
        Date.parse('2026-07-01T02:00:00.000Z'),
      ),
      project: '/cache-known/project-a',
    };
    const transcript = writeTranscript('cache-unknown-b', sessionId, {
      cwd: '/cache-known/project-b',
      day: '2026-07-01',
      durationMs: 1000,
      executionId: 'unknown-project-response',
      tokens: 400,
    });
    const open = vi.spyOn(fs.promises, 'open');
    try {
      const first = await loadUsageHistoryWithLive({
        sinceMs: 0,
        persistedRecords: [persisted],
      });
      const opensBeforeSecondRead = open.mock.calls.filter(([file]) =>
        String(file).endsWith(`${sessionId}.jsonl`),
      ).length;
      expect(opensBeforeSecondRead).toBeGreaterThan(0);
      const second = await loadUsageHistoryWithLive({
        sinceMs: 0,
        persistedRecords: [persisted],
      });
      const opensAfterSecondRead = open.mock.calls.filter(([file]) =>
        String(file).endsWith(`${sessionId}.jsonl`),
      ).length;
      expect(opensAfterSecondRead).toBe(opensBeforeSecondRead);
      expect(second).toEqual(first);
      expect(fs.readFileSync(transcript, 'utf8')).toContain(
        'unknown-project-response',
      );
    } finally {
      open.mockRestore();
    }
  });

  it('keeps later real daemon activity after an earlier reconstruction', async () => {
    const sessionId = '77777777-7777-4777-8777-777777777777';
    const project = '/live/project';
    const service = new SessionService(project, {
      runtimeBaseDir: process.env['QWEN_HOME']!,
    });
    const filePath = service.getSessionTranscriptPath(sessionId);
    writeTranscript(
      path.basename(path.dirname(path.dirname(filePath))),
      sessionId,
      {
        cwd: project,
        day: '2026-06-11',
        durationMs: 1200,
        tokens: 1000,
        assistant: true,
      },
    );
    expect(totalTokensOf(aggregateUsage(await loadUsageHistory(), 'all'))).toBe(
      1000,
    );
    const response = {
      sessionId,
      cwd: project,
      uuid: 'late-response-event',
      parentUuid: 'u2',
      timestamp: '2026-06-13T00:01:00.000Z',
      type: 'system',
      subtype: 'ui_telemetry',
      systemPayload: {
        uiEvent: {
          'event.name': 'qwen-code.api_response',
          'event.timestamp': '2026-06-13T00:01:00.000Z',
          response_id: 'late-response',
          execution_id: 'late-execution',
          prompt_id: 'late-prompt',
          model: 'qwen-max',
          duration_ms: 1200,
          input_token_count: 300,
          output_token_count: 150,
          cached_content_token_count: 0,
          thoughts_token_count: 50,
          total_token_count: 500,
        },
      },
    };
    fs.appendFileSync(
      filePath,
      `${JSON.stringify(response)}\n${JSON.stringify({
        sessionId,
        cwd: project,
        uuid: 'late-assistant',
        parentUuid: 'late-response-event',
        timestamp: '2026-06-13T00:02:00.000Z',
        type: 'assistant',
        message: { role: 'assistant', content: 'Later' },
      })}\n`,
    );

    expect(fs.readFileSync(filePath, 'utf8')).toContain('late-response');
    const originalOpen = fs.promises.open;
    const opened: string[] = [];
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation(((
      file: fs.PathLike,
      flags?: string | number,
      mode?: fs.Mode,
    ) => {
      opened.push(String(file));
      return originalOpen(file, flags as number, mode);
    }) as typeof fs.promises.open);
    const preparedBeforeMerge =
      await prepareUsageBeforeTranscriptDeletion(filePath);
    const afterAppend = await loadUsageHistoryWithLive({ sinceMs: 0 });
    try {
      expect(preparedBeforeMerge).not.toBeNull();
      expect(preparedBeforeMerge?.record?.models['qwen-max']?.totalTokens).toBe(
        1500,
      );
      expect(opened).toContain(filePath);
      expect(afterAppend).toEqual([preparedBeforeMerge!.record]);
      expect(totalTokensOf(aggregateUsage(afterAppend, 'all'))).toBe(1500);
    } finally {
      spy.mockRestore();
    }

    const prepared = await prepareUsageBeforeTranscriptDeletion(filePath);
    expect(prepared?.record?.models['qwen-max']?.totalTokens).toBe(1500);
    expect(
      prepared ? commitUsageBeforeTranscriptDeletion(prepared) : false,
    ).toBe(true);
    fs.rmSync(filePath);
    expect(
      totalTokensOf(
        aggregateUsage(await loadUsageHistoryWithLive({ sinceMs: 0 }), 'all'),
      ),
    ).toBe(1500);
  });

  it('does not persist a caller-truncated transcript as authoritative', async () => {
    const sessionId = 'caller-cutoff-must-not-persist';
    const file = writeTranscript('caller-cutoff', sessionId, {
      cwd: '/repro/project',
      day: '2026-06-11',
      durationMs: 1000,
      tokens: 100,
    });
    appendNativeResponse(
      file,
      sessionId,
      '2026-06-11T00:02:00.000Z',
      'after-caller-cutoff',
    );

    const first = await loadUsageHistory(undefined, {
      beforeMsBySession: new Map([
        [sessionId, Date.parse('2026-06-11T00:01:30.000Z')],
      ]),
    });
    expect(totalTokensOf(aggregateUsage(first, 'all'))).toBe(100);
    expect(fs.existsSync(usagePath())).toBe(false);
    const second = await loadUsageHistory(undefined, { persistRebuild: false });
    expect(totalTokensOf(aggregateUsage(second, 'all'))).toBe(600);
  });

  it('does not skip a unique transcript path for an unverified project', async () => {
    const sessionId = 'single-path-needs-project-proof';
    seedPersisted([
      {
        ...persistedRec(sessionId, 100),
        project: '/single-path/project-a',
      },
    ]);
    writeTranscript('single-path-b', sessionId, {
      cwd: '/single-path/project-b',
      day: '2026-06-11',
      durationMs: 1000,
      tokens: 300,
    });

    const records = await loadUsageHistoryWithLive({ sinceMs: 0 });
    expect(totalTokensOf(aggregateUsage(records, 'all'))).toBe(400);
    expect(
      records.find((record) => record.project === '/single-path/project-b'),
    ).toBeDefined();
  });

  it('preserves the active session on repeat reads without a project root', async () => {
    const oldSession = 'prior-authoritative-session';
    const activeSession = 'active-session-without-project-root';
    writeTranscript('prior-authoritative', oldSession, {
      cwd: '/repro/project',
      day: '2026-06-11',
      durationMs: 1000,
      tokens: 100,
    });
    await loadUsageHistory(undefined);
    writeTranscript('later-active', activeSession, {
      cwd: '/repro/project',
      day: '2026-06-11',
      durationMs: 2000,
      tokens: 200,
    });

    for (let read = 0; read < 2; read++) {
      const records = await loadUsageHistory(activeSession);
      expect(totalTokensOf(aggregateUsage(records, 'all'))).toBe(300);
      expect(
        records.find((record) => record.sessionId === activeSession),
      ).toBeDefined();
    }
    expect(usageLines()).toHaveLength(1);
  });

  it('adversarial: covered history with a future run does not grow the ledger on repeat default loads', async () => {
    const sessionId = 'covered-history-future-repeat';
    const projectA = '/repeat/project-a';
    const projectB = '/repeat/project-b';
    writeTranscript('repeat-project-a', sessionId, {
      cwd: projectA,
      day: '1970-01-01',
      durationMs: 100,
      tokens: 100,
      assistant: true,
    });
    writeTranscript('repeat-project-b', sessionId, {
      cwd: projectB,
      day: '1970-01-01',
      durationMs: 100,
      tokens: 200,
      assistant: true,
    });
    const migrated = await loadUsageHistory();
    expect(totalTokensOf(aggregateUsage(migrated, 'all'))).toBe(300);
    expect(usageLines()).toHaveLength(2);
    const future = {
      ...runRec(sessionId, 50, 130_000, 200_000),
      project: projectA,
      requestExecutionIds: ['new-future-response'],
    };
    fs.appendFileSync(usagePath(), `${JSON.stringify(future)}\n`);
    const initialLines = usageLines();
    expect(initialLines).toHaveLength(3);

    for (let read = 0; read < 2; read++) {
      const records = await loadUsageHistory(undefined, { readAt: 150_000 });
      expect(aggregateUsage(records, 'all')).toMatchObject({
        totalRequests: 3,
        models: { 'qwen-max': { requests: 3, totalTokens: 350 } },
      });
      expect(records).toHaveLength(3);
      expect(
        records.find(
          (record) => record.project === projectA && record.runScoped === true,
        ),
      ).toMatchObject({
        timestamp: 200_000,
        requestExecutionIds: ['new-future-response'],
        models: { 'qwen-max': { requests: 1, totalTokens: 50 } },
      });
      expect(usageLines()).toEqual(initialLines);
    }

    const projectC = '/repeat/project-c';
    writeTranscript('repeat-project-c', sessionId, {
      cwd: projectC,
      day: '1970-01-01',
      durationMs: 100,
      tokens: 300,
      assistant: true,
    });
    const firstDiscovery = await loadUsageHistory(undefined, {
      readAt: 150_000,
    });
    expect(totalTokensOf(aggregateUsage(firstDiscovery, 'all'))).toBe(650);
    const afterFirstDiscovery = usageLines();
    expect(afterFirstDiscovery).toHaveLength(initialLines.length + 1);
    expect(JSON.parse(afterFirstDiscovery.at(-1)!)).toMatchObject({
      sessionId,
      project: projectC,
      transcriptRebuild: true,
      models: { 'qwen-max': { requests: 1, totalTokens: 300 } },
    });
    const secondDiscovery = await loadUsageHistory(undefined, {
      readAt: 150_000,
    });
    expect(totalTokensOf(aggregateUsage(secondDiscovery, 'all'))).toBe(650);
    expect(usageLines()).toEqual(afterFirstDiscovery);
  });

  it('retains late native activity without charging shared and internal calls again', async () => {
    const sessionId = 'sess-internal-and-late';
    const filePath = writeTranscript('repro-project', sessionId, {
      cwd: '/repro/project',
      day: '2026-06-11',
      durationMs: 100,
      tokens: 100,
      assistant: true,
      executionId: 'shared-call',
    });
    seedPersisted([
      {
        ...runRec(
          sessionId,
          200,
          Date.parse('2026-06-11T00:02:00.000Z'),
          Date.parse('2026-06-11T00:04:00.000Z'),
        ),
        project: '/repro/project',
        models: { 'qwen-max': modelUsage(2, 200, 0, 200) },
        requestExecutionIds: ['shared-call', 'internal-call'],
      },
    ]);
    appendNativeResponse(
      filePath,
      sessionId,
      '2026-06-11T00:05:00.000Z',
      'late-native-call',
    );

    const records = await loadUsageHistoryWithLive({ sinceMs: 0 });

    expect(totalTokensOf(aggregateUsage(records, 'all'))).toBe(700);
    expect(totalTokensOf(aggregateUsage(records, 'all'))).toBe(700);
    expect(aggregateUsage(records, 'all').totalRequests).toBe(3);
    const supplement = records.find((r) => r.transcriptSupplement === true);
    expect(supplement?.models['qwen-max']?.totalTokens).toBe(500);
  });

  it('retains identified activity after a legacy run without identities', async () => {
    const sessionId = 'sess-legacy-and-late';
    const filePath = writeTranscript('repro-project', sessionId, {
      cwd: '/repro/project',
      day: '2026-06-11',
      durationMs: 100,
      tokens: 50,
      assistant: true,
    });
    seedPersisted([
      {
        ...runRec(
          sessionId,
          100,
          Date.parse('2026-06-11T00:02:00.000Z'),
          Date.parse('2026-06-11T00:04:00.000Z'),
        ),
        project: '/repro/project',
      },
    ]);
    appendNativeResponse(
      filePath,
      sessionId,
      '2026-06-11T00:05:00.000Z',
      'late-identified-call',
    );

    const records = await loadUsageHistoryWithLive({ sinceMs: 0 });

    expect(records).toHaveLength(3);
    expect(totalTokensOf(aggregateUsage(records, 'all'))).toBe(650);
    const supplement = records.find((r) => r.transcriptSupplement === true);
    expect(supplement?.requestExecutionIds).toEqual(['late-identified-call']);
    expect(supplement?.models['qwen-max']?.totalTokens).toBe(500);
  });

  it('retains earlier usage and identified supplements when the conversation clock is unparseable', async () => {
    const sessionId = 'sess-corrupt-clock-and-late';
    const filePath = writeTranscript('repro-project', sessionId, {
      cwd: '/repro/project',
      day: '2026-06-11',
      durationMs: 100,
      tokens: 50,
      assistant: true,
      executionId: 'prior-response-before-corrupt-header',
    });
    const [header, ...remaining] = fs
      .readFileSync(filePath, 'utf8')
      .trimEnd()
      .split('\n');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({ ...JSON.parse(header), timestamp: 'not-a-date' }),
        ...remaining,
      ].join('\n') + '\n',
    );
    seedPersisted([
      {
        ...runRec(
          sessionId,
          100,
          Date.parse('2026-06-11T00:02:00.000Z'),
          Date.parse('2026-06-11T00:04:00.000Z'),
        ),
        project: '/repro/project',
      },
    ]);
    appendNativeResponse(
      filePath,
      sessionId,
      '2026-06-11T00:05:00.000Z',
      'late-identified-call',
    );

    const records = await loadUsageHistoryWithLive({ sinceMs: 0 });

    expect(totalTokensOf(aggregateUsage(records, 'all'))).toBe(650);
    expect(
      records.find((record) =>
        record.requestExecutionIds?.includes(
          'prior-response-before-corrupt-header',
        ),
      ),
    ).toMatchObject({
      transcriptRebuild: true,
      models: { 'qwen-max': { requests: 1, totalTokens: 50 } },
    });
    const supplement = records.find((r) => r.transcriptSupplement === true);
    expect(supplement?.requestExecutionIds).toEqual(['late-identified-call']);
    expect(supplement?.models['qwen-max']?.totalTokens).toBe(500);
  });

  it('keeps a later native call beside an identified run instead of truncating or choosing the old snapshot', async () => {
    const sessionId = 'sess-native-after-run';
    const filePath = writeTranscript('repro-project', sessionId, {
      cwd: '/repro/project',
      day: '2026-06-11',
      durationMs: 1200,
      tokens: 1000,
      assistant: true,
      executionId: 'existing-run',
    });
    const [persisted] = await loadUsageHistory();
    expect(persisted?.requestExecutionIds).toEqual(['existing-run']);
    const timestamp = '2026-06-11T00:03:00.000Z';
    fs.appendFileSync(
      filePath,
      JSON.stringify({
        sessionId,
        cwd: '/repro/project',
        uuid: 'new-native-response',
        parentUuid: 'u3',
        timestamp,
        type: 'system',
        subtype: 'ui_telemetry',
        systemPayload: {
          uiEvent: {
            'event.name': 'qwen-code.api_response',
            'event.timestamp': timestamp,
            response_id: 'new-native-response',
            execution_id: 'new-native-response',
            model: 'qwen-max',
            duration_ms: 700,
            input_token_count: 300,
            output_token_count: 150,
            cached_content_token_count: 0,
            thoughts_token_count: 50,
            total_token_count: 500,
            prompt_id: 'new-native-prompt',
          },
        },
      }) + '\n',
    );
    seedPersisted([
      persisted!,
      {
        ...runRec(
          sessionId,
          1000,
          Date.parse('2026-06-11T00:00:00.000Z'),
          Date.parse('2026-06-11T00:04:00.000Z'),
        ),
        project: '/repro/project',
        models: structuredClone(persisted!.models),
        requestExecutionIds: ['existing-run'],
      },
    ]);

    const records = await loadUsageHistoryWithLive({ sinceMs: 0 });

    expect(records).toHaveLength(1);
    expect(records[0]?.models['qwen-max']?.requests).toBe(2);
    expect(totalTokensOf(aggregateUsage(records, 'all'))).toBe(1500);
  });

  it('keeps different late daemon ids beside current live usage without inflating run counts', async () => {
    const sessionId = 'sess-live-and-daemon-tails';
    const filePath = writeTranscript('repro-project', sessionId, {
      cwd: '/repro/project',
      day: '2026-06-11',
      durationMs: 100,
      tokens: 100,
      assistant: true,
      executionId: 'shared-call',
    });
    seedPersisted([
      {
        ...runRec(
          sessionId,
          200,
          Date.parse('2026-06-11T00:02:00.000Z'),
          Date.parse('2026-06-11T00:04:00.000Z'),
        ),
        project: '/repro/project',
        models: { 'qwen-max': modelUsage(2, 200, 0, 200) },
        requestExecutionIds: ['shared-call', 'internal-call'],
      },
    ]);
    const liveService = new UiTelemetryService();
    liveService.addEvent(
      appendNativeResponse(
        filePath,
        sessionId,
        '2026-06-11T00:05:00.000Z',
        'current-live-call',
        100,
      ),
    );
    appendNativeResponse(
      filePath,
      sessionId,
      '2026-06-11T00:06:00.000Z',
      'other-daemon-call',
      200,
    );
    const current = metricsToRunUsageRecord(
      sessionId,
      '/repro/project',
      Date.parse('2026-06-11T00:04:30.000Z'),
      Date.parse('2026-06-11T00:05:30.000Z'),
      liveService.getLiveMetrics(),
    );
    const history = await loadUsageHistoryWithLive({ sinceMs: 0 });

    const records = dedupBySessionId([...history, current]);
    const report = aggregateUsage(records, 'all');

    expect(records).toHaveLength(3);
    expect(totalTokensOf(report)).toBe(500);
    expect(report.totalRequests).toBe(4);
    expect(report.sessionCount).toBe(2);
    expect(report.totalDurationMs).toBe(180_000);
    expect(report.projects).toEqual([
      expect.objectContaining({
        path: '/repro/project',
        sessionCount: 2,
        totalDurationMs: 180_000,
        totalTokens: 500,
      }),
    ]);
    expect(
      records.find((r) => r.transcriptSupplement === true)?.requestExecutionIds,
    ).toEqual(['other-daemon-call']);
  });

  it('does not let late tool telemetry overwrite the known run tools or files', async () => {
    const sessionId = 'sess-late-tool-boundary';
    const filePath = writeTranscript('repro-project', sessionId, {
      cwd: '/repro/project',
      day: '2026-06-11',
      durationMs: 111,
      tokens: 50,
      assistant: true,
      executionId: 'known-api',
    });
    seedPersisted([
      {
        ...runRec(
          sessionId,
          50,
          Date.parse('2026-06-11T00:00:00.000Z'),
          Date.parse('2026-06-11T00:04:00.000Z'),
        ),
        project: '/repro/project',
        requestExecutionIds: ['known-api'],
        tools: {
          totalCalls: 1,
          totalSuccess: 1,
          totalFail: 0,
          byName: {
            edit: { count: 1, success: 1, fail: 0, totalDurationMs: 111 },
          },
        },
        files: { linesAdded: 7, linesRemoved: 3 },
      },
    ]);
    appendNativeResponse(
      filePath,
      sessionId,
      '2026-06-11T00:05:00.000Z',
      'late-api',
    );
    const toolTime = '2026-06-11T00:06:00.000Z';
    fs.appendFileSync(
      filePath,
      JSON.stringify({
        sessionId,
        cwd: '/repro/project',
        uuid: 'late-edit',
        parentUuid: 'late-api',
        timestamp: toolTime,
        type: 'system',
        subtype: 'ui_telemetry',
        systemPayload: {
          uiEvent: {
            'event.name': 'qwen-code.tool_call',
            'event.timestamp': toolTime,
            call_id: 'late-edit',
            function_name: 'edit',
            function_args: { path: '/repro/project/temporary.ts' },
            duration_ms: 222,
            success: true,
            metadata: { model_added_lines: 9, model_removed_lines: 4 },
            prompt_id: 'late-api',
          },
        },
      }) + '\n',
    );

    const report = aggregateUsage(
      await loadUsageHistoryWithLive({ sinceMs: 0 }),
      'all',
    );

    expect(report.models['qwen-max']?.totalTokens).toBe(550);
    expect(report.totalRequests).toBe(2);
    expect(report.tools.totalCalls).toBe(1);
    expect(report.tools.topTools[0]?.totalDurationMs).toBe(111);
    expect(report.files).toEqual({ linesAdded: 7, linesRemoved: 3 });
    expect(report.totalDurationMs).toBe(240_000);
  });

  it('does not let an authoritative sibling project skip a run-scoped transcript', async () => {
    const sessionId = 'same-session-two-project-early-return';
    const projectA = path.resolve('/early-return/project-a');
    const projectB = path.resolve('/early-return/project-b');
    writeTranscript('early-return-a', sessionId, {
      cwd: projectA,
      day: '2026-06-11',
      durationMs: 9_000,
      tokens: 100,
    });
    writeTranscript('early-return-b', sessionId, {
      cwd: projectB,
      day: '2026-06-11',
      durationMs: 9_000,
      tokens: 300,
    });
    const runStart = Date.parse('2026-06-11T00:02:00.000Z');
    seedPersisted([
      {
        ...runRec(sessionId, 100, t0, t0 + 9_000),
        project: projectA,
        runScoped: false,
        transcriptRebuild: true,
      },
      {
        ...runRec(sessionId, 200, runStart, runStart + 1_000),
        project: projectB,
      },
    ]);

    const records = await loadUsageHistory(undefined, {
      persistRebuild: false,
    });

    expect(totalTokensOf(aggregateUsage(records, 'all'))).toBe(600);
    expect(
      records.find(
        (record) =>
          record.project === projectB && record.transcriptRebuild === true,
      )?.models['qwen-max']?.totalTokens,
    ).toBe(300);
  });

  it('revalidates a prior rebuild once and serves its later run refreshes from cache', async () => {
    const authoritativePath = plantChatJsonl('authoritative-session', 1000);
    await loadUsageHistory();
    const start = Date.parse('2026-06-12T00:00:00Z');
    fs.appendFileSync(
      usagePath(),
      `${JSON.stringify({
        ...runRec('authoritative-session', 100, start, start + 60_000),
        project: '/repro/project',
      })}\n`,
    );
    const originalOpen = fs.promises.open;
    const opened: string[] = [];
    const directory = path.join(process.env['QWEN_HOME']!, 'projects');
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation(((
      p: fs.PathLike,
      flags?: string | number,
      mode?: fs.Mode,
    ) => {
      opened.push(String(p));
      return originalOpen(p, flags as number, mode);
    }) as typeof fs.promises.open);
    const directorySpy = vi.spyOn(fs, 'readdirSync');
    try {
      await loadUsageHistory();
      expect(
        opened.filter((entry) => entry === authoritativePath),
      ).toHaveLength(0);
      const calls = directorySpy.mock.calls.map(([entry]) => String(entry));
      expect(calls).not.toContain(directory);
      const records = await loadUsageHistoryWithLive({ sinceMs: 0 });
      const reads = opened.filter((entry) => entry === authoritativePath);
      expect(reads).toHaveLength(1);
      expect(totalTokensOf(aggregateUsage(records, 'all'))).toBe(1100);
      await loadUsageHistoryWithLive({ sinceMs: 0 });
      expect(opened.filter((entry) => entry === authoritativePath)).toEqual(
        reads,
      );
    } finally {
      openSpy.mockRestore();
      directorySpy.mockRestore();
    }
  });

  it('keeps an active single-project session warm without temporal maps', async () => {
    const sessionId = 'active-session-without-temporal-maps';
    const project = '/warm/project';
    const filePath = writeTranscript('warm-project', sessionId, {
      cwd: project,
      day: '2026-06-11',
      durationMs: 1000,
      tokens: 100,
    });
    seedPersisted([{ ...persistedRec(sessionId, 0), project }]);
    const originalOpen = fs.promises.open;
    const opened: string[] = [];
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation(((
      p: fs.PathLike,
      flags?: string | number,
      mode?: fs.Mode,
    ) => {
      opened.push(String(p));
      return originalOpen(p, flags as number, mode);
    }) as typeof fs.promises.open);
    try {
      await loadUsageHistory(sessionId, {
        projectRoot: project,
        persistRebuild: false,
      });
      await loadUsageHistory(sessionId, {
        projectRoot: project,
        persistRebuild: false,
      });
      expect(opened.filter((entry) => entry === filePath)).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps ordinary transcripts warm while checking its known runs', async () => {
    seedPersisted([
      runRec(
        'run-session',
        1000,
        Date.parse('2026-07-01T00:00:00Z'),
        Date.parse('2026-07-02T00:00:00Z'),
      ),
    ]);
    const stable = plantChatJsonl('stable-session', 250);
    const originalOpen = fs.promises.open;
    const opened: string[] = [];
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation(((
      p: fs.PathLike,
      flags?: string | number,
      mode?: fs.Mode,
    ) => {
      opened.push(String(p));
      return originalOpen(p, flags as number, mode);
    }) as typeof fs.promises.open);
    try {
      await loadUsageHistoryWithLive({ sinceMs: 0 });
      const first = opened.filter((entry) => entry === stable).length;
      opened.length = 0;
      const second = await loadUsageHistoryWithLive({ sinceMs: 0 });
      const warm = opened.filter((entry) => entry === stable).length;
      expect(first).toBe(1);
      expect(warm).toBe(0);
      expect(totalTokensOf(aggregateUsage(second, 'all'))).toBe(1250);
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps directory-first duplicates stable within one project across cache resets', async () => {
    const sessionId = 'duplicate-session';
    const start = Date.parse('2026-06-12T00:00:00Z');
    const persisted = [
      {
        ...runRec(sessionId, 200, start, start + 60_000),
        project: '/a/project',
      },
    ];
    writeTranscript('a-project', sessionId, {
      cwd: '/a/project',
      day: '2026-06-11',
      durationMs: 1200,
      tokens: 1000,
      assistant: true,
    });
    writeTranscript('z-project', sessionId, {
      cwd: '/a/project',
      day: '2026-06-11',
      durationMs: 1200,
      tokens: 2000,
      assistant: true,
    });
    seedPersisted(persisted);

    const assertDirectoryFirst = (records: UsageSummaryRecord[]) => {
      expect(totalTokensOf(aggregateUsage(records, 'all'))).toBe(1200);
      expect(
        records.find(
          (record) =>
            record.sessionId === sessionId && record.transcriptRebuild,
        )?.project,
      ).toBe('/a/project');
    };
    assertDirectoryFirst(await loadUsageHistoryWithLive({ sinceMs: 0 }));
    assertDirectoryFirst(await loadUsageHistoryWithLive({ sinceMs: 0 }));
    _resetReplayCacheForTest();
    assertDirectoryFirst(await loadUsageHistoryWithLive({ sinceMs: 0 }));
  });

  it('caches each exact beforeMs boundary of an unchanged transcript', async () => {
    const sessionId = 'boundary-session';
    const filePath = writeTranscript('repro-project', sessionId, {
      cwd: '/p',
      day: '2026-06-11',
      durationMs: 1200,
      tokens: 100,
    });
    const later = {
      sessionId,
      timestamp: '2026-06-11T00:03:00.000Z',
      type: 'system',
      subtype: 'ui_telemetry',
      systemPayload: {
        uiEvent: {
          'event.name': 'qwen-code.api_response',
          'event.timestamp': '2026-06-11T00:03:00.000Z',
          response_id: 'later-response',
          model: 'qwen-max',
          duration_ms: 1200,
          input_token_count: 120,
          output_token_count: 60,
          cached_content_token_count: 0,
          thoughts_token_count: 20,
          total_token_count: 200,
          prompt_id: 'later-prompt',
        },
      },
    };
    fs.appendFileSync(
      filePath,
      `${JSON.stringify(later)}\n${JSON.stringify({
        sessionId,
        timestamp: '2026-06-11T00:04:00.000Z',
        type: 'assistant',
        message: { role: 'assistant', content: 'done' },
      })}\n`,
    );
    seedPersisted([
      runRec(
        sessionId,
        200,
        Date.parse('2026-06-11T12:00:00Z'),
        Date.parse('2026-06-11T12:01:00Z'),
      ),
    ]);
    const originalOpen = fs.promises.open;
    const opened: string[] = [];
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation(((
      p: fs.PathLike,
      flags?: string | number,
      mode?: fs.Mode,
    ) => {
      opened.push(String(p));
      return originalOpen(p, flags as number, mode);
    }) as typeof fs.promises.open);
    try {
      const first = await loadUsageHistory(sessionId, {
        persistRebuild: false,
        beforeMsBySession: new Map([
          [sessionId, Date.parse('2026-06-11T00:02:00Z')],
        ]),
      });
      const second = await loadUsageHistory(sessionId, {
        persistRebuild: false,
        beforeMsBySession: new Map([
          [sessionId, Date.parse('2026-06-11T00:06:00Z')],
        ]),
      });
      expect(totalTokensOf(aggregateUsage(first, 'all'))).toBe(300);
      expect(totalTokensOf(aggregateUsage(second, 'all'))).toBe(500);
      expect(
        first.find((record) => record.transcriptRebuild)?.models['qwen-max']
          ?.totalTokens,
      ).toBe(100);
      expect(
        second.find((record) => record.transcriptRebuild)?.models['qwen-max']
          ?.totalTokens,
      ).toBe(300);
      expect(
        opened.filter((filePath) => filePath.endsWith(`${sessionId}.jsonl`)),
      ).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('applies the trailing mtime window even with run-scoped history', async () => {
    const now = Date.now();
    const transcriptStart = Date.parse('2026-06-11T00:00:00Z');
    const oldRunStart = transcriptStart + DAY;
    seedPersisted([
      runRec('run-only', 50, now - DAY, now),
      {
        ...runRec('old-run', 50, oldRunStart, oldRunStart + 60_000),
        project: '/repro/project',
      },
    ]);
    const knownOld = writeTranscript(
      path.basename(
        path.dirname(
          path.dirname(
            new SessionService('/repro/project', {
              runtimeBaseDir: process.env['QWEN_HOME']!,
            }).getSessionTranscriptPath('old-run'),
          ),
        ),
      ),
      'old-run',
      {
        cwd: '/repro/project',
        day: '2026-06-11',
        durationMs: 1200,
        tokens: 100,
        assistant: true,
      },
    );
    fs.utimesSync(knownOld, (now - 100 * DAY) / 1000, (now - 100 * DAY) / 1000);
    const older = plantChatJsonl('old-unrecorded', 100);
    const stale = (now - 100 * DAY) / 1000;
    fs.utimesSync(older, stale, stale);
    const recent = plantChatJsonl('recent-unrecorded', 100);
    const originalOpen = fs.promises.open;
    const opened: string[] = [];
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation(((
      p: fs.PathLike,
      flags?: string | number,
      mode?: fs.Mode,
    ) => {
      opened.push(String(p));
      return originalOpen(p, flags as number, mode);
    }) as typeof fs.promises.open);
    try {
      const records = await loadUsageHistoryWithLive();
      expect(records.map((record) => record.sessionId).sort()).toEqual([
        'old-run',
        'old-run',
        'recent-unrecorded',
        'run-only',
      ]);
      expect(
        records.map((record) => [
          record.sessionId,
          record.models['qwen-max']?.totalTokens,
          record.startTime,
          record.timestamp,
        ]),
      ).toEqual([
        ['old-run', 100, transcriptStart, transcriptStart + 120_000],
        ['old-run', 50, oldRunStart, oldRunStart + 60_000],
        ['recent-unrecorded', 100, transcriptStart, transcriptStart + 120_000],
        ['run-only', 50, now - DAY, now],
      ]);
      expect(totalTokensOf(aggregateUsage(records, 'all'))).toBe(300);
      expect(opened).not.toContain(older);
      expect(opened).toContain(recent);
      expect(opened).toContain(knownOld);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not count a forked parent transcript as additional branch usage', async () => {
    const projectRoot = process.cwd();
    const parentId = '11111111-1111-4111-8111-111111111111';
    const forkId = '22222222-2222-4222-8222-222222222222';
    const runtimeBaseDir = process.env['QWEN_HOME']!;
    const service = new SessionService(projectRoot, { runtimeBaseDir });
    const sourcePath = service.getSessionTranscriptPath(parentId);
    expect(
      writeTranscript(
        path.basename(path.dirname(path.dirname(sourcePath))),
        parentId,
        {
          cwd: projectRoot,
          day: '2026-06-11',
          durationMs: 1200,
          tokens: 1000,
          assistant: true,
        },
      ),
    ).toBe(sourcePath);
    await loadUsageHistory();
    const forked = await service.forkSession(parentId, forkId);
    expect(forked.copiedCount).toBeGreaterThan(0);
    const start = Date.parse('2026-06-12T00:00:00Z');
    fs.appendFileSync(
      usagePath(),
      `${JSON.stringify(runRec(forkId, 100, start, start + 60_000))}\n`,
    );

    const records = await loadUsageHistoryWithLive({ sinceMs: 0 });
    const report = aggregateUsage(records, 'all');
    expect(report.sessionCount).toBe(2);
    expect(report.totalDurationMs).toBe(180_000);
    expect(report.totalRequests).toBe(2);
    expect(totalTokensOf(report)).toBe(1100);
    expect(
      report.projects.reduce((sum, project) => sum + project.totalTokens, 0),
    ).toBe(1100);
    expect(
      records.find((record) => record.sessionId === forkId)?.runScoped,
    ).toBe(true);
  });

  it.each([
    ['line-delimited records', '\n'],
    ['small glued records', ''],
  ])(
    'retains native post-fork usage with %s while excluding inherited rows',
    async (_shape, separator) => {
      const projectRoot = process.cwd();
      const parentId = '11111111-1111-4111-8111-111111111111';
      const forkId = '22222222-2222-4222-8222-222222222222';
      const service = new SessionService(projectRoot, {
        runtimeBaseDir: process.env['QWEN_HOME']!,
      });
      const sourcePath = service.getSessionTranscriptPath(parentId);
      writeTranscript(
        path.basename(path.dirname(path.dirname(sourcePath))),
        parentId,
        {
          cwd: projectRoot,
          day: '2026-06-11',
          durationMs: 1200,
          tokens: 1000,
          assistant: true,
        },
      );
      await loadUsageHistory();
      const forked = await service.forkSession(parentId, forkId);
      const at = (minute: number) => `2026-06-13T00:0${minute}:00.000Z`;
      const native = [
        {
          sessionId: forkId,
          cwd: projectRoot,
          uuid: 'branch-u1',
          parentUuid: 'u3',
          timestamp: at(0),
          type: 'user',
          message: { role: 'user', content: 'native branch request' },
        },
        {
          sessionId: forkId,
          cwd: projectRoot,
          uuid: 'branch-u2',
          parentUuid: 'branch-u1',
          timestamp: at(1),
          type: 'system',
          subtype: 'ui_telemetry',
          systemPayload: {
            uiEvent: {
              'event.name': 'qwen-code.api_response',
              'event.timestamp': at(1),
              response_id: 'branch-response',
              model: 'qwen-max',
              duration_ms: 800,
              input_token_count: 300,
              output_token_count: 150,
              cached_content_token_count: 0,
              thoughts_token_count: 50,
              total_token_count: 500,
              prompt_id: 'branch-prompt',
            },
          },
        },
        {
          sessionId: forkId,
          cwd: projectRoot,
          uuid: 'branch-u3',
          parentUuid: 'branch-u2',
          timestamp: at(2),
          type: 'assistant',
          message: { role: 'assistant', content: 'native branch response' },
        },
      ];
      // No child run record: deriving this activity from the daemon transcript
      // is the only way it can be counted. An interrupted append may also lose
      // the inherited file's final newline, gluing it to the next JSON object.
      if (separator === '') {
        fs.writeFileSync(
          forked.filePath,
          fs.readFileSync(forked.filePath, 'utf8').trimEnd(),
        );
      }
      fs.appendFileSync(
        forked.filePath,
        native.map((record) => JSON.stringify(record)).join(separator) + '\n',
      );
      if (separator === '') {
        expect(
          fs.readFileSync(forked.filePath, 'utf8').trimEnd().split('}{'),
        ).toHaveLength(4);
      }

      const records = await loadUsageHistoryWithLive({ sinceMs: 0 });
      const report = aggregateUsage(records, 'all');
      expect(report.sessionCount).toBe(2);
      expect(totalTokensOf(report)).toBe(1500);
      expect(report.totalRequests).toBe(2);
      expect(report.totalDurationMs).toBe(240_000);
      const branch = records.find((record) => record.sessionId === forkId);
      expect(branch?.transcriptRebuild).toBe(true);
      expect(branch?.startTime).toBe(Date.parse(at(0)));
      expect(branch?.timestamp).toBe(Date.parse(at(2)));
      expect(usageLines()).toHaveLength(1);
    },
  );

  it('marks what /clear and exit write as run-scoped', async () => {
    persistLive('sess-marker');

    const written = usageLines().map(
      (l) => JSON.parse(l) as UsageSummaryRecord,
    );
    expect(written).toHaveLength(1);
    expect(written[0]!.runScoped).toBe(true);
  });

  it('keeps every disjoint run of one session (run-scoped records are deltas)', async () => {
    seedPersisted([
      runRec('sess-runs', 1000, t0, t0 + 60_000),
      runRec('sess-runs', 2000, t0 + DAY, t0 + DAY + 60_000),
    ]);

    const records = await loadUsageHistory();

    expect(records).toHaveLength(2);
    expect(totalTokensOf(aggregateUsage(records, 'all'))).toBe(3000);
  });

  it('keeps adjacent runs, including a same-session resume in one millisecond', async () => {
    seedPersisted([
      runRec('sess-adjacent', 1000, t0, t0 + 60_000),
      runRec('sess-adjacent', 2000, t0 + 60_000, t0 + 120_000),
    ]);

    const records = await loadUsageHistory();

    expect(records).toHaveLength(2);
    expect(totalTokensOf(aggregateUsage(records, 'all'))).toBe(3000);
  });

  it('still collapses a run written twice (partially overlapping windows, last wins)', async () => {
    seedPersisted([
      runRec('sess-twice', 1000, t0, t0 + 60_000),
      runRec('sess-twice', 1600, t0, t0 + 120_000),
    ]);

    const records = await loadUsageHistory();

    expect(records).toHaveLength(1);
    expect(records[0]!.models['qwen-max']!.totalTokens).toBe(1600);
  });

  it('collapses exactly identical runs, including zero-length copies', async () => {
    seedPersisted([
      runRec('sess-equal', 1000, t0, t0 + 60_000),
      runRec('sess-equal', 1600, t0, t0 + 60_000),
      runRec('sess-zero', 2000, t0, t0),
      runRec('sess-zero', 3000, t0, t0),
    ]);

    const records = await loadUsageHistory();

    expect(records).toHaveLength(2);
    expect(records[0]!.models['qwen-max']!.totalTokens).toBe(1600);
    expect(records[1]!.models['qwen-max']!.totalTokens).toBe(3000);
  });

  it('collapses a run and rebuild over exactly the same zero-length window', () => {
    const records = dedupBySessionId([
      { ...runRec('sess-zero-mixed', 10, t0, t0) },
      {
        ...runRec('sess-zero-mixed', 1000, t0, t0),
        runScoped: false,
        transcriptRebuild: true,
      },
    ]);

    expect(records).toHaveLength(1);
    expect(records[0]!.models['qwen-max']!.totalTokens).toBe(10);
  });

  it('preserves a covering rebuild and its known run skills', () => {
    const records = dedupBySessionId([
      {
        ...persistedRec('sess-covered-skills', 1000),
        startTime: t0,
        timestamp: t0 + 120_000,
        transcriptRebuild: true,
        requestExecutionIds: ['request-with-skill'],
      },
      {
        ...runRec('sess-covered-skills', 500, t0 + 10_000, t0 + 20_000),
        requestExecutionIds: ['request-with-skill'],
        skills: {
          totalCalls: 2,
          totalSuccess: 2,
          totalFail: 0,
          byName: {
            'helper-skill': { count: 1, success: 1, fail: 0 },
            ['__proto__']: { count: 1, success: 1, fail: 0 },
          },
        },
      },
    ]);

    expect(records).toHaveLength(1);
    expect(records[0]!.transcriptRebuild).toBe(true);
    expect(records[0]!.models['qwen-max']!.totalTokens).toBe(1000);
    expect(records[0]!.skills?.totalCalls).toBe(2);
    expect(records[0]!.skills?.byName['helper-skill']?.count).toBe(1);
    expect(Object.hasOwn(records[0]!.skills!.byName, '__proto__')).toBe(true);
    expect(records[0]!.skills?.byName['__proto__']?.count).toBe(1);
  });

  it('preserves a covering rebuild across the exit-persist clock gap', () => {
    const records = dedupBySessionId([
      {
        ...persistedRec('sess-covered-at-exit', 1000),
        startTime: t0,
        timestamp: t0 + 120_000,
        transcriptRebuild: true,
        requestExecutionIds: ['request-1'],
      },
      {
        ...runRec('sess-covered-at-exit', 1000, t0 + 60_000, t0 + 120_900),
        requestExecutionIds: ['request-1'],
      },
    ]);

    expect(records).toHaveLength(1);
    expect(records[0]!.transcriptRebuild).toBe(true);
    expect(records[0]!.models['qwen-max']!.totalTokens).toBe(1000);
  });

  it('keeps same-window runs for distinct projects without request ids', () => {
    const records = dedupBySessionId([
      {
        ...runRec('shared-id', 100, t0, t0 + 300),
        project: '/project/a',
      },
      {
        ...runRec('shared-id', 200, t0, t0 + 300),
        project: '/project/b',
      },
    ]);

    expect(records).toHaveLength(2);
    expect(totalTokensOf(aggregateUsage(records, 'all'))).toBe(300);
  });

  it('keeps two independent calls with equal counters but different execution ids', () => {
    const records = dedupBySessionId([
      {
        ...runRec('sess-distinct-calls', 100, t0, t0 + 60_000),
        transcriptRebuild: true,
        requestExecutionIds: ['request-2'],
      },
      {
        ...runRec('sess-distinct-calls', 100, t0, t0 + 60_000),
        requestExecutionIds: ['request-1'],
      },
    ]);

    expect(records).toHaveLength(2);
    expect(totalTokensOf(aggregateUsage(records, 'all'))).toBe(200);
  });

  it('keeps same-window runs with independent request identities', () => {
    const records = dedupBySessionId([
      {
        ...runRec('sess-parallel-runs', 100, t0, t0 + 300),
        requestExecutionIds: ['run-a'],
      },
      {
        ...runRec('sess-parallel-runs', 100, t0, t0 + 300),
        requestExecutionIds: ['run-b'],
      },
    ]);

    expect(records).toHaveLength(2);
    expect(totalTokensOf(aggregateUsage(records, 'all'))).toBe(200);
  });

  it('retains distinct known calls on both sides of a partial ID overlap', () => {
    const shared = modelUsage(1, 100, 0, 100);
    const records = dedupBySessionId([
      {
        ...runRec('partial-runs', 100, t0 + 1_000, t0 + 2_000),
        requestExecutionIds: ['shared', 'alpha-only'],
        models: { 'qwen-max': shared, 'alpha-model': shared },
      },
      {
        ...runRec('partial-runs', 100, t0 + 1_500, t0 + 2_500),
        requestExecutionIds: ['shared', 'beta-only'],
        models: { 'qwen-max': shared, 'beta-model': shared },
      },
    ]);
    expect(records).toHaveLength(2);
    expect(aggregateUsage(records, 'all')).toMatchObject({
      models: {
        'alpha-model': { requests: 1 },
        'beta-model': { requests: 1 },
      },
    });

    const partialNative = dedupBySessionId([
      {
        ...runRec('partial-native', 100, t0 + 1_000, t0 + 2_000),
        requestExecutionIds: ['shared'],
      },
      {
        ...persistedRec('partial-native', 200),
        startTime: t0 + 1_100,
        timestamp: t0 + 2_200,
        transcriptRebuild: true,
        models: { 'qwen-max': modelUsage(2, 200, 0, 200) },
        requestExecutionIds: ['shared', 'rebuild-only'],
      },
    ]);
    expect(partialNative).toHaveLength(1);
    expect(partialNative[0]?.transcriptRebuild).toBe(true);
    expect(aggregateUsage(partialNative, 'all')).toMatchObject({
      totalRequests: 2,
      models: { 'qwen-max': { totalTokens: 200 } },
    });

    const olderCoversNewer = dedupBySessionId([
      {
        ...runRec('older-covers-newer', 200, t0 + 1_000, t0 + 2_000),
        requestExecutionIds: ['shared', 'older-only'],
        models: { 'qwen-max': modelUsage(2, 200, 0, 200) },
      },
      {
        ...runRec('older-covers-newer', 100, t0 + 1_500, t0 + 2_500),
        requestExecutionIds: ['shared'],
      },
    ]);
    expect(olderCoversNewer).toHaveLength(1);
    expect(olderCoversNewer[0]?.requestExecutionIds).toContain('older-only');
    expect(aggregateUsage(olderCoversNewer, 'all')).toMatchObject({
      totalRequests: 2,
      models: { 'qwen-max': { totalTokens: 200 } },
    });
  });

  it('does not count a partial identity overlap as independent usage', () => {
    const records = dedupBySessionId([
      {
        ...persistedRec('sess-internal-overlap', 100),
        startTime: t0,
        timestamp: t0 + 300,
        transcriptRebuild: true,
        requestExecutionIds: ['shared-response'],
      },
      {
        ...runRec('sess-internal-overlap', 200, t0 + 100, t0 + 200),
        requestExecutionIds: ['shared-response', 'internal-prompt'],
      },
    ]);

    expect(records).toHaveLength(1);
    expect(records[0]!.transcriptRebuild).toBeUndefined();
    expect(totalTokensOf(aggregateUsage(records, 'all'))).toBe(200);
  });

  it('keeps the run when unidentifiable tool details disagree', () => {
    const records = dedupBySessionId([
      {
        ...persistedRec('sess-tool-mismatch', 100),
        startTime: t0,
        timestamp: t0 + 120_000,
        transcriptRebuild: true,
        tools: {
          totalCalls: 1,
          totalSuccess: 0,
          totalFail: 1,
          byName: {
            read_file: { count: 1, success: 0, fail: 1 },
          },
        },
      },
      {
        ...runRec('sess-tool-mismatch', 100, t0, t0 + 210_000),
        tools: {
          totalCalls: 1,
          totalSuccess: 1,
          totalFail: 0,
          byName: {
            edit_file: { count: 1, success: 1, fail: 0 },
          },
        },
      },
    ]);

    expect(records).toHaveLength(1);
    expect(records[0]!.transcriptRebuild).toBeUndefined();
    expect(records[0]!.tools.byName['edit_file']?.success).toBe(1);
    expect(records[0]!.tools.totalFail).toBe(0);
  });

  it('preserves a covering rebuild when the user exits after a reading pause', () => {
    const records = dedupBySessionId([
      {
        ...persistedRec('sess-idle-exit', 1000),
        startTime: t0,
        timestamp: t0 + 120_000,
        transcriptRebuild: true,
      },
      runRec('sess-idle-exit', 1000, t0 + 60_000, t0 + 210_000),
    ]);

    expect(records).toHaveLength(1);
    expect(records[0]!.transcriptRebuild).toBe(true);
    expect(records[0]!.models['qwen-max']!.totalTokens).toBe(1000);
  });

  it('keeps a rebuild whose window and counters cover the live run', () => {
    const records = dedupBySessionId([
      {
        ...persistedRec('sess-covered', 1000),
        startTime: t0,
        timestamp: t0 + 120_000,
        transcriptRebuild: true,
        requestExecutionIds: ['request-covered'],
      },
      {
        ...runRec('sess-covered', 10, t0 + 10_000, t0 + 20_000),
        requestExecutionIds: ['request-covered'],
      },
    ]);

    expect(records).toHaveLength(1);
    expect(records[0]!.transcriptRebuild).toBe(true);
    expect(records[0]!.models['qwen-max']!.totalTokens).toBe(1000);
  });

  it('does not retain a partial-overlap rebuild merely for another disjoint run', () => {
    const records = dedupBySessionId([
      runRec('sess-mixed', 200, t0 + 10_000, t0 + 30_000),
      runRec('sess-mixed', 100, t0 + 60_000, t0 + 70_000),
      {
        ...persistedRec('sess-mixed', 1000),
        startTime: t0 + 20_000,
        timestamp: t0 + 50_000,
        transcriptRebuild: true,
      },
    ]);

    expect(records).toHaveLength(2);
    expect(records.every((record) => !record.transcriptRebuild)).toBe(true);
  });

  it('does not replace an identityless run merely because a rebuild has identities', () => {
    const records = dedupBySessionId([
      {
        ...persistedRec('sess-mixed-identities', 1000),
        startTime: t0,
        timestamp: t0 + 120_000,
        transcriptRebuild: true,
        requestExecutionIds: ['replayed-request'],
      },
      runRec('sess-mixed-identities', 500, t0 + 10_000, t0 + 20_000),
    ]);

    expect(records).toHaveLength(1);
    expect(records[0]!.transcriptRebuild).toBeUndefined();
    expect(records[0]!.models['qwen-max']!.totalTokens).toBe(500);
  });

  it('does not cover a legacy run with lower per-model counters', () => {
    const records = dedupBySessionId([
      {
        ...persistedRec('sess-lower-counters', 1000),
        startTime: t0,
        timestamp: t0 + 120_000,
        transcriptRebuild: true,
        models: {
          'qwen-max': {
            requests: 0,
            inputTokens: 1000,
            outputTokens: 0,
            cachedTokens: 0,
            thoughtsTokens: 0,
            totalTokens: 1000,
          },
        },
      },
      runRec('sess-lower-counters', 500, t0 + 10_000, t0 + 20_000),
    ]);

    expect(records).toHaveLength(1);
    expect(records[0]!.transcriptRebuild).toBeUndefined();
    expect(records[0]!.models['qwen-max']!.totalTokens).toBe(500);
  });

  it('retains a known run when a rebuilt record lacks tool telemetry', () => {
    const run = runRec('sess-missing-tools', 500, t0 + 10_000, t0 + 20_000);
    const records = dedupBySessionId([
      {
        ...persistedRec('sess-missing-tools', 1000),
        startTime: t0,
        timestamp: t0 + 120_000,
        transcriptRebuild: true,
        tools: undefined,
      } as unknown as UsageSummaryRecord,
      run,
    ]);

    expect(records).toEqual([run]);
  });

  it('keeps last-wins for cumulative records, which are copies not runs', async () => {
    // Pre-run-scoped history: a resume replayed the conversation's history into
    // each record, so disjoint windows still describe the same spend.
    const legacy = (tokens: number, startMs: number, endMs: number) => ({
      ...persistedRec('sess-legacy', tokens),
      startTime: startMs,
      timestamp: endMs,
    });
    seedPersisted([
      legacy(1000, t0, t0 + 60_000),
      legacy(1600, t0 + DAY, t0 + DAY + 60_000),
    ]);

    const records = await loadUsageHistory();

    expect(records).toHaveLength(1);
    expect(records[0]!.models['qwen-max']!.totalTokens).toBe(1600);
  });

  it('keeps a real transcript migration beside a later disjoint run', async () => {
    writeTranscript('repro-migration', 'sess-migration', {
      cwd: '/repro/migration',
      day: '2026-06-11',
      durationMs: 1200,
      tokens: 1000,
      assistant: true,
    });
    const migrated = await loadUsageHistory();
    expect(migrated).toHaveLength(1);
    expect(migrated[0]!.transcriptRebuild).toBe(true);
    expect(totalTokensOf(aggregateUsage(migrated, 'all'))).toBe(1000);

    persistSessionUsage({
      sessionId: 'sess-migration',
      startTime: new Date(migrated[0]!.timestamp),
      endTime: new Date(migrated[0]!.timestamp + DAY),
      project: '/repro/migration',
      metrics: makeMetrics({
        models: {
          'qwen-max': modelMetrics([2, 0, 100], [200, 0, 200, 0, 0]),
        },
      }),
    });

    const kept = await loadUsageHistory();

    expect(kept).toHaveLength(2);
    expect(kept.some((record) => record.transcriptRebuild === true)).toBe(true);
    expect(totalTokensOf(aggregateUsage(kept, 'all'))).toBe(1200);
  });

  it('preserves an old migration beside a run without double-counting its later transcript activity', async () => {
    const sessionId = 'sess-legacy-with-later-run';
    const filePath = plantChatJsonl(sessionId, 1000);
    const [legacy] = await loadUsageHistory();
    expect(legacy).toBeDefined();
    delete legacy!.transcriptRebuild;

    const runStart = Date.parse('2026-06-11T00:03:00Z');
    const laterResponse = {
      sessionId,
      timestamp: new Date(runStart + 10_000).toISOString(),
      type: 'system',
      subtype: 'ui_telemetry',
      systemPayload: {
        uiEvent: {
          'event.name': 'qwen-code.api_response',
          'event.timestamp': new Date(runStart + 10_000).toISOString(),
          response_id: 'later-run',
          model: 'qwen-max',
          duration_ms: 1200,
          input_token_count: 120,
          output_token_count: 60,
          cached_content_token_count: 0,
          thoughts_token_count: 20,
          total_token_count: 200,
          prompt_id: 'later-run',
        },
      },
    };
    const assistant = {
      sessionId,
      timestamp: new Date(runStart + 60_000).toISOString(),
      type: 'assistant',
      message: { role: 'assistant', content: 'done' },
    };
    fs.appendFileSync(
      filePath,
      `${JSON.stringify(laterResponse)}\n${JSON.stringify(assistant)}\n`,
    );
    seedPersisted([
      legacy!,
      {
        ...runRec(sessionId, 200, runStart, runStart + 60_000),
        project: '/repro/project',
      },
    ]);

    const records = await loadUsageHistory();

    expect(records).toHaveLength(2);
    const rebuilt = records.find((r) => r.transcriptRebuild === true);
    expect(rebuilt?.models['qwen-max']?.inputTokens).toBe(600);
    expect(totalTokensOf(aggregateUsage(records, 'all'))).toBe(1200);
    expect(usageLines()).toHaveLength(2);
  });

  it('keeps whole-transcript rebuilds cumulative for one project and collapses copies', async () => {
    writeTranscript('repro-project', 'sess-rebuilt', {
      cwd: '/repro/project',
      day: '2026-06-11',
      durationMs: 1200,
      tokens: 1000,
      assistant: true,
    });
    writeTranscript('zzz-repro-project', 'sess-rebuilt', {
      cwd: '/repro/project',
      day: '2026-06-12',
      durationMs: 1200,
      tokens: 2000,
      assistant: true,
    });

    const records = await loadUsageHistory();

    expect(records).toHaveLength(1);
    expect(records[0]!.runScoped).toBeUndefined();
    expect(records[0]!.models['qwen-max']!.totalTokens).toBe(1000);
    expect(totalTokensOf(aggregateUsage(records, 'all'))).toBe(1000);
  });

  it('prefers run-scoped runs over a cumulative record for the same session', async () => {
    // A conversation that spans the upgrade: one trustworthy run delta plus a
    // pre-upgrade cumulative record. The cumulative one may itself be inflated
    // by a replay, so it is dropped rather than added — undercounting an
    // ambiguous legacy overlap is the safe direction, double counting is not.
    seedPersisted([
      runRec('sess-upgrade', 1000, t0, t0 + 60_000),
      {
        ...persistedRec('sess-upgrade', 5000),
        startTime: t0 + DAY,
        timestamp: t0 + DAY + 60_000,
      },
    ]);

    const records = await loadUsageHistory();

    expect(records).toHaveLength(1);
    expect(records[0]!.models['qwen-max']!.totalTokens).toBe(1000);
  });

  it('migrates a same-id transcript from another project without persisting the active project', async () => {
    const sessionId = 'shared-across-projects';
    const projectA = path.resolve('/migration/project-a');
    const projectB = path.resolve('/migration/project-b');
    writeTranscript('project-a', sessionId, {
      cwd: projectA,
      day: '2026-06-10',
      durationMs: 1000,
      tokens: 100,
      assistant: true,
    });
    const projectBTranscript = writeTranscript('project-b', sessionId, {
      cwd: projectB,
      day: '2026-06-11',
      durationMs: 2000,
      tokens: 200,
      assistant: true,
    });
    appendNativeResponse(
      projectBTranscript,
      sessionId,
      '2026-06-11T00:03:00.000Z',
      'project-b-after-project-a-cutoff',
      50,
    );

    const first = await loadUsageHistory(sessionId, {
      projectRoot: projectA,
      beforeMsBySession: new Map([
        [sessionId, Date.parse('2026-06-11T00:00:30.000Z')],
      ]),
    });
    expect(totalTokensOf(aggregateUsage(first, 'all'))).toBe(350);
    expect(usageLines().map((line) => JSON.parse(line))).toMatchObject([
      {
        sessionId,
        project: projectB,
        transcriptRebuild: true,
        requestExecutionIds: ['project-b-after-project-a-cutoff'],
        models: { 'qwen-max': { requests: 2, totalTokens: 250 } },
      },
    ]);

    const second = await loadUsageHistory(sessionId, {
      projectRoot: projectA,
    });
    expect(totalTokensOf(aggregateUsage(second, 'all'))).toBe(350);
    expect(usageLines()).toHaveLength(1);

    fs.rmSync(projectBTranscript);
    const withoutB = await loadUsageHistoryWithLive({ sinceMs: 0 });
    expect(totalTokensOf(aggregateUsage(withoutB, 'all'))).toBe(350);
    expect(
      withoutB.find((record) => record.project === projectB)?.models['qwen-max']
        ?.totalTokens,
    ).toBe(250);
  });

  it('retains whole-session migration exclusion without a project root', async () => {
    const sessionId = 'legacy-shared-session';
    writeTranscript('legacy-a', sessionId, {
      cwd: '/legacy/project-a',
      day: '2026-06-11',
      durationMs: 1000,
      tokens: 100,
      assistant: true,
    });
    writeTranscript('legacy-b', sessionId, {
      cwd: '/legacy/project-b',
      day: '2026-06-11',
      durationMs: 2000,
      tokens: 200,
      assistant: true,
    });

    const records = await loadUsageHistory(sessionId);

    expect(totalTokensOf(aggregateUsage(records, 'all'))).toBe(300);
    expect(fs.existsSync(usagePath())).toBe(false);
  });

  it('withLive: a cumulative copy does not add on top of persisted runs', async () => {
    seedPersisted([
      runRec('sess-mixed', 1000, t0, t0 + 60_000),
      {
        ...persistedRec('sess-mixed', 3000),
        startTime: t0,
        timestamp: t0 + DAY + 60_000,
      },
      runRec('sess-mixed', 2000, t0 + DAY, t0 + DAY + 60_000),
    ]);

    const merged = await loadUsageHistoryWithLive();

    expect(merged).toHaveLength(2);
    expect(totalTokensOf(aggregateUsage(merged, 'all'))).toBe(3000);
  });
});

// The live merge rescans only transcripts whose mtime/size changed and serves
// the rest from an in-process replay cache; the scan itself JSON-parses just
// the header and telemetry lines, skipping the large tool-result payloads.
describe('loadUsageHistoryWithLive — replay cache + selective scan', () => {
  useTempQwenHome('qwen-usage-replay-cache-');
  beforeEach(() => {
    _resetReplayCacheForTest();
  });

  const plant = (sessionId: string, tokens: number) =>
    writeTranscript('cache-project', sessionId, {
      cwd: '/cache/project',
      day: '2026-06-11',
      durationMs: 1200,
      tokens,
      assistant: true,
    });

  const tokensOf = (records: UsageSummaryRecord[], sessionId: string) => {
    const r = records.find((x) => x.sessionId === sessionId);
    return r
      ? Object.values(r.models).reduce((sum, m) => sum + m.totalTokens, 0)
      : undefined;
  };

  it('returns identical records on a repeated load of unchanged transcripts', async () => {
    plant('sess-stable', 1000);
    const first = await loadUsageHistoryWithLive();
    const second = await loadUsageHistoryWithLive();
    expect(second).toEqual(first);
    expect(tokensOf(second, 'sess-stable')).toBe(1000);
  });

  it('does not reuse a whole cached response at an exclusive timestamp boundary', async () => {
    const sessionId = 'sess-exclusive-boundary';
    writeTranscript('cache-project', sessionId, {
      cwd: '/cache/project',
      day: '2026-06-11',
      durationMs: 1200,
      tokens: 1000,
    });
    await loadUsageHistory(undefined, { persistRebuild: false });

    const records = await loadUsageHistory(undefined, {
      persistRebuild: false,
      beforeMsBySession: new Map([
        [sessionId, Date.parse('2026-06-11T00:01:00.000Z')],
      ]),
    });

    expect(records).toEqual([]);
  });

  it('rescans a transcript when it grows so active sessions stay current', async () => {
    const filePath = plant('sess-grow', 1000);
    const before = await loadUsageHistoryWithLive();
    expect(tokensOf(before, 'sess-grow')).toBe(1000);

    // Append a second api_response worth 500 tokens (size + mtime change).
    fs.appendFileSync(
      filePath,
      JSON.stringify({
        sessionId: 'sess-grow',
        cwd: '/cache/project',
        uuid: 'u-grow',
        parentUuid: 'u3',
        timestamp: '2026-06-11T00:03:00.000Z',
        type: 'system',
        subtype: 'ui_telemetry',
        systemPayload: {
          uiEvent: {
            'event.name': 'qwen-code.api_response',
            'event.timestamp': '2026-06-11T00:03:00.000Z',
            response_id: 'r2',
            model: 'qwen-max',
            duration_ms: 800,
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

    const after = await loadUsageHistoryWithLive();
    expect(tokensOf(after, 'sess-grow')).toBe(1500);
  });

  it('drops a transcript from the cache once the file is deleted', async () => {
    plant('sess-keep', 1000);
    const removed = plant('sess-remove', 500);
    const before = await loadUsageHistoryWithLive();
    expect(before.map((r) => r.sessionId).sort()).toEqual([
      'sess-keep',
      'sess-remove',
    ]);

    fs.rmSync(removed);
    const after = await loadUsageHistoryWithLive();
    expect(after.map((r) => r.sessionId)).toEqual(['sess-keep']);
  });

  it('skips large non-telemetry payloads, even ones whose text mentions ui_telemetry', async () => {
    const sessionId = 'sess-bigline';
    const dir = path.join(
      process.env['QWEN_HOME']!,
      'projects',
      'cache-project',
      'chats',
    );
    fs.mkdirSync(dir, { recursive: true });
    const base = { sessionId, cwd: '/cache/project' };
    // A ~1MB tool_result tagged `subtype:"ui_telemetry"` (so the cheap substring
    // pre-filter matches it) AND carrying its own uiEvent worth 5000 tokens with
    // distinct response/prompt ids. Only the `type === 'system'` guard keeps it
    // out: deleting that guard lets this non-system record inflate the total to
    // 6000. A fixture without a uiEvent could not discriminate the guard.
    const bigText = 'x'.repeat(1024 * 1024);
    const records = [
      {
        ...base,
        uuid: 'u1',
        parentUuid: null,
        timestamp: '2026-06-11T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', content: 'hi' },
      },
      {
        ...base,
        uuid: 'u2',
        parentUuid: 'u1',
        timestamp: '2026-06-11T00:01:00.000Z',
        type: 'tool_result',
        subtype: 'ui_telemetry',
        message: { role: 'user', content: bigText },
        systemPayload: {
          uiEvent: {
            'event.name': 'qwen-code.api_response',
            'event.timestamp': '2026-06-11T00:01:00.000Z',
            response_id: 'r-embedded',
            model: 'qwen-max',
            duration_ms: 900,
            input_token_count: 3000,
            output_token_count: 1500,
            cached_content_token_count: 0,
            thoughts_token_count: 500,
            total_token_count: 5000,
            prompt_id: 'p-embedded',
          },
        },
      },
      {
        ...base,
        uuid: 'u3',
        parentUuid: 'u2',
        timestamp: '2026-06-11T00:02:00.000Z',
        type: 'system',
        subtype: 'ui_telemetry',
        systemPayload: {
          uiEvent: {
            'event.name': 'qwen-code.api_response',
            'event.timestamp': '2026-06-11T00:02:00.000Z',
            response_id: 'r1',
            model: 'qwen-max',
            duration_ms: 1200,
            input_token_count: 600,
            output_token_count: 300,
            cached_content_token_count: 0,
            thoughts_token_count: 100,
            total_token_count: 1000,
            prompt_id: 'p1',
          },
        },
      },
    ];
    fs.writeFileSync(
      path.join(dir, `${sessionId}.jsonl`),
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );

    const merged = await loadUsageHistoryWithLive();
    // Only the real system telemetry counts (1000). The embedded uiEvent on the
    // non-system tool_result (5000) must be rejected by the type guard — without
    // the guard this total would be 6000.
    expect(tokensOf(merged, sessionId)).toBe(1000);
  });

  it('uses the regex-extracted timestamp when the trailing line is corrupt', async () => {
    const sessionId = 'sess-corrupt-tail';
    const dir = path.join(
      process.env['QWEN_HOME']!,
      'projects',
      'cache-project',
      'chats',
    );
    fs.mkdirSync(dir, { recursive: true });
    const base = { sessionId, cwd: '/cache/project' };
    const records = [
      {
        ...base,
        uuid: 'u1',
        parentUuid: null,
        timestamp: '2026-06-11T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', content: 'hi' },
      },
      {
        ...base,
        uuid: 'u2',
        parentUuid: 'u1',
        timestamp: '2026-06-11T00:01:00.000Z',
        type: 'system',
        subtype: 'ui_telemetry',
        systemPayload: {
          uiEvent: {
            'event.name': 'qwen-code.api_response',
            'event.timestamp': '2026-06-11T00:01:00.000Z',
            response_id: 'r1',
            model: 'qwen-max',
            duration_ms: 1200,
            input_token_count: 600,
            output_token_count: 300,
            cached_content_token_count: 0,
            thoughts_token_count: 100,
            total_token_count: 1000,
            prompt_id: 'p1',
          },
        },
      },
    ];
    // A truncated append: the final physical line is unparseable but still
    // carries its own timestamp. The scan must keep the session and use that
    // trailing timestamp (not drop the record, not reuse the earlier one).
    const body =
      records.map((r) => JSON.stringify(r)).join('\n') +
      '\n' +
      '{"timestamp":"2026-06-11T00:02:00.000Z","type":"assis';
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), body);

    const merged = await loadUsageHistoryWithLive();
    const r = merged.find((x) => x.sessionId === sessionId);
    expect(r).toBeDefined();
    expect(tokensOf(merged, sessionId)).toBe(1000);
    expect(r!.timestamp).toBe(new Date('2026-06-11T00:02:00.000Z').getTime());
  });

  it('returns every session when candidates exceed the scan concurrency', async () => {
    // More transcripts than REBUILD_CONCURRENCY (8) so the worker pool must
    // hand off indices; none may be lost or duplicated by the parallel pass.
    const n = 12;
    const expected = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      const sid = `sess-many-${String(i).padStart(2, '0')}`;
      plant(sid, 100 + i);
      expected.set(sid, 100 + i);
    }

    const merged = await loadUsageHistoryWithLive();
    expect(merged.length).toBe(n);
    for (const [sid, tokens] of expected) {
      expect(tokensOf(merged, sid)).toBe(tokens);
    }
  });

  it('does not cache a failed scan: a transient open failure recovers on the next load', async () => {
    const filePath = plant('sess-transient', 1000);
    const orig = fs.promises.open;
    let failedOnce = false;
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation(((
      p: fs.PathLike,
      flags?: string | number,
      mode?: fs.Mode,
    ) => {
      if (!failedOnce && String(p) === filePath) {
        failedOnce = true;
        // An asynchronous open failure (EACCES-like), not a sync throw: this is
        // the path that must NOT be memoized as "no usage".
        return Promise.reject(
          Object.assign(new Error('EACCES: simulated'), { code: 'EACCES' }),
        );
      }
      return orig(p, flags as number, mode);
    }) as typeof fs.promises.open);
    try {
      const first = await loadUsageHistoryWithLive();
      expect(
        first.find((r) => r.sessionId === 'sess-transient'),
      ).toBeUndefined();
      // The failure was not cached, so the next load rescans and recovers.
      const second = await loadUsageHistoryWithLive();
      expect(tokensOf(second, 'sess-transient')).toBe(1000);
    } finally {
      spy.mockRestore();
    }
  });

  // POSIX-only: the fake handle witnesses the fd-level read/close semantics;
  // openNoFollow's Windows fallback inserts an lstat/fstat identity step that a
  // bare fake handle cannot satisfy (the helper's own tests cover that path).
  it.skipIf(process.platform === 'win32')(
    'does not cache a failed scan: a read error after a successful open recovers on the next load',
    async () => {
      // The open succeeds and the fd recheck passes; the failure lands mid-read
      // (the `for await` catch -> rethrow branch), which an open-time rejection
      // never exercises. A failed scan must not be memoized as "no usage".
      const filePath = plant('sess-read-err', 1000);
      const orig = fs.promises.open;
      let failedOnce = false;
      let closeCalls = 0;
      const spy = vi.spyOn(fs.promises, 'open').mockImplementation(((
        p: fs.PathLike,
        flags?: string | number,
        mode?: fs.Mode,
      ) => {
        if (!failedOnce && String(p) === filePath) {
          failedOnce = true;
          const fakeHandle = {
            stat: async () => ({ isFile: () => true }) as unknown as fs.Stats,
            createReadStream: () =>
              new Readable({
                read() {
                  this.destroy(
                    Object.assign(new Error('EIO: simulated'), { code: 'EIO' }),
                  );
                },
              }),
            close: async () => {
              closeCalls++;
            },
          };
          return Promise.resolve(
            fakeHandle as unknown as fs.promises.FileHandle,
          );
        }
        return orig(p, flags as number, mode);
      }) as typeof fs.promises.open);
      try {
        const first = await loadUsageHistoryWithLive();
        expect(
          first.find((r) => r.sessionId === 'sess-read-err'),
        ).toBeUndefined();
        // The fd is owned explicitly, so it is closed even on the read-error path.
        expect(closeCalls).toBe(1);
        // The failure was not cached, so the next load rescans and recovers.
        const second = await loadUsageHistoryWithLive();
        expect(tokensOf(second, 'sess-read-err')).toBe(1000);
      } finally {
        spy.mockRestore();
      }
    },
  );

  // POSIX-only for the same reason as the read-error companion above.
  it.skipIf(process.platform === 'win32')(
    'closes the handle when stat() rejects before a stream exists, and does not cache the failure',
    async () => {
      // stat() can reject (EIO/ESTALE on a network- or FUSE-backed home) after a
      // successful open but before any stream exists to inherit the fd. The
      // handle must still be closed, and the failed scan must not be memoized.
      const filePath = plant('sess-stat-err', 1000);
      const orig = fs.promises.open;
      let failedOnce = false;
      let closeCalls = 0;
      let readStreamCalls = 0;
      const spy = vi.spyOn(fs.promises, 'open').mockImplementation(((
        p: fs.PathLike,
        flags?: string | number,
        mode?: fs.Mode,
      ) => {
        if (!failedOnce && String(p) === filePath) {
          failedOnce = true;
          const fakeHandle = {
            stat: async () => {
              throw Object.assign(new Error('EIO: simulated'), { code: 'EIO' });
            },
            createReadStream: () => {
              readStreamCalls++;
              return new Readable({ read() {} });
            },
            close: async () => {
              closeCalls++;
            },
          };
          return Promise.resolve(
            fakeHandle as unknown as fs.promises.FileHandle,
          );
        }
        return orig(p, flags as number, mode);
      }) as typeof fs.promises.open);
      try {
        const first = await loadUsageHistoryWithLive();
        expect(
          first.find((r) => r.sessionId === 'sess-stat-err'),
        ).toBeUndefined();
        expect(closeCalls).toBe(1);
        // The recheck must refuse before any stream is created: counting is
        // discriminating (a createReadStream that throws would be swallowed by
        // the inner catch and produce the same observables).
        expect(readStreamCalls).toBe(0);
        const second = await loadUsageHistoryWithLive();
        expect(tokensOf(second, 'sess-stat-err')).toBe(1000);
      } finally {
        spy.mockRestore();
      }
    },
  );

  // POSIX-only: fake-handle fd semantics, like the companions above.
  it.skipIf(process.platform === 'win32')(
    'a close() failure after a complete read does not discard the scan',
    async () => {
      // The bytes are fully read; a best-effort close() that rejects must not
      // replace the success (nor, on the read-error path, mask the read error).
      const filePath = plant('sess-close-err', 1000);
      const orig = fs.promises.open;
      let failedOnce = false;
      const spy = vi.spyOn(fs.promises, 'open').mockImplementation(((
        p: fs.PathLike,
        flags?: string | number,
        mode?: fs.Mode,
      ) => {
        if (!failedOnce && String(p) === filePath) {
          failedOnce = true;
          const content = fs.readFileSync(filePath, 'utf8');
          const fakeHandle = {
            stat: async () => ({ isFile: () => true }) as unknown as fs.Stats,
            createReadStream: () =>
              new Readable({
                read() {
                  this.push(content);
                  this.push(null);
                },
              }),
            close: async () => {
              throw Object.assign(new Error('EIO: close failed'), {
                code: 'EIO',
              });
            },
          };
          return Promise.resolve(
            fakeHandle as unknown as fs.promises.FileHandle,
          );
        }
        return orig(p, flags as number, mode);
      }) as typeof fs.promises.open);
      try {
        const first = await loadUsageHistoryWithLive();
        expect(tokensOf(first, 'sess-close-err')).toBe(1000);
      } finally {
        spy.mockRestore();
      }
    },
  );

  it('degrades to a plain open on an inode-0 volume so usage is not silently emptied', async () => {
    // openNoFollow's no-O_NOFOLLOW fallback refuses an inode-0 volume (FAT/exFAT,
    // some SMB) as unverifiable. A usage replay is not identity-sensitive, so it
    // must degrade to the plain non-blocking open and still read the transcript
    // (the gitDiff.ts posture). Force the fallback: hide O_NOFOLLOW and report
    // ino 0 from the pre-open lstat, then load through a freshly imported module.
    const filePath = plant('sess-eunv', 1000);
    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      const modified = {
        ...actual,
        constants: { ...actual.constants, O_NOFOLLOW: undefined },
        promises: {
          ...actual.promises,
          lstat: ((p: fs.PathLike, opts?: unknown) => {
            if (String(p) === filePath) {
              return Promise.resolve({
                isSymbolicLink: () => false,
                dev: 1n,
                ino: 0n,
              });
            }
            return actual.promises.lstat(p, opts as never);
          }) as typeof actual.promises.lstat,
        },
      };
      return { ...modified, default: modified };
    });
    try {
      const { loadUsageHistoryWithLive: load } = await import(
        './usageHistoryService.js'
      );
      const merged = await load();
      expect(tokensOf(merged, 'sess-eunv')).toBe(1000);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });

  it('limits retained runtime root caches without losing recent reads', async () => {
    const originalQwenHome = process.env['QWEN_HOME'];
    const base = process.env['QWEN_HOME']!;
    const originalOpen = fs.promises.open;
    const opened: string[] = [];
    const persistedRecords: UsageSummaryRecord[] = [];
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation(((
      p: fs.PathLike,
      flags?: string | number,
      mode?: fs.Mode,
    ) => {
      opened.push(String(p));
      return originalOpen(p, flags as number, mode);
    }) as typeof fs.promises.open);
    try {
      const roots = Array.from({ length: 65 }, (_, index) => {
        const qwenHomeDir = path.join(base, `runtime-root-${index}`);
        process.env['QWEN_HOME'] = qwenHomeDir;
        const transcript = writeTranscript('project', `session-${index}`, {
          cwd: `/runtime/project-${index}`,
          day: '2026-06-11',
          durationMs: 1000,
          tokens: 100,
        });
        return { qwenHomeDir, transcript };
      });
      for (const root of roots) {
        await loadUsageHistoryWithLive({
          qwenHomeDir: root.qwenHomeDir,
          sinceMs: 0,
          persistedRecords,
        });
      }
      opened.length = 0;
      await loadUsageHistoryWithLive({
        qwenHomeDir: roots[0]!.qwenHomeDir,
        sinceMs: 0,
        persistedRecords,
      });
      expect(
        opened.filter((entry) => entry === roots[0]!.transcript),
      ).toHaveLength(1);
      await loadUsageHistoryWithLive({
        qwenHomeDir: roots.at(-1)!.qwenHomeDir,
        sinceMs: 0,
        persistedRecords,
      });
      expect(
        opened.filter((entry) => entry === roots.at(-1)!.transcript),
      ).toHaveLength(0);
    } finally {
      spy.mockRestore();
      if (originalQwenHome === undefined) delete process.env['QWEN_HOME'];
      else process.env['QWEN_HOME'] = originalQwenHome;
    }
  });

  it('serves unchanged transcripts from the replay cache without re-reading them', async () => {
    const paths = [
      plant('sess-cache-a', 100),
      plant('sess-cache-b', 200),
      plant('sess-cache-c', 300),
    ];
    const opened: string[] = [];
    const orig = fs.promises.open;
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation(((
      p: fs.PathLike,
      flags?: string | number,
      mode?: fs.Mode,
    ) => {
      opened.push(String(p));
      return orig(p, flags as number, mode);
    }) as typeof fs.promises.open);
    const transcriptOpens = () =>
      opened.filter((p) => paths.includes(p)).length;
    try {
      await loadUsageHistoryWithLive();
      expect(transcriptOpens()).toBe(3); // cold: every transcript read

      opened.length = 0;
      await loadUsageHistoryWithLive();
      expect(transcriptOpens()).toBe(0); // warm: no transcript re-read

      // Grow one transcript; only it may be re-read on the next load.
      fs.appendFileSync(
        paths[0]!,
        JSON.stringify({
          sessionId: 'sess-cache-a',
          cwd: '/cache/project',
          uuid: 'u-extra',
          parentUuid: 'u3',
          timestamp: '2026-06-11T00:03:00.000Z',
          type: 'system',
          subtype: 'ui_telemetry',
          systemPayload: {
            uiEvent: {
              'event.name': 'qwen-code.api_response',
              'event.timestamp': '2026-06-11T00:03:00.000Z',
              response_id: 'r-extra',
              model: 'qwen-max',
              duration_ms: 500,
              input_token_count: 60,
              output_token_count: 30,
              cached_content_token_count: 0,
              thoughts_token_count: 10,
              total_token_count: 100,
              prompt_id: 'p-extra',
            },
          },
        }) + '\n',
      );
      opened.length = 0;
      const third = await loadUsageHistoryWithLive();
      expect(transcriptOpens()).toBe(1); // only the grown transcript
      expect(tokensOf(third, 'sess-cache-a')).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not JSON-parse a large trailing tool_result line', async () => {
    const sessionId = 'sess-bigtail';
    const dir = path.join(
      process.env['QWEN_HOME']!,
      'projects',
      'cache-project',
      'chats',
    );
    fs.mkdirSync(dir, { recursive: true });
    const base = { sessionId, cwd: '/cache/project' };
    // The FINAL record is a ~1MB tool_result — the shape a session idles on
    // right after a big tool call. It must not be parsed after the loop.
    const records = [
      {
        ...base,
        uuid: 'u1',
        parentUuid: null,
        timestamp: '2026-06-11T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', content: 'hi' },
      },
      {
        ...base,
        uuid: 'u2',
        parentUuid: 'u1',
        timestamp: '2026-06-11T00:01:00.000Z',
        type: 'system',
        subtype: 'ui_telemetry',
        systemPayload: {
          uiEvent: {
            'event.name': 'qwen-code.api_response',
            'event.timestamp': '2026-06-11T00:01:00.000Z',
            response_id: 'r1',
            model: 'qwen-max',
            duration_ms: 1200,
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
        timestamp: '2026-06-11T00:02:00.000Z',
        type: 'tool_result',
        message: { role: 'user', content: 'x'.repeat(1024 * 1024) },
      },
    ];
    fs.writeFileSync(
      path.join(dir, `${sessionId}.jsonl`),
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );

    const parseInputLengths: number[] = [];
    const origParse = JSON.parse;
    const spy = vi.spyOn(JSON, 'parse').mockImplementation((text: string) => {
      parseInputLengths.push(text.length);
      return origParse(text);
    });
    try {
      const merged = await loadUsageHistoryWithLive();
      expect(tokensOf(merged, sessionId)).toBe(1000);
      // No parse may touch the megabyte trailing payload; header + telemetry
      // lines are a few hundred chars each.
      expect(Math.max(...parseInputLengths)).toBeLessThan(10_000);
    } finally {
      spy.mockRestore();
    }
  });

  it('detects root fork markers without parsing nested markers in large payloads', async () => {
    const sessionId = 'sess-nested-fork';
    const filePath = plant(sessionId, 1000);
    const records = fs
      .readFileSync(filePath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    // Put the marker last and add whitespace outside the key/value compact
    // shape. A >64 KiB inherited row is glued to the next native telemetry
    // record: only the inherited object may be discarded, without parsing it.
    records[0]!['content'] = 'y'.repeat(70 * 1024);
    records[0]!['forkedFrom'] = {
      sessionId: 'parent-session',
      messageUuid: records[0]!['uuid'],
    };
    const inheritedLine = JSON.stringify(records[0]).replace(
      /"forkedFrom":/,
      '"forkedFrom" :',
    );
    records.push({
      sessionId,
      cwd: '/cache/project',
      uuid: 'u-big-tool-result',
      parentUuid: 'u3',
      timestamp: '2026-06-11T00:03:00.000Z',
      type: 'tool_result',
      message: {
        role: 'user',
        content: 'x'.repeat(1024 * 1024),
        response: {
          forkedFrom: { sessionId: 'nested-marker' },
          text: '{"forkedFrom":"quoted-marker",',
        },
      },
    });
    fs.writeFileSync(
      filePath,
      [
        inheritedLine + JSON.stringify(records[1]),
        ...records.slice(2).map((record) => JSON.stringify(record)),
      ].join('\n') + '\n',
    );
    expect(fs.statSync(filePath).size).toBeGreaterThan(1024 * 1024);
    const parseInputLengths: number[] = [];
    const origParse = JSON.parse;
    const spy = vi.spyOn(JSON, 'parse').mockImplementation((text: string) => {
      parseInputLengths.push(text.length);
      return origParse(text);
    });
    try {
      const merged = await loadUsageHistoryWithLive();
      expect(tokensOf(merged, sessionId)).toBe(1000);
      expect(Math.max(...parseInputLengths)).toBeLessThan(10_000);
    } finally {
      spy.mockRestore();
    }
  });

  it('recovers the later timestamp from a small glued trailing line', async () => {
    const sessionId = 'sess-glued-small';
    const dir = path.join(
      process.env['QWEN_HOME']!,
      'projects',
      'cache-project',
      'chats',
    );
    fs.mkdirSync(dir, { recursive: true });
    const base = { sessionId, cwd: '/cache/project' };
    const u1 = {
      ...base,
      uuid: 'u1',
      parentUuid: null,
      timestamp: '2026-06-11T00:00:00.000Z',
      type: 'user',
      message: { role: 'user', content: 'hi' },
    };
    const u2 = {
      ...base,
      uuid: 'u2',
      parentUuid: 'u1',
      timestamp: '2026-06-11T00:01:00.000Z',
      type: 'system',
      subtype: 'ui_telemetry',
      systemPayload: {
        uiEvent: {
          'event.name': 'qwen-code.api_response',
          'event.timestamp': '2026-06-11T00:01:00.000Z',
          response_id: 'r1',
          model: 'qwen-max',
          duration_ms: 1200,
          input_token_count: 600,
          output_token_count: 300,
          cached_content_token_count: 0,
          thoughts_token_count: 100,
          total_token_count: 1000,
          prompt_id: 'p1',
        },
      },
    };
    // Two records fused on the final physical line (interrupted append); the
    // second carries a much later timestamp. The small-tail parse must take the
    // LAST recovered record, not the first.
    const recA = {
      ...base,
      uuid: 'u3',
      parentUuid: 'u2',
      timestamp: '2026-06-11T00:02:00.000Z',
      type: 'assistant',
      message: { role: 'assistant', content: 'a' },
    };
    const recB = {
      ...base,
      uuid: 'u4',
      parentUuid: 'u3',
      timestamp: '2026-06-11T23:59:00.000Z',
      type: 'assistant',
      message: { role: 'assistant', content: 'b' },
    };
    const body =
      [u1, u2].map((r) => JSON.stringify(r)).join('\n') +
      '\n' +
      JSON.stringify(recA) +
      JSON.stringify(recB) +
      '\n';
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), body);

    const merged = await loadUsageHistoryWithLive();
    const r = merged.find((x) => x.sessionId === sessionId);
    expect(r).toBeDefined();
    expect(tokensOf(merged, sessionId)).toBe(1000);
    expect(r!.timestamp).toBe(new Date('2026-06-11T23:59:00.000Z').getTime());
  });

  it('takes the later timestamp from a large glued trailing line without parsing it', async () => {
    const sessionId = 'sess-glued-large';
    const dir = path.join(
      process.env['QWEN_HOME']!,
      'projects',
      'cache-project',
      'chats',
    );
    fs.mkdirSync(dir, { recursive: true });
    const base = { sessionId, cwd: '/cache/project' };
    const u1 = {
      ...base,
      uuid: 'u1',
      parentUuid: null,
      timestamp: '2026-06-11T00:00:00.000Z',
      type: 'user',
      message: { role: 'user', content: 'hi' },
    };
    const u2 = {
      ...base,
      uuid: 'u2',
      parentUuid: 'u1',
      timestamp: '2026-06-11T00:01:00.000Z',
      type: 'system',
      subtype: 'ui_telemetry',
      systemPayload: {
        uiEvent: {
          'event.name': 'qwen-code.api_response',
          'event.timestamp': '2026-06-11T00:01:00.000Z',
          response_id: 'r1',
          model: 'qwen-max',
          duration_ms: 1200,
          input_token_count: 600,
          output_token_count: 300,
          cached_content_token_count: 0,
          thoughts_token_count: 100,
          total_token_count: 1000,
          prompt_id: 'p1',
        },
      },
    };
    // A >64KB final line: a megabyte tool_result fused to a later record. The
    // large-tail branch must take the LAST top-level timestamp as raw text
    // (first-match would pick the earlier one) and must not JSON-parse the line.
    const recA = {
      ...base,
      uuid: 'u3',
      parentUuid: 'u2',
      timestamp: '2026-06-11T00:05:00.000Z',
      type: 'tool_result',
      message: { role: 'user', content: 'x'.repeat(1024 * 1024) },
    };
    const recB = {
      ...base,
      uuid: 'u4',
      parentUuid: 'u3',
      timestamp: '2026-06-11T00:09:00.000Z',
      type: 'assistant',
      message: { role: 'assistant', content: 'ok' },
    };
    const body =
      [u1, u2].map((r) => JSON.stringify(r)).join('\n') +
      '\n' +
      JSON.stringify(recA) +
      JSON.stringify(recB) +
      '\n';
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), body);

    const parseInputLengths: number[] = [];
    const origParse = JSON.parse;
    const spy = vi.spyOn(JSON, 'parse').mockImplementation((text: string) => {
      parseInputLengths.push(text.length);
      return origParse(text);
    });
    try {
      const merged = await loadUsageHistoryWithLive();
      const r = merged.find((x) => x.sessionId === sessionId);
      expect(r).toBeDefined();
      expect(tokensOf(merged, sessionId)).toBe(1000);
      expect(r!.timestamp).toBe(new Date('2026-06-11T00:09:00.000Z').getTime());
      expect(Math.max(...parseInputLengths)).toBeLessThan(10_000);
    } finally {
      spy.mockRestore();
    }
  });

  it('ignores a nested payload timestamp on a large trailing tool_result', async () => {
    const sessionId = 'sess-nested-ts';
    const dir = path.join(
      process.env['QWEN_HOME']!,
      'projects',
      'cache-project',
      'chats',
    );
    fs.mkdirSync(dir, { recursive: true });
    const base = { sessionId, cwd: '/cache/project' };
    const u1 = {
      ...base,
      uuid: 'u1',
      parentUuid: null,
      timestamp: '2026-06-11T00:00:00.000Z',
      type: 'user',
      message: { role: 'user', content: 'hi' },
    };
    const u2 = {
      ...base,
      uuid: 'u2',
      parentUuid: 'u1',
      timestamp: '2026-06-11T00:01:00.000Z',
      type: 'system',
      subtype: 'ui_telemetry',
      systemPayload: {
        uiEvent: {
          'event.name': 'qwen-code.api_response',
          'event.timestamp': '2026-06-11T00:01:00.000Z',
          response_id: 'r1',
          model: 'qwen-max',
          duration_ms: 1200,
          input_token_count: 600,
          output_token_count: 300,
          cached_content_token_count: 0,
          thoughts_token_count: 100,
          total_token_count: 1000,
          prompt_id: 'p1',
        },
      },
    };
    // A >64KB final tool_result whose own timestamp is 00:05 but whose payload
    // (functionResponse.response) carries a much LATER nested timestamp. The
    // depth-aware scan must keep the record's own 00:05, not the nested 2035.
    const recA = {
      ...base,
      uuid: 'u3',
      parentUuid: 'u2',
      timestamp: '2026-06-11T00:05:00.000Z',
      type: 'tool_result',
      message: {
        role: 'user',
        content: [
          {
            functionResponse: {
              name: 'read_file',
              response: {
                timestamp: '2035-01-01T00:00:00.000Z',
                output: 'x'.repeat(100 * 1024),
              },
            },
          },
        ],
      },
    };
    const body =
      [u1, u2].map((r) => JSON.stringify(r)).join('\n') +
      '\n' +
      JSON.stringify(recA) +
      '\n';
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), body);

    const parseInputLengths: number[] = [];
    const origParse = JSON.parse;
    const spy = vi.spyOn(JSON, 'parse').mockImplementation((text: string) => {
      parseInputLengths.push(text.length);
      return origParse(text);
    });
    try {
      const merged = await loadUsageHistoryWithLive();
      const r = merged.find((x) => x.sessionId === sessionId);
      expect(r).toBeDefined();
      expect(tokensOf(merged, sessionId)).toBe(1000);
      expect(r!.timestamp).toBe(new Date('2026-06-11T00:05:00.000Z').getTime());
      expect(Math.max(...parseInputLengths)).toBeLessThan(10_000);
    } finally {
      spy.mockRestore();
    }
  });

  it('bounds the replay scan concurrency instead of one worker per candidate', async () => {
    const paths: string[] = [];
    for (let i = 0; i < 12; i++) paths.push(plant(`sess-conc-${i}`, 100));
    const gated: Array<{
      path: string;
      resolve: (h: fs.promises.FileHandle) => void;
    }> = [];
    let opens = 0;
    let gating = true;
    const orig = fs.promises.open;
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation(((
      p: fs.PathLike,
      flags?: string | number,
      mode?: fs.Mode,
    ) => {
      if (gating && paths.includes(String(p))) {
        opens++;
        // A pending open: the worker blocks here, so no further opens occur.
        return new Promise<fs.promises.FileHandle>((resolve) => {
          gated.push({ path: String(p), resolve });
        });
      }
      return orig(p, flags as number, mode);
    }) as typeof fs.promises.open);
    try {
      const pending = loadUsageHistoryWithLive();
      // Let the persisted-file read settle and the pool start: each worker
      // blocks on its gated open, so no further opens can occur.
      await new Promise((r) => setTimeout(r, 150));
      expect(opens).toBeGreaterThan(0);
      expect(opens).toBeLessThanOrEqual(8); // REBUILD_CONCURRENCY
      // Release the gates with real handles and stop gating so the load finishes.
      gating = false;
      for (const g of gated) {
        g.resolve(
          await orig(g.path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK),
        );
      }
      await pending;
    } finally {
      spy.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'settles and skips a FIFO swapped in after the Phase-1 stat',
    async () => {
      // A real transcript plus a real FIFO. statSync is fooled into reporting
      // the FIFO as a regular file (Phase 1), so only the fd-level recheck in
      // summarizeTranscriptFile can reject it. O_NONBLOCK keeps the open from
      // blocking (a writerless FIFO then reads as an empty stream), so the
      // settle alone does not witness the recheck; the isFile() check is what
      // refuses a non-regular file, and only its throw logs the message below.
      const real = plant('sess-real', 1000);
      const fifoPath = path.join(path.dirname(real), 'sess-fifo.jsonl');
      const mkfifo = spawnSync('mkfifo', [fifoPath]);
      expect(mkfifo.status).toBe(0);
      const origStat = fs.statSync;
      const statSpy = vi.spyOn(fs, 'statSync').mockImplementation(((
        p: fs.PathLike,
      ) => {
        if (String(p) === fifoPath) {
          return {
            isFile: () => true,
            mtimeMs: Date.now(),
            size: 100,
          } as unknown as fs.Stats;
        }
        return origStat(p);
      }) as typeof fs.statSync);
      debugMock.mockClear();
      try {
        const merged = await loadUsageHistoryWithLive();
        expect(merged.map((r) => r.sessionId)).toEqual(['sess-real']);
        // Pin the rejection, not just the settle: only the fd-level isFile()
        // recheck throws "non-regular transcript", which the worker logs. With
        // the recheck deleted the FIFO reads as an empty transcript and this
        // message never appears.
        expect(debugMock).toHaveBeenCalledWith(
          expect.stringContaining(`non-regular transcript: ${fifoPath}`),
        );
      } finally {
        statSpy.mockRestore();
        fs.rmSync(fifoPath, { force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a symlinked transcript rather than replaying its target (no-follow open)',
    async () => {
      // The no-follow open refuses a symlinked final component, so a symlink
      // planted in chats must not replay its target's usage. The target lives
      // outside the chats enumeration with a distinct sessionId: if the open
      // followed symlinks, that session would appear; refused, it must not.
      const real = plant('sess-real', 1000);
      // Reuse the same fixture as the real transcripts (no hand-copied records
      // that could drift and make this negative assertion vacuous), then move
      // the target out of the chats enumeration so it is reachable only through
      // the symlink.
      const targetInChats = plant('sess-link-target', 2000);
      const targetPath = path.join(
        process.env['QWEN_HOME']!,
        'symlink-target.jsonl',
      );
      fs.renameSync(targetInChats, targetPath);
      const linkPath = path.join(path.dirname(real), 'sess-link.jsonl');
      fs.symlinkSync(targetPath, linkPath);
      try {
        const merged = await loadUsageHistoryWithLive();
        expect(merged.map((r) => r.sessionId)).toEqual(['sess-real']);
      } finally {
        fs.rmSync(linkPath, { force: true });
        fs.rmSync(targetPath, { force: true });
      }
    },
  );
});

// Regression for #7384: deleting a session erased its usage from the
// rebuild-from-transcript fallback forever. The salvage runs right before
// transcript deletion.
describe('persistUsageBeforeTranscriptDeletion (issue #7384)', () => {
  const tmpHome = useTempQwenHome('qwen-usage-salvage-');

  const plantTranscript = (sessionId: string, withTelemetry: boolean) =>
    writeTranscript('salvage-project', sessionId, {
      cwd: '/salvage/project',
      day: '2026-07-01',
      durationMs: 900,
      ...(withTelemetry ? { tokens: 1000 } : {}),
    });

  it('writes the session summary before the transcript disappears', async () => {
    const filePath = plantTranscript('sess-salvage-1', true);
    await expect(persistUsageBeforeTranscriptDeletion(filePath)).resolves.toBe(
      true,
    );
    const lines = usageLines().map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0].sessionId).toBe('sess-salvage-1');
    expect(lines[0].models['qwen-max'].totalTokens).toBe(1000);
    expect(lines[0].project).toBe('/salvage/project');
  });

  it('skips the write when the history already has the session (no #4994 duplicates)', async () => {
    const filePath = plantTranscript('sess-salvage-2', true);
    await persistUsageBeforeTranscriptDeletion(filePath);
    await expect(persistUsageBeforeTranscriptDeletion(filePath)).resolves.toBe(
      false,
    );
    expect(usageLines()).toHaveLength(1);
  });

  it('project-scoped deletion salvage preserves another project', async () => {
    const sessionId = 'sess-salvage-other-project';
    const filePath = writeTranscript('salvage-other-project', sessionId, {
      cwd: '/salvage/project-b',
      day: '2026-07-01',
      durationMs: 900,
      tokens: 200,
    });
    persistSessionUsage({
      sessionId,
      project: '/salvage/project-a',
      startTime: new Date('2026-07-01T00:00:00Z'),
      endTime: new Date('2026-07-01T00:01:00Z'),
      metrics: makeMetrics(),
    });

    const prepared = await prepareUsageBeforeTranscriptDeletion(filePath);
    expect(prepared?.record.project).toBe('/salvage/project-b');
    expect(commitUsageBeforeTranscriptDeletion(prepared!)).toBe(true);
    const lines = usageLines().map((line) => JSON.parse(line));
    expect(lines.map((line) => line.project)).toEqual([
      '/salvage/project-a',
      '/salvage/project-b',
    ]);
    expect(lines[1].models['qwen-max'].totalTokens).toBe(200);
  });

  it('project-scoped deletion salvage survives a concurrent other-project write', async () => {
    const sessionId = 'sess-salvage-concurrent-project';
    const filePath = writeTranscript('salvage-concurrent-project', sessionId, {
      cwd: '/salvage/project-b',
      day: '2026-07-01',
      durationMs: 900,
      tokens: 200,
    });
    const prepared = await prepareUsageBeforeTranscriptDeletion(filePath);
    persistSessionUsage({
      sessionId,
      project: '/salvage/project-a',
      startTime: new Date('2026-07-01T00:00:00Z'),
      endTime: new Date('2026-07-01T00:01:00Z'),
      metrics: makeMetrics(),
    });

    expect(commitUsageBeforeTranscriptDeletion(prepared!)).toBe(true);
    expect(usageLines().map((line) => JSON.parse(line).project)).toEqual([
      '/salvage/project-a',
      '/salvage/project-b',
    ]);
  });

  it('does not append stale salvage after authoritative usage is persisted', async () => {
    const sessionId = 'sess-salvage-race';
    const filePath = plantTranscript(sessionId, true);
    const prepared = await prepareUsageBeforeTranscriptDeletion(filePath);
    expect(prepared).not.toBeNull();
    persistSessionUsage({
      sessionId,
      project: '/salvage/project',
      startTime: new Date('2026-07-01T00:00:00Z'),
      endTime: new Date('2026-07-01T00:01:00Z'),
      metrics: makeMetrics(),
    });

    expect(commitUsageBeforeTranscriptDeletion(prepared!)).toBe(false);
    expect(usageLines()).toHaveLength(1);
  });

  it('salvages disjoint transcript history beside a later run-scoped record', async () => {
    const sessionId = 'sess-salvage-disjoint';
    const filePath = plantTranscript(sessionId, true);
    persistSessionUsage({
      sessionId,
      project: '/salvage/project',
      startTime: new Date('2026-07-01T01:00:00Z'),
      endTime: new Date('2026-07-01T01:01:00Z'),
      metrics: makeMetrics(),
    });

    const prepared = await prepareUsageBeforeTranscriptDeletion(filePath);
    expect(prepared).not.toBeNull();
    expect(commitUsageBeforeTranscriptDeletion(prepared!)).toBe(true);

    const lines = usageLines().map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines.at(-1)?.transcriptRebuild).toBe(true);
  });

  it('returns false for a transcript with no telemetry and writes nothing', async () => {
    const filePath = plantTranscript('sess-salvage-3', false);
    await expect(persistUsageBeforeTranscriptDeletion(filePath)).resolves.toBe(
      false,
    );
    expect(fs.existsSync(usagePath())).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'salvage refuses a symlinked transcript without throwing or persisting (no-follow)',
    async () => {
      // The shared reader is no-follow for every caller, including the salvage:
      // a symlinked transcript is refused (the salvage never throws) and nothing
      // is written. If the open followed the link, the target's usage would be
      // persisted instead.
      const target = plantTranscript('sess-salvage-link-target', true);
      const linkPath = path.join(
        path.dirname(target),
        'sess-salvage-link.jsonl',
      );
      fs.symlinkSync(target, linkPath);
      try {
        await expect(
          persistUsageBeforeTranscriptDeletion(linkPath),
        ).resolves.toBe(false);
        expect(fs.existsSync(usagePath())).toBe(false);
      } finally {
        fs.rmSync(linkPath, { force: true });
      }
    },
  );

  it.each([
    [false, 'request_lifecycle'],
    [true, 'request_lifecycle'],
    [false, 'tool_lifecycle'],
    [true, 'tool_lifecycle'],
    [false, 'hook_lifecycle'],
    [true, 'hook_lifecycle'],
  ] as const)(
    'ignores lifecycle frames during usage rebuild and salvage (metrics: %s, event: %s)',
    async (withMetrics, eventName) => {
      const sessionId = `sess-lifecycle-${withMetrics}`;
      const filePath = plantTranscript(sessionId, withMetrics);
      const started = {
        'event.name': eventName,
        v: 1,
        kind: eventName === 'tool_lifecycle' ? 'tool' : 'request',
        ...(eventName === 'tool_lifecycle'
          ? {
              callId: 'call',
              toolName: 'read_file',
              executionStatus: 'running',
            }
          : {}),
        executionId: 'execution',
        sessionId,
        promptId: `${sessionId}########1`,
        model: 'qwen-max',
        startedAt: 100,
        phase: 'started',
      };
      fs.appendFileSync(
        filePath,
        [
          started,
          {
            ...started,
            phase: 'ended',
            endedAt: 120,
            durationMs: 20,
            outcome: 'cancelled',
            ...(eventName === 'tool_lifecycle'
              ? { executionStatus: 'cancelled', executionDurationMs: 20 }
              : {}),
          },
        ]
          .map((uiEvent, i) =>
            JSON.stringify({
              uuid: `lifecycle-${i}`,
              parentUuid: i === 0 ? 'u1' : 'lifecycle-0',
              sessionId,
              cwd: '/salvage/project',
              timestamp: '2026-07-01T00:01:00.000Z',
              type: 'system',
              subtype: 'ui_telemetry',
              systemPayload: { uiEvent },
            }),
          )
          .join('\n') + '\n',
      );

      const rebuilt = await loadUsageHistory(undefined, {
        persistRebuild: false,
      });
      expect(rebuilt).toHaveLength(withMetrics ? 1 : 0);
      expect(aggregateUsage(rebuilt, 'all').sessionCount).toBe(
        withMetrics ? 1 : 0,
      );
      const prepared = await prepareUsageBeforeTranscriptDeletion(filePath);
      if (withMetrics) {
        expect(prepared?.record.models['qwen-max']?.totalTokens).toBe(1000);
      } else {
        expect(prepared).toBeNull();
        await expect(
          persistUsageBeforeTranscriptDeletion(filePath),
        ).resolves.toBe(false);
        expect(fs.existsSync(usagePath())).toBe(false);
      }
    },
  );

  it('never throws for a missing transcript', async () => {
    await expect(
      persistUsageBeforeTranscriptDeletion(
        path.join(tmpHome(), 'nope', 'missing.jsonl'),
      ),
    ).resolves.toBe(false);
  });
});

describe('aggregateUsage — skills', () => {
  function skillRecord(
    sessionId: string,
    skills?: UsageSummaryRecord['skills'],
  ): UsageSummaryRecord {
    return {
      version: 1,
      sessionId,
      timestamp: Date.now(),
      startTime: Date.now(),
      project: '/p',
      durationMs: 0,
      totalLatencyMs: 0,
      models: { m: { ...modelUsage(1, 0, 0, 0), totalLatencyMs: 0 } },
      tools: { totalCalls: 0, totalSuccess: 0, totalFail: 0, byName: {} },
      files: { linesAdded: 0, linesRemoved: 0 },
      ...(skills ? { skills } : {}),
    };
  }

  it('sums skill counts across sessions, sorted by count desc', () => {
    const report = aggregateUsage(
      [
        skillRecord('a', {
          totalCalls: 3,
          totalSuccess: 3,
          totalFail: 0,
          byName: {
            qreview: { count: 2, success: 2, fail: 0 },
            simplify: { count: 1, success: 1, fail: 0 },
          },
        }),
        skillRecord('b', {
          totalCalls: 1,
          totalSuccess: 1,
          totalFail: 0,
          byName: { qreview: { count: 1, success: 1, fail: 0 } },
        }),
      ],
      'all',
    );
    expect(report.skills.totalCalls).toBe(4);
    expect(report.skills.topSkills).toEqual([
      { name: 'qreview', count: 3, success: 3, fail: 0 },
      { name: 'simplify', count: 1, success: 1, fail: 0 },
    ]);
  });

  it('caps topSkills at 25, keeping the highest-count skills', () => {
    const byName: NonNullable<UsageSummaryRecord['skills']>['byName'] = {};
    for (let i = 0; i < 40; i++) {
      byName[`skill-${i}`] = { count: i + 1, success: i + 1, fail: 0 };
    }
    const report = aggregateUsage(
      [
        skillRecord('a', {
          totalCalls: 820,
          totalSuccess: 820,
          totalFail: 0,
          byName,
        }),
      ],
      'all',
    );
    expect(report.skills.topSkills.length).toBe(25);
    expect(report.skills.topSkills[0]!.name).toBe('skill-39');
  });

  it('is inert for records without a skills field', () => {
    const report = aggregateUsage([skillRecord('a')], 'all');
    expect(report.skills.totalCalls).toBe(0);
    expect(report.skills.topSkills).toEqual([]);
  });
});

describe('getTimeRangeBounds — local calendar-day windows', () => {
  const originalTimeZone = process.env['TZ'];
  afterEach(() => {
    vi.useRealTimers();
    if (originalTimeZone === undefined) delete process.env['TZ'];
    else process.env['TZ'] = originalTimeZone;
  });

  it('does not add a boundary day across a DST transition', () => {
    process.env['TZ'] = 'America/New_York';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-09T04:30:00Z'));
    expect(localDateKey(getTimeRangeBounds('week').start.getTime())).toBe(
      '2026-03-02',
    );
    expect(localDateKey(getTimeRangeBounds('month').start.getTime())).toBe(
      '2026-02-07',
    );
  });
});
