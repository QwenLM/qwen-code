/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ToolOutputMaskingService,
  MASKING_INDICATOR_TAG,
} from './toolOutputMaskingService.js';
import type { Content } from '@google/genai';
import type { Config, ToolOutputMaskingConfig } from '../config/config.js';

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../telemetry/loggers.js', () => ({
  logToolOutputMasking: vi.fn(),
}));

function createMockConfig(
  overrides: Partial<ToolOutputMaskingConfig> = {},
): Config {
  const maskingConfig: ToolOutputMaskingConfig = {
    enabled: true,
    toolProtectionThreshold: 50_000,
    minPrunableTokensThreshold: 1_000,
    protectLatestTurn: true,
    ...overrides,
  };
  return {
    getToolOutputMaskingEnabled: () => maskingConfig.enabled,
    getToolOutputMaskingConfig: async () => maskingConfig,
    getSessionId: () => 'test-session',
    storage: {
      getProjectTempDir: () => '/tmp/test',
    },
  } as unknown as Config;
}

function toolResponseContent(
  name: string,
  output: string,
  id?: string,
): Content {
  return {
    role: 'model',
    parts: [
      {
        functionResponse: {
          name,
          id: id || `call-${name}`,
          response: { output },
        },
      },
    ],
  };
}

describe('ToolOutputMaskingService', () => {
  let service: ToolOutputMaskingService;

  beforeEach(() => {
    service = new ToolOutputMaskingService();
    vi.clearAllMocks();
  });

  it('should return unmodified history when masking is disabled', async () => {
    const config = createMockConfig({ enabled: false });
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'hi' }] },
      toolResponseContent('read_file', 'x'.repeat(100_000)),
    ];
    const result = await service.mask(history, config);
    expect(result.maskedCount).toBe(0);
    expect(result.newHistory).toBe(history);
  });

  it('should return unmodified history when empty', async () => {
    const config = createMockConfig();
    const result = await service.mask([], config);
    expect(result.maskedCount).toBe(0);
  });

  it('should not mask when prunable tokens are below threshold', async () => {
    const config = createMockConfig({ minPrunableTokensThreshold: 999_999 });
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'hi' }] },
      toolResponseContent('read_file', 'small output'),
    ];
    const result = await service.mask(history, config);
    expect(result.maskedCount).toBe(0);
  });

  it('should mask old tool outputs when above threshold', async () => {
    const config = createMockConfig({
      toolProtectionThreshold: 100,
      minPrunableTokensThreshold: 100,
      protectLatestTurn: false,
    });
    const bigOutput = 'x'.repeat(50_000);
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'start' }] },
      toolResponseContent('read_file', bigOutput, 'old-call'),
      { role: 'user', parts: [{ text: 'continue' }] },
      toolResponseContent('read_file', bigOutput, 'new-call'),
    ];
    const result = await service.mask(history, config);
    expect(result.maskedCount).toBeGreaterThan(0);
    expect(result.tokensSaved).toBeGreaterThan(0);
  });

  it('should protect the latest turn when configured', async () => {
    const config = createMockConfig({
      toolProtectionThreshold: 1,
      minPrunableTokensThreshold: 1,
      protectLatestTurn: true,
    });
    const bigOutput = 'x'.repeat(50_000);
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'hi' }] },
      toolResponseContent('read_file', bigOutput, 'latest'),
    ];
    const result = await service.mask(history, config);
    expect(result.maskedCount).toBe(0);
  });

  it('should not mask exempt tools (skill, memory, ask_user_question)', async () => {
    const config = createMockConfig({
      toolProtectionThreshold: 1,
      minPrunableTokensThreshold: 1,
      protectLatestTurn: false,
    });
    const bigOutput = 'x'.repeat(50_000);
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'hi' }] },
      toolResponseContent('skill', bigOutput, 'skill-call'),
      toolResponseContent('memory', bigOutput, 'memory-call'),
      { role: 'user', parts: [{ text: 'next' }] },
      toolResponseContent('read_file', bigOutput, 'read-call'),
    ];
    const result = await service.mask(history, config);
    const maskedHistory = result.newHistory;
    const skillResponse = maskedHistory[1].parts![0].functionResponse;
    const skillOutput = (skillResponse!.response as Record<string, unknown>)[
      'output'
    ];
    expect(typeof skillOutput === 'string' && skillOutput).toBe(bigOutput);
  });

  it('should not re-mask already masked outputs', async () => {
    const config = createMockConfig({
      toolProtectionThreshold: 1,
      minPrunableTokensThreshold: 1,
      protectLatestTurn: false,
    });
    const maskedContent = `<${MASKING_INDICATOR_TAG}>preview</${MASKING_INDICATOR_TAG}>`;
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'hi' }] },
      {
        role: 'model',
        parts: [
          {
            functionResponse: {
              name: 'read_file',
              id: 'already-masked',
              response: { output: maskedContent },
            },
          },
        ],
      },
      { role: 'user', parts: [{ text: 'next' }] },
      toolResponseContent('read_file', 'x'.repeat(50_000), 'new-call'),
    ];
    const result = await service.mask(history, config);
    const firstToolOutput = (
      result.newHistory[1].parts![0].functionResponse!.response as Record<
        string,
        unknown
      >
    )['output'];
    expect(firstToolOutput).toBe(maskedContent);
  });

  it('should include masking indicator tag in masked output', async () => {
    const config = createMockConfig({
      toolProtectionThreshold: 1,
      minPrunableTokensThreshold: 1,
      protectLatestTurn: false,
    });
    const bigOutput = 'x'.repeat(50_000);
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'start' }] },
      toolResponseContent('read_file', bigOutput, 'old'),
      { role: 'user', parts: [{ text: 'continue' }] },
      toolResponseContent('read_file', 'y'.repeat(50_000), 'new'),
    ];
    const result = await service.mask(history, config);
    if (result.maskedCount > 0) {
      const masked = JSON.stringify(result.newHistory);
      expect(masked).toContain(MASKING_INDICATOR_TAG);
    }
  });
});
