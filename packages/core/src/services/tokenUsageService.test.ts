/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GenerateContentResponseUsageMetadata } from '@google/genai';
import { AuthType } from '../core/contentGenerator.js';
import { Storage } from '../config/storage.js';
import { makeFakeConfig } from '../test-utils/config.js';
import { ApiResponseEvent } from '../telemetry/types.js';
import { setDebugLogSession } from '../utils/debugLogger.js';
import * as jsonl from '../utils/jsonl-utils.js';
import {
  MAX_LEDGER_EXECUTION_EVIDENCE_RECORDS,
  __overrideNowForTesting,
  apiResponseEventToTokenUsageRecord,
  exportTokenUsageSummary,
  formatTokenUsageSummaryAsCsv,
  formatTokenUsageSummaryAsJson,
  getTokenUsageExecutionIds,
  getTokenUsageExecutionRecords,
  getTokenUsageFilePath,
  getTokenUsageSessionIds,
  getTokenUsageUnidentifiedSessionIds,
  isCompleteLedgerExecutionEvidence,
  loadTokenUsageDailyByModel,
  mergeTokenUsageExecutionIds,
  mergeTokenUsageSessionIds,
  queryTokenUsage,
  recordTokenUsageFromApiResponse,
  recordTokenUsageFromApiResponseBestEffort,
  resetTokenUsageFailureLogging,
  subtractTokenUsageFromDailyByModel,
} from './tokenUsageService.js';
import type {
  TokenUsageCompletedMonthCache,
  TokenUsageDailyByModel,
  TokenUsageRecord,
} from './tokenUsageService.js';
import {
  buildUsageDashboard,
  loadUsageDashboardSources,
  localDateKey,
  setLedgerTranscriptScope,
} from './usage-dashboard-service.js';
import {
  persistSessionUsage,
  type UsageSummaryRecord,
} from './usageHistoryService.js';
import { SessionService } from './sessionService.js';
import {
  UiTelemetryService,
  uiTelemetryService,
  type UiEvent,
} from '../telemetry/uiTelemetry.js';
import { EVENT_API_RESPONSE } from '../telemetry/constants.js';

describe('tokenUsageService', () => {
  let tempDir: string;
  let originalRuntimeDir: string | undefined;
  let originalQwenHome: string | undefined;
  let originalDebugLogFileEnv: string | undefined;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-25T10:00:00.000Z'));
    originalRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
    originalQwenHome = process.env['QWEN_HOME'];
    originalDebugLogFileEnv = process.env['QWEN_DEBUG_LOG_FILE'];
    tempDir = await mkdtemp(path.join(tmpdir(), 'qwen-token-usage-'));
    process.env['QWEN_RUNTIME_DIR'] = tempDir;
    process.env['QWEN_HOME'] = tempDir;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    setDebugLogSession(null);
    resetTokenUsageFailureLogging();
    if (originalRuntimeDir === undefined) {
      delete process.env['QWEN_RUNTIME_DIR'];
    } else {
      process.env['QWEN_RUNTIME_DIR'] = originalRuntimeDir;
    }
    if (originalQwenHome === undefined) {
      delete process.env['QWEN_HOME'];
    } else {
      process.env['QWEN_HOME'] = originalQwenHome;
    }
    if (originalDebugLogFileEnv === undefined) {
      delete process.env['QWEN_DEBUG_LOG_FILE'];
    } else {
      process.env['QWEN_DEBUG_LOG_FILE'] = originalDebugLogFileEnv;
    }
    Storage.setRuntimeBaseDir(null);
    await rm(tempDir, { recursive: true, force: true });
  });

  function createEvent(
    model: string,
    promptId: string,
    usageData: GenerateContentResponseUsageMetadata,
    options: {
      timestamp?: string;
      authType?: string;
      responseId?: string;
      subagentName?: string;
      durationMs?: number;
    } = {},
  ): ApiResponseEvent {
    const event = new ApiResponseEvent(
      options.responseId ?? `${promptId}-response`,
      model,
      options.durationMs ?? 100,
      promptId,
      options.authType ?? AuthType.USE_GEMINI,
      usageData,
      undefined,
      options.subagentName,
    );
    event['event.timestamp'] = options.timestamp ?? '2026-05-25T10:00:00.000Z';
    return event;
  }

  const fakeConfig = () =>
    makeFakeConfig({
      sessionId: 'session-1',
      targetDir: path.join(tempDir, 'project'),
    });

  /** Usage with only prompt, candidates and total token counts. */
  const usage = (
    promptTokenCount: number,
    candidatesTokenCount: number,
    totalTokenCount: number,
  ): GenerateContentResponseUsageMetadata => ({
    promptTokenCount,
    candidatesTokenCount,
    totalTokenCount,
  });

  const recordUsage = (
    config: ReturnType<typeof makeFakeConfig>,
    ...event: Parameters<typeof createEvent>
  ) => recordTokenUsageFromApiResponse(config, createEvent(...event));

  const may25 = { period: 'day', value: '2026-05-25' } as const;

  const silenceStderr = () =>
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

  const buildTranscriptlessRunDashboard = async (
    startTime: Date,
    endTime: Date,
    responses: ApiResponseEvent[],
  ) => {
    const originalQwenHome = process.env['QWEN_HOME'];
    const config = fakeConfig();
    const sessionId = config.getSessionId();
    const telemetry = new UiTelemetryService();
    process.env['QWEN_HOME'] = tempDir;
    try {
      for (const response of responses) {
        await recordTokenUsageFromApiResponse(config, response);
        telemetry.addEvent(
          { ...response, 'event.name': EVENT_API_RESPONSE } as UiEvent,
          sessionId,
        );
      }
      persistSessionUsage({
        sessionId,
        startTime,
        endTime,
        project: path.join(tempDir, 'identified-project'),
        metrics: telemetry.getLiveMetrics(),
      });
      vi.setSystemTime(Math.max(Date.now(), endTime.getTime()));
      const sources = await loadUsageDashboardSources([tempDir]);
      return buildUsageDashboard(
        sources.records,
        { range: 'all' },
        sources.ledgerDaily,
        sources.runtimeScopes,
      );
    } finally {
      if (originalQwenHome === undefined) delete process.env['QWEN_HOME'];
      else process.env['QWEN_HOME'] = originalQwenHome;
    }
  };

  it('maps an API response event to a privacy-preserving usage record', () => {
    const config = fakeConfig();
    const event = createEvent(
      'qwen-model',
      'prompt-1',
      {
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        cachedContentTokenCount: 3,
        thoughtsTokenCount: 5,
        totalTokenCount: 35,
      },
      {
        authType: AuthType.QWEN_OAUTH,
        subagentName: 'agent-a',
      },
    );

    const record = apiResponseEventToTokenUsageRecord(config, event);

    expect(record).toMatchObject({
      schemaVersion: 1,
      timestamp: '2026-05-25T10:00:00.000Z',
      localDate: '2026-05-25',
      localMonth: '2026-05',
      sessionId: 'session-1',
      model: 'qwen-model',
      authType: AuthType.QWEN_OAUTH,
      source: 'agent-a',
      inputTokens: 10,
      outputTokens: 20,
      cachedTokens: 3,
      thoughtsTokens: 5,
      totalTokens: 35,
      apiDurationMs: 100,
    });
    expect(record).not.toHaveProperty('promptId');
    expect(record).not.toHaveProperty('responseId');
    expect(record).not.toHaveProperty('projectRoot');
    expect(record).not.toHaveProperty('response_text');
  });

  it('uses current local date when API timestamps are missing or invalid', () => {
    const config = fakeConfig();
    const invalidEvent = createEvent('model-a', 'prompt-1', usage(1, 2, 3));
    invalidEvent['event.timestamp'] = 'not-a-date';
    const missingEvent = createEvent('model-b', 'prompt-2', usage(1, 2, 3));
    Reflect.deleteProperty(missingEvent, 'event.timestamp');

    const invalidRecord = apiResponseEventToTokenUsageRecord(
      config,
      invalidEvent,
    );
    const missingRecord = apiResponseEventToTokenUsageRecord(
      config,
      missingEvent,
    );

    expect(invalidRecord.localDate).toBe('2026-05-25');
    expect(invalidRecord.localMonth).toBe('2026-05');
    expect(missingRecord.timestamp).toBe('2026-05-25T10:00:00.000Z');
    expect(missingRecord.localDate).toBe('2026-05-25');
    expect(missingRecord.localMonth).toBe('2026-05');
  });

  it('persists API usage to monthly JSONL and aggregates daily totals', async () => {
    const config = fakeConfig();

    await recordUsage(config, 'model-a', 'prompt-1', {
      promptTokenCount: 10,
      candidatesTokenCount: 20,
      cachedContentTokenCount: 5,
      thoughtsTokenCount: 2,
      totalTokenCount: 32,
    });
    await recordUsage(
      config,
      'model-b',
      'prompt-2',
      {
        promptTokenCount: 7,
        candidatesTokenCount: 8,
        cachedContentTokenCount: 1,
        thoughtsTokenCount: 0,
        totalTokenCount: 15,
      },
      {
        authType: AuthType.USE_VERTEX_AI,
        timestamp: '2026-05-25T12:00:00.000Z',
      },
    );
    await recordUsage(config, 'model-a', 'prompt-3', usage(100, 100, 200), {
      timestamp: '2026-05-26T12:00:00.000Z',
    });

    const fileContent = await readFile(
      getTokenUsageFilePath('2026-05'),
      'utf-8',
    );
    expect(fileContent.trim().split('\n')).toHaveLength(3);

    const summary = await queryTokenUsage(may25);

    expect(summary.totals).toMatchObject({
      requests: 2,
      inputTokens: 17,
      outputTokens: 28,
      cachedTokens: 6,
      thoughtsTokens: 2,
      totalTokens: 47,
      apiDurationMs: 200,
    });
    expect(summary.byModel.map((group) => group.key)).toEqual([
      'model-a',
      'model-b',
    ]);
    expect(summary.byAuthType.map((group) => group.key)).toEqual([
      AuthType.USE_GEMINI,
      AuthType.USE_VERTEX_AI,
    ]);
  });

  it('swallows best-effort write errors and surfaces non-ENOENT failures', async () => {
    const config = fakeConfig();
    const event = createEvent('model-a', 'prompt-1', usage(1, 2, 3));
    const error = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    const writeSpy = vi.spyOn(jsonl, 'writeLine').mockRejectedValueOnce(error);
    const stderrSpy = silenceStderr();

    expect(() =>
      recordTokenUsageFromApiResponseBestEffort(config, event),
    ).not.toThrow();

    expect(writeSpy).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(stderrSpy).toHaveBeenCalledWith(
        '[token-usage] Write failed (ENOSPC):',
        'disk full',
      );
    });
  });

  it('swallows synchronous best-effort record conversion errors', () => {
    const config = {
      getSessionId: () => {
        throw Object.assign(new Error('session unavailable'), {
          code: 'EACCES',
        });
      },
    } as unknown as ReturnType<typeof makeFakeConfig>;
    const event = createEvent('model-a', 'prompt-1', usage(1, 2, 3));
    const writeSpy = vi.spyOn(jsonl, 'writeLine');
    const stderrSpy = silenceStderr();

    expect(() =>
      recordTokenUsageFromApiResponseBestEffort(config, event),
    ).not.toThrow();

    expect(writeSpy).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith(
      '[token-usage] Write failed (EACCES):',
      'session unavailable',
    );
  });

  it('suppresses repeated console.error for same error code within 60s cooldown, re-fires after cooldown', async () => {
    const config = fakeConfig();
    const event = createEvent('model-a', 'prompt-1', usage(1, 2, 3));
    const error = Object.assign(new Error('disk full'), { code: 'ENOSPC' });

    let fakeNow = 1000000;
    __overrideNowForTesting(() => fakeNow);

    const stderrSpy = silenceStderr();

    /** Fails the next write with `err`, records best-effort, then runs `check`. */
    async function failNextWrite(err: Error, check: () => Promise<void>) {
      const writeSpy = vi.spyOn(jsonl, 'writeLine').mockRejectedValueOnce(err);
      try {
        recordTokenUsageFromApiResponseBestEffort(config, event);
        await check();
      } finally {
        writeSpy.mockRestore();
      }
    }

    // --- First failure: should log ---
    await failNextWrite(error, async () => {
      await vi.waitFor(() => {
        expect(stderrSpy).toHaveBeenCalledTimes(1);
      });
      expect(stderrSpy).toHaveBeenCalledWith(
        '[token-usage] Write failed (ENOSPC):',
        'disk full',
      );
    });

    // --- Second failure, same code, within cooldown: suppressed ---
    await failNextWrite(error, async () => {
      await vi.runAllTimers();
      // Still only 1 call — the second was suppressed
      expect(stderrSpy).toHaveBeenCalledTimes(1);
    });

    const eaccesError = Object.assign(new Error('permission denied'), {
      code: 'EACCES',
    });
    await failNextWrite(eaccesError, async () => {
      await vi.waitFor(() => {
        expect(stderrSpy).toHaveBeenCalledTimes(2);
      });
      expect(stderrSpy).toHaveBeenCalledWith(
        '[token-usage] Write failed (EACCES):',
        'permission denied',
      );
    });

    // --- Advance time past cooldown: should log again with suppression count ---
    fakeNow += 61_000;
    await failNextWrite(error, async () => {
      await vi.waitFor(() => {
        expect(stderrSpy).toHaveBeenCalledTimes(3);
      });
      expect(stderrSpy).toHaveBeenLastCalledWith(
        '[token-usage] Write failed (ENOSPC):',
        'disk full (1 similar suppressed since last log)',
      );
    });
  });

  it('does not surface best-effort ENOENT write failures to stderr', async () => {
    const config = fakeConfig();
    const event = createEvent('model-a', 'prompt-1', usage(1, 2, 3));
    const error = Object.assign(new Error('missing directory'), {
      code: 'ENOENT',
    });
    const writeSpy = vi.spyOn(jsonl, 'writeLine').mockRejectedValueOnce(error);
    const stderrSpy = silenceStderr();

    recordTokenUsageFromApiResponseBestEffort(config, event);

    expect(writeSpy).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(writeSpy).toHaveBeenCalledTimes(1);
    });
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('aggregates monthly model, auth type, model/auth, and source groups', async () => {
    const config = fakeConfig();

    await recordUsage(config, 'model-a', 'prompt-1', usage(1, 2, 3), {
      authType: AuthType.USE_GEMINI,
      subagentName: 'agent-a',
    });
    await recordUsage(config, 'model-a', 'prompt-2', usage(4, 5, 9), {
      authType: AuthType.USE_VERTEX_AI,
      subagentName: 'agent-a',
    });
    await recordUsage(config, 'model-b', 'prompt-3', usage(6, 7, 13), {
      authType: AuthType.USE_GEMINI,
    });

    const summary = await queryTokenUsage({
      period: 'month',
      value: '2026-05',
    });

    expect(summary.totals.totalTokens).toBe(25);
    expect(summary.byModel).toEqual([
      expect.objectContaining({ key: 'model-b', totalTokens: 13 }),
      expect.objectContaining({ key: 'model-a', totalTokens: 12 }),
    ]);
    expect(summary.byAuthType).toEqual([
      expect.objectContaining({ key: AuthType.USE_GEMINI, totalTokens: 16 }),
      expect.objectContaining({ key: AuthType.USE_VERTEX_AI, totalTokens: 9 }),
    ]);
    expect(summary.byModelAndAuthType).toEqual([
      expect.objectContaining({
        key: `model-b|${AuthType.USE_GEMINI}`,
        model: 'model-b',
        authType: AuthType.USE_GEMINI,
        totalTokens: 13,
      }),
      expect.objectContaining({
        key: `model-a|${AuthType.USE_VERTEX_AI}`,
        totalTokens: 9,
      }),
      expect.objectContaining({
        key: `model-a|${AuthType.USE_GEMINI}`,
        totalTokens: 3,
      }),
    ]);
    expect(summary.bySource).toEqual([
      expect.objectContaining({ key: 'main', totalTokens: 13 }),
      expect.objectContaining({ key: 'agent-a', totalTokens: 12 }),
    ]);
  });

  it('preserves a provider grand total when token components are absent', async () => {
    await recordUsage(fakeConfig(), 'total-only', 'prompt-total-only', {
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      cachedContentTokenCount: 0,
      thoughtsTokenCount: 0,
      totalTokenCount: 1500,
    });

    const summary = await queryTokenUsage(may25);
    const daily = await loadTokenUsageDailyByModel(may25.value);

    expect(summary.totals.totalTokens).toBe(1500);
    expect(daily.get(may25.value)?.get('total-only')?.totalTokens).toBe(1500);
  });

  it('falls back to component totals when API total is missing', async () => {
    const config = fakeConfig();

    await recordUsage(config, 'model-a', 'prompt-1', {
      promptTokenCount: 10,
      candidatesTokenCount: 20,
      cachedContentTokenCount: 5,
      thoughtsTokenCount: 7,
    });

    const summary = await queryTokenUsage(may25);

    expect(summary.totals.totalTokens).toBe(37);
    expect(summary.totals.cachedTokens).toBe(5);
  });

  it.each([
    AuthType.USE_OPENAI,
    AuthType.USE_OPENAI_RESPONSES,
    AuthType.QWEN_OAUTH,
    AuthType.QWEN_SUBSCRIPTION,
  ])('does not add thoughts again for %s when total is missing', (authType) => {
    const event = createEvent(
      'model-a',
      'prompt-1',
      {
        promptTokenCount: 1000,
        candidatesTokenCount: 200,
        thoughtsTokenCount: 50,
        totalTokenCount: 0,
      },
      { authType },
    );

    const record = apiResponseEventToTokenUsageRecord(fakeConfig(), event);

    expect(record.outputTokens).toBe(200);
    expect(record.thoughtsTokens).toBe(50);
    expect(record.totalTokens).toBe(1200);
    expect(record.inputTokens + record.outputTokens).toBe(record.totalTokens);
  });

  it('uses cached tokens as fallback input when prompt tokens are missing', async () => {
    const config = fakeConfig();

    await recordUsage(config, 'model-a', 'prompt-1', {
      promptTokenCount: 0,
      candidatesTokenCount: 20,
      cachedContentTokenCount: 5,
      thoughtsTokenCount: 7,
    });

    const summary = await queryTokenUsage(may25);

    expect(summary.totals.totalTokens).toBe(32);
    expect(summary.totals.inputTokens).toBe(5);
    expect(summary.totals.cachedTokens).toBe(5);
  });

  it('returns empty summaries for missing usage files', async () => {
    const summary = await queryTokenUsage({
      period: 'month',
      value: '2026-04',
    });

    expect(summary.totals).toEqual({
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      thoughtsTokens: 0,
      totalTokens: 0,
      apiDurationMs: 0,
    });
    expect(summary.byModel).toEqual([]);
  });

  it('surfaces token usage read failures instead of returning zero totals', async () => {
    const error = Object.assign(new Error('permission denied'), {
      code: 'EACCES',
    });
    const readSpy = vi.spyOn(jsonl, 'read').mockRejectedValueOnce(error);

    await expect(
      queryTokenUsage({ period: 'month', value: '2026-05' }),
    ).rejects.toThrow('permission denied');
    expect(readSpy).toHaveBeenCalledWith(getTokenUsageFilePath('2026-05'), {
      throwOnNonEnoentError: true,
    });
  });

  it('tolerates malformed JSONL lines while querying', async () => {
    vi.useRealTimers();
    process.env['QWEN_DEBUG_LOG_FILE'] = '1';
    const filePath = getTokenUsageFilePath('2026-05');
    const sessionId = 'token-usage-read-test';
    setDebugLogSession({ getSessionId: () => sessionId });
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      [
        '{"schemaVersion":1,"id":"ok","timestamp":"2026-05-25T00:00:00.000Z","localDate":"2026-05-25","localMonth":"2026-05","sessionId":"s","model":"model-a","authType":"gemini","source":"main","inputTokens":1,"outputTokens":2,"cachedTokens":0,"thoughtsTokens":0,"totalTokens":3,"apiDurationMs":4}',
        '{"schemaVersion":1,"timestamp":"2026-05-25T00:00:00.000Z","localDate":"2026-05-25","localMonth":"2026-05","sessionId":"s","model":"model-a","authType":"gemini","source":"main","inputTokens":100,"outputTokens":100,"cachedTokens":0,"thoughtsTokens":0,"totalTokens":200,"apiDurationMs":4}',
        '{"schemaVersion":1,"id":"missing-session","timestamp":"2026-05-25T00:00:00.000Z","localDate":"2026-05-25","localMonth":"2026-05","model":"model-a","authType":"gemini","source":"main","inputTokens":100,"outputTokens":100,"cachedTokens":0,"thoughtsTokens":0,"totalTokens":200,"apiDurationMs":4}',
        '{"schemaVersion":1,"id":"invalid"}',
        'not-json',
      ].join('\n'),
      'utf-8',
    );

    const summary = await queryTokenUsage(may25);

    expect(summary.totals.totalTokens).toBe(3);
    expect(summary.totals.requests).toBe(1);
    await vi.waitFor(async () => {
      const log = await readFile(Storage.getDebugLogPath(sessionId), 'utf-8');
      expect(log).toContain(`Dropped 3/4 invalid record(s) from ${filePath}`);
    });
  });

  it('reads older compatible schema versions', async () => {
    const filePath = getTokenUsageFilePath('2026-05');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      [
        '{"schemaVersion":1,"id":"ok","timestamp":"2026-05-25T00:00:00.000Z","localDate":"2026-05-25","localMonth":"2026-05","sessionId":"s","model":"model-a","authType":"gemini","source":"main","inputTokens":1,"outputTokens":2,"cachedTokens":0,"thoughtsTokens":0,"totalTokens":3,"apiDurationMs":4}',
        '{"schemaVersion":2,"id":"future","timestamp":"2026-05-25T00:00:00.000Z","localDate":"2026-05-25","localMonth":"2026-05","sessionId":"s","model":"model-a","authType":"gemini","source":"main","inputTokens":100,"outputTokens":100,"cachedTokens":0,"thoughtsTokens":0,"totalTokens":200,"apiDurationMs":4}',
      ].join('\n'),
      'utf-8',
    );

    const summary = await queryTokenUsage(may25);

    expect(summary.totals.totalTokens).toBe(3);
    expect(summary.totals.requests).toBe(1);
  });

  it('exports summaries as JSON and escaped CSV', async () => {
    const config = fakeConfig();
    await recordUsage(config, '=cmd|quoted', 'prompt-1', usage(1, 2, 3), {
      authType: 'auth"quoted',
    });

    const json = await exportTokenUsageSummary({
      period: 'day',
      value: '2026-05-25',
      format: 'json',
    });
    expect(JSON.parse(json)).toMatchObject({
      period: 'day',
      value: '2026-05-25',
      totals: { totalTokens: 3 },
    });
    expect(JSON.parse(json)).not.toHaveProperty('coordination');

    const csv = formatTokenUsageSummaryAsCsv(await queryTokenUsage(may25));
    expect(csv).toContain('day,2026-05-25,total,total,,,,1,1,2,0,0,3,100');
    expect(csv).toContain(
      "day,2026-05-25,model,'=cmd|quoted,'=cmd|quoted,,,1,1,2,0,0,3,100",
    );
    expect(csv).toContain(
      'day,2026-05-25,auth_type,"auth""quoted",,"auth""quoted",,1,1,2,0,0,3,100',
    );
  });

  it('escapes formula-like CSV fields after leading whitespace', () => {
    const group = (key: string) => ({
      key,
      model: key,
      requests: 1,
      inputTokens: 1,
      outputTokens: 2,
      cachedTokens: 0,
      thoughtsTokens: 0,
      totalTokens: 3,
      apiDurationMs: 100,
    });
    const formulaKeys = [
      '=SUM(A1)',
      ' =SUM(A1)',
      '+SUM(A1)',
      ' +SUM(A1)',
      '-SUM(A1)',
      ' -SUM(A1)',
      '@SUM(A1)',
      ' @SUM(A1)',
      '\tSUM(A1)',
    ];
    const csv = formatTokenUsageSummaryAsCsv({
      period: 'day',
      value: '2026-05-25',
      generatedAt: '2026-05-25T10:00:00.000Z',
      totals: {
        requests: 9,
        inputTokens: 9,
        outputTokens: 18,
        cachedTokens: 0,
        thoughtsTokens: 0,
        totalTokens: 27,
        apiDurationMs: 900,
      },
      byModel: formulaKeys.map(group),
      byAuthType: [],
      byModelAndAuthType: [],
      bySource: [],
    });

    // Each formula-like key (even after leading whitespace) gets a ' prefix.
    for (const key of formulaKeys)
      expect(csv).toContain(
        `day,2026-05-25,model,'${key},'${key},,,1,1,2,0,0,3,100`,
      );
  });

  it('persists best-effort records asynchronously without blocking callers', async () => {
    const config = fakeConfig();

    recordTokenUsageFromApiResponseBestEffort(
      config,
      createEvent('model-a', 'prompt-1', usage(1, 2, 3)),
    );

    const fileContent = await vi.waitFor(() =>
      readFile(getTokenUsageFilePath('2026-05'), 'utf-8'),
    );
    expect(fileContent).toContain('"model":"model-a"');
  });

  it.each([AuthType.USE_OPENAI, AuthType.QWEN_SUBSCRIPTION])(
    'reads pre-upgrade chat-completions reasoning only once for %s',
    async (authType) => {
      // The old writer could store 1000 + 200 + 50 as total=1250 for openai.
      const filePath = getTokenUsageFilePath('2026-05');
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(
        filePath,
        JSON.stringify({
          schemaVersion: 1,
          id: 'legacy-reasoning',
          timestamp: '2026-05-25T10:00:00.000Z',
          localDate: '2026-05-25',
          localMonth: '2026-05',
          sessionId: 'legacy-session',
          model: 'qwen-model',
          authType,
          source: 'main',
          inputTokens: 1000,
          outputTokens: 200,
          cachedTokens: 0,
          thoughtsTokens: 50,
          totalTokens: 1250,
          apiDurationMs: 50,
        }) + '\n',
      );

      const ledgerDaily = await loadTokenUsageDailyByModel('2026-05-25');

      expect(ledgerDaily.get('2026-05-25')?.get('qwen-model')).toMatchObject({
        outputTokens: 200,
        totalTokens: 1200,
      });
      const dashboard = buildUsageDashboard(
        [],
        { range: 'today' },
        ledgerDaily,
      );
      expect(dashboard.summary).toMatchObject({
        totalTokens: 1200,
        inputTokens: 1000,
        outputTokens: 200,
        thoughtsTokens: 50,
        requests: 1,
      });
      const summary = await queryTokenUsage({
        period: 'day',
        value: '2026-05-25',
      });
      expect(summary.totals).toMatchObject({
        totalTokens: 1200,
        inputTokens: 1000,
        outputTokens: 200,
        thoughtsTokens: 50,
        requests: 1,
      });
      expect(
        JSON.parse(formatTokenUsageSummaryAsJson(summary)).totals.totalTokens,
      ).toBe(1200);
      expect(formatTokenUsageSummaryAsCsv(summary).split('\n')[1]).toBe(
        'day,2026-05-25,total,total,,,,1,1000,200,0,50,1200,50',
      );
    },
  );

  it('aggregates the ledger per local day and model', async () => {
    const config = fakeConfig();
    await recordUsage(config, 'model-a', 'p1', usage(100, 10, 110));
    await recordUsage(config, 'model-a', 'p2', usage(200, 20, 220));
    await recordUsage(config, 'model-b', 'p3', usage(5, 1, 6));
    await recordUsage(config, 'model-a', 'p4', usage(7, 3, 10), {
      timestamp: '2026-05-24T10:00:00.000Z',
    });

    const table = await loadTokenUsageDailyByModel('2026-05-01');

    expect([...table.keys()].sort()).toEqual(['2026-05-24', '2026-05-25']);
    expect(table.get('2026-05-25')?.get('model-a')).toEqual({
      requests: 2,
      inputTokens: 300,
      outputTokens: 30,
      cachedTokens: 0,
      thoughtsTokens: 0,
      totalTokens: 330,
      // Two responses at the fixture's default 100 ms each.
      apiDurationMs: 200,
    });
    expect(table.get('2026-05-25')?.get('model-b')?.requests).toBe(1);
    expect(table.get('2026-05-24')?.get('model-a')?.totalTokens).toBe(10);
  });

  it('merges session evidence across runtime roots without mutating the source', async () => {
    const day = '2026-05-25';
    const roots = [path.join(tempDir, 'root-a'), path.join(tempDir, 'root-b')];
    for (const root of roots) {
      const sessionId = path.basename(root);
      Storage.runWithResolvedRuntimeBaseDir(root, () => {
        const filePath = getTokenUsageFilePath('2026-05');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(
          filePath,
          JSON.stringify({
            schemaVersion: 1,
            id: `${sessionId}-request`,
            timestamp: `${day}T10:00:00.000Z`,
            localDate: day,
            localMonth: '2026-05',
            sessionId,
            model: 'qwen-max',
            authType: 'openai',
            source: 'main',
            inputTokens: 10,
            outputTokens: 1,
            cachedTokens: 0,
            thoughtsTokens: 0,
            totalTokens: 11,
            apiDurationMs: 1,
          }) + '\n',
        );
      });
    }
    const [first, second] = await Promise.all(
      roots.map((root) =>
        Storage.runWithResolvedRuntimeBaseDir(root, () =>
          loadTokenUsageDailyByModel(day),
        ),
      ),
    );

    mergeTokenUsageSessionIds(first, second);
    expect(getTokenUsageSessionIds(first, day, 'qwen-max')).toEqual(
      new Set(['root-a', 'root-b']),
    );
    expect(getTokenUsageSessionIds(second, day, 'qwen-max')).toEqual(
      new Set(['root-b']),
    );
  });

  it('keeps cached counters coherent with a rescan during a late append', async () => {
    vi.setSystemTime(new Date(2026, 4, 1, 12));
    const timestamp = '2026-04-15T04:00:00.000Z';
    const day = localDateKey(Date.parse(timestamp));
    const first: TokenUsageRecord = {
      schemaVersion: 1,
      id: 'middle-a',
      executionId: 'middle-a',
      timestamp,
      localDate: day,
      localMonth: '2026-04',
      sessionId: 'session-1',
      model: 'model-a',
      authType: 'openai',
      source: 'main',
      inputTokens: 1,
      outputTokens: 0,
      cachedTokens: 0,
      thoughtsTokens: 0,
      totalTokens: 1,
      apiDurationMs: 1,
    };
    const appended: TokenUsageRecord = {
      ...first,
      id: 'middle-b',
      executionId: 'middle-b',
    };
    const later = {
      ...first,
      id: 'latest-c',
      executionId: 'latest-c',
      timestamp: '2026-04-30T04:00:00.000Z',
      localDate: '2026-04-30',
    };
    const file = getTokenUsageFilePath('2026-04');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      [first, later].map((row) => JSON.stringify(row)).join('\n') + '\n',
      'utf8',
    );
    const cache: TokenUsageCompletedMonthCache = new Map();
    await loadTokenUsageDailyByModel('2026-04-01', cache);
    const originalStream = fs.createReadStream;
    let appendedBeforeRead = false;
    const stream = vi.spyOn(fs, 'createReadStream').mockImplementation(((
      filePath: fs.PathLike,
      options?: Parameters<typeof fs.createReadStream>[1],
    ) => {
      if (!appendedBeforeRead) {
        appendedBeforeRead = true;
        fs.appendFileSync(filePath as string, `${JSON.stringify(appended)}\n`);
      }
      return originalStream(filePath, options);
    }) as typeof fs.createReadStream);
    try {
      const table = await loadTokenUsageDailyByModel(day, cache);
      expect(table.get(day)?.get('model-a')).toMatchObject({
        requests: 2,
        totalTokens: 2,
      });
      expect(getTokenUsageExecutionIds(table, day, 'model-a')).toEqual(
        new Set(['middle-a', 'middle-b']),
      );
      expect(cache.get(file)?.get(day)?.get('model-a')?.requests).toBe(1);
      subtractTokenUsageFromDailyByModel(table, appended);
      expect(table.get(day)?.get('model-a')).toMatchObject({
        requests: 1,
        totalTokens: 1,
      });
    } finally {
      stream.mockRestore();
    }
  });

  it('reuses completed-month aggregates across different start days', async () => {
    const config = fakeConfig();
    await recordUsage(config, 'past', 'p1', usage(100, 10, 110), {
      timestamp: '2026-04-20T10:00:00.000Z',
    });
    await recordUsage(config, 'past', 'p2', usage(40, 8, 48), {
      timestamp: '2026-04-10T10:00:00.000Z',
    });
    const readStream = vi.spyOn(fs, 'createReadStream');
    const completedMonths = new Map();
    const sum = (
      daily: Awaited<ReturnType<typeof loadTokenUsageDailyByModel>>,
    ) => {
      let total = 0;
      for (const models of daily.values()) {
        for (const model of models.values()) total += model.totalTokens;
      }
      return total;
    };

    expect(
      sum(await loadTokenUsageDailyByModel('2026-04-20', completedMonths)),
    ).toBe(110);
    expect(
      sum(await loadTokenUsageDailyByModel('2026-04-01', completedMonths)),
    ).toBe(158);
    expect(readStream).toHaveBeenCalledOnce();
    expect(completedMonths.has(getTokenUsageFilePath('2026-04'))).toBe(true);
    const cached = await loadTokenUsageDailyByModel(
      '2026-04-20',
      completedMonths,
    );
    expect(getTokenUsageSessionIds(cached, '2026-04-20', 'past')).toEqual(
      new Set([config.getSessionId()]),
    );

    await recordUsage(config, 'past', 'late', usage(200, 20, 220), {
      timestamp: '2026-04-20T12:00:00.000Z',
    });
    expect(
      sum(await loadTokenUsageDailyByModel('2026-04-01', completedMonths)),
    ).toBe(378);
    expect(readStream).toHaveBeenCalledTimes(2);
    expect(
      sum(await loadTokenUsageDailyByModel('2026-04-01', completedMonths)),
    ).toBe(378);
    expect(readStream).toHaveBeenCalledTimes(2);
  });

  it('invalidates a completed-month cache after an append during reading', async () => {
    await recordUsage(fakeConfig(), 'past', 'first', usage(100, 10, 110), {
      timestamp: '2026-04-20T10:00:00.000Z',
    });
    const filePath = getTokenUsageFilePath('2026-04');
    const firstRow = JSON.parse(await readFile(filePath, 'utf8'));
    const original = fs.createReadStream;
    let injected = false;
    const stream = vi
      .spyOn(fs, 'createReadStream')
      .mockImplementation((file, options) => {
        const input = original(file, options as BufferEncoding);
        if (String(file) === filePath && !injected) {
          injected = true;
          input.once('data', () => {
            fs.appendFileSync(
              filePath,
              JSON.stringify({ ...firstRow, id: 'late-row' }) + '\n',
            );
          });
        }
        return input;
      });
    const total = (records: TokenUsageDailyByModel) =>
      [...records.values()]
        .flatMap((models) => [...models.values()])
        .reduce((sum, model) => sum + model.totalTokens, 0);
    const cache = new Map();

    const firstRead = total(
      await loadTokenUsageDailyByModel('2026-04-01', cache),
    );
    expect([110, 220]).toContain(firstRead);
    expect(injected).toBe(true);
    expect(total(await loadTokenUsageDailyByModel('2026-04-01', cache))).toBe(
      220,
    );
    expect(total(await loadTokenUsageDailyByModel('2026-04-01', cache))).toBe(
      220,
    );
    expect(stream).toHaveBeenCalledTimes(2);
  });

  it('does not reuse completed-month data across runtime directories', async () => {
    const firstHome = tempDir;
    const secondHome = await mkdtemp(
      path.join(tmpdir(), 'qwen-token-other-home-'),
    );
    const completedMonths = new Map();
    try {
      await recordUsage(fakeConfig(), 'past', 'p1', usage(100, 10, 110), {
        timestamp: '2026-04-20T10:00:00.000Z',
      });
      const first = await loadTokenUsageDailyByModel(
        '2026-04-01',
        completedMonths,
      );
      expect(first.get('2026-04-20')?.get('past')?.totalTokens).toBe(110);

      process.env['QWEN_RUNTIME_DIR'] = secondHome;
      Storage.setRuntimeBaseDir(secondHome);
      const empty = await loadTokenUsageDailyByModel(
        '2026-04-01',
        completedMonths,
      );
      expect(empty.size).toBe(0);
      await recordUsage(fakeConfig(), 'other', 'p2', usage(30, 5, 35), {
        timestamp: '2026-04-20T12:00:00.000Z',
      });
      const second = await loadTokenUsageDailyByModel(
        '2026-04-01',
        completedMonths,
      );
      expect(second.get('2026-04-20')?.get('other')?.totalTokens).toBe(35);
      expect(second.get('2026-04-20')?.has('past')).toBe(false);
    } finally {
      process.env['QWEN_RUNTIME_DIR'] = firstHome;
      Storage.setRuntimeBaseDir(firstHome);
      await rm(secondHome, { recursive: true, force: true });
    }
  });

  it('always re-reads the current month after a real append', async () => {
    const config = fakeConfig();
    await recordUsage(config, 'current', 'p1', usage(20, 4, 24));
    const readStream = vi.spyOn(fs, 'createReadStream');
    const completedMonths = new Map();
    const sum = (
      daily: Awaited<ReturnType<typeof loadTokenUsageDailyByModel>>,
    ) => {
      let total = 0;
      for (const models of daily.values()) {
        for (const model of models.values()) total += model.totalTokens;
      }
      return total;
    };

    expect(
      sum(await loadTokenUsageDailyByModel('2026-05-01', completedMonths)),
    ).toBe(24);
    await recordUsage(config, 'current', 'p2', usage(80, 20, 100));
    expect(
      sum(await loadTokenUsageDailyByModel('2026-05-01', completedMonths)),
    ).toBe(124);
    expect(readStream).toHaveBeenCalledTimes(2);
    expect(completedMonths.size).toBe(0);
  });

  it('skips days and months before the requested start', async () => {
    const config = fakeConfig();
    await recordUsage(config, 'model-a', 'p1', usage(1, 1, 2));
    await recordUsage(config, 'model-a', 'p2', usage(9, 9, 18), {
      timestamp: '2026-05-24T10:00:00.000Z',
    });
    await recordUsage(config, 'model-a', 'p3', usage(50, 50, 100), {
      timestamp: '2026-04-30T10:00:00.000Z',
    });

    const table = await loadTokenUsageDailyByModel('2026-05-25');

    expect([...table.keys()]).toEqual(['2026-05-25']);
    expect(table.get('2026-05-25')?.get('model-a')?.totalTokens).toBe(2);
  });

  it('returns an empty table when no ledger was ever written', async () => {
    await expect(loadTokenUsageDailyByModel('2026-05-01')).resolves.toEqual(
      new Map(),
    );
  });

  it('omits request execution identity when the response has none', async () => {
    const event = createEvent('model-a', 'p1', usage(4, 6, 10));
    await recordTokenUsageFromApiResponse(fakeConfig(), event);

    expect(
      getTokenUsageExecutionIds(
        await loadTokenUsageDailyByModel('2026-05-01'),
        localDateKey(Date.parse(event['event.timestamp'])),
        'model-a',
      ),
    ).toBeUndefined();
    expect(event.execution_id).toBeUndefined();
  });

  it('preserves execution identity in snapshots and merged tables', async () => {
    const cache: TokenUsageCompletedMonthCache = new Map();
    await recordUsage(fakeConfig(), 'model-a', 'p1', usage(10, 0, 10), {
      timestamp: '2026-04-20T10:00:00.000Z',
    });
    const file = getTokenUsageFilePath('2026-04');
    const [line] = (await readFile(file, 'utf8')).trim().split('\n');
    const row = JSON.parse(line!) as Record<string, unknown>;
    row['executionId'] = 'completed-month-request';
    await writeFile(file, `${JSON.stringify(row)}\n`, 'utf8');

    const first = await loadTokenUsageDailyByModel('2026-04-01', cache);
    const fromCache = await loadTokenUsageDailyByModel('2026-04-01', cache);
    const merged: TokenUsageDailyByModel = new Map();
    mergeTokenUsageExecutionIds(merged, cache.values().next().value!);

    const requestDay = localDateKey(Date.parse('2026-04-20T10:00:00.000Z'));
    for (const table of [first, fromCache, merged]) {
      expect(getTokenUsageExecutionIds(table, requestDay, 'model-a')).toEqual(
        new Set(['completed-month-request']),
      );
    }
  });

  it('bounds execution evidence while preserving all counters', async () => {
    const timestamp = '2026-05-25T10:00:00.000Z';
    const localDate = localDateKey(Date.parse(timestamp));
    const localMonth = localDate.slice(0, 7);
    const file = getTokenUsageFilePath(localMonth);
    await mkdir(path.dirname(file), { recursive: true });
    const count = MAX_LEDGER_EXECUTION_EVIDENCE_RECORDS + 1;
    const rows = Array.from({ length: count }, (_, index) =>
      JSON.stringify({
        schemaVersion: 1,
        id: `budget-${index}`,
        executionId: `budget-${index}`,
        timestamp,
        localDate,
        localMonth,
        sessionId: 'session-1',
        model: 'model-a',
        authType: 'openai',
        source: 'main',
        inputTokens: 1,
        outputTokens: 0,
        cachedTokens: 0,
        thoughtsTokens: 0,
        totalTokens: 1,
        apiDurationMs: 1,
      }),
    ).join('\n');
    await writeFile(file, `${rows}\n`, 'utf8');

    const cache: TokenUsageCompletedMonthCache = new Map();
    const table = await loadTokenUsageDailyByModel('2026-05-01', cache);
    expect(table.get(localDate)?.get('model-a')).toMatchObject({
      requests: count,
      totalTokens: count,
    });
    expect(isCompleteLedgerExecutionEvidence(table)).toBe(false);
    expect(
      getTokenUsageExecutionRecords(table, localDate, 'model-a'),
    ).toBeUndefined();
    expect(
      getTokenUsageExecutionIds(table, localDate, 'model-a'),
    ).toBeUndefined();
    expect(
      isCompleteLedgerExecutionEvidence(
        await loadTokenUsageDailyByModel('2026-05-01', cache),
      ),
    ).toBe(false);
    const merged: TokenUsageDailyByModel = new Map();
    mergeTokenUsageExecutionIds(merged, table);
    expect(isCompleteLedgerExecutionEvidence(merged)).toBe(false);

    const record: UsageSummaryRecord = {
      version: 1,
      sessionId: 'session-1',
      timestamp: Date.parse(timestamp),
      startTime: Date.parse(timestamp) - 1_000,
      project: tempDir,
      durationMs: 1_000,
      totalLatencyMs: 1,
      models: {
        'model-a': {
          requests: 1,
          inputTokens: 1,
          outputTokens: 0,
          cachedTokens: 0,
          thoughtsTokens: 0,
          totalTokens: 1,
          totalLatencyMs: 1,
        },
      },
      tools: { totalCalls: 0, totalSuccess: 0, totalFail: 0, byName: {} },
      files: { linesAdded: 0, linesRemoved: 0 },
      runScoped: true,
      requestExecutionIds: ['budget-0'],
      successfulRequestExecutionIds: ['budget-0'],
    };
    setLedgerTranscriptScope(table, {
      root: tempDir,
      pathsBySessionId: new Map(),
    });
    expect(
      buildUsageDashboard([record], { range: 'all' }, table, [
        { records: [record], ledgerDaily: table },
      ]).summary,
    ).toMatchObject({ totalTokens: count + 1, requests: count + 1 });

    const transcript = new SessionService(record.project, {
      runtimeBaseDir: tempDir,
    }).getSessionTranscriptPath(record.sessionId);
    expect(fs.existsSync(transcript)).toBe(false);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(
      transcript,
      `${JSON.stringify({
        sessionId: record.sessionId,
        cwd: record.project,
        timestamp: new Date(record.startTime).toISOString(),
        type: 'user',
        message: { role: 'user', content: 'verified transcript' },
      })}\n`,
    );
    setLedgerTranscriptScope(table, {
      root: tempDir,
      pathsBySessionId: new Map([[record.sessionId, new Set([transcript])]]),
    });
    expect(fs.existsSync(transcript)).toBe(true);
    expect(
      buildUsageDashboard([record], { range: 'all' }, table, [
        { records: [record], ledgerDaily: table },
      ]).summary,
    ).toMatchObject({ totalTokens: count, requests: count });
  });

  it('counts unidentified rows in the evidence budget and merged metadata', async () => {
    const timestamp = '2026-05-25T10:00:00.000Z';
    const localDate = localDateKey(Date.parse(timestamp));
    const localMonth = localDate.slice(0, 7);
    const file = getTokenUsageFilePath(localMonth);
    await mkdir(path.dirname(file), { recursive: true });
    const rows: Array<Partial<TokenUsageRecord>> = Array.from(
      { length: MAX_LEDGER_EXECUTION_EVIDENCE_RECORDS - 1 },
      (_, index) => ({
        schemaVersion: 1,
        id: `unidentified-budget-${index}`,
        executionId: `unidentified-budget-${index}`,
        timestamp,
        localDate,
        localMonth,
        sessionId: 'unidentified-budget-session',
        model: 'model-a',
        authType: 'openai',
        source: 'main',
        inputTokens: 1,
        outputTokens: 0,
        cachedTokens: 0,
        thoughtsTokens: 0,
        totalTokens: 1,
        apiDurationMs: 1,
      }),
    );
    const unidentified = structuredClone(rows.at(-1)!);
    delete unidentified.executionId;
    rows.push(unidentified);
    const writeRows = async () => {
      await writeFile(
        file,
        `${rows.map((record) => JSON.stringify(record)).join('\n')}\n`,
      );
    };
    await writeRows();
    const table = await loadTokenUsageDailyByModel('2026-05-01');
    expect(isCompleteLedgerExecutionEvidence(table)).toBe(true);
    expect(
      getTokenUsageExecutionRecords(table, localDate, 'model-a'),
    ).toHaveLength(MAX_LEDGER_EXECUTION_EVIDENCE_RECORDS - 1);
    expect(
      getTokenUsageUnidentifiedSessionIds(table, localDate, 'model-a'),
    ).toEqual(new Set(['unidentified-budget-session']));

    const unidentifiedOnly: TokenUsageDailyByModel = new Map();
    mergeTokenUsageExecutionIds(unidentifiedOnly, table);
    expect(isCompleteLedgerExecutionEvidence(unidentifiedOnly)).toBe(true);
    expect(
      getTokenUsageUnidentifiedSessionIds(
        unidentifiedOnly,
        localDate,
        'model-a',
      ),
    ).toEqual(new Set(['unidentified-budget-session']));

    rows.push({ ...unidentified, id: 'unidentified-budget-overflow' });
    await writeRows();
    const overBudget = await loadTokenUsageDailyByModel('2026-05-01');
    expect(isCompleteLedgerExecutionEvidence(overBudget)).toBe(false);
    expect(
      getTokenUsageUnidentifiedSessionIds(overBudget, localDate, 'model-a'),
    ).toEqual(new Set(['unidentified-budget-session']));
    const mergedOverBudget: TokenUsageDailyByModel = new Map();
    mergeTokenUsageExecutionIds(mergedOverBudget, overBudget);
    expect(isCompleteLedgerExecutionEvidence(mergedOverBudget)).toBe(false);
    expect(
      getTokenUsageUnidentifiedSessionIds(
        mergedOverBudget,
        localDate,
        'model-a',
      ),
    ).toEqual(new Set(['unidentified-budget-session']));
  });

  it('retains complete evidence exactly at the single-root and merged cap', async () => {
    const timestamp = '2026-05-25T10:00:00.000Z';
    const localDate = localDateKey(Date.parse(timestamp));
    const localMonth = localDate.slice(0, 7);
    const writeRows = async (root: string, prefix: string, count: number) => {
      await Storage.runWithResolvedRuntimeBaseDir(root, async () => {
        const file = getTokenUsageFilePath(localMonth);
        await mkdir(path.dirname(file), { recursive: true });
        const rows = Array.from({ length: count }, (_, index) =>
          JSON.stringify({
            schemaVersion: 1,
            id: `${prefix}-${index}`,
            executionId: `${prefix}-${index}`,
            timestamp,
            localDate,
            localMonth,
            sessionId: 'exact-budget-session',
            model: 'model-a',
            authType: 'openai',
            source: 'main',
            inputTokens: 1,
            outputTokens: 0,
            cachedTokens: 0,
            thoughtsTokens: 0,
            totalTokens: 1,
            apiDurationMs: 1,
          }),
        ).join('\n');
        await writeFile(file, `${rows}\n`, 'utf8');
      });
    };
    const singleRoot = path.join(tempDir, 'single-cap');
    await writeRows(
      singleRoot,
      'single-cap',
      MAX_LEDGER_EXECUTION_EVIDENCE_RECORDS,
    );
    const single = await Storage.runWithResolvedRuntimeBaseDir(singleRoot, () =>
      loadTokenUsageDailyByModel('2026-05-01'),
    );
    expect(isCompleteLedgerExecutionEvidence(single)).toBe(true);
    expect(
      getTokenUsageExecutionRecords(single, localDate, 'model-a'),
    ).toHaveLength(MAX_LEDGER_EXECUTION_EVIDENCE_RECORDS);

    const roots = ['half-cap-a', 'half-cap-b'].map((name) =>
      path.join(tempDir, name),
    );
    const merged: TokenUsageDailyByModel = new Map();
    let actualRequests = 0;
    let actualTokens = 0;
    for (const root of roots) {
      await writeRows(
        root,
        `exact-${root}`,
        MAX_LEDGER_EXECUTION_EVIDENCE_RECORDS / 2,
      );
      const table = await Storage.runWithResolvedRuntimeBaseDir(root, () =>
        loadTokenUsageDailyByModel('2026-05-01'),
      );
      actualRequests += table.get(localDate)?.get('model-a')?.requests ?? 0;
      actualTokens += table.get(localDate)?.get('model-a')?.totalTokens ?? 0;
      mergeTokenUsageExecutionIds(merged, table);
    }
    expect(isCompleteLedgerExecutionEvidence(merged)).toBe(true);
    expect(
      getTokenUsageExecutionRecords(merged, localDate, 'model-a'),
    ).toHaveLength(MAX_LEDGER_EXECUTION_EVIDENCE_RECORDS);
    expect({ requests: actualRequests, tokens: actualTokens }).toEqual({
      requests: MAX_LEDGER_EXECUTION_EVIDENCE_RECORDS,
      tokens: MAX_LEDGER_EXECUTION_EVIDENCE_RECORDS,
    });
  });

  it('discards merged evidence above the combined budget but keeps counters', async () => {
    const sourceCount = 6_000;
    const timestamp = '2026-05-25T10:00:00.000Z';
    const localDate = localDateKey(Date.parse(timestamp));
    const localMonth = localDate.slice(0, 7);
    const roots = ['merge-budget-a', 'merge-budget-b'].map((name) =>
      path.join(tempDir, name),
    );
    for (const root of roots) {
      Storage.runWithResolvedRuntimeBaseDir(root, () => {
        const file = getTokenUsageFilePath(localMonth);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const rows = Array.from({ length: sourceCount }, (_, index) =>
          JSON.stringify({
            schemaVersion: 1,
            id: `row-${root}-${index}`,
            executionId: `execution-${root}-${index}`,
            timestamp,
            localDate,
            localMonth,
            sessionId: 'merge-session',
            model: 'model-a',
            authType: 'openai',
            source: 'main',
            inputTokens: 1,
            outputTokens: 0,
            cachedTokens: 0,
            thoughtsTokens: 0,
            totalTokens: 1,
            apiDurationMs: 1,
          }),
        ).join('\n');
        fs.writeFileSync(file, `${rows}\n`);
      });
    }
    const tables: TokenUsageDailyByModel[] = [];
    for (const root of roots) {
      tables.push(
        await Storage.runWithResolvedRuntimeBaseDir(root, () =>
          loadTokenUsageDailyByModel('2026-05-01'),
        ),
      );
    }
    for (const table of tables) {
      expect(isCompleteLedgerExecutionEvidence(table)).toBe(true);
      expect(
        getTokenUsageExecutionRecords(table, localDate, 'model-a'),
      ).toHaveLength(sourceCount);
    }
    const merged: TokenUsageDailyByModel = new Map();
    for (const table of tables) mergeTokenUsageExecutionIds(merged, table);
    expect(isCompleteLedgerExecutionEvidence(merged)).toBe(false);
    expect(
      getTokenUsageExecutionRecords(merged, localDate, 'model-a'),
    ).toBeUndefined();
    expect(
      tables.reduce(
        (sum, table) =>
          sum + (table.get(localDate)?.get('model-a')?.requests ?? 0),
        0,
      ),
    ).toBe(12_000);
    expect(
      tables.reduce(
        (sum, table) =>
          sum + (table.get(localDate)?.get('model-a')?.totalTokens ?? 0),
        0,
      ),
    ).toBe(12_000);
    const sources = await loadUsageDashboardSources(roots);
    expect(isCompleteLedgerExecutionEvidence(sources.ledgerDaily)).toBe(false);
    expect(
      buildUsageDashboard(
        sources.records,
        { range: 'today' },
        sources.ledgerDaily,
        sources.runtimeScopes,
      ).summary,
    ).toMatchObject({ requests: 12_000, totalTokens: 12_000 });
  });

  it('keeps execution evidence scoped to the requested completed-month day', async () => {
    const firstDay = new Date(2026, 3, 1, 12);
    const lastDay = new Date(2026, 3, 30, 12);
    vi.setSystemTime(new Date(2026, 4, 1, 12));
    const firstDayIso = firstDay.toISOString();
    const middleDayIso = new Date(2026, 3, 15, 12).toISOString();
    const lastDayIso = lastDay.toISOString();
    const localMonth = '2026-04';
    const file = getTokenUsageFilePath(localMonth);
    await mkdir(path.dirname(file), { recursive: true });
    const rows = Array.from(
      { length: MAX_LEDGER_EXECUTION_EVIDENCE_RECORDS + 1 },
      (_, index) => {
        const timestamp =
          index === 0 ? lastDayIso : index === 1 ? middleDayIso : firstDayIso;
        return JSON.stringify({
          schemaVersion: 1,
          id: `window-row-${index}`,
          executionId:
            index === 0
              ? 'window-only-response'
              : index === 1
                ? 'window-only-middle'
                : `old-${index}`,
          timestamp,
          localDate: localDateKey(Date.parse(timestamp)),
          localMonth,
          sessionId: 'session-1',
          model: 'model-a',
          authType: 'openai',
          source: 'main',
          inputTokens: 1,
          outputTokens: 0,
          cachedTokens: 0,
          thoughtsTokens: 0,
          totalTokens: 1,
          apiDurationMs: 1,
        });
      },
    ).join('\n');
    await writeFile(file, `${rows}\n`, 'utf8');
    const cache: TokenUsageCompletedMonthCache = new Map();
    const direct = await loadTokenUsageDailyByModel('2026-04-30');
    await loadTokenUsageDailyByModel('2026-04-01', cache);
    const cached = await loadTokenUsageDailyByModel('2026-04-30', cache);
    const record: UsageSummaryRecord = {
      version: 1,
      sessionId: 'session-1',
      timestamp: lastDay.getTime(),
      startTime: lastDay.getTime() - 1_000,
      project: tempDir,
      durationMs: 1_000,
      totalLatencyMs: 1,
      models: {
        'model-a': {
          requests: 1,
          inputTokens: 1,
          outputTokens: 0,
          cachedTokens: 0,
          thoughtsTokens: 0,
          totalTokens: 1,
          totalLatencyMs: 1,
        },
      },
      tools: { totalCalls: 0, totalSuccess: 0, totalFail: 0, byName: {} },
      files: { linesAdded: 0, linesRemoved: 0 },
      runScoped: true,
      requestExecutionIds: ['window-only-response'],
      successfulRequestExecutionIds: ['window-only-response'],
    };
    for (const table of [direct, cached]) {
      expect(isCompleteLedgerExecutionEvidence(table)).toBe(true);
      expect(getTokenUsageExecutionIds(table, '2026-04-30', 'model-a')).toEqual(
        new Set(['window-only-response']),
      );
      setLedgerTranscriptScope(table, {
        root: tempDir,
        pathsBySessionId: new Map(),
      });
      expect(
        buildUsageDashboard([record], { range: 'all' }, table, [
          { records: [record], ledgerDaily: table },
        ]).summary,
      ).toMatchObject({ totalTokens: 1, requests: 1 });
    }

    const middleRecord = structuredClone(record);
    middleRecord.startTime = Date.parse(middleDayIso) - 1_000;
    middleRecord.timestamp = Date.parse(middleDayIso);
    middleRecord.requestExecutionIds = ['window-only-middle'];
    middleRecord.successfulRequestExecutionIds = ['window-only-middle'];
    for (const table of [
      await loadTokenUsageDailyByModel('2026-04-15'),
      await loadTokenUsageDailyByModel('2026-04-15', cache),
    ]) {
      expect(isCompleteLedgerExecutionEvidence(table)).toBe(true);
      expect(getTokenUsageExecutionIds(table, '2026-04-15', 'model-a')).toEqual(
        new Set(['window-only-middle']),
      );
      setLedgerTranscriptScope(table, {
        root: tempDir,
        pathsBySessionId: new Map(),
      });
      expect(
        getTokenUsageExecutionRecords(table, '2026-04-15', 'model-a'),
      ).toHaveLength(1);
      expect(
        buildUsageDashboard([middleRecord], { range: 'all' }, table, [
          { records: [middleRecord], ledgerDaily: table },
        ]).summary,
      ).toMatchObject({ totalTokens: 2, requests: 2 });
    }
  });

  it('appends a table to itself only once', async () => {
    const event = createEvent('model-a', 'alias-request', usage(2, 0, 2));
    event.execution_id = 'alias-execution';
    await recordTokenUsageFromApiResponse(fakeConfig(), event);
    const table = await loadTokenUsageDailyByModel('2026-05-01');
    const day = localDateKey(Date.now());
    expect(table.get(day)?.get('model-a')?.totalTokens).toBe(2);
    mergeTokenUsageExecutionIds(table, table);
    expect(getTokenUsageExecutionRecords(table, day, 'model-a')?.length).toBe(
      2,
    );
    expect(table.get(day)?.get('model-a')?.totalTokens).toBe(2);
    expect(table.get(day)?.get('model-a')?.requests).toBe(1);
  });

  it('uses successful request IDs to replace only the covered persisted run', async () => {
    const originalQwenHome = process.env['QWEN_HOME'];
    const config = fakeConfig();
    const sessionId = config.getSessionId();
    const project = path.join(tempDir, 'deleted-project');
    const startTime = new Date(2026, 4, 25, 12);
    const endTime = new Date(startTime.getTime() + 1_000);
    // This is a completed-run test; the read must follow it in every timezone.
    vi.setSystemTime(endTime);
    const transcript = new SessionService(project, {
      runtimeBaseDir: tempDir,
    }).getSessionTranscriptPath(sessionId);
    const usageRecordPath = path.join(tempDir, 'usage_record.jsonl');
    const event = createEvent('qwen-max', 'p1', usage(100, 0, 100), {
      timestamp: endTime.toISOString(),
    });
    event.execution_id = 'request-after-delete';
    const failure = {
      'event.name': 'qwen-code.api_error',
      'event.timestamp': endTime.toISOString(),
      execution_id: 'failure-after-delete',
      model: 'qwen-max',
      duration_ms: 25,
      error_message: 'failed',
    } as UiEvent;
    uiTelemetryService.reset();
    process.env['QWEN_HOME'] = tempDir;
    try {
      fs.mkdirSync(path.dirname(transcript), { recursive: true });
      fs.writeFileSync(
        transcript,
        `${JSON.stringify({
          sessionId,
          cwd: project,
          uuid: 'user-before-delete',
          parentUuid: null,
          timestamp: startTime.toISOString(),
          type: 'user',
          message: { role: 'user', content: 'temporary transcript' },
        })}\n`,
      );
      await recordTokenUsageFromApiResponse(config, event);
      uiTelemetryService.setSessionStartTime(
        new Date(startTime.getTime() - 1_000),
        sessionId,
      );
      uiTelemetryService.addEvent(
        { ...event, 'event.name': EVENT_API_RESPONSE } as UiEvent,
        sessionId,
      );
      uiTelemetryService.addEvent(failure, sessionId);
      persistSessionUsage({
        sessionId,
        startTime,
        endTime,
        project,
        metrics: uiTelemetryService.getLiveMetrics(),
      });
      const persistedRecord = JSON.parse(
        fs.readFileSync(usageRecordPath, 'utf8').trim(),
      ) as UsageSummaryRecord;
      expect(persistedRecord.requestExecutionIds).toEqual([
        'failure-after-delete',
        'request-after-delete',
      ]);
      expect(persistedRecord.successfulRequestExecutionIds).toEqual([
        'request-after-delete',
      ]);

      const legacyRecord = { ...persistedRecord };
      delete legacyRecord.successfulRequestExecutionIds;
      fs.writeFileSync(usageRecordPath, `${JSON.stringify(legacyRecord)}\n`);
      const legacyIdentified = await loadUsageDashboardSources([tempDir]);
      expect(
        buildUsageDashboard(
          legacyIdentified.records,
          { range: 'all' },
          legacyIdentified.ledgerDaily,
          legacyIdentified.runtimeScopes,
        ).summary,
      ).toMatchObject({ totalTokens: 100, requests: 2 });

      fs.writeFileSync(usageRecordPath, `${JSON.stringify(persistedRecord)}\n`);
      const transcriptContent = fs.readFileSync(transcript, 'utf8');
      fs.rmSync(transcript);
      const sources = await loadUsageDashboardSources([tempDir]);
      expect(fs.existsSync(transcript)).toBe(false);
      expect(
        buildUsageDashboard(
          sources.records,
          { range: 'all' },
          sources.ledgerDaily,
          sources.runtimeScopes,
        ).summary,
      ).toMatchObject({
        totalTokens: 100,
        requests: 2,
      });

      const rewriteLedger = async (
        change: (row: Record<string, unknown>) => void,
      ) => {
        const ledgerPath = getTokenUsageFilePath('2026-05');
        const lines = (await readFile(ledgerPath, 'utf8')).trim().split('\n');
        const row = JSON.parse(lines[0]!) as Record<string, unknown>;
        change(row);
        await writeFile(ledgerPath, `${JSON.stringify(row)}\n`, 'utf8');
      };

      await rewriteLedger((row) => {
        row['executionId'] = 'a-different-request';
      });
      const mismatched = await loadUsageDashboardSources([tempDir]);
      expect(
        buildUsageDashboard(
          mismatched.records,
          { range: 'all' },
          mismatched.ledgerDaily,
          mismatched.runtimeScopes,
        ).summary,
      ).toMatchObject({
        totalTokens: 200,
        requests: 3,
      });
      fs.writeFileSync(transcript, transcriptContent);
      expect(fs.existsSync(transcript)).toBe(true);
      const mismatchedWithTranscript = await loadUsageDashboardSources([
        tempDir,
      ]);
      expect(
        buildUsageDashboard(
          mismatchedWithTranscript.records,
          { range: 'all' },
          mismatchedWithTranscript.ledgerDaily,
          mismatchedWithTranscript.runtimeScopes,
        ).summary,
      ).toMatchObject({ totalTokens: 200, requests: 3 });

      const partialRecord = structuredClone(persistedRecord);
      partialRecord.requestExecutionIds = [
        'request-after-delete',
        'unknown-second-request',
      ];
      partialRecord.successfulRequestExecutionIds!.push(
        'unknown-second-request',
      );
      Object.assign(partialRecord.models['qwen-max']!, {
        errors: 0,
        errorLatencyMs: 0,
        totalLatencyMs: 100,
      });
      partialRecord.totalLatencyMs = 100;
      fs.writeFileSync(usageRecordPath, `${JSON.stringify(partialRecord)}\n`);
      await rewriteLedger((row) => {
        row['executionId'] = 'request-after-delete';
      });
      fs.rmSync(transcript);
      expect(fs.existsSync(transcript)).toBe(false);
      const partial = await loadUsageDashboardSources([tempDir]);
      expect(
        buildUsageDashboard(
          partial.records,
          { range: 'all' },
          partial.ledgerDaily,
          partial.runtimeScopes,
        ).summary,
      ).toMatchObject({
        totalTokens: 200,
        requests: 3,
      });
      fs.writeFileSync(transcript, transcriptContent);
      expect(fs.existsSync(transcript)).toBe(true);
      const partialWithTranscript = await loadUsageDashboardSources([tempDir]);
      expect(
        buildUsageDashboard(
          partialWithTranscript.records,
          { range: 'all' },
          partialWithTranscript.ledgerDaily,
          partialWithTranscript.runtimeScopes,
        ).summary,
      ).toMatchObject({ totalTokens: 200, requests: 3 });

      fs.rmSync(transcript);
      delete persistedRecord.requestExecutionIds;
      delete persistedRecord.successfulRequestExecutionIds;
      fs.writeFileSync(usageRecordPath, `${JSON.stringify(persistedRecord)}\n`);
      await rewriteLedger((row) => {
        delete row['executionId'];
      });
      const legacy = await loadUsageDashboardSources([tempDir]);
      expect(
        buildUsageDashboard(
          legacy.records,
          { range: 'all' },
          legacy.ledgerDaily,
          legacy.runtimeScopes,
        ).summary,
      ).toMatchObject({
        totalTokens: 200,
        requests: 3,
      });
    } finally {
      if (originalQwenHome === undefined) delete process.env['QWEN_HOME'];
      else process.env['QWEN_HOME'] = originalQwenHome;
      uiTelemetryService.reset();
    }
  });

  it('normalizes a missing Qwen OAuth total without double-billing reasoning', async () => {
    const startTime = new Date(2026, 4, 25, 10);
    const endTime = new Date(startTime.getTime() + 1_000);
    const response = createEvent(
      'model-a',
      'missing-oauth-total',
      {
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        thoughtsTokenCount: 5,
      },
      {
        authType: AuthType.QWEN_OAUTH,
        timestamp: startTime.toISOString(),
        durationMs: 1,
      },
    );
    response.execution_id = 'oauth-missing-total';
    const dashboard = await buildTranscriptlessRunDashboard(
      startTime,
      endTime,
      [response],
    );
    expect(dashboard.summary).toMatchObject({
      requests: 1,
      totalTokens: 30,
      inputTokens: 10,
      outputTokens: 20,
      thoughtsTokens: 5,
    });
  });

  it('matches a cache-only response across live and ledger normalization', async () => {
    const startTime = new Date(2026, 4, 25, 10);
    const endTime = new Date(startTime.getTime() + 1_000);
    const response = createEvent(
      'model-a',
      'cache-only-total',
      {
        promptTokenCount: 0,
        candidatesTokenCount: 0,
        cachedContentTokenCount: 100,
        totalTokenCount: 100,
      },
      {
        authType: AuthType.USE_OPENAI,
        timestamp: startTime.toISOString(),
        durationMs: 1,
      },
    );
    response.execution_id = 'cache-only-response';
    const dashboard = await buildTranscriptlessRunDashboard(
      startTime,
      endTime,
      [response],
    );
    expect(dashboard.summary).toMatchObject({
      requests: 1,
      inputTokens: 100,
      cachedTokens: 100,
      totalTokens: 100,
    });
    expect(
      getTokenUsageExecutionRecords(
        await loadTokenUsageDailyByModel('2026-05-01'),
        localDateKey(startTime.getTime()),
        'model-a',
      ),
    ).toMatchObject([{ apiDurationMs: 1 }]);
  });

  it('matches a cache-only response without an explicit total', async () => {
    const startTime = new Date(2026, 4, 25, 10);
    const endTime = new Date(startTime.getTime() + 1_000);
    const response = createEvent(
      'model-a',
      'cache-only-without-total',
      {
        promptTokenCount: 0,
        candidatesTokenCount: 0,
        cachedContentTokenCount: 100,
        totalTokenCount: 0,
      },
      {
        authType: AuthType.USE_GEMINI,
        timestamp: startTime.toISOString(),
        durationMs: 1,
      },
    );
    response.execution_id = 'cache-only-without-total-response';
    const dashboard = await buildTranscriptlessRunDashboard(
      startTime,
      endTime,
      [response],
    );
    expect(dashboard.summary).toMatchObject({
      requests: 1,
      inputTokens: 100,
      cachedTokens: 100,
      totalTokens: 100,
    });
  });

  it('matches successful identities across every model in a run', async () => {
    const startTime = new Date(2026, 4, 25, 10);
    const endTime = new Date(startTime.getTime() + 1_000);
    const first = createEvent('model-a', 'a', usage(100, 0, 100), {
      timestamp: startTime.toISOString(),
    });
    first.execution_id = 'model-a-request';
    const second = createEvent('model-b', 'b', usage(200, 0, 200), {
      timestamp: endTime.toISOString(),
    });
    second.execution_id = 'model-b-request';

    const dashboard = await buildTranscriptlessRunDashboard(
      startTime,
      endTime,
      [first, second],
    );

    expect(dashboard.summary).toMatchObject({ totalTokens: 300, requests: 2 });
    expect(dashboard.models.map((model) => model.totalTokens).sort()).toEqual([
      100, 200,
    ]);
  });

  it('matches successful identities across every local day in a run', async () => {
    const startTime = new Date(2026, 4, 24, 23, 59);
    const endTime = new Date(2026, 4, 25, 0, 1);
    const first = createEvent('model-a', 'a', usage(100, 0, 100), {
      timestamp: startTime.toISOString(),
    });
    first.execution_id = 'first-day-request';
    const second = createEvent('model-a', 'b', usage(200, 0, 200), {
      timestamp: endTime.toISOString(),
    });
    second.execution_id = 'second-day-request';

    const dashboard = await buildTranscriptlessRunDashboard(
      startTime,
      endTime,
      [first, second],
    );

    expect(dashboard.summary).toMatchObject({ totalTokens: 300, requests: 2 });
    expect(dashboard.heatmap['2026-05-24']?.tokens).toBe(100);
    expect(dashboard.heatmap['2026-05-25']?.tokens).toBe(200);
  });

  it('drops invalid and future-schema records while keeping valid ones', async () => {
    const config = fakeConfig();
    const event = createEvent('model-a', 'p1', usage(4, 6, 10));
    event.execution_id = 'valid-execution';
    await recordTokenUsageFromApiResponse(config, event);
    const file = getTokenUsageFilePath('2026-05');
    const valid = JSON.parse(
      (await readFile(file, 'utf-8')).trim().split('\n')[0]!,
    ) as Record<string, unknown>;
    await jsonl.writeLine(file, { ...valid, schemaVersion: 99, id: 'future' });
    await jsonl.writeLine(file, {
      ...valid,
      id: 'invalid-execution-id',
      executionId: 42,
    });
    // `undefined` drops the key on serialization, so the record fails validation.
    await jsonl.writeLine(file, {
      ...valid,
      id: 'missing-count',
      inputTokens: undefined,
    });
    const broken = await readFile(file, 'utf-8');
    await writeFile(file, `${broken}{not json}\n`, 'utf-8');

    const table = await loadTokenUsageDailyByModel('2026-05-01');

    // Only the one well-formed record survives.
    expect(table.get('2026-05-25')?.get('model-a')).toMatchObject({
      requests: 1,
      totalTokens: 10,
    });
    expect(getTokenUsageExecutionIds(table, '2026-05-25', 'model-a')).toEqual(
      new Set(['valid-execution']),
    );
  });

  it('validates period values', async () => {
    const rejects = (period: 'day' | 'month', value: string, message: string) =>
      expect(queryTokenUsage({ period, value })).rejects.toThrow(message);
    await rejects('day', '2026-05', 'Expected YYYY-MM-DD');
    await rejects('day', '2026-02-29', 'Expected YYYY-MM-DD');
    await expect(
      queryTokenUsage({ period: 'day', value: '2024-02-29' }),
    ).resolves.toMatchObject({ value: '2024-02-29' });
    await rejects('month', '2026-05-25', 'Expected YYYY-MM');
    await rejects('month', '2026-13', 'Expected YYYY-MM');
    expect(() => getTokenUsageFilePath('2026-00')).toThrow('Expected YYYY-MM');
  });
});
