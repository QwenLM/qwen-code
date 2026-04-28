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

  it('should display model stats when using the "model" subcommand', async () => {
    const modelSubCommand = statsCommand.subCommands?.find(
      (sc) => sc.name === 'model',
    );
    if (!modelSubCommand?.action) throw new Error('Subcommand has no action');

    await modelSubCommand.action(mockContext, '');

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

      nonInteractiveContext.session.stats.sessionStartTime = undefined;

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

    it('stats model subcommand should include estimated cost when prices are configured', async () => {
      const modelSubCommand = statsCommand.subCommands?.find(
        (sc) => sc.name === 'model',
      );
      if (!modelSubCommand?.action) throw new Error('Subcommand has no action');

      nonInteractiveContext = createMockCommandContext({
        executionMode: 'non_interactive',
        services: {
          settings: {
            merged: {
              billing: {
                currency: 'USD',
                modelPrices: {
                  'gpt-4o': { input: 5, cachedInput: 1, output: 15 },
                },
              },
            },
          },
        },
        session: {
          stats: {
            metrics: {
              models: {
                'gpt-4o': {
                  api: {
                    totalRequests: 1,
                    totalErrors: 0,
                    totalLatencyMs: 100,
                  },
                  tokens: {
                    prompt: 1_000_000,
                    candidates: 500_000,
                    total: 1_500_000,
                    cached: 250_000,
                    thoughts: 0,
                    tool: 0,
                  },
                  bySource: {},
                },
              },
            },
          },
        },
      });

      const result = (await modelSubCommand.action(
        nonInteractiveContext,
        '',
      )) as { type: string; content: string };

      expect(result.type).toBe('message');
      expect(result.content).toContain(
        'gpt-4o: prompt=1000000, output=500000, cached=250000, uncached_input_cost=$3.75, cached_input_cost=$0.25, output_cost=$7.5, cost=$11.5',
      );
      expect(result.content).toContain('Total cost: $11.5');
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
  });
});
