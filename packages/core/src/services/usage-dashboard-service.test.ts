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
  loadLedgerOrEmpty,
  loadUsageDashboard,
  loadUsageDashboardSources,
  recordTouchesLedgerDays,
  setLedgerTranscriptScope,
} from './usage-dashboard-service.js';
import { SessionService } from './sessionService.js';
import { Storage } from '../config/storage.js';
import {
  aggregateUsage,
  type UsageSummaryRecord,
} from './usageHistoryService.js';
import {
  getTokenUsageFilePath,
  loadTokenUsageDailyByModel,
  type TokenUsageDailyByModel,
  type TokenUsageDayModelTotals,
  type TokenUsageRecord,
} from './tokenUsageService.js';

const executionRecordProbe = vi.hoisted(() => ({ calls: 0 }));
vi.mock('./tokenUsageService.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./tokenUsageService.js')>();
  return {
    ...actual,
    getTokenUsageExecutionRecords: (
      ...args: Parameters<typeof actual.getTokenUsageExecutionRecords>
    ) => {
      executionRecordProbe.calls++;
      return actual.getTokenUsageExecutionRecords(...args);
    },
  };
});

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
  startTime?: number;
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
    startTime: o.startTime ?? o.timestamp,
    project: o.project ?? '/project',
    durationMs: o.timestamp - (o.startTime ?? o.timestamp),
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

function writeTestLedgerRows(
  root: string,
  rows: Array<Partial<TokenUsageRecord>>,
): void {
  const records = rows.map((overrides): TokenUsageRecord => {
    const timestamp = overrides.timestamp ?? '2026-05-25T12:00:00.000Z';
    const localDate = dayKey(Date.parse(timestamp));
    return {
      schemaVersion: 1,
      id: 'scoped-ledger-row',
      executionId: 'same-scoped-execution',
      timestamp,
      localDate,
      localMonth: localDate.slice(0, 7),
      sessionId: 'shared-scoped-ledger',
      model: 'qwen-max',
      authType: 'openai',
      source: 'main',
      inputTokens: 100,
      outputTokens: 0,
      cachedTokens: 0,
      thoughtsTokens: 0,
      totalTokens: 100,
      apiDurationMs: 10,
      ...overrides,
    };
  });
  Storage.runWithResolvedRuntimeBaseDir(root, () => {
    const file = getTokenUsageFilePath(records[0]!.localMonth);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    );
  });
}

function writeTestLedgerRow(
  root: string,
  overrides: Partial<TokenUsageRecord> = {},
): void {
  writeTestLedgerRows(root, [overrides]);
}

async function loadScopedSourcesAt(
  roots: readonly string[] | undefined,
  timestamp: string,
) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse(timestamp));
  try {
    return await loadUsageDashboardSources(roots);
  } finally {
    vi.useRealTimers();
  }
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

  it('retains warm replay caches for every runtime and invalidates only a changed file', async () => {
    const rootA = path.join(tmpHome, 'owner-a');
    const rootB = path.join(tmpHome, 'owner-b');
    const originalHome = process.env['HOME'];
    const originalRuntime = process.env['QWEN_RUNTIME_DIR'];
    const isolatedHome = path.join(tmpHome, 'isolated');
    process.env['HOME'] = isolatedHome;
    process.env['QWEN_HOME'] = isolatedHome;
    process.env['QWEN_RUNTIME_DIR'] = isolatedHome;
    fs.mkdirSync(isolatedHome, { recursive: true });

    const plant = (
      root: string,
      project: string,
      sessionId: string,
      tokens: number,
    ) => {
      const file = new SessionService(project, {
        runtimeBaseDir: root,
      }).getSessionTranscriptPath(sessionId);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const timestamp = new Date(Date.now() - 120_000).toISOString();
      const base = { sessionId, cwd: project };
      fs.writeFileSync(
        file,
        [
          JSON.stringify({
            ...base,
            uuid: 'u1',
            timestamp,
            type: 'user',
            message: { role: 'user', content: 'hi' },
          }),
          JSON.stringify({
            ...base,
            uuid: 'u2',
            timestamp,
            type: 'system',
            subtype: 'ui_telemetry',
            systemPayload: {
              uiEvent: {
                'event.name': 'qwen-code.api_response',
                'event.timestamp': timestamp,
                response_id: `${sessionId}-response`,
                model: 'qwen-max',
                duration_ms: 10,
                input_token_count: tokens,
                output_token_count: 0,
                cached_content_token_count: 0,
                thoughts_token_count: 0,
                total_token_count: tokens,
                prompt_id: `${sessionId}-prompt`,
              },
            },
          }),
        ].join('\n') + '\n',
      );
      return file;
    };
    const fileA = plant(rootA, '/runtime/a', 'runtime-a', 600);
    const fileB = plant(rootB, '/runtime/b', 'runtime-b', 500);
    const originalOpen = fs.promises.open;
    const opened: string[] = [];
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation(((
      file: fs.PathLike,
      flags?: string | number,
      mode?: fs.Mode,
    ) => {
      opened.push(String(file));
      return originalOpen(file, flags as number, mode);
    }) as typeof fs.promises.open);
    const expectedPaths = new Set(
      [fileA, fileB].map((file) => fs.realpathSync(file)),
    );
    try {
      const first = await loadUsageDashboardSources([rootA, rootB]);
      expect(opened.filter((file) => expectedPaths.has(file)).sort()).toEqual(
        [...expectedPaths].sort(),
      );
      expect(
        buildUsageDashboard(
          first.records,
          { range: 'all' },
          first.ledgerDaily,
          first.runtimeScopes,
        ).summary.totalTokens,
      ).toBe(1100);

      opened.length = 0;
      await loadUsageDashboardSources([rootA, rootB]);
      expect(opened.filter((file) => expectedPaths.has(file))).toEqual([]);

      const timestamp = new Date().toISOString();
      fs.appendFileSync(
        fileA,
        JSON.stringify({
          sessionId: 'runtime-a',
          cwd: '/runtime/a',
          uuid: 'a2',
          timestamp,
          type: 'system',
          subtype: 'ui_telemetry',
          systemPayload: {
            uiEvent: {
              'event.name': 'qwen-code.api_response',
              'event.timestamp': timestamp,
              response_id: 'runtime-a-late',
              model: 'qwen-max',
              duration_ms: 10,
              input_token_count: 100,
              output_token_count: 0,
              cached_content_token_count: 0,
              thoughts_token_count: 0,
              total_token_count: 100,
              prompt_id: 'runtime-a-late-prompt',
            },
          },
        }) + '\n',
      );
      opened.length = 0;
      const third = await loadUsageDashboardSources([rootA, rootB]);
      expect(opened.filter((file) => expectedPaths.has(file))).toEqual([
        fs.realpathSync(fileA),
      ]);
      expect(
        buildUsageDashboard(
          third.records,
          { range: 'all' },
          third.ledgerDaily,
          third.runtimeScopes,
        ).summary.totalTokens,
      ).toBe(1200);
    } finally {
      openSpy.mockRestore();
      if (originalHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = originalHome;
      if (originalRuntime === undefined) delete process.env['QWEN_RUNTIME_DIR'];
      else process.env['QWEN_RUNTIME_DIR'] = originalRuntime;
    }
  });

  function plantRuntimeRequest(
    root: string,
    o: {
      sessionId: string;
      project: string;
      timestamp: string;
      executionId?: string;
      modelName?: string;
      durationMs?: number;
      tokens: number;
      toolLines?: { added: number; removed: number };
    },
  ): string {
    const file = new SessionService(o.project, {
      runtimeBaseDir: root,
    }).getSessionTranscriptPath(o.sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const base = { sessionId: o.sessionId, cwd: o.project };
    fs.writeFileSync(
      file,
      `${JSON.stringify({
        ...base,
        uuid: 'first-turn',
        timestamp: o.timestamp,
        type: 'user',
        message: { role: 'user', content: 'synthetic fixture' },
      })}\n${JSON.stringify({
        ...base,
        uuid: 'first-response',
        timestamp: o.timestamp,
        type: 'system',
        subtype: 'ui_telemetry',
        systemPayload: {
          uiEvent: {
            'event.name': 'qwen-code.api_response',
            'event.timestamp': o.timestamp,
            response_id: o.executionId ?? o.sessionId,
            model: o.modelName ?? 'qwen-max',
            duration_ms: o.durationMs ?? 10,
            input_token_count: o.tokens,
            output_token_count: 0,
            cached_content_token_count: 0,
            thoughts_token_count: 0,
            total_token_count: o.tokens,
            prompt_id: o.executionId ?? o.sessionId,
            ...(o.executionId ? { execution_id: o.executionId } : {}),
          },
        },
      })}\n`,
    );
    const events = [];
    if (o.toolLines) {
      events.push({
        ...base,
        timestamp: o.timestamp,
        type: 'system',
        subtype: 'ui_telemetry',
        systemPayload: {
          uiEvent: {
            'event.name': 'qwen-code.tool_call',
            'event.timestamp': o.timestamp,
            call_id: 'copy-tool',
            function_name: 'edit',
            function_args: { file_path: `${o.project}/copy.ts` },
            duration_ms: 20,
            success: true,
            metadata: {
              model_added_lines: o.toolLines.added,
              model_removed_lines: o.toolLines.removed,
            },
          },
        },
      });
    }
    if (events.length > 0) {
      fs.appendFileSync(
        file,
        events.map((event) => JSON.stringify(event)).join('\n') + '\n',
      );
    }
    return file;
  }

  it('keeps the first canonical root for three aliases of one physical identity', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 4, 25, 12));
    const aliases = ['alias-a', 'alias-b', 'alias-c'].map((name) => {
      const root = path.join(tmpHome, name);
      fs.mkdirSync(root, { recursive: true });
      return root;
    });
    const aliasPaths = new Set(aliases);
    const originalStat = fs.promises.stat;
    const realpathSpy = vi
      .spyOn(fs.promises, 'realpath')
      .mockImplementation(async (file) => String(file));
    const statSpy = vi.spyOn(fs.promises, 'stat').mockImplementation((async (
      file: fs.PathLike,
      options?: fs.StatOptions,
    ) => {
      const stats = await originalStat(file, options);
      if (aliasPaths.has(String(file)) && options?.bigint === true) {
        return { ...stats, dev: 37n, ino: 42n } as fs.BigIntStats;
      }
      return stats;
    }) as typeof fs.promises.stat);
    try {
      const ledger: TokenUsageRecord = {
        schemaVersion: 1,
        id: 'alias-request',
        timestamp: '2026-05-25T12:00:00.000Z',
        localDate: '2026-05-25',
        localMonth: '2026-05',
        sessionId: 'alias-request',
        model: 'qwen-max',
        authType: 'openai',
        source: 'main',
        inputTokens: 500,
        outputTokens: 100,
        cachedTokens: 0,
        thoughtsTokens: 0,
        totalTokens: 600,
        apiDurationMs: 50,
      };
      Storage.runWithResolvedRuntimeBaseDir(aliases[0]!, () => {
        const file = getTokenUsageFilePath('2026-05');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(ledger)}\n`);
      });

      const sources = await loadUsageDashboardSources(aliases);
      expect(sources.runtimeScopes).toHaveLength(2);
      expect(
        buildUsageDashboard(
          sources.records,
          { range: 'all' },
          sources.ledgerDaily,
          sources.runtimeScopes,
        ).summary,
      ).toMatchObject({ totalTokens: 600, outputTokens: 100, requests: 1 });
    } finally {
      realpathSpy.mockRestore();
      statSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('preserves distinct localDate evidence and exact same-day copies', async () => {
    const rootA = path.join(tmpHome, 'ledger-date-a');
    const rootB = path.join(tmpHome, 'ledger-date-b');
    const rootC = process.env['QWEN_HOME']!;
    const timestamp = '2026-05-25T12:00:00.000Z';
    for (const [root, localDate] of [
      [rootA, '2026-05-24'],
      [rootB, '2026-05-25'],
      [rootC, '2026-05-24'],
    ]) {
      writeTestLedgerRow(root, {
        timestamp,
        localDate,
        localMonth: localDate.slice(0, 7),
      });
    }
    const sources = await loadScopedSourcesAt([rootA, rootB], timestamp);
    const summary = buildUsageDashboard(
      sources.records,
      { range: 'all' },
      sources.ledgerDaily,
      sources.runtimeScopes,
    ).summary;
    expect(summary).toMatchObject({ totalTokens: 200, requests: 2 });
    expect(
      sources.ledgerDaily.get('2026-05-24')?.get('qwen-max'),
    ).toMatchObject({ totalTokens: 100, requests: 1 });
    expect(
      sources.ledgerDaily.get('2026-05-25')?.get('qwen-max'),
    ).toMatchObject({ totalTokens: 100, requests: 1 });
  });

  it('uses one read clock when a persisted run ends during loading', async () => {
    const root = process.env['QWEN_HOME']!;
    const now = Date.parse('2026-05-25T12:00:00.000Z');
    const sessionId = 'ending-during-read';
    const executionId = 'ending-during-read-response';
    const timestamp = new Date(now).toISOString();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    plantRuntimeRequest(root, {
      sessionId,
      project: '/runtime/end-clock',
      timestamp,
      executionId,
      tokens: 100,
    });
    seed([
      {
        ...rec({
          sessionId,
          timestamp: now,
          startTime: now,
          project: '/runtime/end-clock',
          model: { inputTokens: 100, totalTokens: 100 },
        }),
        runScoped: true,
        requestExecutionIds: [executionId],
        successfulRequestExecutionIds: [executionId],
      },
    ]);
    const clock = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(now - 1)
      .mockReturnValue(now);
    try {
      const sources = await loadUsageDashboardSources([root]);
      expect(sources.records).toHaveLength(1);
      expect(sources.records[0]?.requestExecutionIds).toEqual([executionId]);
      expect(
        buildUsageDashboard(
          sources.records,
          { range: 'all' },
          sources.ledgerDaily,
          sources.runtimeScopes,
        ).summary,
      ).toMatchObject({ sessions: 1, requests: 1, totalTokens: 100 });
    } finally {
      clock.mockRestore();
      vi.useRealTimers();
    }
  });

  it('promotes a complete ended replay after future-owned runs', async () => {
    const root = process.env['QWEN_HOME']!;
    const now = Date.parse('2026-05-25T12:00:00.000Z');
    const sessionId = 'ended-future-owned-runs';
    const project = '/runtime/ended-future-owned-runs';
    const run = (
      executionId: string,
      timestamp: number,
      startTime: number,
    ) => ({
      ...rec({
        sessionId,
        project,
        timestamp,
        startTime,
        model: { inputTokens: 100, totalTokens: 100, totalLatencyMs: 10 },
      }),
      runScoped: true,
      requestExecutionIds: [executionId],
      successfulRequestExecutionIds: [executionId],
    });
    seed([
      run('ended-future-bounded', now - 240_000, now - 360_000),
      {
        ...run('ended-future-unbounded', now - 120_000, NaN),
        durationMs: NaN,
      },
    ]);
    const file = plantRuntimeRequest(root, {
      sessionId,
      project,
      timestamp: new Date(now - 300_000).toISOString(),
      executionId: 'ended-future-bounded',
      tokens: 100,
    });
    for (const [offsetMs, executionId, tokens] of [
      [-120_000, 'ended-future-unbounded', 100],
      [-60_000, 'independent-ended-tail', 50],
    ] as const) {
      const timestamp = new Date(now + offsetMs).toISOString();
      fs.appendFileSync(
        file,
        `${JSON.stringify({
          sessionId,
          cwd: project,
          uuid: executionId,
          timestamp,
          type: 'system',
          subtype: 'ui_telemetry',
          systemPayload: {
            uiEvent: {
              'event.name': 'qwen-code.api_response',
              'event.timestamp': timestamp,
              response_id: executionId,
              execution_id: executionId,
              model: 'qwen-max',
              duration_ms: 10,
              input_token_count: tokens,
              output_token_count: 0,
              cached_content_token_count: 0,
              thoughts_token_count: 0,
              total_token_count: tokens,
              prompt_id: executionId,
            },
          },
        })}\n`,
      );
    }
    const sources = await loadScopedSourcesAt(
      [root, path.join(tmpHome, 'empty-ended-root')],
      new Date(now).toISOString(),
    );
    expect(sources.records).toHaveLength(1);
    expect(sources.records[0]?.transcriptSupplement).not.toBe(true);
    expect(sources.records[0]?.requestExecutionIds).toEqual(
      expect.arrayContaining([
        'ended-future-bounded',
        'ended-future-unbounded',
        'independent-ended-tail',
      ]),
    );
    expect(
      buildUsageDashboard(
        sources.records,
        { range: 'all' },
        sources.ledgerDaily,
        sources.runtimeScopes,
      ).summary,
    ).toMatchObject({
      sessions: 1,
      requests: 3,
      inputTokens: 250,
      totalTokens: 250,
    });
  });

  it('reduces duplicate future-backed records without erasing ended runs', async () => {
    const now = Date.parse('2026-05-25T12:00:00.000Z');
    const timestamp = new Date(now + 60_000).toISOString();
    const sessionId = 'future-duplicate-root';
    const project = '/runtime/future-duplicate';
    plantRuntimeRequest(process.env['QWEN_HOME']!, {
      sessionId,
      project,
      timestamp,
      executionId: 'future-duplicate-response',
      tokens: 100,
    });
    const future = {
      ...rec({
        sessionId,
        timestamp: now + 60_000,
        project,
        model: { inputTokens: 100, totalTokens: 100 },
      }),
      runScoped: true,
      requestExecutionIds: ['future-duplicate-response'],
      successfulRequestExecutionIds: ['future-duplicate-response'],
    };
    seed([
      rec({
        sessionId: 'ended-other',
        timestamp: now - 1_000,
        model: { inputTokens: 200, totalTokens: 200 },
      }),
      future,
      { ...future, models: structuredClone(future.models) },
    ]);
    const sources = await loadScopedSourcesAt([], timestamp);
    expect(sources.records).toHaveLength(2);
    expect(
      sources.records.filter((r) => r.sessionId === sessionId),
    ).toHaveLength(1);
    expect(
      buildUsageDashboard(
        sources.records,
        { range: 'all' },
        sources.ledgerDaily,
        sources.runtimeScopes,
      ).summary,
    ).toMatchObject({ sessions: 2, requests: 2, totalTokens: 300 });
  });

  it('reduces future-backed records before matching exact root copies', async () => {
    const rootA = path.join(tmpHome, 'future-owned-root-a');
    const rootB = path.join(tmpHome, 'future-owned-root-b');
    const now = Date.parse('2026-05-25T12:00:00.000Z');
    const timestamp = new Date(now + 60_000).toISOString();
    const sessionId = 'future-owned-root';
    const project = '/runtime/future-owned-root';
    const executionId = 'future-owned-root-response';
    for (const root of [rootA, rootB]) {
      plantRuntimeRequest(root, {
        sessionId,
        project,
        timestamp,
        executionId,
        tokens: 100,
      });
    }
    seed([
      {
        ...rec({
          sessionId,
          project,
          timestamp: now + 60_000,
          model: { inputTokens: 100, totalTokens: 100 },
        }),
        runScoped: true,
        requestExecutionIds: [executionId],
        successfulRequestExecutionIds: [executionId],
      },
    ]);
    const sources = await loadScopedSourcesAt(
      [rootA, rootB],
      new Date(now).toISOString(),
    );
    expect(sources.records).toHaveLength(1);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    try {
      expect(
        buildUsageDashboard(
          sources.records,
          { range: 'all' },
          sources.ledgerDaily,
          sources.runtimeScopes,
        ).summary,
      ).toMatchObject({ totalTokens: 100, requests: 1, sessions: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps conflicting same-ID histories when only one ledger matches', async () => {
    const rootA = path.join(tmpHome, 'one-covered-100');
    const rootB = path.join(tmpHome, 'uncovered-conflict-200');
    const timestamp = '2026-05-25T12:00:00.000Z';
    const sessionId = 'partially-covered-conflict';
    const project = '/runtime/partially-covered';
    for (const [root, tokens] of [
      [rootA, 100],
      [rootB, 200],
    ] as const) {
      plantRuntimeRequest(root, {
        sessionId,
        project,
        timestamp,
        executionId: 'conflicting-partial-coverage',
        tokens,
      });
    }
    writeTestLedgerRow(rootA, {
      sessionId,
      executionId: 'conflicting-partial-coverage',
      timestamp,
    });
    const sources = await loadScopedSourcesAt([rootB, rootA], timestamp);
    expect(sources.records).toHaveLength(2);
    expect(
      buildUsageDashboard(
        sources.records,
        { range: 'all' },
        sources.ledgerDaily,
        sources.runtimeScopes,
      ).summary,
    ).toMatchObject({ sessions: 2, requests: 2, totalTokens: 300 });
  });

  it('keeps exact proof from each runtime within the per-table budget', async () => {
    const rootA = path.join(tmpHome, 'local-proof-a');
    const rootB = path.join(tmpHome, 'local-proof-b');
    const now = Date.parse('2026-05-25T12:00:00.000Z');
    const sessionId = 'local-proof-owner';
    const ids = Array.from({ length: 5_001 }, (_, index) => `exec-${index}`);
    for (const root of [rootA, rootB]) {
      const rows = ids.map((executionId, index) => {
        const timestamp = new Date(now + index * 1_000).toISOString();
        const localDate = dayKey(Date.parse(timestamp));
        return JSON.stringify({
          schemaVersion: 1,
          id: `row-${index}`,
          executionId,
          timestamp,
          localDate,
          localMonth: localDate.slice(0, 7),
          sessionId,
          model: 'qwen-max',
          authType: 'openai',
          source: 'main',
          inputTokens: 1,
          outputTokens: 0,
          cachedTokens: 0,
          thoughtsTokens: 0,
          totalTokens: 1,
          apiDurationMs: 1,
        });
      });
      Storage.runWithResolvedRuntimeBaseDir(root, () => {
        const file = getTokenUsageFilePath('2026-05');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${rows.join('\n')}\n`);
      });
    }
    seed([
      {
        ...rec({
          sessionId,
          timestamp: now + 60_000,
          startTime: now,
          project: '/runtime/local-proof',
          model: {
            requests: ids.length,
            inputTokens: ids.length,
            totalTokens: ids.length,
          },
        }),
        runScoped: true,
        requestExecutionIds: ids,
        successfulRequestExecutionIds: ids,
      },
    ]);
    const sources = await loadScopedSourcesAt(
      [rootA, rootB],
      new Date(now + 60_000).toISOString(),
    );
    expect(sources.records).toHaveLength(1);
    expect(
      buildUsageDashboard(
        sources.records,
        { range: 'all' },
        sources.ledgerDaily,
        sources.runtimeScopes,
      ).summary,
    ).toMatchObject({ requests: 5_001, totalTokens: 5_001 });
  });

  it('uses complete per-root evidence for a normal cross-day response set', async () => {
    const sessionId = 'cross-day-execution-budget';
    const project = '/runtime/cross-day-execution-budget';
    const roots = [
      path.join(tmpHome, 'cross-day-proof-a'),
      path.join(tmpHome, 'cross-day-proof-b'),
    ];
    const records = Array.from({ length: 5_001 }, (_, index) => {
      const timestamp =
        index === 0 ? '2026-05-24T23:30:00.000Z' : '2026-05-25T12:00:00.000Z';
      return {
        executionId: `midnight-budget-${index}`,
        timestamp,
        sessionId,
        inputTokens: 1,
        totalTokens: 1,
      };
    });
    for (const root of roots) {
      writeTestLedgerRows(root, records);
    }
    seed([
      {
        ...rec({
          sessionId,
          project,
          startTime: Date.parse('2026-05-24T00:00:00.000Z'),
          timestamp: Date.parse('2026-05-25T13:00:00.000Z'),
          model: { requests: 5_001, inputTokens: 5_001, totalTokens: 5_001 },
        }),
        runScoped: true,
        requestExecutionIds: records.map((row) => row.executionId),
        successfulRequestExecutionIds: records.map((row) => row.executionId),
      },
    ]);

    const sources = await loadScopedSourcesAt(
      roots,
      '2026-05-26T12:00:00.000Z',
    );
    expect(sources.records).toHaveLength(1);
    expect(
      buildUsageDashboard(
        sources.records,
        { range: 'all' },
        sources.ledgerDaily,
        sources.runtimeScopes,
      ).summary,
    ).toMatchObject({ requests: 5_001, totalTokens: 5_001 });
  });

  it('does not cover a record whose successful IDs are not a subset of its requests', async () => {
    const rootA = path.join(tmpHome, 'own-request-root');
    const rootB = path.join(tmpHome, 'other-request-root');
    const timestamp = '2026-05-25T12:00:00.000Z';
    const sessionId = 'incompatible-success-request-ids';
    const project = '/runtime/success-subset';
    for (const [root, executionId] of [
      [rootA, 'own'],
      [rootB, 'other'],
    ]) {
      plantRuntimeRequest(root, {
        sessionId,
        project,
        timestamp,
        executionId,
        tokens: 100,
      });
    }
    writeTestLedgerRow(rootB, {
      sessionId,
      executionId: 'other',
      timestamp,
    });
    seed([
      {
        ...rec({
          sessionId,
          project,
          timestamp: Date.parse(timestamp),
          model: { inputTokens: 100, totalTokens: 100 },
        }),
        runScoped: true,
        requestExecutionIds: ['own'],
        successfulRequestExecutionIds: ['other'],
      },
    ]);
    const sources = await loadScopedSourcesAt([rootA, rootB], timestamp);
    expect(sources.records.length).toBeGreaterThanOrEqual(2);
    expect(
      buildUsageDashboard(
        sources.records,
        { range: 'all' },
        sources.ledgerDaily,
        sources.runtimeScopes,
      ).summary,
    ).toMatchObject({ requests: 2, totalTokens: 200 });
  });

  it('keeps supplements out of generic identity conflicts while reducing overlap', async () => {
    const root = process.env['QWEN_HOME']!;
    const now = Date.parse('2026-05-25T12:00:00.000Z');
    const overlap = {
      ...rec({
        sessionId: 'supplement-overlap-proof',
        timestamp: now - 1_000,
        model: { inputTokens: 100, totalTokens: 100 },
      }),
      runScoped: true,
      requestExecutionIds: ['overlapping-response'],
      successfulRequestExecutionIds: ['overlapping-response'],
    };
    seed([
      overlap,
      { ...overlap, transcriptRebuild: true, transcriptSupplement: true },
    ]);
    const sources = await loadScopedSourcesAt(
      [root],
      new Date(now).toISOString(),
    );
    expect(sources.records).toHaveLength(1);
    expect(
      buildUsageDashboard(
        sources.records,
        { range: 'all' },
        sources.ledgerDaily,
        sources.runtimeScopes,
      ).summary,
    ).toMatchObject({ totalTokens: 100, requests: 1 });
  });

  it('folds durable copies before reconciling native observations', async () => {
    const first = path.join(tmpHome, 'mixed-observation-first');
    const second = path.join(tmpHome, 'mixed-observation-second');
    const timestamp = '2026-05-25T12:00:00.000Z';
    const timestampMs = Date.parse(timestamp);
    const sessionId = 'mixed-durable-native-identity';
    const project = '/runtime/mixed-durable-native';
    const rich = {
      ...rec({
        sessionId,
        project,
        startTime: timestampMs + 20_000,
        timestamp: timestampMs + 30_000,
        model: { inputTokens: 100, totalTokens: 100 },
      }),
      runScoped: true,
      requestExecutionIds: ['shared-mixed-response'],
      successfulRequestExecutionIds: ['shared-mixed-response'],
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
    seed([
      {
        ...rich,
        startTime: timestampMs - 20_000,
        timestamp: timestampMs - 10_000,
        tools: {
          totalCalls: 0,
          totalSuccess: 0,
          totalFail: 0,
          byName: {},
        },
        files: { linesAdded: 0, linesRemoved: 0 },
      },
      rich,
    ]);
    for (const [firstRoot, secondRoot] of [
      [first, second],
      [second, first],
    ]) {
      for (const currentRoot of [firstRoot, secondRoot]) {
        plantRuntimeRequest(currentRoot, {
          sessionId,
          project,
          timestamp,
          executionId: 'shared-mixed-response',
          tokens: 100,
        });
      }
      const sources = await loadScopedSourcesAt(
        [firstRoot, secondRoot],
        timestamp,
      );
      expect(sources.records).toHaveLength(1);
      expect(sources.records).toHaveLength(1);
      expect(sources.records[0]).toMatchObject({
        models: { 'qwen-max': { requests: 1, totalTokens: 100 } },
        tools: { totalCalls: 1 },
        files: { linesAdded: 7, linesRemoved: 3 },
      });
    }
  });

  it('collapses only exactly identified copies across runtime roots', async () => {
    const rootA = path.join(tmpHome, 'copy-root-a');
    const rootB = path.join(tmpHome, 'copy-root-b');
    const sessionId = 'shared-runtime-copy';
    const project = '/runtime/shared';
    const timestamp = '2026-05-25T12:00:00.000Z';
    const transcript = plantRuntimeRequest(rootA, {
      sessionId,
      project,
      timestamp,
      executionId: 'shared-runtime-request',
      tokens: 100,
    });
    const copiedTranscript = plantRuntimeRequest(rootB, {
      sessionId,
      project,
      timestamp,
      executionId: 'shared-runtime-request',
      tokens: 100,
    });
    expect(
      fs.readFileSync(transcript).equals(fs.readFileSync(copiedTranscript)),
    ).toBe(true);
    seed([
      {
        ...rec({
          sessionId,
          timestamp: Date.parse(timestamp),
          project,
          model: {
            inputTokens: 100,
            totalTokens: 100,
            totalLatencyMs: 10,
          },
        }),
        runScoped: true,
        requestExecutionIds: ['shared-runtime-request'],
        successfulRequestExecutionIds: ['shared-runtime-request'],
        totalLatencyMs: 10,
        tools: {
          totalCalls: 7,
          totalSuccess: 7,
          totalFail: 0,
          byName: { edit: { count: 7, success: 7, fail: 0 } },
        },
        files: { linesAdded: 12, linesRemoved: 4 },
        skills: {
          totalCalls: 3,
          totalSuccess: 3,
          totalFail: 0,
          byName: { qreview: { count: 3, success: 3, fail: 0 } },
        },
      },
    ]);
    const timestampDay = dayKey(Date.parse(timestamp));
    const ledger: TokenUsageRecord = {
      schemaVersion: 1,
      id: 'copy-ledger-row',
      executionId: 'shared-runtime-request',
      timestamp,
      localDate: timestampDay,
      localMonth: timestampDay.slice(0, 7),
      sessionId,
      model: 'qwen-max',
      authType: 'openai',
      source: 'main',
      inputTokens: 100,
      outputTokens: 0,
      cachedTokens: 0,
      thoughtsTokens: 0,
      totalTokens: 100,
      apiDurationMs: 10,
    };
    Storage.runWithResolvedRuntimeBaseDir(process.env['QWEN_HOME']!, () => {
      const file = getTokenUsageFilePath(timestampDay.slice(0, 7));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(ledger)}\n`);
    });

    const sources = await loadScopedSourcesAt([rootA, rootB], timestamp);
    expect(sources.records).toHaveLength(1);
    expect(sources.records[0]).toMatchObject({
      sessionId,
      project,
      totalLatencyMs: 10,
      requestExecutionIds: ['shared-runtime-request'],
    });
    expect(sources.records[0]!.runScoped).toBe(true);
    expect(sources.records[0]?.tools?.totalCalls).toBe(7);
    expect(sources.records[0]?.files).toEqual({
      linesAdded: 12,
      linesRemoved: 4,
    });
    expect(sources.records[0]?.skills?.totalCalls).toBe(3);
    expect(
      buildUsageDashboard(
        sources.records,
        { range: 'all' },
        sources.ledgerDaily,
        sources.runtimeScopes,
      ).summary,
    ).toMatchObject({ totalTokens: 100, requests: 1, sessions: 1 });
  });

  it.each([
    ['global-ledger', 'global'],
    ['first-runtime-ledger', 'first'],
    ['duplicate-runtime-ledgers', 'both'],
  ] as const)(
    'deduplicates the same execution ID: %s',
    async (_label, location) => {
      const rootA = path.join(tmpHome, `ledger-copy-a-${location}`);
      const rootB = path.join(tmpHome, `ledger-copy-b-${location}`);
      const sessionId = 'shared-scoped-ledger';
      const project = '/runtime/scoped-ledger';
      const timestamp = '2026-05-25T12:00:00.000Z';
      const options = {
        sessionId,
        project,
        timestamp,
        executionId: 'same-scoped-execution',
        tokens: 100,
      };
      plantRuntimeRequest(rootA, options);
      plantRuntimeRequest(rootB, options);
      seed([
        {
          ...rec({
            sessionId,
            timestamp: Date.parse(timestamp),
            project,
            model: { inputTokens: 100, totalTokens: 100 },
          }),
          runScoped: true,
          requestExecutionIds: ['same-scoped-execution'],
          successfulRequestExecutionIds: ['same-scoped-execution'],
        },
      ]);
      const roots = location === 'both' ? [rootA, rootB] : [rootA];
      for (const root of roots) writeTestLedgerRow(root, { timestamp });
      if (location === 'global') {
        writeTestLedgerRow(process.env['QWEN_HOME']!, { timestamp });
      }

      const sources = await loadScopedSourcesAt(
        location === 'global'
          ? [process.env['QWEN_HOME']!, rootA, rootB]
          : [rootA, rootB],
        timestamp,
      );
      expect(
        buildUsageDashboard(
          sources.records,
          { range: 'all' },
          sources.ledgerDaily,
          sources.runtimeScopes,
        ).summary,
      ).toMatchObject({ totalTokens: 100, requests: 1 });
    },
  );

  it('retains richer tool/file/skill evidence in either root order', async () => {
    const thinRoot = path.join(tmpHome, 'thin-observed');
    const richRoot = path.join(tmpHome, 'rich-observed');
    const options = {
      sessionId: 'same-observed-response',
      project: '/runtime/observations',
      timestamp: '2026-05-25T12:00:00.000Z',
      executionId: 'same-observed-execution',
      tokens: 100,
    };
    seed([
      {
        ...rec({
          sessionId: options.sessionId,
          project: options.project,
          timestamp: Date.parse(options.timestamp),
          model: { inputTokens: 100, totalTokens: 100 },
        }),
        runScoped: true,
        requestExecutionIds: [options.executionId],
        successfulRequestExecutionIds: [options.executionId],
        skills: {
          totalCalls: 1,
          totalSuccess: 1,
          totalFail: 0,
          byName: { qreview: { count: 1, success: 1, fail: 0 } },
        },
      },
    ]);
    plantRuntimeRequest(thinRoot, options);
    plantRuntimeRequest(richRoot, {
      ...options,
      toolLines: { added: 7, removed: 3 },
    });
    for (const roots of [
      [thinRoot, richRoot],
      [richRoot, thinRoot],
    ]) {
      const sources = await loadScopedSourcesAt(roots, options.timestamp);
      expect(sources.records).toHaveLength(1);
      expect(sources.records[0]).toMatchObject({
        tools: { totalCalls: 1, totalSuccess: 1, totalFail: 0 },
        files: { linesAdded: 7, linesRemoved: 3 },
        skills: { totalCalls: 1, totalSuccess: 1, totalFail: 0 },
      });
      const dashboard = buildUsageDashboard(
        sources.records,
        { range: 'all' },
        sources.ledgerDaily,
        sources.runtimeScopes,
      );
      expect(dashboard.summary).toMatchObject({
        totalTokens: 100,
        requests: 1,
        sessions: 1,
        toolCalls: 1,
        linesAdded: 7,
        linesRemoved: 3,
      });
      expect(dashboard.skills).toEqual([{ name: 'qreview', count: 1 }]);
    }
  });

  it('does not combine session and execution IDs from different responses', async () => {
    const rootA = path.join(tmpHome, 'row-proof-a');
    const rootB = path.join(tmpHome, 'row-proof-b');
    const rootC = path.join(tmpHome, 'row-proof-c');
    const timestamp = '2026-05-25T12:00:00.000Z';
    plantRuntimeRequest(rootA, {
      sessionId: 'proof-session',
      project: '/runtime/row-proof',
      timestamp,
      executionId: 'expected',
      tokens: 500,
    });
    writeTestLedgerRow(rootB, {
      id: 'same-session-other-id',
      timestamp,
      sessionId: 'proof-session',
      executionId: 'other',
    });
    writeTestLedgerRow(rootC, {
      id: 'other-session-target-id',
      timestamp,
      sessionId: 'other-session',
      executionId: 'expected',
      inputTokens: 200,
      totalTokens: 200,
    });

    const sources = await loadScopedSourcesAt([rootA, rootB, rootC], timestamp);
    expect(
      buildUsageDashboard(
        sources.records,
        { range: 'all' },
        sources.ledgerDaily,
        sources.runtimeScopes,
      ).summary,
    ).toMatchObject({ totalTokens: 800, requests: 3 });
  });

  it('includes a response that exists only in the global ledger', async () => {
    const root = process.env['QWEN_HOME']!;
    const timestamp = '2026-05-25T12:00:00.000Z';
    writeTestLedgerRow(root, {
      id: 'global-only-response',
      timestamp,
      sessionId: 'global-only-session',
      executionId: 'global-only-execution',
    });

    const sources = await loadScopedSourcesAt([root], timestamp);
    expect(sources.records).toHaveLength(0);
    expect(
      buildUsageDashboard(
        sources.records,
        { range: 'all' },
        sources.ledgerDaily,
        sources.runtimeScopes,
      ).summary,
    ).toMatchObject({ totalTokens: 100, requests: 1 });
  });

  it('matches execution evidence within the owning session only', async () => {
    const root = path.join(tmpHome, 'session-scoped-execution');
    const timestamp = '2026-05-25T12:00:00.000Z';
    const localDate = dayKey(Date.parse(timestamp));
    const rows = [
      ['session-a', 100],
      ['session-b', 200],
    ].map(([sessionId, tokens]) =>
      JSON.stringify({
        schemaVersion: 1,
        id: `${sessionId}-ledger`,
        executionId: 'same-execution-across-sessions',
        timestamp,
        localDate,
        localMonth: '2026-05',
        sessionId,
        model: 'qwen-max',
        authType: 'openai',
        source: 'main',
        inputTokens: tokens,
        outputTokens: 0,
        cachedTokens: 0,
        thoughtsTokens: 0,
        totalTokens: tokens,
        apiDurationMs: 1,
      }),
    );
    Storage.runWithResolvedRuntimeBaseDir(root, () => {
      const file = getTokenUsageFilePath('2026-05');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${rows.join('\n')}\n`);
    });
    const ledger = await Storage.runWithResolvedRuntimeBaseDir(root, () =>
      loadTokenUsageDailyByModel('2026-05-01'),
    );
    setLedgerTranscriptScope(ledger, {
      root,
      pathsBySessionId: new Map(),
    });
    const record: UsageSummaryRecord = {
      ...rec({
        sessionId: 'session-a',
        timestamp: Date.parse(timestamp),
        model: { inputTokens: 100, totalTokens: 100 },
      }),
      runScoped: true,
      requestExecutionIds: ['same-execution-across-sessions'],
      successfulRequestExecutionIds: ['same-execution-across-sessions'],
    };
    expect(
      buildUsageDashboard([record], { range: 'all' }, ledger, [
        { records: [record], ledgerDaily: ledger },
      ]).summary,
    ).toMatchObject({ requests: 2, totalTokens: 300 });
  });

  it('matches mixed OpenAI and Gemini responses by per-row provider totals', async () => {
    const root = process.env['QWEN_HOME']!;
    const sessionId = 'mixed-provider-responses';
    const timestamp = '2026-05-25T12:00:00.000Z';
    seed([
      {
        ...rec({
          sessionId,
          project: '/runtime/mixed-provider',
          timestamp: Date.parse(timestamp),
          model: {
            requests: 2,
            inputTokens: 20,
            outputTokens: 40,
            thoughtsTokens: 10,
            totalTokens: 70,
          },
        }),
        runScoped: true,
        requestExecutionIds: ['openai-a', 'gemini-b'],
        successfulRequestExecutionIds: ['openai-a', 'gemini-b'],
      },
    ]);
    writeTestLedgerRows(
      root,
      ['openai', 'gemini'].map((authType, index) => ({
        id: `mixed-provider-${authType}`,
        executionId: index === 0 ? 'openai-a' : 'gemini-b',
        timestamp,
        sessionId,
        authType,
        inputTokens: 10,
        outputTokens: 20,
        thoughtsTokens: 5,
        // Missing native totals are normalized when each response is recorded.
        totalTokens: index === 0 ? 30 : 35,
      })),
    );

    const sources = await loadScopedSourcesAt([root], timestamp);
    expect(
      buildUsageDashboard(
        sources.records,
        { range: 'all' },
        sources.ledgerDaily,
        sources.runtimeScopes,
      ).summary,
    ).toMatchObject({ totalTokens: 65, requests: 2 });
  });

  it('indexes each real ledger bucket once across many sessions', async () => {
    const root = process.env['QWEN_HOME']!;
    const timestamp = '2026-05-25T12:00:00.000Z';
    const requests = Array.from({ length: 100 }, (_, index) => ({
      sessionId: `index-session-${index}`,
      executionId: `index-execution-${index}`,
    }));
    seed(
      requests.map(({ sessionId, executionId }) => ({
        ...rec({
          sessionId,
          project: '/runtime/index-per-bucket',
          timestamp: Date.parse(timestamp),
          model: { inputTokens: 1, totalTokens: 1 },
        }),
        runScoped: true,
        requestExecutionIds: [executionId],
        successfulRequestExecutionIds: [executionId],
      })),
    );
    writeTestLedgerRows(
      root,
      requests.map(({ sessionId, executionId }, index) => ({
        id: `index-row-${index}`,
        sessionId,
        executionId,
        timestamp,
        inputTokens: 1,
        totalTokens: 1,
      })),
    );
    const sources = await loadScopedSourcesAt([root], timestamp);

    executionRecordProbe.calls = 0;
    const dashboard = buildUsageDashboard(
      sources.records,
      { range: 'all' },
      sources.ledgerDaily,
      sources.runtimeScopes,
    );

    // The scoped build consults its own ledger and the combined evidence table.
    expect(executionRecordProbe.calls).toBe(2);
    expect(dashboard.summary).toMatchObject({
      requests: 100,
      inputTokens: 100,
      totalTokens: 100,
      sessions: 100,
    });
  });

  it('does not lend another root ledger to a different-project legacy record', async () => {
    const rootA = path.join(tmpHome, 'root-projection-a');
    const rootB = path.join(tmpHome, 'root-projection-b');
    const timestamp = '2026-05-25T12:00:00.000Z';
    const sessionId = 'same-session-across-projects';
    const projectA = '/runtime/root-projection-a';
    plantRuntimeRequest(rootA, {
      sessionId,
      project: projectA,
      timestamp,
      tokens: 50,
    });
    writeTestLedgerRow(rootB, {
      timestamp,
      sessionId,
      executionId: 'root-b-only-response',
    });

    const sources = await loadScopedSourcesAt([rootA, rootB], timestamp);
    const dashboard = buildUsageDashboard(
      sources.records,
      { range: 'all' },
      sources.ledgerDaily,
      sources.runtimeScopes,
    );
    expect(dashboard.summary).toMatchObject({
      totalTokens: 150,
      requests: 2,
    });
    const serialized = JSON.stringify(dashboard);
    expect(serialized).not.toContain(projectA);
    expect(serialized).not.toContain(rootA);
    expect(serialized).not.toContain(rootB);
  });

  it('drops only the session coverage supplied by a duplicate ledger copy', async () => {
    const rootA = path.join(tmpHome, 'duplicate-session-cover-a');
    const rootB = path.join(tmpHome, 'duplicate-session-cover-b');
    const timestamp = '2026-05-25T12:00:00.000Z';
    const sessionId = 'duplicate-and-legacy-session';
    const project = '/runtime/duplicate-and-legacy';
    plantRuntimeRequest(rootB, {
      sessionId,
      project,
      timestamp: '2026-05-25T11:00:00.000Z',
      tokens: 50,
    });
    for (const root of [rootA, rootB]) {
      writeTestLedgerRow(root, {
        timestamp,
        sessionId,
        executionId: 'duplicate-100-response',
      });
    }

    const duplicated = await loadScopedSourcesAt([rootA, rootB], timestamp);
    expect(
      buildUsageDashboard(
        duplicated.records,
        { range: 'all' },
        duplicated.ledgerDaily,
        duplicated.runtimeScopes,
      ).summary,
    ).toMatchObject({ totalTokens: 150, requests: 2 });

    const duplicateFile = Storage.runWithResolvedRuntimeBaseDir(rootB, () =>
      getTokenUsageFilePath('2026-05'),
    );
    fs.rmSync(duplicateFile);
    const singleCopy = await loadScopedSourcesAt([rootA, rootB], timestamp);
    expect(
      buildUsageDashboard(
        singleCopy.records,
        { range: 'all' },
        singleCopy.ledgerDaily,
        singleCopy.runtimeScopes,
      ).summary,
    ).toMatchObject({ totalTokens: 150, requests: 2 });
  });

  it('keeps a newer replay instead of reattaching its legacy future snapshot', async () => {
    const root = process.env['QWEN_HOME']!;
    const now = Date.parse('2026-05-25T12:00:00.000Z');
    const sessionId = 'future-legacy-grown-replay';
    const project = '/runtime/future-legacy-grown';
    const file = plantRuntimeRequest(root, {
      sessionId,
      project,
      timestamp: new Date(now).toISOString(),
      tokens: 100,
    });
    const timestamp = new Date(now + 61_000).toISOString();
    fs.appendFileSync(
      file,
      `${JSON.stringify({
        sessionId,
        cwd: project,
        timestamp,
        type: 'system',
        subtype: 'ui_telemetry',
        systemPayload: {
          uiEvent: {
            'event.name': 'qwen-code.api_response',
            'event.timestamp': timestamp,
            response_id: 'later-real-response',
            duration_ms: 10,
            model: 'qwen-max',
            input_token_count: 200,
            output_token_count: 0,
            cached_content_token_count: 0,
            thoughts_token_count: 0,
            total_token_count: 200,
          },
        },
      })}\n`,
    );
    seed([
      rec({
        sessionId,
        project,
        timestamp: now + 60_000,
        model: { inputTokens: 100, totalTokens: 100 },
      }),
    ]);
    const sources = await loadScopedSourcesAt([], new Date(now).toISOString());
    expect(sources.records).toHaveLength(1);
    expect(sources.records[0]).toMatchObject({
      transcriptRebuild: true,
      timestamp: now + 61_000,
      models: { 'qwen-max': { totalTokens: 300, requests: 2 } },
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    try {
      expect(
        buildUsageDashboard(
          sources.records,
          { range: 'all' },
          sources.ledgerDaily,
          sources.runtimeScopes,
        ).summary,
      ).toMatchObject({ totalTokens: 300, requests: 2, sessions: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains ordinary counters when dashboard requestExecutionIds is malformed', async () => {
    const root = process.env['QWEN_HOME']!;
    const timestamp = '2026-05-25T12:00:00.000Z';
    seed([
      {
        ...rec({
          sessionId: 'malformed-dashboard-id',
          timestamp: Date.parse(timestamp),
          project: '/runtime/malformed-id',
          model: { inputTokens: 200, totalTokens: 200 },
        }),
        runScoped: true,
        requestExecutionIds: { 0: 'owned', length: 1 } as unknown as string[],
      },
    ]);
    const sources = await loadScopedSourcesAt([root], timestamp);
    expect(sources.records).toHaveLength(1);
    expect(
      buildUsageDashboard(
        sources.records,
        { range: 'all' },
        sources.ledgerDaily,
        sources.runtimeScopes,
      ).summary,
    ).toMatchObject({ requests: 1, totalTokens: 200 });
  });

  it.each([{ 0: 'owned', length: 1 }, 'owned'])(
    'retains counters with malformed successfulRequestExecutionIds: %j',
    async (malformed) => {
      const root = process.env['QWEN_HOME']!;
      const timestamp = '2026-05-25T12:00:00.000Z';
      seed([
        {
          ...rec({
            sessionId: 'malformed-success-shape',
            timestamp: Date.parse(timestamp),
            project: '/runtime/malformed-success',
            model: { inputTokens: 200, totalTokens: 200 },
          }),
          runScoped: true,
          requestExecutionIds: ['owned'],
          successfulRequestExecutionIds: malformed as unknown as string[],
        },
      ]);
      const sources = await loadScopedSourcesAt([root], timestamp);
      expect(sources.records).toHaveLength(1);
      expect(
        buildUsageDashboard(
          sources.records,
          { range: 'all' },
          sources.ledgerDaily,
          sources.runtimeScopes,
        ).summary,
      ).toMatchObject({ requests: 1, totalTokens: 200 });
    },
  );

  it('folds durable copies with the same identity even across disjoint windows', async () => {
    const root = process.env['QWEN_HOME']!;
    const now = Date.parse('2026-05-25T12:00:00.000Z');
    const timestamp = new Date(now).toISOString();
    const durable = (
      executionId: string,
      startTime: number,
      endTime: number,
    ) => ({
      ...rec({
        sessionId: 'same-consumption-across-windows',
        project: '/runtime/duplicate-durable',
        timestamp: endTime,
        startTime,
        model: { inputTokens: 100, totalTokens: 100 },
      }),
      runScoped: true,
      requestExecutionIds: [executionId],
      successfulRequestExecutionIds: [executionId],
    });
    const duplicate = durable('same-real-response', now + 1000, now + 1100);
    seed([
      duplicate,
      { ...duplicate, startTime: now + 2000, timestamp: now + 2100 },
    ]);
    const merged = await loadScopedSourcesAt([root], timestamp);
    expect(merged.records).toHaveLength(1);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    try {
      expect(
        buildUsageDashboard(
          merged.records,
          { range: 'all' },
          merged.ledgerDaily,
          merged.runtimeScopes,
        ).summary,
      ).toMatchObject({ totalTokens: 100, requests: 1, sessions: 0 });
    } finally {
      vi.useRealTimers();
    }
    seed([
      durable('independent-response-a', now + 1000, now + 1100),
      durable('independent-response-b', now + 2000, now + 2100),
    ]);
    const distinct = await loadScopedSourcesAt([root], timestamp);
    expect(distinct.records).toHaveLength(2);
    expect(
      buildUsageDashboard(
        distinct.records,
        { range: 'all' },
        distinct.ledgerDaily,
        distinct.runtimeScopes,
      ).summary,
    ).toMatchObject({ totalTokens: 200, requests: 2 });
  });

  it('does not append a legacy future record already in the scoped view', async () => {
    const now = Date.parse('2026-05-25T12:00:00.000Z');
    const timestamp = new Date(now + 60_000).toISOString();
    seed([
      rec({
        sessionId: 'legacy-future-covered-twice',
        timestamp: now + 60_000,
        model: { inputTokens: 100, totalTokens: 100 },
      }),
    ]);
    const sources = await loadScopedSourcesAt([], timestamp);
    expect(sources.records).toHaveLength(1);
    expect(
      buildUsageDashboard(
        sources.records,
        { range: 'all' },
        sources.ledgerDaily,
        sources.runtimeScopes,
      ).summary,
    ).toMatchObject({ totalTokens: 100, requests: 1 });
  });

  it('sums independently maximal model latencies across identical root copies', async () => {
    const rootA = path.join(tmpHome, 'latency-copy-a');
    const rootB = path.join(tmpHome, 'latency-copy-b');
    const sessionId = 'shared-latency-copy';
    const project = '/runtime/latency-copy';
    const timestamp = '2026-05-25T12:00:00.000Z';
    const executionId = 'shared-latency-m1-response';
    const fileA = plantRuntimeRequest(rootA, {
      sessionId,
      project,
      timestamp,
      executionId,
      modelName: 'm1',
      durationMs: 100,
      tokens: 100,
    });
    const fileB = plantRuntimeRequest(rootB, {
      sessionId,
      project,
      timestamp,
      executionId,
      modelName: 'm1',
      durationMs: 0,
      tokens: 100,
    });
    for (const [file, duration] of [
      [fileA, 0],
      [fileB, 80],
    ] as const) {
      fs.appendFileSync(
        file,
        `${JSON.stringify({
          sessionId,
          cwd: project,
          timestamp,
          type: 'system',
          subtype: 'ui_telemetry',
          systemPayload: {
            uiEvent: {
              'event.name': 'qwen-code.api_response',
              'event.timestamp': timestamp,
              response_id: 'shared-latency-m2-response',
              execution_id: 'shared-latency-m2-response',
              model: 'm2',
              duration_ms: duration,
              input_token_count: 100,
              output_token_count: 0,
              cached_content_token_count: 0,
              thoughts_token_count: 0,
              total_token_count: 100,
            },
          },
        })}\n`,
      );
    }
    const sources = await loadScopedSourcesAt([rootA, rootB], timestamp);
    expect(sources.records).toHaveLength(1);
    expect(sources.records).toHaveLength(1);
    expect(sources.records[0]).toMatchObject({
      totalLatencyMs: 180,
      models: {
        m1: { totalLatencyMs: 100 },
        m2: { totalLatencyMs: 80 },
      },
    });
    expect(aggregateUsage(sources.records, 'all').totalLatencyMs).toBe(180);
  });

  it('deduplicates identical totals-only ledger rows', async () => {
    const rootA = path.join(tmpHome, 'totals-only-a');
    const rootB = path.join(tmpHome, 'totals-only-b');
    const timestamp = '2026-05-25T12:00:00.000Z';
    for (const [index, root] of [rootA, rootB].entries()) {
      writeTestLedgerRow(root, {
        id: `totals-only-${index}`,
        timestamp,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 100,
      });
    }

    const sources = await loadScopedSourcesAt([rootA, rootB], timestamp);
    expect(
      buildUsageDashboard(
        sources.records,
        { range: 'all' },
        sources.ledgerDaily,
        sources.runtimeScopes,
      ).summary,
    ).toMatchObject({ totalTokens: 100, requests: 1 });
  });

  it('keeps conflicting ledger rows with the same execution ID', async () => {
    const rootA = path.join(tmpHome, 'conflicting-ledger-a');
    const rootB = path.join(tmpHome, 'conflicting-ledger-b');
    const sessionId = 'same-id-different-evidence';
    const project = '/runtime/conflicting-evidence';
    const timestamp = '2026-05-25T12:00:00.000Z';
    for (const [index, root] of [rootA, rootB].entries()) {
      const tokens = (index + 1) * 100;
      plantRuntimeRequest(root, {
        sessionId,
        project,
        timestamp,
        executionId: 'conflicting-execution',
        tokens,
      });
      writeTestLedgerRow(root, {
        id: `conflicting-row-${index}`,
        timestamp,
        sessionId,
        executionId: 'conflicting-execution',
        inputTokens: tokens,
        totalTokens: tokens,
      });
    }

    const sources = await loadScopedSourcesAt([rootA, rootB], timestamp);
    expect(sources.records).toHaveLength(2);
    expect(
      buildUsageDashboard(
        sources.records,
        { range: 'all' },
        sources.ledgerDaily,
        sources.runtimeScopes,
      ).summary,
    ).toMatchObject({ totalTokens: 300, requests: 2 });
  });

  it('rejects conflicting response evidence for one ID across local days', async () => {
    const rootA = path.join(tmpHome, 'multi-day-conflict-a');
    const rootB = path.join(tmpHome, 'multi-day-conflict-b');
    const sessionId = 'multi-day-conflict';
    const firstDay = new Date(2026, 4, 24, 12);
    const secondDay = new Date(2026, 4, 25, 12);
    seed([
      {
        ...rec({
          sessionId,
          timestamp: secondDay.getTime(),
          model: { inputTokens: 100, totalTokens: 100 },
        }),
        startTime: firstDay.getTime(),
        runScoped: true,
        requestExecutionIds: ['conflicting-id'],
        successfulRequestExecutionIds: ['conflicting-id'],
      },
    ]);
    for (const [root, timestamp, tokens] of [
      [rootA, firstDay.toISOString(), 100],
      [rootB, secondDay.toISOString(), 200],
    ] as const) {
      writeTestLedgerRow(root, {
        id: `cross-day-${tokens}`,
        timestamp,
        sessionId,
        executionId: 'conflicting-id',
        inputTokens: tokens,
        totalTokens: tokens,
      });
    }

    const sources = await loadScopedSourcesAt(
      [rootA, rootB],
      secondDay.toISOString(),
    );
    expect(
      buildUsageDashboard(
        sources.records,
        { range: 'all' },
        sources.ledgerDaily,
        sources.runtimeScopes,
      ).summary,
    ).toMatchObject({ totalTokens: 400, requests: 3 });
  });

  it('retains records with malformed request ID elements instead of throwing', async () => {
    const root = path.join(tmpHome, 'malformed-array-elements');
    const sessionId = 'malformed-array-elements';
    const timestamp = '2026-05-25T12:00:00.000Z';
    seed([
      {
        ...rec({
          sessionId,
          project: '/runtime/malformed-array-elements',
          timestamp: Date.parse(timestamp),
          model: { inputTokens: 100, totalTokens: 100 },
        }),
        requestExecutionIds: [
          { toString: null },
          { toString: null },
        ] as unknown as string[],
      },
    ]);

    const sources = await loadScopedSourcesAt([root], timestamp);
    expect(sources.records).toMatchObject([
      { sessionId, models: { 'qwen-max': { totalTokens: 100 } } },
    ]);
    expect(
      buildUsageDashboard(
        sources.records,
        { range: 'all' },
        sources.ledgerDaily,
        sources.runtimeScopes,
      ).summary,
    ).toMatchObject({ totalTokens: 100, requests: 1 });
  });

  it('retains conflicting future consumption with the same execution ID', async () => {
    const timestamp = '2026-05-25T12:00:00.000Z';
    const timestampMs = Date.parse(timestamp);
    const sessionId = 'future-conflicting-execution';
    const project = '/runtime/future-conflicting-execution';
    const executionId = 'future-conflicting-execution-response';
    const roots = [100, 200].map((tokens) => {
      const root = path.join(tmpHome, `future-conflicting-${tokens}`);
      plantRuntimeRequest(root, {
        sessionId,
        project,
        timestamp,
        executionId,
        tokens,
      });
      return root;
    });
    seed(
      [100, 200].map((tokens) => ({
        ...rec({
          sessionId,
          project,
          startTime: timestampMs,
          timestamp: timestampMs,
          model: { inputTokens: tokens, totalTokens: tokens },
        }),
        runScoped: true,
        requestExecutionIds: [executionId],
        successfulRequestExecutionIds: [executionId],
      })),
    );

    const sources = await loadScopedSourcesAt(
      roots,
      new Date(timestampMs - 1000).toISOString(),
    );
    expect(
      sources.records
        .map((record) => record.models['qwen-max']?.totalTokens)
        .sort((a, b) => (a ?? 0) - (b ?? 0)),
    ).toEqual([100, 200]);
    expect(
      buildUsageDashboard(
        sources.records,
        { range: 'all' },
        sources.ledgerDaily,
        sources.runtimeScopes,
      ).summary,
    ).toMatchObject({ totalTokens: 300, requests: 2 });
  });

  it('keeps an active response that is not yet in the ledger', async () => {
    const root = path.join(tmpHome, 'active-response-not-yet-written');
    const sessionId = 'active-response-not-yet-written';
    const project = '/runtime/active-response-not-yet-written';
    const timestamp = '2026-05-25T12:00:00.000Z';
    plantRuntimeRequest(root, {
      sessionId,
      project,
      timestamp,
      executionId: 'persisted-response',
      tokens: 100,
    });
    writeTestLedgerRow(root, {
      timestamp,
      sessionId,
      executionId: 'persisted-response',
    });
    const ledgerDaily = await Storage.runWithResolvedRuntimeBaseDir(root, () =>
      loadTokenUsageDailyByModel('2026-05-25'),
    );
    setLedgerTranscriptScope(ledgerDaily, {
      root,
      pathsBySessionId: new Map([
        [
          sessionId,
          new Set([
            new SessionService(project, {
              runtimeBaseDir: root,
            }).getSessionTranscriptPath(sessionId),
          ]),
        ],
      ]),
      projectKeysBySession: new Map([[sessionId, new Set([project])]]),
    });
    const active = rec({
      sessionId,
      project,
      timestamp: Date.parse(timestamp) + 1000,
      model: {
        requests: 2,
        inputTokens: 150,
        totalTokens: 150,
        totalLatencyMs: 100,
      },
    });
    active.totalLatencyMs = 100;
    active.requestExecutionIds = ['persisted-response', 'live-response'];

    const table = buildUsageDayTable(
      [active],
      ledgerDaily,
      undefined,
      undefined,
      active,
    );

    expect(
      table.get(dayKey(Date.parse(timestamp)))?.get('qwen-max'),
    ).toMatchObject({ requests: 2, totalTokens: 150, apiDurationMs: 100 });
    const recombined = {
      ...active,
      requestExecutionIds: [...active.requestExecutionIds!],
    };
    const recombinedTable = buildUsageDayTable(
      [recombined],
      ledgerDaily,
      undefined,
      undefined,
      active,
    );
    expect(
      recombinedTable.get(dayKey(Date.parse(timestamp)))?.get('qwen-max'),
    ).toMatchObject({ requests: 2, totalTokens: 150, apiDurationMs: 100 });
    const reordered = {
      ...recombined,
      requestExecutionIds: [...recombined.requestExecutionIds!].reverse(),
    };
    expect(
      buildUsageDayTable([reordered], ledgerDaily, undefined, undefined, active)
        .get(dayKey(Date.parse(timestamp)))
        ?.get('qwen-max'),
    ).toMatchObject({ requests: 2, totalTokens: 150, apiDurationMs: 100 });

    await Storage.runWithResolvedRuntimeBaseDir(root, () => {
      const ledgerPath = getTokenUsageFilePath('2026-05');
      const row = JSON.parse(
        fs.readFileSync(ledgerPath, 'utf8').trim().split('\n')[0]!,
      ) as TokenUsageRecord;
      fs.appendFileSync(
        ledgerPath,
        `${JSON.stringify({
          ...row,
          id: 'conflicting-persisted-response',
          inputTokens: 200,
          totalTokens: 200,
        })}\n`,
      );
    });
    const conflicting = await Storage.runWithResolvedRuntimeBaseDir(root, () =>
      loadTokenUsageDailyByModel('2026-05-25'),
    );
    const day = dayKey(Date.parse(timestamp));
    for (const scopes of [
      undefined,
      [{ records: [active], ledgerDaily: conflicting }],
    ]) {
      expect(
        buildUsageDayTable(
          [active],
          conflicting,
          undefined,
          undefined,
          active,
          scopes,
        )
          .get(day)
          ?.get('qwen-max'),
      ).toMatchObject({ requests: 4, totalTokens: 450 });
    }
  });

  it('does not let an unidentified ledger row cover a known response', async () => {
    const root = path.join(tmpHome, 'known-id-unidentified-ledger-row');
    const sessionId = 'known-response-unidentified-ledger-row';
    const project = '/runtime/known-response-unidentified-ledger-row';
    const timestamp = '2026-05-25T12:00:00.000Z';
    plantRuntimeRequest(root, {
      sessionId,
      project,
      timestamp,
      executionId: 'known-public-response',
      tokens: 100,
    });
    writeTestLedgerRow(root, {
      sessionId,
      timestamp,
      executionId: undefined,
      inputTokens: 200,
      totalTokens: 200,
    });

    const sources = await loadScopedSourcesAt([root], timestamp);
    expect(
      buildUsageDashboard(
        sources.records,
        { range: 'all' },
        sources.ledgerDaily,
        sources.runtimeScopes,
      ).summary,
    ).toMatchObject({ totalTokens: 300, requests: 2 });
  });

  it('retains the unidentified veto past the evidence budget', async () => {
    const root = path.join(tmpHome, 'unidentified-veto-over-budget');
    const sessionId = 'known-response-over-budget';
    const project = '/runtime/unidentified-veto-over-budget';
    const timestamp = '2026-05-25T12:00:00.000Z';
    plantRuntimeRequest(root, {
      sessionId,
      project,
      timestamp,
      executionId: 'known-response-over-budget',
      tokens: 100,
    });
    const fillers = Array.from({ length: 10_000 }, (_, index) => ({
      timestamp: '2026-05-24T12:00:00.000Z',
      sessionId: 'unrelated-filler',
      model: 'filler-model',
      executionId: `unrelated-fill-${index}`,
    }));
    writeTestLedgerRows(root, [
      ...fillers,
      {
        sessionId,
        timestamp,
        executionId: undefined,
        inputTokens: 200,
        totalTokens: 200,
      },
    ]);

    const sources = await loadScopedSourcesAt([root], timestamp);
    expect(
      buildUsageDayTable(
        sources.records,
        sources.ledgerDaily,
        undefined,
        undefined,
        undefined,
        sources.runtimeScopes,
      )
        .get(dayKey(Date.parse(timestamp)))
        ?.get('qwen-max'),
    ).toMatchObject({ totalTokens: 300, requests: 2 });
  });

  it('lets a full cumulative future cover a smaller older delta everywhere', async () => {
    const sessionId = 'future-expanded-cumulative-cover';
    const project = '/runtime/future-expanded-cumulative-cover';
    const expanded = rec({
      sessionId,
      project,
      startTime: 1900,
      timestamp: 2200,
      model: { inputTokens: 250, totalTokens: 250 },
    });
    seed([
      {
        ...rec({
          sessionId,
          project,
          startTime: 2000,
          timestamp: 2100,
          model: { inputTokens: 100, totalTokens: 100 },
        }),
        runScoped: true,
        requestExecutionIds: ['a'],
        successfulRequestExecutionIds: ['a'],
      },
      {
        ...expanded,
        requestExecutionIds: ['a', 'b'],
        successfulRequestExecutionIds: ['a', 'b'],
        models: {
          'qwen-max': { ...expanded.models['qwen-max']!, requests: 2 },
        },
      },
    ]);

    for (const roots of [undefined, []] as const) {
      const sources = await loadScopedSourcesAt(
        roots,
        '2026-05-25T12:00:00.000Z',
      );
      expect(sources.records).toMatchObject([
        {
          models: {
            'qwen-max': { inputTokens: 250, totalTokens: 250, requests: 2 },
          },
        },
      ]);
      expect(
        buildUsageDashboard(
          sources.records,
          { range: 'all' },
          sources.ledgerDaily,
          sources.runtimeScopes,
        ).summary,
      ).toMatchObject({ totalTokens: 250, requests: 2 });
    }
  });

  it('keeps an older delta when a fuller snapshot has lower consumption', async () => {
    const sessionId = 'future-expanded-lower-consumption';
    const project = '/runtime/future-expanded-lower-consumption';
    const expanded = rec({
      sessionId,
      project,
      startTime: 1900,
      timestamp: 2200,
      model: { inputTokens: 50, totalTokens: 50 },
    });
    seed([
      {
        ...rec({
          sessionId,
          project,
          startTime: 2000,
          timestamp: 2100,
          model: { inputTokens: 100, totalTokens: 100 },
        }),
        runScoped: true,
        requestExecutionIds: ['a'],
        successfulRequestExecutionIds: ['a'],
      },
      {
        ...expanded,
        requestExecutionIds: ['a', 'b'],
        successfulRequestExecutionIds: ['a', 'b'],
        models: {
          'qwen-max': { ...expanded.models['qwen-max']!, requests: 2 },
        },
      },
    ]);

    for (const roots of [undefined, []] as const) {
      const sources = await loadScopedSourcesAt(
        roots,
        '2026-05-25T12:00:00.000Z',
      );
      expect(sources.records).toHaveLength(2);
      expect(
        buildUsageDashboard(
          sources.records,
          { range: 'all' },
          sources.ledgerDaily,
          sources.runtimeScopes,
        ).summary,
      ).toMatchObject({ totalTokens: 150, requests: 3 });
    }
  });

  it('uses each root exact proof for the same session UUID in different projects', async () => {
    const rootA = path.join(tmpHome, 'project-exact-owner-a');
    const rootB = path.join(tmpHome, 'project-exact-owner-b');
    const timestamp = '2026-05-25T12:00:00.000Z';
    const sessionId = 'shared-uuid-exact-projects';
    const projectA = '/runtime/exact-project-a';
    const projectB = '/runtime/exact-project-b';
    for (const [root, project, executionId] of [
      [rootA, projectA, 'project-a-response'],
      [rootB, projectB, 'project-b-response'],
    ] as const) {
      plantRuntimeRequest(root, {
        sessionId,
        project,
        timestamp,
        executionId,
        tokens: 100,
      });
      writeTestLedgerRow(root, { timestamp, sessionId, executionId });
    }

    const sources = await loadScopedSourcesAt([rootA, rootB], timestamp);
    expect(
      buildUsageDashboard(
        sources.records,
        { range: 'all' },
        sources.ledgerDaily,
        sources.runtimeScopes,
      ).summary,
    ).toMatchObject({ totalTokens: 200, requests: 2 });
  });

  it('reconciles future native snapshots and deltas without execution IDs', async () => {
    const startTime = Date.parse('2026-05-25T12:00:00.000Z');
    const endTime = startTime + 600_000;
    const sessionId = 'future-snapshot-without-ids';
    const project = '/runtime/future-snapshot-without-ids';
    seed([
      {
        ...rec({
          sessionId,
          project,
          startTime,
          timestamp: endTime,
          model: { inputTokens: 100, totalTokens: 100 },
        }),
        transcriptRebuild: true,
      },
      {
        ...rec({
          sessionId,
          project,
          startTime,
          timestamp: endTime,
          model: { inputTokens: 100, totalTokens: 100 },
        }),
        runScoped: true,
      },
    ]);

    for (const roots of [undefined, []] as const) {
      const sources = await loadScopedSourcesAt(
        roots,
        new Date(startTime).toISOString(),
      );
      expect(sources.records).toHaveLength(1);
      expect(
        buildUsageDashboard(
          sources.records,
          { range: 'all' },
          sources.ledgerDaily,
          sources.runtimeScopes,
        ).summary,
      ).toMatchObject({ totalTokens: 100, requests: 1 });
    }
  });

  it('keeps ledger rows that differ only in API duration', async () => {
    const rootA = path.join(tmpHome, 'different-duration-a');
    const rootB = path.join(tmpHome, 'different-duration-b');
    const timestamp = '2026-05-25T12:00:00.000Z';
    for (const [root, duration] of [
      [rootA, 10],
      [rootB, 20],
    ] as const) {
      writeTestLedgerRow(root, {
        id: `duration-${duration}`,
        timestamp,
        executionId: 'duration-conflict',
        apiDurationMs: duration,
      });
    }

    const sources = await loadScopedSourcesAt([rootA, rootB], timestamp);
    expect(
      buildUsageDashboard(
        sources.records,
        { range: 'all' },
        sources.ledgerDaily,
        sources.runtimeScopes,
      ).summary,
    ).toMatchObject({ totalTokens: 200, requests: 2 });
  });

  it.each([
    ['localDate', { localDate: '2026-05-24', localMonth: '2026-05' }],
    ['auth type', { authType: 'qwen-oauth' }],
    ['source', { source: 'side-query:prompt_suggestion' }],
    ['timestamp', { timestamp: '2026-05-25T11:59:59.000Z' }],
    ['cached tokens', { cachedTokens: 1 }],
    ['thoughts tokens', { thoughtsTokens: 1 }],
    ['reported total', { totalTokens: 200 }],
  ] satisfies Array<[string, Partial<TokenUsageRecord>]>)(
    'preserves distinct ledger evidence for %s',
    async (_label, override) => {
      const rootA = path.join(tmpHome, 'fingerprint-field-a');
      const rootB = path.join(tmpHome, 'fingerprint-field-b');
      const timestamp = '2026-05-25T12:00:00.000Z';
      writeTestLedgerRow(rootA, {
        id: 'fingerprint-field-a',
        timestamp,
        sessionId: 'fingerprint-field-session',
        executionId: 'fingerprint-field-execution',
      });
      writeTestLedgerRow(rootB, {
        id: 'fingerprint-field-b',
        timestamp,
        sessionId: 'fingerprint-field-session',
        executionId: 'fingerprint-field-execution',
        ...override,
      });

      const sources = await loadScopedSourcesAt([rootA, rootB], timestamp);
      expect(
        buildUsageDashboard(
          sources.records,
          { range: 'all' },
          sources.ledgerDaily,
          sources.runtimeScopes,
        ).summary,
      ).toMatchObject({ totalTokens: 200, requests: 2 });
    },
  );

  it('does not merge conflicting durable history into a single transcript candidate', async () => {
    const root = path.join(tmpHome, 'relocated-root');
    const sessionId = 'relocated-request';
    const project = '/runtime/relocated';
    const timestamp = '2026-05-25T12:00:00.000Z';
    seed([
      {
        ...rec({
          sessionId,
          project,
          timestamp: Date.parse(timestamp),
          model: { inputTokens: 100, totalTokens: 100 },
        }),
        runScoped: true,
        requestExecutionIds: ['relocated-execution'],
        successfulRequestExecutionIds: ['relocated-execution'],
      },
    ]);
    plantRuntimeRequest(root, {
      sessionId,
      project,
      timestamp,
      executionId: 'relocated-execution',
      tokens: 200,
    });

    const sources = await loadScopedSourcesAt([root], timestamp);
    expect(sources.records).toHaveLength(2);
    expect(
      buildUsageDashboard(
        sources.records,
        { range: 'all' },
        sources.ledgerDaily,
        sources.runtimeScopes,
      ).summary,
    ).toMatchObject({ totalTokens: 300, requests: 2 });
  });

  it('does not erase higher history consumption against a self-consistent ledger', async () => {
    const root = path.join(tmpHome, 'conflicting-session-total');
    const sessionId = 'conflicting-session-total';
    const project = '/runtime/conflicting-session-total';
    const executionId = 'conflicting-session-total-response';
    const timestamp = '2026-05-25T12:00:00.000Z';
    seed([
      {
        ...rec({
          sessionId,
          project,
          timestamp: Date.parse(timestamp),
          model: { inputTokens: 200, totalTokens: 200 },
        }),
        runScoped: true,
        requestExecutionIds: [executionId],
        successfulRequestExecutionIds: [executionId],
      },
    ]);
    plantRuntimeRequest(root, {
      sessionId,
      project,
      timestamp,
      executionId,
      tokens: 200,
    });
    writeTestLedgerRow(root, {
      timestamp,
      sessionId,
      executionId,
      inputTokens: 100,
      totalTokens: 100,
    });

    const sources = await loadScopedSourcesAt([root], timestamp);
    expect(
      buildUsageDashboard(
        sources.records,
        { range: 'all' },
        sources.ledgerDaily,
        sources.runtimeScopes,
      ).summary,
    ).toMatchObject({ totalTokens: 300, requests: 2 });
  });

  it('does not accept a partial cached-input difference as one response', async () => {
    const root = path.join(tmpHome, 'conflicting-cached-input');
    const sessionId = 'conflicting-cached-input';
    const project = '/runtime/conflicting-cached-input';
    const executionId = 'conflicting-cached-input-response';
    const timestamp = '2026-05-25T12:00:00.000Z';
    seed(
      [100, 150].map((inputTokens) => ({
        ...rec({
          sessionId,
          project,
          timestamp: Date.parse(timestamp),
          model: { inputTokens, cachedTokens: 100, totalTokens: 200 },
        }),
        runScoped: true,
        requestExecutionIds: [executionId],
        successfulRequestExecutionIds: [executionId],
      })),
    );
    writeTestLedgerRow(root, {
      timestamp,
      sessionId,
      executionId,
      inputTokens: 150,
      cachedTokens: 100,
      totalTokens: 200,
    });

    const sources = await loadScopedSourcesAt([root], timestamp);
    expect(
      sources.ledgerDaily.get(dayKey(Date.parse(timestamp)))?.get('qwen-max'),
    ).toMatchObject({ inputTokens: 150, totalTokens: 150 });
    expect(
      buildUsageDashboard(
        sources.records,
        { range: 'all' },
        sources.ledgerDaily,
        sources.runtimeScopes,
      ).summary,
    ).toMatchObject({ totalTokens: 350, requests: 2 });
  });

  it('updates an older transcript snapshot when its native history grows', async () => {
    const root = path.join(tmpHome, 'appended-snapshot');
    const sessionId = 'appended-transcript';
    const project = '/runtime/appended-snapshot';
    const firstTimestamp = '2026-05-25T12:00:00.000Z';
    const secondTimestamp = '2026-05-25T12:01:00.000Z';
    const file = plantRuntimeRequest(root, {
      sessionId,
      project,
      timestamp: firstTimestamp,
      executionId: 'first-appended-response',
      tokens: 100,
    });
    seed([
      {
        ...rec({
          sessionId,
          project,
          timestamp: Date.parse(firstTimestamp),
          model: { inputTokens: 100, totalTokens: 100 },
        }),
        transcriptRebuild: true,
      },
    ]);
    fs.appendFileSync(
      file,
      `${JSON.stringify({
        sessionId,
        cwd: project,
        uuid: 'second-appended-response',
        timestamp: secondTimestamp,
        type: 'system',
        subtype: 'ui_telemetry',
        systemPayload: {
          uiEvent: {
            'event.name': 'qwen-code.api_response',
            'event.timestamp': secondTimestamp,
            response_id: 'second-appended-response',
            execution_id: 'second-appended-response',
            model: 'qwen-max',
            duration_ms: 10,
            input_token_count: 200,
            output_token_count: 0,
            cached_content_token_count: 0,
            thoughts_token_count: 0,
            total_token_count: 200,
            prompt_id: 'second-appended-response',
          },
        },
      })}\n`,
    );

    const sources = await loadScopedSourcesAt([root], secondTimestamp);
    expect(sources.records).toHaveLength(1);
    expect(sources.records[0]).toMatchObject({
      transcriptRebuild: true,
      timestamp: Date.parse(secondTimestamp),
    });
    expect(
      buildUsageDashboard(
        sources.records,
        { range: 'all' },
        sources.ledgerDaily,
        sources.runtimeScopes,
      ).summary,
    ).toMatchObject({ totalTokens: 300, requests: 2, sessions: 1 });
  });

  it('inherits only matching successful IDs from intact copies', async () => {
    const rootA = path.join(tmpHome, 'legacy-success-a');
    const rootB = path.join(tmpHome, 'legacy-success-b');
    const sessionId = 'legacy-success-id';
    const project = '/runtime/legacy-success-id';
    const timestamp = '2026-05-25T12:00:00.000Z';
    for (const root of [rootA, rootB]) {
      plantRuntimeRequest(root, {
        sessionId,
        project,
        timestamp,
        executionId: 'inherited-success',
        tokens: 100,
      });
    }
    writeTestLedgerRow(rootA, {
      timestamp,
      sessionId,
      executionId: 'inherited-success',
    });
    seed([
      {
        ...rec({
          sessionId,
          project,
          timestamp: Date.parse(timestamp),
          model: { inputTokens: 100, totalTokens: 100, totalLatencyMs: 10 },
        }),
        runScoped: true,
        requestExecutionIds: ['inherited-success'],
        tools: {
          totalCalls: 7,
          totalSuccess: 7,
          totalFail: 0,
          byName: { edit: { count: 7, success: 7, fail: 0 } },
        },
        files: { linesAdded: 12, linesRemoved: 4 },
        skills: {
          totalCalls: 3,
          totalSuccess: 3,
          totalFail: 0,
          byName: { qreview: { count: 3, success: 3, fail: 0 } },
        },
      },
    ]);

    const sources = await loadScopedSourcesAt([rootA, rootB], timestamp);
    expect(sources.records).toHaveLength(1);
    expect(sources.records[0]).toMatchObject({
      successfulRequestExecutionIds: ['inherited-success'],
      runScoped: true,
    });
    expect(sources.records[0]?.tools?.totalCalls).toBe(7);
    expect(sources.records[0]?.skills?.totalCalls).toBe(3);
    expect(
      buildUsageDashboard(
        sources.records,
        { range: 'all' },
        sources.ledgerDaily,
        sources.runtimeScopes,
      ).summary,
    ).toMatchObject({ totalTokens: 100, requests: 1 });
  });

  it('preserves the richer durable snapshot on a timestamp tie', async () => {
    const root = path.join(tmpHome, 'durable-tie-root');
    const sessionId = 'durable-tie-session';
    const project = '/runtime/durable-tie';
    const timestamp = '2026-05-25T12:00:00.000Z';
    plantRuntimeRequest(root, {
      sessionId,
      project,
      timestamp,
      executionId: 'durable-tie-response',
      tokens: 100,
    });
    seed([
      {
        ...rec({
          sessionId,
          project,
          timestamp: Date.parse(timestamp),
          model: { requests: 2, inputTokens: 200, totalTokens: 200 },
        }),
        transcriptRebuild: true,
      },
    ]);

    const sources = await loadScopedSourcesAt([root], timestamp);
    expect(sources.records).toHaveLength(1);
    expect(
      buildUsageDashboard(
        sources.records,
        { range: 'all' },
        sources.ledgerDaily,
        sources.runtimeScopes,
      ).summary,
    ).toMatchObject({ totalTokens: 200, requests: 2, sessions: 1 });
  });

  it('preserves maximum observed API and error latency across copies', async () => {
    const rootA = path.join(tmpHome, 'latency-a');
    const rootB = path.join(tmpHome, 'latency-b');
    const sessionId = 'latency-observability';
    const project = '/runtime/latency-observability';
    const timestamp = '2026-05-25T12:00:00.000Z';
    for (const root of [rootA, rootB]) {
      plantRuntimeRequest(root, {
        sessionId,
        project,
        timestamp,
        executionId: 'latency-observability-execution',
        tokens: 100,
      });
    }
    seed([
      {
        ...rec({
          sessionId,
          project,
          timestamp: Date.parse(timestamp),
          model: {
            inputTokens: 100,
            totalTokens: 100,
            totalLatencyMs: 200,
            errorLatencyMs: 150,
          },
        }),
        runScoped: true,
        totalLatencyMs: 200,
        requestExecutionIds: ['latency-observability-execution'],
        successfulRequestExecutionIds: ['latency-observability-execution'],
      },
    ]);

    const sources = await loadScopedSourcesAt([rootA, rootB], timestamp);
    expect(sources.records).toHaveLength(1);
    expect(sources.records[0]).toMatchObject({
      totalLatencyMs: 200,
      models: {
        'qwen-max': { totalLatencyMs: 200, errorLatencyMs: 150 },
      },
    });
    expect(
      buildUsageDashboard(
        sources.records,
        { range: 'all' },
        sources.ledgerDaily,
        sources.runtimeScopes,
      ).summary,
    ).toMatchObject({ requests: 1, totalTokens: 100 });
  });

  it('uses a valid native clock when a copied run authority is corrupt', async () => {
    const rootA = path.join(tmpHome, 'corrupt-authority-a');
    const rootB = path.join(tmpHome, 'corrupt-authority-b');
    const sessionId = 'corrupt-authority-clock';
    const project = '/runtime/corrupt-authority-clock';
    const executionId = 'corrupt-authority-response';
    const timestamp = '2026-05-25T12:00:00.000Z';
    const timestampMs = Date.parse(timestamp);
    for (const root of [rootA, rootB]) {
      plantRuntimeRequest(root, {
        sessionId,
        project,
        timestamp,
        executionId,
        tokens: 100,
      });
    }
    seed([
      {
        ...rec({
          sessionId,
          project,
          startTime: timestampMs + 20_000,
          timestamp: timestampMs,
          model: { inputTokens: 100, totalTokens: 100 },
        }),
        runScoped: true,
        requestExecutionIds: [executionId],
        successfulRequestExecutionIds: [executionId],
        timestamp: 'not-a-date' as unknown as number,
      },
    ]);

    const sources = await loadScopedSourcesAt([rootA, rootB], timestamp);
    expect(sources).toMatchObject({
      records: [
        {
          sessionId,
          timestamp: timestampMs,
          startTime: timestampMs,
          durationMs: 0,
          models: { 'qwen-max': { totalTokens: 100, requests: 1 } },
        },
      ],
    });
    expect(
      buildUsageDashboard(
        sources.records,
        { range: 'all' },
        sources.ledgerDaily,
        sources.runtimeScopes,
      ).summary,
    ).toMatchObject({ totalTokens: 100, requests: 1 });
  });

  it('restores the authoritative run clock across root copies at midnight', async () => {
    const rootA = path.join(tmpHome, 'midnight-root-a');
    const rootB = path.join(tmpHome, 'midnight-root-b');
    const sessionId = 'midnight-authoritative-run';
    const project = '/runtime/midnight';
    const startTime = new Date(2026, 4, 25, 23, 59, 59).getTime();
    const endTime = startTime + 2_000;
    const timestamp = new Date(startTime).toISOString();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(endTime);
    try {
      for (const root of [rootA, rootB]) {
        plantRuntimeRequest(root, {
          sessionId,
          project,
          timestamp,
          executionId: 'midnight-execution',
          tokens: 100,
        });
      }
      seed([
        {
          ...rec({
            sessionId,
            project,
            timestamp: endTime,
            startTime,
            model: {
              inputTokens: 100,
              totalTokens: 100,
              totalLatencyMs: 10,
            },
          }),
          runScoped: true,
          requestExecutionIds: ['midnight-execution'],
          successfulRequestExecutionIds: ['midnight-execution'],
        },
      ]);
      writeTestLedgerRow(rootB, {
        timestamp,
        sessionId,
        executionId: 'midnight-execution',
      });

      const sources = await loadUsageDashboardSources([rootA, rootB]);
      expect(sources.records).toHaveLength(1);
      expect(sources.records[0]).toMatchObject({
        timestamp: endTime,
        startTime,
        durationMs: 2_000,
        runScoped: true,
        totalLatencyMs: 10,
      });
      expect(sources.records[0]?.transcriptRebuild).not.toBe(true);
      const dashboard = buildUsageDashboard(
        sources.records,
        { range: 'today' },
        sources.ledgerDaily,
        sources.runtimeScopes,
      );
      expect(dashboard.summary.sessions).toBe(1);
      expect(dashboard.daily).toEqual([
        { date: dayKey(endTime), tokens: 0, sessions: 1 },
      ]);
      expect(dashboard.heatmap[dayKey(startTime)]?.tokens).toBe(100);
      expect(
        buildUsageDashboard(
          sources.records,
          { range: 'all' },
          sources.ledgerDaily,
          sources.runtimeScopes,
        ).summary,
      ).toMatchObject({ totalTokens: 100, requests: 1, sessions: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a future-ended run erase an earlier overlapping run', async () => {
    const now = Date.now();
    const sessionId = 'future-overlapping-run';
    const past = rec({
      sessionId,
      timestamp: now - 1_000,
      model: { inputTokens: 100, totalTokens: 100 },
    });
    const future = rec({
      sessionId,
      timestamp: now + 60_000,
      model: { inputTokens: 100, totalTokens: 100 },
    });
    seed([
      { ...past, startTime: now - 5_000, runScoped: true },
      { ...future, startTime: now - 4_000, runScoped: true },
    ]);

    const sources = await loadUsageDashboardSources();
    expect(sources.records.map((record) => record.timestamp).sort()).toEqual(
      [now - 1_000, now + 60_000].sort(),
    );
    expect(
      buildUsageDashboard(
        sources.records,
        { range: 'all' },
        sources.ledgerDaily,
        sources.runtimeScopes,
      ).summary,
    ).toMatchObject({ totalTokens: 200, requests: 2, sessions: 1 });
  });

  it('keeps partial execution identities conservative', async () => {
    const rootA = path.join(tmpHome, 'partial-identity-a');
    const rootB = path.join(tmpHome, 'partial-identity-b');
    const timestamp = '2026-05-25T12:00:00.000Z';
    const sessionId = 'partial-identity';
    seed([
      {
        ...rec({
          sessionId,
          timestamp: Date.parse(timestamp),
          model: { requests: 2, inputTokens: 300, totalTokens: 300 },
        }),
        runScoped: true,
        requestExecutionIds: ['known-response'],
        successfulRequestExecutionIds: ['known-response'],
      },
    ]);
    writeTestLedgerRow(rootA, {
      timestamp,
      sessionId,
      executionId: 'known-response',
    });
    writeTestLedgerRow(rootB, {
      id: 'unidentified-response',
      timestamp,
      sessionId,
      executionId: undefined,
      inputTokens: 200,
      totalTokens: 200,
    });

    const sources = await loadScopedSourcesAt([rootA, rootB], timestamp);
    expect(
      buildUsageDashboard(
        sources.records,
        { range: 'all' },
        sources.ledgerDaily,
        sources.runtimeScopes,
      ).summary,
    ).toMatchObject({ totalTokens: 600, requests: 4 });
  });

  it('preserves different execution ids and unidentified records across roots', async () => {
    const rootA = path.join(tmpHome, 'distinct-root-a');
    const rootB = path.join(tmpHome, 'distinct-root-b');
    const rootC = path.join(tmpHome, 'distinct-root-c');
    const timestamp = new Date().toISOString();
    const shared = {
      sessionId: 'distinct-runtime-projects',
      project: '/runtime/shared',
      timestamp,
      tokens: 100,
    };
    plantRuntimeRequest(rootA, {
      ...shared,
      executionId: 'request-a',
    });
    plantRuntimeRequest(rootB, {
      ...shared,
      executionId: 'request-b',
    });
    plantRuntimeRequest(rootC, shared);

    const sources = await loadScopedSourcesAt([rootA, rootB, rootC], timestamp);
    expect(
      buildUsageDashboard(
        sources.records,
        { range: 'all' },
        sources.ledgerDaily,
        sources.runtimeScopes,
      ).summary,
    ).toMatchObject({ totalTokens: 300, requests: 3, sessions: 3 });
  });

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

  it('cuts future ended-run tiles without discarding ledger-backed responses', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 4, 25, 12));
    try {
      const record = rec({
        sessionId: 'future-ended-run',
        timestamp: Date.now() + 1000,
        model: { requests: 1, inputTokens: 100, totalTokens: 100 },
        tools: { totalCalls: 1, totalSuccess: 1, totalFail: 0 },
      });

      const dash = buildUsageDashboard([record], { range: 'today' });

      expect(dash.summary).toMatchObject({
        totalTokens: 100,
        requests: 1,
        sessions: 0,
        toolCalls: 0,
      });
      expect(dash.daily).toEqual([
        { date: '2026-05-25', tokens: 100, sessions: 0 },
      ]);

      const scoped = buildUsageDashboard(
        [record],
        { range: 'today' },
        undefined,
        [{ records: [record], ledgerDaily: new Map() }],
      );
      expect(scoped.summary).toMatchObject({
        totalTokens: 100,
        requests: 1,
        sessions: 0,
        toolCalls: 0,
      });
      expect(scoped.daily).toEqual([
        { date: '2026-05-25', tokens: 100, sessions: 0 },
      ]);

      const ledgerDaily: TokenUsageDailyByModel = new Map([
        [
          '2026-05-25',
          ledgerDay('qwen-max', {
            requests: 1,
            inputTokens: 100,
            totalTokens: 100,
          }),
        ],
      ]);
      for (const runtimeScopes of [
        undefined,
        [{ records: [record], ledgerDaily }],
      ]) {
        const withLedger = buildUsageDashboard(
          [record],
          { range: 'today' },
          ledgerDaily,
          runtimeScopes,
        );
        // Ended-run attribution stops at the read clock, while the already
        // written API response remains a real token/request consumption.
        expect(withLedger.summary).toMatchObject({
          totalTokens: 100,
          requests: 1,
          sessions: 0,
          toolCalls: 0,
        });
        expect(withLedger.daily).toEqual([
          { date: '2026-05-25', tokens: 100, sessions: 0 },
        ]);
      }

      const supplement = {
        ...rec({
          sessionId: 'future-supplement',
          timestamp: Date.now() + 1000,
          model: { requests: 1, inputTokens: 100, totalTokens: 100 },
        }),
        transcriptSupplement: true as const,
        transcriptRebuild: true as const,
      };
      for (const runtimeScopes of [
        undefined,
        [{ records: [supplement], ledgerDaily: new Map() }],
      ]) {
        const split = buildUsageDashboard(
          [supplement],
          { range: 'today' },
          undefined,
          runtimeScopes,
        );
        expect(split.summary).toMatchObject({
          totalTokens: 100,
          sessions: 0,
          toolCalls: 0,
        });
        expect(split.daily[0]?.tokens).toBe(100);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the unpartitioned history to bound per-root replay', async () => {
    const originalHome = process.env['HOME'];
    const originalQwenHome = process.env['QWEN_HOME'];
    const originalRuntime = process.env['QWEN_RUNTIME_DIR'];
    const isolatedHome = path.join(tmpHome, 'history-boundary');
    const rootA = path.join(tmpHome, 'history-root-a');
    const rootB = path.join(tmpHome, 'history-root-b');
    const project = '/runtime/history-boundary';
    const timestamp = '2026-05-25T12:00:00.000Z';
    process.env['HOME'] = isolatedHome;
    process.env['QWEN_HOME'] = isolatedHome;
    process.env['QWEN_RUNTIME_DIR'] = isolatedHome;
    fs.mkdirSync(isolatedHome, { recursive: true });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(timestamp));
    plantRuntimeRequest(rootA, {
      sessionId: 'persisted-owner',
      project,
      timestamp,
      executionId: 'owned-execution',
      tokens: 100,
    });
    seed([
      {
        ...rec({
          sessionId: 'persisted-owner',
          project,
          timestamp: Date.parse(timestamp),
          model: { inputTokens: 100, outputTokens: 0, totalTokens: 100 },
        }),
        runScoped: true,
        requestExecutionIds: ['owned-execution'],
        successfulRequestExecutionIds: ['owned-execution'],
      },
    ]);
    const oldTimestamp = Date.now() - 60 * MS_PER_DAY;
    const oldSession = 'stale-unrecorded-session';
    plantRuntimeRequest(rootB, {
      sessionId: oldSession,
      project: '/runtime/history-stale',
      timestamp: new Date(oldTimestamp).toISOString(),
      executionId: 'stale-execution',
      tokens: 200,
    });
    const oldFile = new SessionService('/runtime/history-stale', {
      runtimeBaseDir: rootB,
    }).getSessionTranscriptPath(oldSession);
    fs.utimesSync(
      oldFile,
      new Date(oldTimestamp / 1000),
      new Date(oldTimestamp),
    );
    const open = vi.spyOn(fs.promises, 'open');
    try {
      const sources = await loadScopedSourcesAt([rootA, rootB], timestamp);
      expect(
        sources.records.some((record) => record.sessionId === oldSession),
      ).toBe(false);
      expect(
        open.mock.calls.filter(([file]) =>
          String(file).endsWith(`${oldSession}.jsonl`),
        ),
      ).toHaveLength(0);
      expect(
        buildUsageDashboard(
          sources.records,
          { range: 'all' },
          sources.ledgerDaily,
          sources.runtimeScopes,
        ).summary,
      ).toMatchObject({ totalTokens: 100, requests: 1 });
    } finally {
      open.mockRestore();
      vi.useRealTimers();
      if (originalHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = originalHome;
      if (originalQwenHome === undefined) delete process.env['QWEN_HOME'];
      else process.env['QWEN_HOME'] = originalQwenHome;
      if (originalRuntime === undefined) delete process.env['QWEN_RUNTIME_DIR'];
      else process.env['QWEN_RUNTIME_DIR'] = originalRuntime;
    }
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
    const coveredDay = dayKey(Date.parse('2026-11-12T12:00:00Z'));
    const ledgerDaily: TokenUsageDailyByModel = new Map([
      [coveredDay, ledgerDay('qwen-max', { requests: 1, inputTokens: 100 })],
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
      expect(table.get(coveredDay)?.get('qwen-max')?.totalTokens).toBe(100);
      const uncoveredDay = dayKey(Date.parse('2026-11-13T12:00:00Z'));
      expect(table.get(uncoveredDay)?.get('qwen-max')?.totalTokens).toBe(100);
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

  it('deducts partial Gemini reasoning and cache-only live usage accurately', async () => {
    const now = Date.parse('2026-06-12T12:00:00.000Z');
    const day = dayKey(now);
    const geminiLedgerFile = getTokenUsageFilePath(day.slice(0, 7));
    fs.mkdirSync(path.dirname(geminiLedgerFile), { recursive: true });
    fs.writeFileSync(
      geminiLedgerFile,
      [
        {
          schemaVersion: 1,
          id: 'row-gem-1',
          timestamp: new Date(now - 2_000).toISOString(),
          localDate: day,
          localMonth: day.slice(0, 7),
          sessionId: 'gem-live',
          model: 'gemini-2.5-pro',
          authType: 'gemini-api-key',
          source: 'main',
          executionId: 'gem-req-1',
          inputTokens: 100,
          outputTokens: 50,
          cachedTokens: 0,
          thoughtsTokens: 30,
          totalTokens: 180,
          apiDurationMs: 100,
        },
        {
          schemaVersion: 1,
          id: 'row-cache-1',
          timestamp: new Date(now - 2_000).toISOString(),
          localDate: day,
          localMonth: day.slice(0, 7),
          sessionId: 'cache-live',
          model: 'gemini-2.5-pro',
          authType: 'gemini-api-key',
          source: 'main',
          executionId: 'cache-req-1',
          inputTokens: 500,
          outputTokens: 50,
          cachedTokens: 500,
          thoughtsTokens: 0,
          totalTokens: 550,
          apiDurationMs: 100,
        },
      ]
        .map((row) => JSON.stringify(row))
        .join('\n') + '\n',
    );
    const ledger = await loadLedgerOrEmpty(day);

    // Case A: Gemini request 1 persisted (out=50, thoughts=30) + request 2 unpersisted (out=20).
    const gemLowOut: UsageSummaryRecord = {
      ...rec({
        sessionId: 'gem-live',
        timestamp: now,
        startTime: now - 5_000,
        modelName: 'gemini-2.5-pro',
        model: {
          requests: 2,
          inputTokens: 200,
          outputTokens: 70,
          cachedTokens: 0,
          thoughtsTokens: 30,
          totalTokens: 300,
          totalLatencyMs: 200,
        },
      }),
      runScoped: true,
      requestExecutionIds: ['gem-req-1', 'gem-req-2'],
      successfulRequestExecutionIds: ['gem-req-1', 'gem-req-2'],
    };
    const lowTable = buildUsageDayTable(
      [gemLowOut],
      ledger,
      undefined,
      undefined,
      gemLowOut,
    );
    expect(lowTable.get(day)?.get('gemini-2.5-pro')).toMatchObject({
      requests: 3, // gem-req-1 + gem-req-2 + cache-req-1 from shared ledger
      totalTokens: 850,
      outputTokens: 150, // ledger normalized (50+30)+50 + remaining 20
      thoughtsTokens: 30,
    });

    // Case B: Gemini request 2 has higher output=40 so thoughts must not be subtracted from output.
    const gemHighOut: UsageSummaryRecord = {
      ...gemLowOut,
      models: {
        'gemini-2.5-pro': {
          requests: 2,
          inputTokens: 200,
          outputTokens: 90,
          cachedTokens: 0,
          thoughtsTokens: 30,
          totalTokens: 320,
          totalLatencyMs: 200,
        },
      },
    };
    const highTable = buildUsageDayTable(
      [gemHighOut],
      ledger,
      undefined,
      undefined,
      gemHighOut,
    );
    expect(highTable.get(day)?.get('gemini-2.5-pro')).toMatchObject({
      requests: 3,
      totalTokens: 870,
      outputTokens: 170, // ledger normalized (50+30)+50 + remaining 40
      thoughtsTokens: 30,
    });

    // Case C: Cache-only request 1 persisted (ledger input=500, live prompt=0) + request 2 unpersisted.
    const cacheLive: UsageSummaryRecord = {
      ...rec({
        sessionId: 'cache-live',
        timestamp: now,
        startTime: now - 5_000,
        modelName: 'gemini-2.5-pro',
        model: {
          requests: 2,
          inputTokens: 0,
          outputTokens: 60,
          cachedTokens: 600,
          thoughtsTokens: 0,
          totalTokens: 660,
          totalLatencyMs: 200,
        },
      }),
      runScoped: true,
      requestExecutionIds: ['cache-req-1', 'cache-req-2'],
      successfulRequestExecutionIds: ['cache-req-1', 'cache-req-2'],
    };
    const cacheTable = buildUsageDayTable(
      [cacheLive],
      ledger,
      undefined,
      undefined,
      cacheLive,
    );
    expect(cacheTable.get(day)?.get('gemini-2.5-pro')).toMatchObject({
      requests: 3, // cache-req-1 + cache-req-2 + gem-req-1
      totalTokens: 840,
    });
  });

  it('preserves unpersisted totals for omitted-total, mixed cache-only, and OpenAI reasoning live records', async () => {
    const now = Date.parse('2026-06-16T12:00:00.000Z');
    const day = dayKey(now);
    const ledgerFile = getTokenUsageFilePath(day.slice(0, 7));
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    const row = (
      id: string,
      sessionId: string,
      model: string,
      authType: string,
      executionId: string,
      inputTokens: number,
      outputTokens: number,
      cachedTokens: number,
      thoughtsTokens: number,
      totalTokens: number,
    ) =>
      JSON.stringify({
        schemaVersion: 1,
        id,
        timestamp: new Date(now).toISOString(),
        localDate: day,
        localMonth: day.slice(0, 7),
        sessionId,
        model,
        authType,
        source: 'main',
        executionId,
        inputTokens,
        outputTokens,
        cachedTokens,
        thoughtsTokens,
        totalTokens,
        apiDurationMs: 10,
      });
    fs.writeFileSync(
      ledgerFile,
      [
        row(
          'r-omit',
          's-omit',
          'm-omit',
          'openai',
          'omit-1',
          100,
          20,
          0,
          0,
          120,
        ),
        row('r-old', 's-old-l', 'm-old', 'openai', 'old-1', 150, 50, 0, 0, 200),
        row('r-co', 's-co', 'm-co', 'openai', 'co-1', 100, 20, 100, 0, 120),
        row(
          'r-mix-hi',
          's-mix-hi',
          'm-mix-hi',
          'openai',
          'mh-1',
          100,
          20,
          0,
          0,
          120,
        ),
        row(
          'r-mix-lo',
          's-mix-lo',
          'm-mix-lo',
          'openai',
          'ml-1',
          100,
          20,
          0,
          0,
          120,
        ),
        row('r-oai', 's-oai', 'm-oai', 'openai', 'oai-1', 100, 50, 0, 30, 150),
      ].join('\n') + '\n',
    );
    const ledger = await loadLedgerOrEmpty(day);

    // 1. omittedAllTotals (metrics.totalTokens=0) + unpersisted 250 tokens -> 120 + 250 = 370
    const omitLive: UsageSummaryRecord = {
      ...rec({
        sessionId: 's-omit',
        timestamp: now,
        startTime: now - 1_000,
        modelName: 'm-omit',
        model: {
          requests: 2,
          inputTokens: 300,
          outputTokens: 70,
          cachedTokens: 0,
          thoughtsTokens: 0,
          totalTokens: 0,
          totalLatencyMs: 20,
        },
      }),
      runScoped: true,
      requestExecutionIds: ['omit-1', 'omit-2'],
      successfulRequestExecutionIds: ['omit-1', 'omit-2'],
    };
    expect(
      buildUsageDayTable([omitLive], ledger, undefined, undefined, omitLive)
        .get(day)
        ?.get('m-omit')?.totalTokens,
    ).toBe(370);

    // 2. Uncovered old record with totalTokens=0 (600) + same-day ledger (200) -> 800
    const oldZero: UsageSummaryRecord = rec({
      sessionId: 's-old-u',
      timestamp: now,
      startTime: now - 1_000,
      modelName: 'm-old',
      model: {
        requests: 1,
        inputTokens: 500,
        outputTokens: 100,
        cachedTokens: 0,
        thoughtsTokens: 0,
        totalTokens: 0,
      },
    });
    const corruptNoModels = {
      ...rec({ sessionId: 'corrupt-no-models', timestamp: now }),
      models: undefined,
    } as unknown as UsageSummaryRecord;
    expect(
      buildUsageDayTable([oldZero, corruptNoModels], ledger)
        .get(day)
        ?.get('m-old')?.totalTokens,
    ).toBe(800);

    // 3. Mixed persisted cache-only (0/100) + unpersisted regular (500/0) -> input=600, total=670
    const coLive: UsageSummaryRecord = {
      ...rec({
        sessionId: 's-co',
        timestamp: now,
        startTime: now - 1_000,
        modelName: 'm-co',
        model: {
          requests: 2,
          inputTokens: 500,
          outputTokens: 70,
          cachedTokens: 100,
          thoughtsTokens: 0,
          totalTokens: 670,
          totalLatencyMs: 20,
        },
      }),
      runScoped: true,
      requestExecutionIds: ['co-1', 'co-2'],
      successfulRequestExecutionIds: ['co-1', 'co-2'],
    };
    expect(
      buildUsageDayTable([coLive], ledger, undefined, undefined, coLive)
        .get(day)
        ?.get('m-co'),
    ).toMatchObject({ requests: 2, inputTokens: 600, totalTokens: 670 });

    // 4. Persisted omitted total (120) + unpersisted positive total (180 or 60) -> 300 / 180
    const mixHi: UsageSummaryRecord = {
      ...rec({
        sessionId: 's-mix-hi',
        timestamp: now,
        startTime: now - 1_000,
        modelName: 'm-mix-hi',
        model: {
          requests: 2,
          inputTokens: 250,
          outputTokens: 50,
          cachedTokens: 0,
          thoughtsTokens: 0,
          totalTokens: 180,
          totalLatencyMs: 20,
        },
      }),
      runScoped: true,
      requestExecutionIds: ['mh-1', 'mh-2'],
      successfulRequestExecutionIds: ['mh-1', 'mh-2'],
    };
    expect(
      buildUsageDayTable([mixHi], ledger, undefined, undefined, mixHi)
        .get(day)
        ?.get('m-mix-hi'),
    ).toMatchObject({ requests: 2, totalTokens: 300 });

    const mixLo: UsageSummaryRecord = {
      ...rec({
        sessionId: 's-mix-lo',
        timestamp: now,
        startTime: now - 1_000,
        modelName: 'm-mix-lo',
        model: {
          requests: 2,
          inputTokens: 150,
          outputTokens: 30,
          cachedTokens: 0,
          thoughtsTokens: 0,
          totalTokens: 60,
          totalLatencyMs: 20,
        },
      }),
      runScoped: true,
      requestExecutionIds: ['ml-1', 'ml-2'],
      successfulRequestExecutionIds: ['ml-1', 'ml-2'],
    };
    expect(
      buildUsageDayTable([mixLo], ledger, undefined, undefined, mixLo)
        .get(day)
        ?.get('m-mix-lo'),
    ).toMatchObject({ requests: 2, totalTokens: 180 });

    // 5. OpenAI omitted totals with thoughts (100/50/30 persisted + 200/40/10 unpersisted) -> 390
    const oaiLive: UsageSummaryRecord = {
      ...rec({
        sessionId: 's-oai',
        timestamp: now,
        startTime: now - 1_000,
        modelName: 'm-oai',
        model: {
          requests: 2,
          inputTokens: 300,
          outputTokens: 90,
          cachedTokens: 0,
          thoughtsTokens: 40,
          totalTokens: 430,
          totalLatencyMs: 20,
        },
      }),
      runScoped: true,
      requestExecutionIds: ['oai-1', 'oai-2'],
      successfulRequestExecutionIds: ['oai-1', 'oai-2'],
    };
    expect(
      buildUsageDayTable([oaiLive], ledger, undefined, undefined, oaiLive)
        .get(day)
        ?.get('m-oai'),
    ).toMatchObject({ requests: 2, totalTokens: 390 });

    // 6. Persisted cache-only (0/100/50/150) + unpersisted OpenAI reasoning (200/150/100/350)
    const oaiCacheFile = getTokenUsageFilePath(day.slice(0, 7));
    fs.appendFileSync(
      oaiCacheFile,
      [
        row('r-oco', 's-oco', 'm-oco', 'openai', 'oco-1', 100, 50, 100, 0, 150),
        row('r-uo', 's-uo', 'm-uo', 'openai', 'uo-1', 100, 50, 0, 0, 150),
        row(
          'r-ut',
          's-ut',
          'm-ut',
          'gemini-api-key',
          'ut-1',
          100,
          50,
          0,
          0,
          150,
        ),
      ].join('\n') + '\n',
    );
    const ledger2 = await loadLedgerOrEmpty(day);
    const ocoLive: UsageSummaryRecord = {
      ...rec({
        sessionId: 's-oco',
        timestamp: now,
        startTime: now - 1_000,
        modelName: 'm-oco',
        model: {
          requests: 2,
          inputTokens: 200,
          outputTokens: 200,
          cachedTokens: 100,
          thoughtsTokens: 100,
          totalTokens: 500,
          totalLatencyMs: 20,
        },
      }),
      runScoped: true,
      requestExecutionIds: ['oco-1', 'oco-2'],
      successfulRequestExecutionIds: ['oco-1', 'oco-2'],
    };
    expect(
      buildUsageDayTable([ocoLive], ledger2, undefined, undefined, ocoLive)
        .get(day)
        ?.get('m-oco'),
    ).toMatchObject({
      requests: 2,
      inputTokens: 300,
      outputTokens: 200,
      thoughtsTokens: 100,
      totalTokens: 500,
    });

    // 7. Unpersisted omitted total (0) -> 150 + 280 = 430; unpersisted extra total -> 150 + 330 = 480
    const uoLive: UsageSummaryRecord = {
      ...rec({
        sessionId: 's-uo',
        timestamp: now,
        startTime: now - 1_000,
        modelName: 'm-uo',
        model: {
          requests: 2,
          inputTokens: 300,
          outputTokens: 130,
          cachedTokens: 0,
          thoughtsTokens: 0,
          totalTokens: 150,
          totalLatencyMs: 20,
        },
      }),
      runScoped: true,
      requestExecutionIds: ['uo-1', 'uo-2'],
      successfulRequestExecutionIds: ['uo-1', 'uo-2'],
    };
    expect(
      buildUsageDayTable([uoLive], ledger2, undefined, undefined, uoLive)
        .get(day)
        ?.get('m-uo'),
    ).toMatchObject({ requests: 2, inputTokens: 300, totalTokens: 430 });

    const utLive: UsageSummaryRecord = {
      ...rec({
        sessionId: 's-ut',
        timestamp: now,
        startTime: now - 1_000,
        modelName: 'm-ut',
        model: {
          requests: 2,
          inputTokens: 300,
          outputTokens: 130,
          cachedTokens: 0,
          thoughtsTokens: 0,
          totalTokens: 480,
          totalLatencyMs: 20,
        },
      }),
      runScoped: true,
      requestExecutionIds: ['ut-1', 'ut-2'],
      successfulRequestExecutionIds: ['ut-1', 'ut-2'],
    };
    expect(
      buildUsageDayTable([utLive], ledger2, undefined, undefined, utLive)
        .get(day)
        ?.get('m-ut'),
    ).toMatchObject({ requests: 2, totalTokens: 480 });

    // 8. Cross-day multi-model live session must not emit a 0-token ghost model on today.
    const prevDay = dayKey(now - MS_PER_DAY);
    const prevLedgerFile = getTokenUsageFilePath(prevDay.slice(0, 7));
    fs.appendFileSync(
      prevLedgerFile,
      `${JSON.stringify({
        schemaVersion: 1,
        id: 'r-ghost-a',
        timestamp: new Date(now - MS_PER_DAY).toISOString(),
        localDate: prevDay,
        localMonth: prevDay.slice(0, 7),
        sessionId: 's-ghost',
        model: 'model-yesterday',
        authType: 'openai',
        source: 'main',
        executionId: 'ghost-a1',
        inputTokens: 100,
        outputTokens: 50,
        cachedTokens: 0,
        thoughtsTokens: 0,
        totalTokens: 150,
        apiDurationMs: 10,
      })}\n`,
    );
    const ledger3 = await loadLedgerOrEmpty(prevDay);
    const ghostLive: UsageSummaryRecord = {
      ...rec({
        sessionId: 's-ghost',
        timestamp: now,
        startTime: now - MS_PER_DAY,
      }),
      runScoped: true,
      requestExecutionIds: ['ghost-a1', 'ghost-b1'],
      successfulRequestExecutionIds: ['ghost-a1', 'ghost-b1'],
      models: {
        'model-yesterday': {
          requests: 1,
          inputTokens: 100,
          outputTokens: 50,
          cachedTokens: 0,
          thoughtsTokens: 0,
          totalTokens: 150,
          totalLatencyMs: 10,
        },
        'model-today': {
          requests: 1,
          inputTokens: 80,
          outputTokens: 20,
          cachedTokens: 0,
          thoughtsTokens: 0,
          totalTokens: 100,
          totalLatencyMs: 10,
        },
      },
    };
    const ghostTable = buildUsageDayTable(
      [ghostLive],
      ledger3,
      undefined,
      undefined,
      ghostLive,
    );
    expect(ghostTable.get(day)?.has('model-yesterday')).toBe(false);
    expect(ghostTable.get(day)?.get('model-today')?.totalTokens).toBe(100);
    expect(recordTouchesLedgerDays(corruptNoModels, ledger3)).toBe(false);

    // 9. Persisted cache-only with omitted total (1A), persisted omitted total +
    // unpersisted cache-only (1B), and multiple persisted cache-only + regular (3).
    fs.appendFileSync(
      oaiCacheFile,
      [
        row('r-1a', 's-1a', 'm-1a', 'openai', 'e-1a', 100, 50, 100, 0, 150),
        row('r-1b', 's-1b', 'm-1b', 'openai', 'e-1b', 100, 50, 0, 0, 150),
        row('r-3a', 's-3', 'm-3', 'openai', 'e-3a', 100, 50, 100, 0, 150),
        row('r-3b', 's-3', 'm-3', 'openai', 'e-3b', 100, 30, 100, 0, 130),
      ].join('\n') + '\n',
    );
    const ledger4 = await loadLedgerOrEmpty(day);
    const live1a: UsageSummaryRecord = {
      ...rec({
        sessionId: 's-1a',
        timestamp: now,
        startTime: now - 1_000,
        modelName: 'm-1a',
        model: {
          requests: 2,
          inputTokens: 120,
          outputTokens: 90,
          cachedTokens: 100,
          thoughtsTokens: 0,
          totalTokens: 160,
          totalLatencyMs: 20,
        },
      }),
      runScoped: true,
      requestExecutionIds: ['e-1a', 'e-1a-live'],
      successfulRequestExecutionIds: ['e-1a', 'e-1a-live'],
    };
    expect(
      buildUsageDayTable([live1a], ledger4, undefined, undefined, live1a)
        .get(day)
        ?.get('m-1a'),
    ).toMatchObject({ requests: 2, inputTokens: 220, totalTokens: 310 });

    const live1b: UsageSummaryRecord = {
      ...rec({
        sessionId: 's-1b',
        timestamp: now,
        startTime: now - 1_000,
        modelName: 'm-1b',
        model: {
          requests: 2,
          inputTokens: 100,
          outputTokens: 90,
          cachedTokens: 120,
          thoughtsTokens: 0,
          totalTokens: 160,
          totalLatencyMs: 20,
        },
      }),
      runScoped: true,
      requestExecutionIds: ['e-1b', 'e-1b-live'],
      successfulRequestExecutionIds: ['e-1b', 'e-1b-live'],
    };
    expect(
      buildUsageDayTable([live1b], ledger4, undefined, undefined, live1b)
        .get(day)
        ?.get('m-1b'),
    ).toMatchObject({ requests: 2, totalTokens: 310 });

    const live3: UsageSummaryRecord = {
      ...rec({
        sessionId: 's-3',
        timestamp: now,
        startTime: now - 1_000,
        modelName: 'm-3',
        model: {
          requests: 3,
          inputTokens: 150,
          outputTokens: 120,
          cachedTokens: 200,
          thoughtsTokens: 0,
          totalTokens: 470,
          totalLatencyMs: 30,
        },
      }),
      runScoped: true,
      requestExecutionIds: ['e-3a', 'e-3b', 'e-3-live'],
      successfulRequestExecutionIds: ['e-3a', 'e-3b', 'e-3-live'],
    };
    expect(
      buildUsageDayTable([live3], ledger4, undefined, undefined, live3)
        .get(day)
        ?.get('m-3'),
    ).toMatchObject({ requests: 3, inputTokens: 350, totalTokens: 470 });

    // 10. Fifth-round adversarial regressions:
    // (a) persisted cache-only + unpersisted regular + unpersisted cache-only
    // (b) persisted OpenAI reasoning + unpersisted cache-only where total === componentFallbackTotal
    // (c) multi-model live session where one model is 100% persisted (cache-only + 100% cache hit)
    // (d) single-model mixed persisted cache-only + persisted 100% cache hit + unpersisted regular
    fs.appendFileSync(
      oaiCacheFile,
      [
        row('r-5a', 's-5a', 'm-5a', 'openai', 'e-5a1', 500, 20, 500, 0, 520),
        row('r-5b', 's-5b', 'm-5b', 'openai', 'e-5b1', 100, 80, 0, 50, 180),
        row(
          'r-5c1',
          's-5c',
          'm-5c-done',
          'openai',
          'e-5c1',
          200,
          20,
          200,
          0,
          220,
        ),
        row(
          'r-5c2',
          's-5c',
          'm-5c-done',
          'openai',
          'e-5c2',
          100,
          0,
          100,
          0,
          100,
        ),
        row('r-5d1', 's-5d', 'm-5d', 'openai', 'e-5d1', 100, 10, 100, 0, 110),
        row('r-5d2', 's-5d', 'm-5d', 'openai', 'e-5d2', 200, 0, 200, 0, 200),
      ].join('\n') + '\n',
    );
    const ledger5 = await loadLedgerOrEmpty(day);

    const live5a: UsageSummaryRecord = {
      ...rec({
        sessionId: 's-5a',
        timestamp: now,
        startTime: now - 1_000,
        modelName: 'm-5a',
        model: {
          requests: 3,
          inputTokens: 600,
          outputTokens: 80,
          cachedTokens: 800,
          thoughtsTokens: 0,
          totalTokens: 1480,
          totalLatencyMs: 30,
        },
      }),
      runScoped: true,
      requestExecutionIds: ['e-5a1', 'e-5a2', 'e-5a3'],
      successfulRequestExecutionIds: ['e-5a1', 'e-5a2', 'e-5a3'],
    };
    expect(
      buildUsageDayTable([live5a], ledger5, undefined, undefined, live5a)
        .get(day)
        ?.get('m-5a'),
    ).toMatchObject({
      requests: 3,
      inputTokens: 1100,
      cachedTokens: 800,
      totalTokens: 1480,
    });

    const live5b: UsageSummaryRecord = {
      ...rec({
        sessionId: 's-5b',
        timestamp: now,
        startTime: now - 1_000,
        modelName: 'm-5b',
        model: {
          requests: 2,
          inputTokens: 100,
          outputTokens: 140,
          cachedTokens: 50,
          thoughtsTokens: 50,
          totalTokens: 290,
          totalLatencyMs: 20,
        },
      }),
      runScoped: true,
      requestExecutionIds: ['e-5b1', 'e-5b2'],
      successfulRequestExecutionIds: ['e-5b1', 'e-5b2'],
    };
    expect(
      buildUsageDayTable([live5b], ledger5, undefined, undefined, live5b)
        .get(day)
        ?.get('m-5b'),
    ).toMatchObject({ requests: 2, totalTokens: 290 });

    const live5c: UsageSummaryRecord = {
      ...rec({
        sessionId: 's-5c',
        timestamp: now,
        startTime: now - 1_000,
      }),
      runScoped: true,
      requestExecutionIds: ['e-5c1', 'e-5c2', 'e-5c3'],
      successfulRequestExecutionIds: ['e-5c1', 'e-5c2', 'e-5c3'],
      models: {
        'm-5c-done': {
          requests: 2,
          inputTokens: 100,
          outputTokens: 20,
          cachedTokens: 300,
          thoughtsTokens: 0,
          totalTokens: 320,
          totalLatencyMs: 20,
        },
        'm-5c-live': {
          requests: 1,
          inputTokens: 50,
          outputTokens: 10,
          cachedTokens: 0,
          thoughtsTokens: 0,
          totalTokens: 60,
          totalLatencyMs: 10,
        },
      },
    };
    const table5c = buildUsageDayTable(
      [live5c],
      ledger5,
      undefined,
      undefined,
      live5c,
    );
    expect(table5c.get(day)?.get('m-5c-done')).toMatchObject({
      requests: 2,
      inputTokens: 300,
      totalTokens: 320,
    });
    expect(table5c.get(day)?.get('m-5c-live')).toMatchObject({
      requests: 1,
      totalTokens: 60,
    });

    const live5d: UsageSummaryRecord = {
      ...rec({
        sessionId: 's-5d',
        timestamp: now,
        startTime: now - 1_000,
        modelName: 'm-5d',
        model: {
          requests: 3,
          inputTokens: 250,
          outputTokens: 40,
          cachedTokens: 300,
          thoughtsTokens: 0,
          totalTokens: 390,
          totalLatencyMs: 30,
        },
      }),
      runScoped: true,
      requestExecutionIds: ['e-5d1', 'e-5d2', 'e-5d3'],
      successfulRequestExecutionIds: ['e-5d1', 'e-5d2', 'e-5d3'],
    };
    expect(
      buildUsageDayTable([live5d], ledger5, undefined, undefined, live5d)
        .get(day)
        ?.get('m-5d'),
    ).toMatchObject({ requests: 3, inputTokens: 350, totalTokens: 390 });

    // 11. Sixth-round adversarial regressions:
    // (1A) OpenAI persisted + unpersisted with toolUsePromptTokens (in former dead zone)
    // (1B) OpenAI persisted + Gemini unpersisted where total === componentFallbackTotal
    // (2A) all omitted total + persisted cache-only
    // (2B) all omitted total + OpenAI thoughts + unpersisted cached
    // (3) persisted cache-only + single unpersisted 100% cache hit + extra total
    // (4) NaN metrics / errors ceiling guard
    // (5) mixed 100% cache hit + cache-only + unpersisted extra total
    fs.appendFileSync(
      oaiCacheFile,
      [
        row('r-6a', 's-6a', 'm-6a', 'openai', 'e-6a1', 100, 50, 0, 0, 150),
        row('r-6b', 's-6b', 'm-6b', 'openai', 'e-6b1', 100, 50, 0, 0, 150),
        row('r-6c', 's-6c', 'm-6c', 'openai', 'e-6c1', 100, 20, 100, 0, 120),
        row('r-6d', 's-6d', 'm-6d', 'openai', 'e-6d1', 100, 80, 0, 30, 180),
        row('r-6e', 's-6e', 'm-6e', 'openai', 'e-6e1', 100, 20, 100, 0, 120),
        row('r-6f1', 's-6f', 'm-6f', 'openai', 'e-6f1', 100, 20, 100, 0, 120),
        row('r-6f2', 's-6f', 'm-6f', 'openai', 'e-6f2', 200, 20, 200, 0, 220),
      ].join('\n') + '\n',
    );
    const ledger6 = await loadLedgerOrEmpty(day);

    const live6a: UsageSummaryRecord = {
      ...rec({
        sessionId: 's-6a',
        timestamp: now,
        startTime: now - 1_000,
        modelName: 'm-6a',
        model: {
          requests: 2,
          inputTokens: 200,
          outputTokens: 100,
          cachedTokens: 0,
          thoughtsTokens: 40,
          totalTokens: 320,
          totalLatencyMs: 20,
        },
      }),
      runScoped: true,
      requestExecutionIds: ['e-6a1', 'e-6a2'],
      successfulRequestExecutionIds: ['e-6a1', 'e-6a2'],
    };
    expect(
      buildUsageDayTable([live6a], ledger6, undefined, undefined, live6a)
        .get(day)
        ?.get('m-6a'),
    ).toMatchObject({ requests: 2, totalTokens: 320 });

    const live6b: UsageSummaryRecord = {
      ...rec({
        sessionId: 's-6b',
        timestamp: now,
        startTime: now - 1_000,
        modelName: 'm-6b',
        model: {
          requests: 2,
          inputTokens: 200,
          outputTokens: 100,
          cachedTokens: 0,
          thoughtsTokens: 40,
          totalTokens: 340,
          totalLatencyMs: 20,
        },
      }),
      runScoped: true,
      requestExecutionIds: ['e-6b1', 'e-6b2'],
      successfulRequestExecutionIds: ['e-6b1', 'e-6b2'],
    };
    expect(
      buildUsageDayTable([live6b], ledger6, undefined, undefined, live6b)
        .get(day)
        ?.get('m-6b'),
    ).toMatchObject({ requests: 2, totalTokens: 340 });

    const live6c: UsageSummaryRecord = {
      ...rec({
        sessionId: 's-6c',
        timestamp: now,
        startTime: now - 1_000,
        modelName: 'm-6c',
        model: {
          requests: 2,
          inputTokens: 50,
          outputTokens: 30,
          cachedTokens: 100,
          thoughtsTokens: 0,
          totalTokens: 80,
          totalLatencyMs: 20,
        },
      }),
      runScoped: true,
      requestExecutionIds: ['e-6c1', 'e-6c2'],
      successfulRequestExecutionIds: ['e-6c1', 'e-6c2'],
    };
    expect(
      buildUsageDayTable([live6c], ledger6, undefined, undefined, live6c)
        .get(day)
        ?.get('m-6c'),
    ).toMatchObject({ requests: 2, inputTokens: 150, totalTokens: 180 });

    const live6d: UsageSummaryRecord = {
      ...rec({
        sessionId: 's-6d',
        timestamp: now,
        startTime: now - 1_000,
        modelName: 'm-6d',
        model: {
          requests: 2,
          inputTokens: 150,
          outputTokens: 120,
          cachedTokens: 50,
          thoughtsTokens: 40,
          totalTokens: 310,
          totalLatencyMs: 20,
        },
      }),
      runScoped: true,
      requestExecutionIds: ['e-6d1', 'e-6d2'],
      successfulRequestExecutionIds: ['e-6d1', 'e-6d2'],
    };
    expect(
      buildUsageDayTable([live6d], ledger6, undefined, undefined, live6d)
        .get(day)
        ?.get('m-6d'),
    ).toMatchObject({ requests: 2, totalTokens: 270 });

    const live6e: UsageSummaryRecord = {
      ...rec({
        sessionId: 's-6e',
        timestamp: now,
        startTime: now - 1_000,
        modelName: 'm-6e',
        model: {
          requests: 2,
          inputTokens: 200,
          outputTokens: 40,
          cachedTokens: 300,
          thoughtsTokens: 0,
          totalTokens: 390,
          totalLatencyMs: 20,
        },
      }),
      runScoped: true,
      requestExecutionIds: ['e-6e1', 'e-6e2'],
      successfulRequestExecutionIds: ['e-6e1', 'e-6e2'],
    };
    expect(
      buildUsageDayTable([live6e], ledger6, undefined, undefined, live6e)
        .get(day)
        ?.get('m-6e'),
    ).toMatchObject({
      requests: 2,
      inputTokens: 300,
      cachedTokens: 300,
      totalTokens: 390,
    });

    const live6f: UsageSummaryRecord = {
      ...rec({
        sessionId: 's-6f',
        timestamp: now,
        startTime: now - 1_000,
        modelName: 'm-6f',
        model: {
          requests: 3,
          inputTokens: 150,
          outputTokens: 50,
          cachedTokens: 300,
          thoughtsTokens: 0,
          totalTokens: 450,
          totalLatencyMs: 30,
        },
      }),
      runScoped: true,
      requestExecutionIds: ['e-6f1', 'e-6f2', 'e-6f3'],
      successfulRequestExecutionIds: ['e-6f1', 'e-6f2', 'e-6f3'],
    };
    expect(
      buildUsageDayTable([live6f], ledger6, undefined, undefined, live6f)
        .get(day)
        ?.get('m-6f'),
    ).toMatchObject({ requests: 3, inputTokens: 350, totalTokens: 450 });

    // NaN live metric must never bypass deduction guards and emit NaN into remaining.
    const nanLive: UsageSummaryRecord = {
      ...live6a,
      models: {
        'm-6a': {
          ...live6a.models['m-6a']!,
          thoughtsTokens: NaN,
        },
      },
    };
    const nanTable = buildUsageDayTable(
      [nanLive],
      ledger6,
      undefined,
      undefined,
      nanLive,
    );
    // Conservative fallback retains the raw record without deducting partially.
    expect(nanTable.get(day)?.get('m-6a')?.requests).toBe(3);

    // 12. Seventh-round adversarial regressions:
    // (1A) remSuccesses === 0 with errors > 0 must preserve error count/latency without inventing tokens
    // (1B) remSuccesses === 1 with errors > 0 must still enforce single-response cache invariant
    // (2) cross-day conflicting fingerprints for one executionId must fail closed
    fs.appendFileSync(
      oaiCacheFile,
      [
        row(
          'r-7a1',
          's-7a',
          'm-7a1',
          'gemini-api-key',
          'e-7a1',
          100,
          20,
          100,
          0,
          120,
        ),
        row(
          'r-7a2',
          's-7a',
          'm-7a1',
          'gemini-api-key',
          'e-7a2',
          100,
          20,
          100,
          0,
          120,
        ),
        row(
          'r-7a3',
          's-7a',
          'm-7a1',
          'gemini-api-key',
          'e-7a3',
          20,
          10,
          20,
          0,
          30,
        ),
        row(
          'r-7b1',
          's-7b',
          'm-7b',
          'gemini-api-key',
          'e-7b1',
          80,
          10,
          80,
          0,
          90,
        ),
        row(
          'r-7c-d1',
          's-7c',
          'm-7c',
          'openai',
          'e-7c-conflict',
          100,
          20,
          0,
          0,
          120,
        ),
      ].join('\n') + '\n',
    );
    fs.appendFileSync(
      prevLedgerFile,
      `${JSON.stringify({
        schemaVersion: 1,
        id: 'r-7c-d0',
        timestamp: new Date(now - MS_PER_DAY).toISOString(),
        localDate: prevDay,
        localMonth: prevDay.slice(0, 7),
        sessionId: 's-7c',
        model: 'm-7c',
        authType: 'openai',
        source: 'main',
        executionId: 'e-7c-conflict',
        inputTokens: 999,
        outputTokens: 1,
        cachedTokens: 0,
        thoughtsTokens: 0,
        totalTokens: 1000,
        apiDurationMs: 10,
      })}\n`,
    );
    const ledger7 = await loadLedgerOrEmpty(prevDay);

    const live7a: UsageSummaryRecord = {
      ...rec({ sessionId: 's-7a', timestamp: now, startTime: now - 1_000 }),
      runScoped: true,
      requestExecutionIds: ['e-7a1', 'e-7a2', 'e-7a3', 'e-7a-err', 'e-7a4'],
      successfulRequestExecutionIds: ['e-7a1', 'e-7a2', 'e-7a3', 'e-7a4'],
      models: {
        'm-7a1': {
          requests: 4,
          errors: 1,
          errorLatencyMs: 50,
          inputTokens: 120,
          outputTokens: 50,
          cachedTokens: 220,
          thoughtsTokens: 0,
          totalTokens: 150,
          totalLatencyMs: 80,
        },
        'm-7a2': {
          requests: 1,
          inputTokens: 40,
          outputTokens: 10,
          cachedTokens: 0,
          thoughtsTokens: 0,
          totalTokens: 50,
          totalLatencyMs: 10,
        },
      },
    };
    const table7a = buildUsageDayTable(
      [live7a],
      ledger7,
      undefined,
      undefined,
      live7a,
    );
    expect(table7a.get(day)?.get('m-7a1')).toMatchObject({
      requests: 4,
      inputTokens: 220,
      totalTokens: 270,
      apiDurationMs: 80,
    });

    const live7b: UsageSummaryRecord = {
      ...rec({
        sessionId: 's-7b',
        timestamp: now,
        startTime: now - 1_000,
        modelName: 'm-7b',
        model: {
          requests: 3,
          errors: 1,
          errorLatencyMs: 50,
          inputTokens: 100,
          outputTokens: 30,
          cachedTokens: 130,
          thoughtsTokens: 0,
          totalTokens: 90,
          totalLatencyMs: 70,
        },
      }),
      runScoped: true,
      requestExecutionIds: ['e-7b1', 'e-7b2', 'e-7b-err'],
      successfulRequestExecutionIds: ['e-7b1', 'e-7b2'],
    };
    expect(
      buildUsageDayTable([live7b], ledger7, undefined, undefined, live7b)
        .get(day)
        ?.get('m-7b'),
    ).toMatchObject({
      requests: 3,
      inputTokens: 180,
      cachedTokens: 130,
      totalTokens: 210,
    });

    const live7c: UsageSummaryRecord = {
      ...rec({
        sessionId: 's-7c',
        timestamp: now,
        startTime: now - 1_000,
        modelName: 'm-7c',
        model: {
          requests: 2,
          inputTokens: 200,
          outputTokens: 40,
          cachedTokens: 0,
          thoughtsTokens: 0,
          totalTokens: 240,
          totalLatencyMs: 20,
        },
      }),
      runScoped: true,
      requestExecutionIds: ['e-7c-conflict', 'e-7c-live'],
      successfulRequestExecutionIds: ['e-7c-conflict', 'e-7c-live'],
    };
    // Cross-day conflict fails closed: live7c is kept conservatively without partial deduction.
    expect(
      buildUsageDayTable([live7c], ledger7, undefined, undefined, live7c)
        .get(day)
        ?.get('m-7c')?.requests,
    ).toBe(3);
  });

  it('matches mixed regular, cache-only, omitted-total, and cross-timezone ledger rows', async () => {
    const now = Date.parse('2026-06-15T04:00:00.000Z');
    const recordDay = dayKey(now);
    const ledgerPrevDay = dayKey(now - MS_PER_DAY);
    const ledgerFile = getTokenUsageFilePath(ledgerPrevDay.slice(0, 7));
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    fs.writeFileSync(
      ledgerFile,
      [
        // Mixed regular + cache-only on one model
        {
          schemaVersion: 1,
          id: 'mix-1',
          timestamp: new Date(now).toISOString(),
          localDate: recordDay,
          localMonth: recordDay.slice(0, 7),
          sessionId: 'mix-cache',
          model: 'qwen-max',
          authType: 'openai',
          source: 'main',
          executionId: 'mix-reg',
          inputTokens: 1000,
          outputTokens: 100,
          cachedTokens: 200,
          thoughtsTokens: 0,
          totalTokens: 1100,
          apiDurationMs: 10,
        },
        {
          schemaVersion: 1,
          id: 'mix-2',
          timestamp: new Date(now).toISOString(),
          localDate: recordDay,
          localMonth: recordDay.slice(0, 7),
          sessionId: 'mix-cache',
          model: 'qwen-max',
          authType: 'openai',
          source: 'main',
          executionId: 'mix-co',
          inputTokens: 500,
          outputTokens: 50,
          cachedTokens: 500,
          thoughtsTokens: 0,
          totalTokens: 550,
          apiDurationMs: 10,
        },
        // OpenAI cache-only + reasoning with omitted total_token_count (0)
        {
          schemaVersion: 1,
          id: 'co-reason-1',
          timestamp: new Date(now).toISOString(),
          localDate: recordDay,
          localMonth: recordDay.slice(0, 7),
          sessionId: 'co-reason',
          model: 'qwen-max',
          authType: 'openai',
          source: 'main',
          executionId: 'co-reason-exec',
          inputTokens: 500,
          outputTokens: 100,
          cachedTokens: 500,
          thoughtsTokens: 40,
          totalTokens: 600,
          apiDurationMs: 10,
        },
        // Mixed reported total + omitted total on OpenAI
        {
          schemaVersion: 1,
          id: 'mix-tot-1',
          timestamp: new Date(now).toISOString(),
          localDate: recordDay,
          localMonth: recordDay.slice(0, 7),
          sessionId: 'mix-tot',
          model: 'qwen-max',
          authType: 'openai',
          source: 'main',
          executionId: 'mix-tot-a',
          inputTokens: 100,
          outputTokens: 80,
          cachedTokens: 0,
          thoughtsTokens: 30,
          totalTokens: 180,
          apiDurationMs: 10,
        },
        {
          schemaVersion: 1,
          id: 'mix-tot-2',
          timestamp: new Date(now).toISOString(),
          localDate: recordDay,
          localMonth: recordDay.slice(0, 7),
          sessionId: 'mix-tot',
          model: 'qwen-max',
          authType: 'openai',
          source: 'main',
          executionId: 'mix-tot-b',
          inputTokens: 200,
          outputTokens: 60,
          cachedTokens: 0,
          thoughtsTokens: 20,
          totalTokens: 260,
          apiDurationMs: 10,
        },
        // Cross-timezone: ledger wrote previous localDate while reader sees recordDay
        {
          schemaVersion: 1,
          id: 'tz-1',
          timestamp: new Date(now).toISOString(),
          localDate: ledgerPrevDay,
          localMonth: ledgerPrevDay.slice(0, 7),
          sessionId: 'tz-sess',
          model: 'qwen-max',
          authType: 'openai',
          source: 'main',
          executionId: 'tz-exec',
          inputTokens: 800,
          outputTokens: 200,
          cachedTokens: 0,
          thoughtsTokens: 0,
          totalTokens: 1000,
          apiDurationMs: 10,
        },
      ]
        .map((row) => JSON.stringify(row))
        .join('\n') + '\n',
    );
    const ledger = await loadLedgerOrEmpty(ledgerPrevDay);
    const records: UsageSummaryRecord[] = [
      {
        ...rec({
          sessionId: 'mix-cache',
          timestamp: now,
          startTime: now - 1_000,
          model: {
            requests: 2,
            inputTokens: 1000,
            outputTokens: 150,
            cachedTokens: 700,
            thoughtsTokens: 0,
            totalTokens: 1650,
          },
        }),
        runScoped: true,
        requestExecutionIds: ['mix-reg', 'mix-co'],
        successfulRequestExecutionIds: ['mix-reg', 'mix-co'],
      },
      {
        ...rec({
          sessionId: 'co-reason',
          timestamp: now,
          startTime: now - 1_000,
          model: {
            requests: 1,
            inputTokens: 0,
            outputTokens: 100,
            cachedTokens: 500,
            thoughtsTokens: 40,
            totalTokens: 0,
          },
        }),
        runScoped: true,
        requestExecutionIds: ['co-reason-exec'],
        successfulRequestExecutionIds: ['co-reason-exec'],
      },
      {
        ...rec({
          sessionId: 'mix-tot',
          timestamp: now,
          startTime: now - 1_000,
          model: {
            requests: 2,
            inputTokens: 300,
            outputTokens: 140,
            cachedTokens: 0,
            thoughtsTokens: 50,
            totalTokens: 180,
          },
        }),
        runScoped: true,
        requestExecutionIds: ['mix-tot-a', 'mix-tot-b'],
        successfulRequestExecutionIds: ['mix-tot-a', 'mix-tot-b'],
      },
      {
        ...rec({
          sessionId: 'tz-sess',
          timestamp: now,
          startTime: now,
          model: {
            requests: 1,
            inputTokens: 800,
            outputTokens: 200,
            cachedTokens: 0,
            thoughtsTokens: 0,
            totalTokens: 1000,
          },
        }),
        runScoped: true,
        requestExecutionIds: ['tz-exec'],
        successfulRequestExecutionIds: ['tz-exec'],
      },
    ];
    const dash = buildUsageDashboard(records, { range: 'all' }, ledger);
    expect(dash.summary).toMatchObject({
      requests: 6,
      totalTokens: 3690,
    });
  });

  it('bounds heatmapDays=1 to today only', async () => {
    const now = Date.now();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    seed([
      rec({ sessionId: 'today', timestamp: now, model: { totalTokens: 100 } }),
      rec({
        sessionId: 'yesterday',
        timestamp: yesterday.getTime(),
        model: { totalTokens: 200 },
      }),
    ]);
    const dash = await loadUsageDashboard({ heatmapDays: 1 });
    expect(Object.keys(dash.heatmap)).toEqual([dayKey(now)]);
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
