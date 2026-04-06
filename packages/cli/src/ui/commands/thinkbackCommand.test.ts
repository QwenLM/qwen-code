/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { thinkbackCommand } from './thinkbackCommand.js';
import type { CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

const mockGenerateContent = vi.fn();
const mockGetHistory = vi.fn();

const mockGeminiClient = {
  getChat: vi.fn(() => ({
    getHistory: mockGetHistory,
  })),
  generateContent: mockGenerateContent,
};

describe('thinkbackCommand', () => {
  let mockContext: CommandContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockContext = createMockCommandContext({
      executionMode: 'interactive',
      services: {
        config: {
          getGeminiClient: vi.fn(() => mockGeminiClient),
          getModel: vi.fn(() => 'test-model'),
        } as unknown as CommandContext['services']['config'],
      },
      ui: {
        addItem: vi.fn(),
        setPendingItem: vi.fn(),
      },
    } as unknown as CommandContext);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('handles empty history', async () => {
    mockGetHistory.mockReturnValue([]);

    if (!thinkbackCommand.action) {
      throw new Error('thinkback command must have action');
    }

    const result = await thinkbackCommand.action(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'No conversation found to review.',
    });
  });

  it('generates thinkback timeline', async () => {
    mockGetHistory.mockReturnValue([
      { role: 'user', parts: [{ text: 'query 1' }] },
      { role: 'model', parts: [{ text: 'response 1' }] },
      { role: 'user', parts: [{ text: 'query 2' }] },
      { role: 'model', parts: [{ text: 'response 2' }] },
    ]);

    mockGenerateContent.mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [{ text: '# Timeline Review\n- **Step 1**' }],
          },
        },
      ],
    });

    if (!thinkbackCommand.action) {
      throw new Error('thinkback command must have action');
    }

    const result = await thinkbackCommand.action(mockContext, '');

    expect(mockGenerateContent).toHaveBeenCalled();
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: '# Timeline Review\n- **Step 1**',
    });
  });

  it('generates thinkback timeline in ACP mode', async () => {
    const acpContext = createMockCommandContext({
      executionMode: 'acp',
      services: {
        config: {
          getGeminiClient: vi.fn(() => mockGeminiClient),
          getModel: vi.fn(() => 'test-model'),
        } as unknown as CommandContext['services']['config'],
      },
    } as unknown as CommandContext);

    mockGetHistory.mockReturnValue([
      { role: 'user', parts: [{ text: 'query 1' }] },
      { role: 'model', parts: [{ text: 'response 1' }] },
      { role: 'user', parts: [{ text: 'query 2' }] },
    ]);

    mockGenerateContent.mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [{ text: '# Timeline Review\n- **Step 1**' }],
          },
        },
      ],
    });

    if (!thinkbackCommand.action) {
      throw new Error('thinkback command must have action');
    }

    const result = await thinkbackCommand.action(acpContext, '');

    expect(result).toBeDefined();
    expect((result as { type: string }).type).toBe('stream_messages');

    const messages = (result as { messages: AsyncGenerator }).messages;
    const collected: Array<{ messageType: string; content: string }> = [];
    for await (const msg of messages) {
      collected.push(msg as { messageType: string; content: string });
    }

    expect(collected).toHaveLength(2);
    expect(collected[0]).toEqual({
      messageType: 'info',
      content: 'Generating thinkback timeline...',
    });
    expect(collected[1]).toEqual({
      messageType: 'info',
      content: '# Timeline Review\n- **Step 1**',
    });
  });

  it('handles --from and --topic arguments', async () => {
    mockGetHistory.mockReturnValue([
      { role: 'user', parts: [{ text: 'query 1' }] },
      { role: 'model', parts: [{ text: 'response 1' }] },
      { role: 'user', parts: [{ text: 'query 2' }] },
    ]);

    mockGenerateContent.mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [{ text: '# Timeline Review\n- **Step 1**' }],
          },
        },
      ],
    });

    if (!thinkbackCommand.action) {
      throw new Error('thinkback command must have action');
    }

    const result = await thinkbackCommand.action(
      mockContext,
      '--from "1h ago" --topic "auth"',
    );

    expect(mockGenerateContent).toHaveBeenCalled();

    // Validate the prompt string
    const callArgs = mockGenerateContent.mock.calls[0][0];
    const userPrompt = callArgs[callArgs.length - 1].parts[0].text;
    expect(userPrompt).toContain(
      'Only include events from the time period corresponding to: 1h ago',
    );
    expect(userPrompt).toContain(
      'Only focus on events related to the topic: auth',
    );

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: '# Timeline Review\n- **Step 1**',
    });
  });

  it('handles missing config gracefully', async () => {
    const noConfigContext = createMockCommandContext({
      services: {
        config: null,
      },
    } as unknown as CommandContext);

    if (!thinkbackCommand.action) {
      throw new Error('thinkback command must have action');
    }

    const result = await thinkbackCommand.action(noConfigContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Config not loaded.',
    });
  });

  it('handles concurrent generation in interactive mode', async () => {
    mockContext.ui.pendingItem = {
      type: 'info',
    } as unknown as import('../types.js').HistoryItemWithoutId;

    if (!thinkbackCommand.action) {
      throw new Error('thinkback command must have action');
    }

    const result = await thinkbackCommand.action(mockContext, '');

    expect(mockContext.ui.addItem).toHaveBeenCalled();
    // Interactive mode returns void — ui.addItem already showed the error.
    expect(result).toBeUndefined();
  });
});
