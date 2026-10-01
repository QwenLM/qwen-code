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
      // A FIFO passing the `*.jsonl` name filter must be skipped before any
      // read: opening it would block forever (no writer ever arrives) and
      // wedge the rebuild — the daemon usage dashboard serves from this path.
      // Observed in the wild from a test-suite leftover. The mkfifo call is
      // skipped on Windows, matching storage.test.ts.
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
