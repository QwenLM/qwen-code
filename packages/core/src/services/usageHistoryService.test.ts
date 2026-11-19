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
  loadUsageHistory,
  loadUsageHistoryWithLive,
  persistSessionUsage,
  persistUsageBeforeTranscriptDeletion,
  prepareUsageBeforeTranscriptDeletion,
  commitUsageBeforeTranscriptDeletion,
  _resetReplayCacheForTest,
} from './usageHistoryService.js';
import { ToolCallDecision } from '../telemetry/tool-call-decision.js';
import type { SessionMetrics } from '../telemetry/uiTelemetry.js';
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
    // Same sessionId in both the persisted file (authoritative 1000) and the
    // transcript (1600). Must appear exactly once, keeping the persisted value.
    seedPersisted([persistedRec('sess-both', 1000)]);
    plantChatJsonl('sess-both', 1600);

    const merged = await loadUsageHistoryWithLive();
    expect(merged).toHaveLength(1);
    expect(merged[0]!.sessionId).toBe('sess-both');
    expect(merged[0]!.models['qwen-max']!.totalTokens).toBe(1000);
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

  it('still collapses a run written twice (overlapping windows, last wins)', async () => {
    seedPersisted([
      runRec('sess-twice', 1000, t0, t0 + 60_000),
      runRec('sess-twice', 1600, t0, t0 + 60_000),
    ]);

    const records = await loadUsageHistory();

    expect(records).toHaveLength(1);
    expect(records[0]!.models['qwen-max']!.totalTokens).toBe(1600);
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

  it('withLive: a whole-transcript replay does not add on top of persisted runs', async () => {
    seedPersisted([
      runRec('sess-mixed', 1000, t0, t0 + 60_000),
      runRec('sess-mixed', 2000, t0 + DAY, t0 + DAY + 60_000),
    ]);
    // The transcript covers the whole conversation (3000 cumulative).
    plantChatJsonl('sess-mixed', 3000);

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
