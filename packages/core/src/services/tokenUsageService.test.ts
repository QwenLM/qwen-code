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
  __overrideNowForTesting,
  apiResponseEventToTokenUsageRecord,
  exportTokenUsageSummary,
  formatTokenUsageSummaryAsCsv,
  getTokenUsageFilePath,
  loadTokenUsageDailyByModel,
  queryTokenUsage,
  recordTokenUsageFromApiResponse,
  recordTokenUsageFromApiResponseBestEffort,
  resetTokenUsageFailureLogging,
} from './tokenUsageService.js';
import type { TokenUsageDailyByModel } from './tokenUsageService.js';

describe('tokenUsageService', () => {
  let tempDir: string;
  let originalRuntimeDir: string | undefined;
  let originalDebugLogFileEnv: string | undefined;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-25T10:00:00.000Z'));
    originalRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
    originalDebugLogFileEnv = process.env['QWEN_DEBUG_LOG_FILE'];
    tempDir = await mkdtemp(path.join(tmpdir(), 'qwen-token-usage-'));
    process.env['QWEN_RUNTIME_DIR'] = tempDir;
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

  it('drops invalid and future-schema records while keeping valid ones', async () => {
    const config = fakeConfig();
    await recordUsage(config, 'model-a', 'p1', usage(4, 6, 10));
    const file = getTokenUsageFilePath('2026-05');
    const valid = JSON.parse(
      (await readFile(file, 'utf-8')).trim().split('\n')[0]!,
    ) as Record<string, unknown>;
    await jsonl.writeLine(file, { ...valid, schemaVersion: 99, id: 'future' });
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
