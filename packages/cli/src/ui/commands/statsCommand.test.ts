/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  access,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { statsCommand } from './statsCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { MessageType } from '../types.js';
import { setLanguageAsync } from '../../i18n/index.js';
import {
  ApiResponseEvent,
  AuthType,
  type Config,
  MAIN_SOURCE,
  type ModelMetrics,
  type ModelMetricsCore,
  Storage,
  getTokenUsageFilePath,
  recordTokenUsageFromApiResponse,
} from '@qwen-code/qwen-code-core';

const fsPromisesMock = vi.hoisted(() => ({
  open: vi.fn<typeof import('node:fs/promises').open>(),
  rename: vi.fn<typeof import('node:fs/promises').rename>(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  fsPromisesMock.open.mockImplementation(actual.open);
  fsPromisesMock.rename.mockImplementation(actual.rename);
  return {
    ...actual,
    open: fsPromisesMock.open,
    rename: fsPromisesMock.rename,
  };
});

const toModelMetrics = (core: ModelMetricsCore): ModelMetrics => ({
  ...core,
  bySource: { [MAIN_SOURCE]: core },
});

describe('statsCommand', () => {
  let mockContext: CommandContext;
  const startTime = new Date('2025-07-14T10:00:00.000Z');
  const endTime = new Date('2025-07-14T10:00:30.000Z');
  let tempDir: string;
  let originalRuntimeDir: string | undefined;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(endTime);
    const actualFs =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    fsPromisesMock.open.mockReset();
    fsPromisesMock.open.mockImplementation(actualFs.open);
    fsPromisesMock.rename.mockReset();
    fsPromisesMock.rename.mockImplementation(actualFs.rename);
    originalRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
    tempDir = await mkdtemp(path.join(tmpdir(), 'qwen-stats-command-'));
    process.env['QWEN_RUNTIME_DIR'] = tempDir;

    // 1. Create the mock context with all default values
    mockContext = createMockCommandContext();

    // 2. Directly set the property on the created mock context
    mockContext.session.stats.sessionStartTime = startTime;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await setLanguageAsync('en');
    if (originalRuntimeDir === undefined) {
      delete process.env['QWEN_RUNTIME_DIR'];
    } else {
      process.env['QWEN_RUNTIME_DIR'] = originalRuntimeDir;
    }
    Storage.setRuntimeBaseDir(null);
    await rm(tempDir, { recursive: true, force: true });
  });

  function createUsageConfig(): Config {
    return {
      getSessionId: () => 'session-1',
      getProjectRoot: () => tempDir,
      getWorkingDir: () => tempDir,
    } as unknown as Config;
  }

  async function seedUsage() {
    const config = createUsageConfig();
    const first = new ApiResponseEvent(
      'response-1',
      'model-a',
      100,
      'prompt-1',
      AuthType.USE_GEMINI,
      {
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        cachedContentTokenCount: 5,
        thoughtsTokenCount: 2,
        totalTokenCount: 32,
      },
    );
    first['event.timestamp'] = '2025-07-14T10:00:00.000Z';
    const second = new ApiResponseEvent(
      'response-2',
      'model-b',
      200,
      'prompt-2',
      AuthType.USE_VERTEX_AI,
      {
        promptTokenCount: 7,
        candidatesTokenCount: 8,
        cachedContentTokenCount: 1,
        thoughtsTokenCount: 0,
        totalTokenCount: 15,
      },
    );
    second['event.timestamp'] = '2025-07-14T11:00:00.000Z';

    await recordTokenUsageFromApiResponse(config, first);
    await recordTokenUsageFromApiResponse(config, second);

    mockContext.services.config = config;
  }

  it('should open stats dialog when run with no subcommand in interactive mode', () => {
    if (!statsCommand.action) throw new Error('Command has no action');

    const result = statsCommand.action(mockContext, '') as {
      type: string;
      dialog: string;
    };

    expect(result).toEqual({ type: 'dialog', dialog: 'stats' });
    expect(mockContext.ui.addItem).not.toHaveBeenCalled();
  });

  it('should display model stats when using the "model" subcommand', () => {
    const modelSubCommand = statsCommand.subCommands?.find(
      (sc) => sc.name === 'model',
    );
    if (!modelSubCommand?.action) throw new Error('Subcommand has no action');

    modelSubCommand.action(mockContext, '');

    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      {
        type: MessageType.MODEL_STATS,
      },
      expect.any(Number),
    );
  });

  it('should display tool stats when using the "tools" subcommand', () => {
    const toolsSubCommand = statsCommand.subCommands?.find(
      (sc) => sc.name === 'tools',
    );
    if (!toolsSubCommand?.action) throw new Error('Subcommand has no action');

    toolsSubCommand.action(mockContext, '');

    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      {
        type: MessageType.TOOL_STATS,
      },
      expect.any(Number),
    );
  });

  describe('non-interactive mode', () => {
    let nonInteractiveContext: ReturnType<typeof createMockCommandContext>;

    beforeEach(() => {
      nonInteractiveContext = createMockCommandContext({
        executionMode: 'non_interactive',
      });
      nonInteractiveContext.session.stats.sessionStartTime = startTime;
    });

    it('should return text stats without calling addItem', async () => {
      if (!statsCommand.action) throw new Error('Command has no action');

      const result = (await statsCommand.action(nonInteractiveContext, '')) as {
        type: string;
        messageType: string;
        content: string;
      };

      expect(result.type).toBe('message');
      expect(result.messageType).toBe('info');
      expect(result.content).toContain('Session duration');
      expect(result.content).toContain('Prompts');
      expect(nonInteractiveContext.ui.addItem).not.toHaveBeenCalled();
    });

    it('should return info with zero duration if sessionStartTime is not available', async () => {
      if (!statsCommand.action) throw new Error('Command has no action');

      (
        nonInteractiveContext.session.stats as unknown as Record<
          string,
          unknown
        >
      )['sessionStartTime'] = undefined;

      const result = (await statsCommand.action(nonInteractiveContext, '')) as {
        type: string;
        messageType: string;
        content: string;
      };

      expect(result.type).toBe('message');
      expect(result.messageType).toBe('info');
      expect(result.content).toContain('Session duration: 0s');
    });

    it('stats model subcommand should return text in non-interactive mode', async () => {
      const modelSubCommand = statsCommand.subCommands?.find(
        (sc) => sc.name === 'model',
      );
      if (!modelSubCommand?.action) throw new Error('Subcommand has no action');

      const result = (await modelSubCommand.action(
        nonInteractiveContext,
        '',
      )) as { type: string; content: string };

      expect(result.type).toBe('message');
      expect(nonInteractiveContext.ui.addItem).not.toHaveBeenCalled();
    });

    it('stats tools subcommand should return text in non-interactive mode', async () => {
      const toolsSubCommand = statsCommand.subCommands?.find(
        (sc) => sc.name === 'tools',
      );
      if (!toolsSubCommand?.action) throw new Error('Subcommand has no action');

      const result = (await toolsSubCommand.action(
        nonInteractiveContext,
        '',
      )) as { type: string; content: string };

      expect(result.type).toBe('message');
      expect(nonInteractiveContext.ui.addItem).not.toHaveBeenCalled();
    });

    it('stats model shows cost when pricing is configured', async () => {
      const modelSubCommand = statsCommand.subCommands?.find(
        (sc) => sc.name === 'model',
      );
      if (!modelSubCommand?.action) throw new Error('Subcommand has no action');

      const contextWithPricing = createMockCommandContext({
        executionMode: 'non_interactive',
      });
      // Set up settings with modelPricing
      (
        contextWithPricing.services.settings as unknown as Record<
          string,
          unknown
        >
      )['merged'] = {
        modelPricing: {
          'test-model': {
            inputPerMillionTokens: 0.3,
            outputPerMillionTokens: 1.2,
          },
        },
      };
      // Set up model metrics
      contextWithPricing.session.stats.metrics.models = {
        'test-model': toModelMetrics({
          tokens: {
            prompt: 1_000_000,
            candidates: 500_000,
            cached: 0,
            total: 1_500_000,
            thoughts: 0,
          },
          api: {
            totalRequests: 10,
            totalErrors: 0,
            totalLatencyMs: 0,
          },
        }),
      };

      const result = (await modelSubCommand.action(contextWithPricing, '')) as {
        type: string;
        content: string;
      };

      expect(result.type).toBe('message');
      expect(result.content).toContain('test-model');
      expect(result.content).toContain('prompt=1000000');
      expect(result.content).toContain('Estimated cost: $0.9000');
    });

    it('stats model does not show cost when pricing is not configured', async () => {
      const modelSubCommand = statsCommand.subCommands?.find(
        (sc) => sc.name === 'model',
      );
      if (!modelSubCommand?.action) throw new Error('Subcommand has no action');

      const contextWithoutPricing = createMockCommandContext({
        executionMode: 'non_interactive',
      });
      // Set up model metrics without pricing
      contextWithoutPricing.session.stats.metrics.models = {
        'test-model': toModelMetrics({
          tokens: {
            prompt: 1_000_000,
            candidates: 500_000,
            cached: 0,
            total: 1_500_000,
            thoughts: 0,
          },
          api: {
            totalRequests: 10,
            totalErrors: 0,
            totalLatencyMs: 0,
          },
        }),
      };

      const result = (await modelSubCommand.action(
        contextWithoutPricing,
        '',
      )) as { type: string; content: string };

      expect(result.type).toBe('message');
      expect(result.content).toContain('test-model');
      expect(result.content).not.toContain('Estimated cost');
    });

    it('stats model shows cost per model when multiple models have pricing', async () => {
      const modelSubCommand = statsCommand.subCommands?.find(
        (sc) => sc.name === 'model',
      );
      if (!modelSubCommand?.action) throw new Error('Subcommand has no action');

      const context = createMockCommandContext({
        executionMode: 'non_interactive',
      });
      // Set up settings with multiple model pricing
      (context.services.settings as unknown as Record<string, unknown>)[
        'merged'
      ] = {
        modelPricing: {
          'model-a': {
            inputPerMillionTokens: 0.5,
            outputPerMillionTokens: 1.5,
          },
          'model-b': {
            inputPerMillionTokens: 0.1,
            outputPerMillionTokens: 0.5,
          },
        },
      };
      // Set up multiple model metrics
      context.session.stats.metrics.models = {
        'model-a': toModelMetrics({
          tokens: {
            prompt: 2_000_000,
            candidates: 1_000_000,
            cached: 0,
            total: 3_000_000,
            thoughts: 0,
          },
          api: {
            totalRequests: 20,
            totalErrors: 0,
            totalLatencyMs: 0,
          },
        }),
        'model-b': toModelMetrics({
          tokens: {
            prompt: 500_000,
            candidates: 200_000,
            cached: 0,
            total: 700_000,
            thoughts: 0,
          },
          api: {
            totalRequests: 5,
            totalErrors: 0,
            totalLatencyMs: 0,
          },
        }),
      };

      const result = (await modelSubCommand.action(context, '')) as {
        type: string;
        content: string;
      };

      expect(result.type).toBe('message');
      expect(result.content).toContain('model-a');
      expect(result.content).toContain('model-b');
      // model-a: 2M * $0.50 + 1M * $1.50 = $1.00 + $1.50 = $2.50
      // model-b: 500K * $0.10 + 200K * $0.50 = $0.05 + $0.10 = $0.15
      expect(result.content).toContain('Estimated cost: $2.5000');
      expect(result.content).toContain('Estimated cost: $0.1500');
    });

    it('stats model shows cost only for models with pricing', async () => {
      const modelSubCommand = statsCommand.subCommands?.find(
        (sc) => sc.name === 'model',
      );
      if (!modelSubCommand?.action) throw new Error('Subcommand has no action');

      const context = createMockCommandContext({
        executionMode: 'non_interactive',
      });
      // Only model-a has pricing
      (context.services.settings as unknown as Record<string, unknown>)[
        'merged'
      ] = {
        modelPricing: {
          'model-a': {
            inputPerMillionTokens: 0.3,
            outputPerMillionTokens: 1.2,
          },
          // model-b has no pricing
        },
      };
      context.session.stats.metrics.models = {
        'model-a': toModelMetrics({
          tokens: {
            prompt: 1_000_000,
            candidates: 1_000_000,
            cached: 0,
            total: 2_000_000,
            thoughts: 0,
          },
          api: {
            totalRequests: 10,
            totalErrors: 0,
            totalLatencyMs: 0,
          },
        }),
        'model-b': toModelMetrics({
          tokens: {
            prompt: 1_000_000,
            candidates: 1_000_000,
            cached: 0,
            total: 2_000_000,
            thoughts: 0,
          },
          api: {
            totalRequests: 10,
            totalErrors: 0,
            totalLatencyMs: 0,
          },
        }),
      };

      const result = (await modelSubCommand.action(context, '')) as {
        type: string;
        content: string;
      };

      expect(result.type).toBe('message');
      // model-a has pricing
      expect(result.content).toContain('model-a');
      // model-b has no pricing
      expect(result.content).toContain('model-b');
      // Count occurrences of "Estimated cost"
      const costMatches = result.content.match(/Estimated cost/g);
      expect(costMatches).toBeTruthy();
      expect(costMatches!.length).toBe(1);
    });

    it('stats model handles zero tokens with pricing', async () => {
      const modelSubCommand = statsCommand.subCommands?.find(
        (sc) => sc.name === 'model',
      );
      if (!modelSubCommand?.action) throw new Error('Subcommand has no action');

      const context = createMockCommandContext({
        executionMode: 'non_interactive',
      });
      (context.services.settings as unknown as Record<string, unknown>)[
        'merged'
      ] = {
        modelPricing: {
          'test-model': {
            inputPerMillionTokens: 0.3,
            outputPerMillionTokens: 1.2,
          },
        },
      };
      context.session.stats.metrics.models = {
        'test-model': toModelMetrics({
          tokens: {
            prompt: 0,
            candidates: 0,
            cached: 0,
            total: 0,
            thoughts: 0,
          },
          api: {
            totalRequests: 0,
            totalErrors: 0,
            totalLatencyMs: 0,
          },
        }),
      };

      const result = (await modelSubCommand.action(context, '')) as {
        type: string;
        content: string;
      };

      expect(result.type).toBe('message');
      expect(result.content).toContain('test-model');
      // Zero tokens mean zero cost, so no cost line should appear
      expect(result.content).not.toContain('Estimated cost');
    });

    it('stats model handles partial pricing (input only)', async () => {
      const modelSubCommand = statsCommand.subCommands?.find(
        (sc) => sc.name === 'model',
      );
      if (!modelSubCommand?.action) throw new Error('Subcommand has no action');

      const context = createMockCommandContext({
        executionMode: 'non_interactive',
      });
      (context.services.settings as unknown as Record<string, unknown>)[
        'merged'
      ] = {
        modelPricing: {
          'test-model': {
            inputPerMillionTokens: 0.3,
            // No output pricing
          },
        },
      };
      context.session.stats.metrics.models = {
        'test-model': toModelMetrics({
          tokens: {
            prompt: 1_000_000,
            candidates: 1_000_000,
            cached: 0,
            total: 2_000_000,
            thoughts: 0,
          },
          api: {
            totalRequests: 10,
            totalErrors: 0,
            totalLatencyMs: 0,
          },
        }),
      };

      const result = (await modelSubCommand.action(context, '')) as {
        type: string;
        content: string;
      };

      expect(result.type).toBe('message');
      // 1M input tokens * $0.30/M = $0.30
      expect(result.content).toContain('Estimated cost: $0.3000');
    });
  });

  describe('historical token usage subcommands', () => {
    it('stats daily returns persisted token usage in non-interactive mode', async () => {
      await seedUsage();
      const dailySubCommand = statsCommand.subCommands?.find(
        (sc) => sc.name === 'daily',
      );
      if (!dailySubCommand?.action) {
        throw new Error('Subcommand has no action');
      }

      const result = (await dailySubCommand.action(
        createMockCommandContext({
          executionMode: 'non_interactive',
          services: { config: mockContext.services.config },
        }),
        '2025-07-14',
      )) as { type: string; messageType: string; content: string };

      expect(result.type).toBe('message');
      expect(result.messageType).toBe('info');
      expect(result.content).toContain('Daily token usage for 2025-07-14');
      expect(result.content).toContain('Total: 47 tokens');
      expect(result.content).toContain('Cached (included in Input): 6');
      expect(result.content).toContain('model-a: 32 tokens');
      expect(result.content).toContain('model-b: 15 tokens');
      expect(result.content).toContain('vertex-ai: 15 tokens');
      expect(result.content).toContain('main: 47 tokens');
      expect(result.content).not.toContain('API response duration only');
      expect(result.content).toContain('TTFT/TPS');
    });

    it('stats monthly writes persisted token usage to the interactive history', async () => {
      await seedUsage();
      const monthlySubCommand = statsCommand.subCommands?.find(
        (sc) => sc.name === 'monthly',
      );
      if (!monthlySubCommand?.action) {
        throw new Error('Subcommand has no action');
      }

      await monthlySubCommand.action(mockContext, '2025-07');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: expect.stringContaining('Monthly token usage for 2025-07'),
        },
        expect.any(Number),
      );
    });

    it('stats daily surfaces usage file read failures', async () => {
      await seedUsage();
      const dailySubCommand = statsCommand.subCommands?.find(
        (sc) => sc.name === 'daily',
      );
      if (!dailySubCommand?.action) {
        throw new Error('Subcommand has no action');
      }

      const usageFile = getTokenUsageFilePath('2025-07');
      await rm(usageFile, { force: true });
      await mkdir(usageFile);

      const result = (await dailySubCommand.action(
        createMockCommandContext({
          executionMode: 'non_interactive',
          services: { config: mockContext.services.config },
        }),
        '2025-07-14',
      )) as { type: string; messageType: string; content: string };

      expect(result.messageType).toBe('error');
      expect(result.content).toContain('Failed to load token usage stats');
      expect(result.content).not.toContain('Total: 0 tokens');
    });

    it('stats export writes CSV with a default filename', async () => {
      await seedUsage();
      const exportSubCommand = statsCommand.subCommands?.find(
        (sc) => sc.name === 'export',
      );
      if (!exportSubCommand?.action) {
        throw new Error('Subcommand has no action');
      }

      const result = (await exportSubCommand.action(
        createMockCommandContext({
          executionMode: 'non_interactive',
          services: { config: mockContext.services.config },
        }),
        'monthly 2025-07 --format csv',
      )) as { type: string; messageType: string; content: string };

      expect(result).toMatchObject({
        type: 'message',
        messageType: 'info',
      });
      expect(result.content).toContain(
        'Token usage exported to CSV: qwen-token-usage-month-2025-07.csv',
      );
      const csv = await readFile(
        path.join(tempDir, 'qwen-token-usage-month-2025-07.csv'),
        'utf-8',
      );
      expect(csv).toContain(
        'period,value,group_type,group_key,model,auth_type,source,requests,input_tokens,output_tokens,cached_tokens,thoughts_tokens,total_tokens,api_duration_ms',
      );
      expect(csv).toContain('month,2025-07,total,total,,,,2,17,28,6,2,47,300');
    });

    it('stats export adds interactive info and error messages', async () => {
      await seedUsage();
      const exportSubCommand = statsCommand.subCommands?.find(
        (sc) => sc.name === 'export',
      );
      if (!exportSubCommand?.action) {
        throw new Error('Subcommand has no action');
      }

      const infoResult = await exportSubCommand.action(
        mockContext,
        'monthly 2025-07 --format csv',
      );

      expect(infoResult).toBeUndefined();
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: expect.stringContaining('Token usage exported to CSV'),
        },
        expect.any(Number),
      );

      const errorContext = createMockCommandContext({
        services: { config: mockContext.services.config },
      });
      const errorResult = await exportSubCommand.action(
        errorContext,
        'monthly 2025-07 --output ../outside.csv',
      );

      expect(errorResult).toBeUndefined();
      expect(errorContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.ERROR,
          text: expect.stringContaining('within the project working directory'),
        },
        expect.any(Number),
      );
    });

    it('stats export writes JSON to an explicit output path', async () => {
      await seedUsage();
      const exportSubCommand = statsCommand.subCommands?.find(
        (sc) => sc.name === 'export',
      );
      if (!exportSubCommand?.action) {
        throw new Error('Subcommand has no action');
      }

      const result = (await exportSubCommand.action(
        createMockCommandContext({
          executionMode: 'non_interactive',
          services: { config: mockContext.services.config },
        }),
        'daily 2025-07-14 --format json --output usage/day.json',
      )) as { type: string; messageType: string; content: string };

      expect(result.messageType).toBe('info');
      expect(result.content).toContain('usage');
      const json = JSON.parse(
        await readFile(path.join(tempDir, 'usage', 'day.json'), 'utf-8'),
      ) as {
        totals: { totalTokens: number };
        byModel: Array<{ key: string }>;
        coordination?: unknown;
      };
      expect(json.totals.totalTokens).toBe(47);
      expect(json.coordination).toBeUndefined();
      expect(json.byModel.map((group) => group.key)).toEqual([
        'model-a',
        'model-b',
      ]);
    });

    it('stats export accepts equals syntax for format and output', async () => {
      await seedUsage();
      const exportSubCommand = statsCommand.subCommands?.find(
        (sc) => sc.name === 'export',
      );
      if (!exportSubCommand?.action) {
        throw new Error('Subcommand has no action');
      }

      const result = (await exportSubCommand.action(
        createMockCommandContext({
          executionMode: 'non_interactive',
          services: { config: mockContext.services.config },
        }),
        'daily 2025-07-14 --format=json --output=usage/day-equals.json',
      )) as { type: string; messageType: string; content: string };

      expect(result.messageType).toBe('info');
      const json = JSON.parse(
        await readFile(path.join(tempDir, 'usage', 'day-equals.json'), 'utf-8'),
      ) as { totals: { totalTokens: number } };
      expect(json.totals.totalTokens).toBe(47);
    });

    it('stats export accepts short format and output flags', async () => {
      await seedUsage();
      const exportSubCommand = statsCommand.subCommands?.find(
        (sc) => sc.name === 'export',
      );
      if (!exportSubCommand?.action) {
        throw new Error('Subcommand has no action');
      }

      const result = (await exportSubCommand.action(
        createMockCommandContext({
          executionMode: 'non_interactive',
          services: { config: mockContext.services.config },
        }),
        'monthly 2025-07 -f csv -o usage/month-short.csv',
      )) as { type: string; messageType: string; content: string };

      expect(result.messageType).toBe('info');
      await expect(
        readFile(path.join(tempDir, 'usage', 'month-short.csv'), 'utf-8'),
      ).resolves.toContain('month,2025-07,total,total');
    });

    it('stats export preserves Windows-style backslashes in output paths', async () => {
      await seedUsage();
      const exportSubCommand = statsCommand.subCommands?.find(
        (sc) => sc.name === 'export',
      );
      if (!exportSubCommand?.action) {
        throw new Error('Subcommand has no action');
      }

      const result = (await exportSubCommand.action(
        createMockCommandContext({
          executionMode: 'non_interactive',
          services: { config: mockContext.services.config },
        }),
        'monthly 2025-07 --output usage\\month.csv',
      )) as { type: string; messageType: string; content: string };

      expect(result.messageType).toBe('info');
      const expectedPath =
        process.platform === 'win32'
          ? path.join(tempDir, 'usage', 'month.csv')
          : path.join(tempDir, 'usage\\month.csv');
      const csv = await readFile(expectedPath, 'utf-8');
      expect(csv).toContain('month,2025-07,total,total');
    });

    it('stats export preserves quoted Windows-style backslashes in output paths', async () => {
      await seedUsage();
      const exportSubCommand = statsCommand.subCommands?.find(
        (sc) => sc.name === 'export',
      );
      if (!exportSubCommand?.action) {
        throw new Error('Subcommand has no action');
      }

      const result = (await exportSubCommand.action(
        createMockCommandContext({
          executionMode: 'non_interactive',
          services: { config: mockContext.services.config },
        }),
        'monthly 2025-07 --output "usage\\\\quoted month.csv"',
      )) as { type: string; messageType: string; content: string };

      expect(result.messageType).toBe('info');
      const expectedPath =
        process.platform === 'win32'
          ? path.join(tempDir, 'usage', 'quoted month.csv')
          : path.join(tempDir, 'usage\\\\quoted month.csv');
      const csv = await readFile(expectedPath, 'utf-8');
      expect(csv).toContain('month,2025-07,total,total');
    });

    it('stats export rejects paths outside the working directory', async () => {
      await seedUsage();
      const exportSubCommand = statsCommand.subCommands?.find(
        (sc) => sc.name === 'export',
      );
      if (!exportSubCommand?.action) {
        throw new Error('Subcommand has no action');
      }

      const result = (await exportSubCommand.action(
        createMockCommandContext({
          executionMode: 'non_interactive',
          services: { config: mockContext.services.config },
        }),
        'monthly 2025-07 --output ../outside.csv',
      )) as { type: string; messageType: string; content: string };

      expect(result.messageType).toBe('error');
      expect(result.content).toContain('within the project working directory');
    });

    it('stats export rejects symlinked directories that resolve outside the working directory', async () => {
      await seedUsage();
      const exportSubCommand = statsCommand.subCommands?.find(
        (sc) => sc.name === 'export',
      );
      if (!exportSubCommand?.action) {
        throw new Error('Subcommand has no action');
      }

      const outsideDir = await mkdtemp(
        path.join(tmpdir(), 'qwen-stats-outside-'),
      );
      try {
        const linkPath = path.join(tempDir, 'linked-outside');
        await symlink(
          outsideDir,
          linkPath,
          process.platform === 'win32' ? 'junction' : 'dir',
        );

        const result = (await exportSubCommand.action(
          createMockCommandContext({
            executionMode: 'non_interactive',
            services: { config: mockContext.services.config },
          }),
          `monthly 2025-07 --output ${path.join('linked-outside', 'usage.csv')}`,
        )) as { type: string; messageType: string; content: string };

        expect(result.messageType).toBe('error');
        expect(result.content).toContain(
          'within the project working directory',
        );
        await expect(
          access(path.join(outsideDir, 'usage.csv')),
        ).rejects.toThrow();
      } finally {
        await rm(outsideDir, { recursive: true, force: true });
      }
    });

    it('stats export rejects symlinked output files before writing', async () => {
      await seedUsage();
      const exportSubCommand = statsCommand.subCommands?.find(
        (sc) => sc.name === 'export',
      );
      if (!exportSubCommand?.action) {
        throw new Error('Subcommand has no action');
      }

      const outsideDir = await mkdtemp(
        path.join(tmpdir(), 'qwen-stats-outside-'),
      );
      try {
        const outsideFile = path.join(outsideDir, 'usage.csv');
        await writeFile(outsideFile, 'outside-original', 'utf-8');

        try {
          await symlink(outsideFile, path.join(tempDir, 'linked-file.csv'));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EPERM') {
            return;
          }
          throw error;
        }

        const result = (await exportSubCommand.action(
          createMockCommandContext({
            executionMode: 'non_interactive',
            services: { config: mockContext.services.config },
          }),
          'monthly 2025-07 --output linked-file.csv',
        )) as { type: string; messageType: string; content: string };

        expect(result.messageType).toBe('error');
        expect(result.content).toContain(
          'within the project working directory',
        );
        await expect(readFile(outsideFile, 'utf-8')).resolves.toBe(
          'outside-original',
        );
      } finally {
        await rm(outsideDir, { recursive: true, force: true });
      }
    });

    it('stats export writes through the real output directory after validation', async () => {
      await seedUsage();
      const exportSubCommand = statsCommand.subCommands?.find(
        (sc) => sc.name === 'export',
      );
      if (!exportSubCommand?.action) {
        throw new Error('Subcommand has no action');
      }

      const result = (await exportSubCommand.action(
        createMockCommandContext({
          executionMode: 'non_interactive',
          services: { config: mockContext.services.config },
        }),
        'monthly 2025-07 --output nested/real.csv',
      )) as { type: string; messageType: string; content: string };

      expect(result.messageType).toBe('info');
      await expect(
        readFile(path.join(tempDir, 'nested', 'real.csv'), 'utf-8'),
      ).resolves.toContain('month,2025-07,total,total');
    });

    it('stats export replaces existing hardlinks without mutating the linked outside file', async () => {
      await seedUsage();
      const exportSubCommand = statsCommand.subCommands?.find(
        (sc) => sc.name === 'export',
      );
      if (!exportSubCommand?.action) {
        throw new Error('Subcommand has no action');
      }

      const outsideDir = await mkdtemp(
        path.join(tmpdir(), 'qwen-stats-outside-'),
      );
      try {
        const outsideFile = path.join(outsideDir, 'usage.csv');
        const hardlinkPath = path.join(tempDir, 'hardlink.csv');
        await writeFile(outsideFile, 'outside-original', 'utf-8');
        await link(outsideFile, hardlinkPath);

        const result = (await exportSubCommand.action(
          createMockCommandContext({
            executionMode: 'non_interactive',
            services: { config: mockContext.services.config },
          }),
          'monthly 2025-07 --output hardlink.csv',
        )) as { type: string; messageType: string; content: string };

        expect(result.messageType).toBe('info');
        await expect(readFile(outsideFile, 'utf-8')).resolves.toBe(
          'outside-original',
        );
        await expect(readFile(hardlinkPath, 'utf-8')).resolves.toContain(
          'month,2025-07,total,total',
        );
      } finally {
        await rm(outsideDir, { recursive: true, force: true });
      }
    });

    it('stats export reports a missing final target after rename', async () => {
      await seedUsage();
      const exportSubCommand = statsCommand.subCommands?.find(
        (sc) => sc.name === 'export',
      );
      if (!exportSubCommand?.action) {
        throw new Error('Subcommand has no action');
      }

      const { rename: realRename } =
        await vi.importActual<typeof import('node:fs/promises')>(
          'node:fs/promises',
        );
      fsPromisesMock.rename.mockImplementationOnce(async (oldPath, newPath) => {
        await realRename(oldPath, newPath);
        await rm(newPath, { force: true });
      });

      const result = (await exportSubCommand.action(
        createMockCommandContext({
          executionMode: 'non_interactive',
          services: { config: mockContext.services.config },
        }),
        'monthly 2025-07 --output missing-after-rename.csv',
      )) as { type: string; messageType: string; content: string };

      expect(result.messageType).toBe('error');
      expect(result.content).toContain('Export target does not exist:');
      expect(result.content).toContain('missing-after-rename.csv');
    });

    it('stats export retries temporary file name collisions', async () => {
      await seedUsage();
      const exportSubCommand = statsCommand.subCommands?.find(
        (sc) => sc.name === 'export',
      );
      if (!exportSubCommand?.action) {
        throw new Error('Subcommand has no action');
      }
      fsPromisesMock.open.mockClear();
      fsPromisesMock.open.mockRejectedValueOnce(
        Object.assign(new Error('exists'), { code: 'EEXIST' }),
      );

      const result = (await exportSubCommand.action(
        createMockCommandContext({
          executionMode: 'non_interactive',
          services: { config: mockContext.services.config },
        }),
        'monthly 2025-07 --output retry.csv',
      )) as { type: string; messageType: string; content: string };

      expect(result.messageType).toBe('info');
      expect(fsPromisesMock.open).toHaveBeenCalledTimes(2);
      await expect(
        readFile(path.join(tempDir, 'retry.csv'), 'utf-8'),
      ).resolves.toContain('month,2025-07,total,total');
    });

    it('stats export reports temporary file collision exhaustion', async () => {
      await seedUsage();
      const exportSubCommand = statsCommand.subCommands?.find(
        (sc) => sc.name === 'export',
      );
      if (!exportSubCommand?.action) {
        throw new Error('Subcommand has no action');
      }
      fsPromisesMock.open.mockClear();
      fsPromisesMock.open.mockRejectedValue(
        Object.assign(new Error('exists'), { code: 'EEXIST' }),
      );

      const result = (await exportSubCommand.action(
        createMockCommandContext({
          executionMode: 'non_interactive',
          services: { config: mockContext.services.config },
        }),
        'monthly 2025-07 --output exhausted.csv',
      )) as { type: string; messageType: string; content: string };

      expect(result.messageType).toBe('error');
      expect(result.content).toContain(
        'Could not create a temporary export file.',
      );
      expect(fsPromisesMock.open).toHaveBeenCalledTimes(10);
    });

    it('stats export rejects Windows alternate data stream output paths', async () => {
      if (process.platform !== 'win32') {
        return;
      }

      await seedUsage();
      const exportSubCommand = statsCommand.subCommands?.find(
        (sc) => sc.name === 'export',
      );
      if (!exportSubCommand?.action) {
        throw new Error('Subcommand has no action');
      }

      const result = (await exportSubCommand.action(
        createMockCommandContext({
          executionMode: 'non_interactive',
          services: { config: mockContext.services.config },
        }),
        'monthly 2025-07 --output usage.csv:stream',
      )) as { type: string; messageType: string; content: string };

      expect(result.messageType).toBe('error');
      expect(result.content).toContain('within the project working directory');
      await expect(access(path.join(tempDir, 'usage.csv'))).rejects.toThrow();
    });

    it('stats export reports invalid arguments', async () => {
      const exportSubCommand = statsCommand.subCommands?.find(
        (sc) => sc.name === 'export',
      );
      if (!exportSubCommand?.action) {
        throw new Error('Subcommand has no action');
      }

      const result = (await exportSubCommand.action(
        createMockCommandContext({
          executionMode: 'non_interactive',
          services: { config: mockContext.services.config },
        }),
        'monthly 2025-07 --format xml',
      )) as { type: string; messageType: string; content: string };

      expect(result.messageType).toBe('error');
      expect(result.content).toContain(
        'Expected --format csv or --format json',
      );
    });

    it('stats export preserves doubled backslashes inside quoted arguments', async () => {
      const exportSubCommand = statsCommand.subCommands?.find(
        (sc) => sc.name === 'export',
      );
      if (!exportSubCommand?.action) {
        throw new Error('Subcommand has no action');
      }

      const result = (await exportSubCommand.action(
        createMockCommandContext({
          executionMode: 'non_interactive',
          services: { config: mockContext.services.config },
        }),
        'monthly 2025-07 out.csv "usage\\\\extra.csv"',
      )) as { type: string; messageType: string; content: string };

      expect(result.messageType).toBe('error');
      expect(result.content).toContain(
        'Unexpected argument: usage\\\\extra.csv',
      );
    });

    it('stats export reports unclosed quotes', async () => {
      const exportSubCommand = statsCommand.subCommands?.find(
        (sc) => sc.name === 'export',
      );
      if (!exportSubCommand?.action) {
        throw new Error('Subcommand has no action');
      }

      const result = (await exportSubCommand.action(
        createMockCommandContext({
          executionMode: 'non_interactive',
          services: { config: mockContext.services.config },
        }),
        'monthly 2025-07 --format "json',
      )) as { type: string; messageType: string; content: string };

      expect(result.messageType).toBe('error');
      expect(result.content).toContain('Unclosed quote in arguments');
    });

    it('uses locale translations for historical token usage output', async () => {
      await seedUsage();
      await setLanguageAsync('zh');
      const dailySubCommand = statsCommand.subCommands?.find(
        (sc) => sc.name === 'daily',
      );
      const exportSubCommand = statsCommand.subCommands?.find(
        (sc) => sc.name === 'export',
      );
      if (!dailySubCommand?.action || !exportSubCommand?.action) {
        throw new Error('Subcommand has no action');
      }

      expect(dailySubCommand.description).toBe('显示每日 token 使用统计信息');
      expect(exportSubCommand.description).toBe(
        '将 token 使用统计信息导出为 CSV 或 JSON',
      );

      const dailyResult = (await dailySubCommand.action(
        createMockCommandContext({
          executionMode: 'non_interactive',
          services: { config: mockContext.services.config },
        }),
        '2025-07-14',
      )) as { type: string; messageType: string; content: string };

      expect(dailyResult.content).toContain('2025-07-14 的每日 token 使用情况');
      expect(dailyResult.content).toContain('总计：47 个 token');
      expect(dailyResult.content).toContain('model-a：32 个 token（1 个请求）');
      expect(dailyResult.content).toContain('缓存（已包含在输入中）：6');
      expect(dailyResult.content).toContain('按来源：');
      expect(dailyResult.content).toContain(
        '生成耗时（TTFT/TPS）归属于生成指标',
      );

      const exportResult = (await exportSubCommand.action(
        createMockCommandContext({
          executionMode: 'non_interactive',
          services: { config: mockContext.services.config },
        }),
        'monthly 2025-07 --output ../outside.csv',
      )) as { type: string; messageType: string; content: string };

      expect(exportResult.messageType).toBe('error');
      expect(exportResult.content).toContain(
        'Token 使用导出路径必须位于项目工作目录内',
      );
    });
  });
});
