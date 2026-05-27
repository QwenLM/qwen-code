/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GenerateContentResponseUsageMetadata } from '@google/genai';
import { AuthType } from '../core/contentGenerator.js';
import { Storage } from '../config/storage.js';
import { makeFakeConfig } from '../test-utils/config.js';
import { ApiResponseEvent } from '../telemetry/types.js';
import {
  apiResponseEventToTokenUsageRecord,
  exportTokenUsageSummary,
  formatTokenUsageSummaryAsCsv,
  getTokenUsageFilePath,
  queryTokenUsage,
  recordTokenUsageFromApiResponse,
} from './tokenUsageService.js';

describe('tokenUsageService', () => {
  let tempDir: string;
  let originalRuntimeDir: string | undefined;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-25T10:00:00.000Z'));
    originalRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
    tempDir = await mkdtemp(path.join(tmpdir(), 'qwen-token-usage-'));
    process.env['QWEN_RUNTIME_DIR'] = tempDir;
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (originalRuntimeDir === undefined) {
      delete process.env['QWEN_RUNTIME_DIR'];
    } else {
      process.env['QWEN_RUNTIME_DIR'] = originalRuntimeDir;
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

  it('maps an API response event to a privacy-preserving usage record', () => {
    const config = makeFakeConfig({
      sessionId: 'session-1',
      targetDir: path.join(tempDir, 'project'),
    });
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

  it('persists API usage to monthly JSONL and aggregates daily totals', async () => {
    const config = makeFakeConfig({
      sessionId: 'session-1',
      targetDir: path.join(tempDir, 'project'),
    });

    await recordTokenUsageFromApiResponse(
      config,
      createEvent('model-a', 'prompt-1', {
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        cachedContentTokenCount: 5,
        thoughtsTokenCount: 2,
        totalTokenCount: 32,
      }),
    );
    await recordTokenUsageFromApiResponse(
      config,
      createEvent(
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
      ),
    );
    await recordTokenUsageFromApiResponse(
      config,
      createEvent(
        'model-a',
        'prompt-3',
        {
          promptTokenCount: 100,
          candidatesTokenCount: 100,
          totalTokenCount: 200,
        },
        {
          timestamp: '2026-05-26T12:00:00.000Z',
        },
      ),
    );

    const fileContent = await readFile(
      getTokenUsageFilePath('2026-05'),
      'utf-8',
    );
    expect(fileContent.trim().split('\n')).toHaveLength(3);

    const summary = await queryTokenUsage({
      period: 'day',
      value: '2026-05-25',
    });

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

  it('aggregates monthly model, auth type, model/auth, and source groups', async () => {
    const config = makeFakeConfig({
      sessionId: 'session-1',
      targetDir: path.join(tempDir, 'project'),
    });

    await recordTokenUsageFromApiResponse(
      config,
      createEvent(
        'model-a',
        'prompt-1',
        {
          promptTokenCount: 1,
          candidatesTokenCount: 2,
          totalTokenCount: 3,
        },
        {
          authType: AuthType.USE_GEMINI,
          subagentName: 'agent-a',
        },
      ),
    );
    await recordTokenUsageFromApiResponse(
      config,
      createEvent(
        'model-a',
        'prompt-2',
        {
          promptTokenCount: 4,
          candidatesTokenCount: 5,
          totalTokenCount: 9,
        },
        {
          authType: AuthType.USE_VERTEX_AI,
          subagentName: 'agent-a',
        },
      ),
    );
    await recordTokenUsageFromApiResponse(
      config,
      createEvent(
        'model-b',
        'prompt-3',
        {
          promptTokenCount: 6,
          candidatesTokenCount: 7,
          totalTokenCount: 13,
        },
        {
          authType: AuthType.USE_GEMINI,
        },
      ),
    );

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
    const config = makeFakeConfig({
      sessionId: 'session-1',
      targetDir: path.join(tempDir, 'project'),
    });

    await recordTokenUsageFromApiResponse(
      config,
      createEvent('model-a', 'prompt-1', {
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        cachedContentTokenCount: 5,
        thoughtsTokenCount: 7,
      }),
    );

    const summary = await queryTokenUsage({
      period: 'day',
      value: '2026-05-25',
    });

    expect(summary.totals.totalTokens).toBe(37);
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

  it('tolerates malformed JSONL lines while querying', async () => {
    const filePath = getTokenUsageFilePath('2026-05');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      [
        '{"schemaVersion":1,"id":"ok","timestamp":"2026-05-25T00:00:00.000Z","localDate":"2026-05-25","localMonth":"2026-05","sessionId":"s","model":"model-a","authType":"gemini","source":"main","inputTokens":1,"outputTokens":2,"cachedTokens":0,"thoughtsTokens":0,"totalTokens":3,"apiDurationMs":4}',
        'not-json',
      ].join('\n'),
      'utf-8',
    );

    const summary = await queryTokenUsage({
      period: 'day',
      value: '2026-05-25',
    });

    expect(summary.totals.totalTokens).toBe(3);
    expect(summary.totals.requests).toBe(1);
  });

  it('exports summaries as JSON and escaped CSV', async () => {
    const config = makeFakeConfig({
      sessionId: 'session-1',
      targetDir: path.join(tempDir, 'project'),
    });
    await recordTokenUsageFromApiResponse(
      config,
      createEvent(
        'model,quoted',
        'prompt-1',
        {
          promptTokenCount: 1,
          candidatesTokenCount: 2,
          totalTokenCount: 3,
        },
        {
          authType: 'auth"quoted',
        },
      ),
    );

    const json = await exportTokenUsageSummary({
      period: 'day',
      value: '2026-05-25',
      format: 'json',
    });
    expect(JSON.parse(json)).toMatchObject({
      period: 'day',
      value: '2026-05-25',
      totals: { totalTokens: 3 },
      coordination: { issues: ['#4479', '#4252', '#4182'] },
    });

    const csv = formatTokenUsageSummaryAsCsv(
      await queryTokenUsage({ period: 'day', value: '2026-05-25' }),
    );
    expect(csv).toContain(
      'day,2026-05-25,model,"model,quoted","model,quoted",,,1,1,2,0,0,3,100',
    );
    expect(csv).toContain(
      'day,2026-05-25,auth_type,"auth""quoted",,"auth""quoted",,1,1,2,0,0,3,100',
    );
  });

  it('validates period values', async () => {
    await expect(
      queryTokenUsage({ period: 'day', value: '2026-05' }),
    ).rejects.toThrow('Expected YYYY-MM-DD');
    await expect(
      queryTokenUsage({ period: 'month', value: '2026-05-25' }),
    ).rejects.toThrow('Expected YYYY-MM');
  });
});
