/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { statsCommand } from './statsCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { MessageType } from '../types.js';
import { formatDuration } from '../utils/formatters.js';
import { MAIN_SOURCE } from '@qwen-code/qwen-code-core';
import type { ModelMetricsCore, ModelMetrics } from '@qwen-code/qwen-code-core';

const toModelMetrics = (core: ModelMetricsCore): ModelMetrics => ({
  ...core,
  bySource: { [MAIN_SOURCE]: core },
});

describe('statsCommand', () => {
  let mockContext: CommandContext;
  const startTime = new Date('2025-07-14T10:00:00.000Z');
  const endTime = new Date('2025-07-14T10:00:30.000Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(endTime);

    // 1. Create the mock context with all default values
    mockContext = createMockCommandContext();

    // 2. Directly set the property on the created mock context
    mockContext.session.stats.sessionStartTime = startTime;
  });

  it('should display general session stats when run with no subcommand', () => {
    if (!statsCommand.action) throw new Error('Command has no action');

    statsCommand.action(mockContext, '');

    const expectedDuration = formatDuration(
      endTime.getTime() - startTime.getTime(),
    );
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      {
        type: MessageType.STATS,
        duration: expectedDuration,
      },
      expect.any(Number),
    );
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

    it('should return error if sessionStartTime is not available', async () => {
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
      };

      expect(result.type).toBe('message');
      expect(result.messageType).toBe('error');
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
            tool: 0,
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
            tool: 0,
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
            tool: 0,
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
            tool: 0,
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
            tool: 0,
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
            tool: 0,
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
            tool: 0,
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
            tool: 0,
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
});
