/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { btwCommand } from './btwCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { CommandKind } from './types.js';
import { MessageType } from '../types.js';

vi.mock('../../i18n/index.js', () => ({
  t: (key: string, params?: Record<string, string>) => {
    if (params) {
      return Object.entries(params).reduce(
        (str, [k, v]) => str.replace(`{{${k}}}`, v),
        key,
      );
    }
    return key;
  },
}));

describe('btwCommand', () => {
  let mockContext: CommandContext;
  let mockGenerateContent: ReturnType<typeof vi.fn>;
  let mockGetHistory: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockGenerateContent = vi.fn();
    mockGetHistory = vi.fn().mockReturnValue([]);

    mockContext = createMockCommandContext({
      services: {
        config: {
          getGeminiClient: () => ({
            getHistory: mockGetHistory,
            generateContent: mockGenerateContent,
          }),
          getModel: () => 'test-model',
        },
      },
    });
  });

  it('should have correct metadata', () => {
    expect(btwCommand.name).toBe('btw');
    expect(btwCommand.kind).toBe(CommandKind.BUILT_IN);
    expect(btwCommand.description).toBeTruthy();
  });

  it('should return error when no question is provided', async () => {
    const result = await btwCommand.action!(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Please provide a question. Usage: /btw <your question>',
    });
  });

  it('should return error when only whitespace is provided', async () => {
    const result = await btwCommand.action!(mockContext, '   ');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Please provide a question. Usage: /btw <your question>',
    });
  });

  it('should return error when config is not loaded', async () => {
    const noConfigContext = createMockCommandContext({
      services: { config: null },
    });

    const result = await btwCommand.action!(noConfigContext, 'test question');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Config not loaded.',
    });
  });

  it('should return error when model is not configured', async () => {
    const noModelContext = createMockCommandContext({
      services: {
        config: {
          getGeminiClient: () => ({
            getHistory: mockGetHistory,
            generateContent: mockGenerateContent,
          }),
          getModel: () => '',
        },
      },
    });

    const result = await btwCommand.action!(noModelContext, 'test question');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'No model configured.',
    });
  });

  describe('interactive mode', () => {
    it('should set pending item and add completed item on success', async () => {
      mockGenerateContent.mockResolvedValue({
        candidates: [
          {
            content: {
              parts: [{ text: 'The answer is 42.' }],
            },
          },
        ],
      });

      await btwCommand.action!(mockContext, 'what is the meaning of life?');

      expect(mockContext.ui.setPendingItem).toHaveBeenCalledWith({
        type: MessageType.BTW,
        btw: {
          question: 'what is the meaning of life?',
          answer: '',
          isPending: true,
        },
      });

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.BTW,
          btw: {
            question: 'what is the meaning of life?',
            answer: 'The answer is 42.',
            isPending: false,
          },
        },
        expect.any(Number),
      );

      expect(mockContext.ui.setPendingItem).toHaveBeenLastCalledWith(null);
    });

    it('should pass conversation history to generateContent', async () => {
      const history = [
        { role: 'user', parts: [{ text: 'Hello' }] },
        { role: 'model', parts: [{ text: 'Hi!' }] },
      ];
      mockGetHistory.mockReturnValue(history);
      mockGenerateContent.mockResolvedValue({
        candidates: [{ content: { parts: [{ text: 'answer' }] } }],
      });

      await btwCommand.action!(mockContext, 'my question');

      expect(mockGenerateContent).toHaveBeenCalledWith(
        [
          ...history,
          {
            role: 'user',
            parts: [
              {
                text: expect.stringContaining('my question'),
              },
            ],
          },
        ],
        {},
        expect.any(AbortSignal),
        'test-model',
      );
    });

    it('should add error item on failure', async () => {
      mockGenerateContent.mockRejectedValue(new Error('API error'));

      await btwCommand.action!(mockContext, 'test question');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.ERROR,
          text: 'Failed to answer btw question: API error',
        },
        expect.any(Number),
      );

      expect(mockContext.ui.setPendingItem).toHaveBeenLastCalledWith(null);
    });

    it('should handle non-Error exceptions', async () => {
      mockGenerateContent.mockRejectedValue('string error');

      await btwCommand.action!(mockContext, 'test question');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.ERROR,
          text: 'Failed to answer btw question: string error',
        },
        expect.any(Number),
      );
    });

    it('should return error when another operation is pending', async () => {
      const busyContext = createMockCommandContext({
        services: {
          config: {
            getGeminiClient: () => ({
              getHistory: mockGetHistory,
              generateContent: mockGenerateContent,
            }),
            getModel: () => 'test-model',
          },
        },
        ui: {
          pendingItem: { type: 'info' },
        },
      });

      const result = await btwCommand.action!(busyContext, 'test question');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content:
          'Another operation is in progress. Please wait for it to complete.',
      });
    });

    it('should not add item when abort signal is aborted', async () => {
      const abortController = new AbortController();
      abortController.abort();

      const abortContext = createMockCommandContext({
        abortSignal: abortController.signal,
        services: {
          config: {
            getGeminiClient: () => ({
              getHistory: mockGetHistory,
              generateContent: mockGenerateContent,
            }),
            getModel: () => 'test-model',
          },
        },
      });

      mockGenerateContent.mockResolvedValue({
        candidates: [{ content: { parts: [{ text: 'answer' }] } }],
      });

      await btwCommand.action!(abortContext, 'test question');

      expect(abortContext.ui.addItem).not.toHaveBeenCalled();
      expect(abortContext.ui.setPendingItem).toHaveBeenLastCalledWith(null);
    });

    it('should return fallback text when response has no parts', async () => {
      mockGenerateContent.mockResolvedValue({
        candidates: [{ content: { parts: [] } }],
      });

      await btwCommand.action!(mockContext, 'test question');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.BTW,
          btw: {
            question: 'test question',
            answer: 'No response received.',
            isPending: false,
          },
        },
        expect.any(Number),
      );
    });
  });

  describe('non-interactive mode', () => {
    let nonInteractiveContext: CommandContext;

    beforeEach(() => {
      nonInteractiveContext = createMockCommandContext({
        executionMode: 'non_interactive',
        services: {
          config: {
            getGeminiClient: () => ({
              getHistory: mockGetHistory,
              generateContent: mockGenerateContent,
            }),
            getModel: () => 'test-model',
          },
        },
      });
    });

    it('should return info message on success', async () => {
      mockGenerateContent.mockResolvedValue({
        candidates: [{ content: { parts: [{ text: 'the answer' }] } }],
      });

      const result = await btwCommand.action!(
        nonInteractiveContext,
        'my question',
      );

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: 'btw> my question\nthe answer',
      });
    });

    it('should return error message on failure', async () => {
      mockGenerateContent.mockRejectedValue(new Error('network error'));

      const result = await btwCommand.action!(
        nonInteractiveContext,
        'my question',
      );

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: 'Failed to answer btw question: network error',
      });
    });
  });

  describe('acp mode', () => {
    let acpContext: CommandContext;

    beforeEach(() => {
      acpContext = createMockCommandContext({
        executionMode: 'acp',
        services: {
          config: {
            getGeminiClient: () => ({
              getHistory: mockGetHistory,
              generateContent: mockGenerateContent,
            }),
            getModel: () => 'test-model',
          },
        },
      });
    });

    it('should return stream_messages generator on success', async () => {
      mockGenerateContent.mockResolvedValue({
        candidates: [{ content: { parts: [{ text: 'streamed answer' }] } }],
      });

      const result = (await btwCommand.action!(acpContext, 'my question')) as {
        type: string;
        messages: AsyncGenerator;
      };

      expect(result.type).toBe('stream_messages');

      const messages = [];
      for await (const msg of result.messages) {
        messages.push(msg);
      }

      expect(messages).toEqual([
        { messageType: 'info', content: 'Thinking...' },
        { messageType: 'info', content: 'btw> my question\nstreamed answer' },
      ]);
    });

    it('should yield error message on failure', async () => {
      mockGenerateContent.mockRejectedValue(new Error('api failure'));

      const result = (await btwCommand.action!(acpContext, 'my question')) as {
        type: string;
        messages: AsyncGenerator;
      };

      const messages = [];
      for await (const msg of result.messages) {
        messages.push(msg);
      }

      expect(messages).toEqual([
        { messageType: 'info', content: 'Thinking...' },
        {
          messageType: 'error',
          content: 'Failed to answer btw question: api failure',
        },
      ]);
    });
  });
});
