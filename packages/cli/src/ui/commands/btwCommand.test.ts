/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterAll } from 'vitest';
import { btwCommand } from './btwCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { CommandKind } from './types.js';
import { MessageType } from '../types.js';
import { setLanguageAsync } from '../../i18n/index.js';

describe('btwCommand', () => {
  let mockContext: CommandContext;
  let mockGenerateContent: ReturnType<typeof vi.fn>;
  let mockGetHistory: ReturnType<typeof vi.fn>;
  const createConfig = (overrides: Record<string, unknown> = {}) => ({
    getGeminiClient: () => ({
      getHistory: mockGetHistory,
      generateContent: mockGenerateContent,
    }),
    getModel: () => 'test-model',
    getSessionId: () => 'test-session-id',
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();

    mockGenerateContent = vi.fn();
    mockGetHistory = vi.fn().mockReturnValue([]);

    mockContext = createMockCommandContext({
      services: {
        config: createConfig(),
      },
    });
  });

  beforeEach(async () => {
    await setLanguageAsync('en');
  });

  afterAll(async () => {
    await setLanguageAsync('en');
  });

  it('should have correct metadata', () => {
    expect(btwCommand.name).toBe('btw');
    expect(btwCommand.kind).toBe(CommandKind.BUILT_IN);
    expect(btwCommand.description).toBeTruthy();
  });

  it('should localize metadata and validation errors in zh', async () => {
    await setLanguageAsync('zh');

    expect(btwCommand.description).toBe(
      '在不影响主对话的情况下快速问一个旁支问题',
    );

    const result = await btwCommand.action!(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: '请输入问题。用法：/btw <your question>',
    });
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
        config: createConfig({
          getModel: () => '',
        }),
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
    const flushPromises = () =>
      new Promise<void>((resolve) => setTimeout(resolve, 0));

    it('should set btwItem and update it on success', async () => {
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

      // Action returns immediately; btwItem is set synchronously
      expect(mockContext.ui.setBtwItem).toHaveBeenCalledWith({
        type: MessageType.BTW,
        btw: {
          question: 'what is the meaning of life?',
          answer: '',
          isPending: true,
        },
      });

      // pendingItem should NOT be used
      expect(mockContext.ui.setPendingItem).not.toHaveBeenCalled();

      await flushPromises();

      // On success, setBtwItem is called with the completed answer
      expect(mockContext.ui.setBtwItem).toHaveBeenCalledWith({
        type: MessageType.BTW,
        btw: {
          question: 'what is the meaning of life?',
          answer: 'The answer is 42.',
          isPending: false,
        },
      });

      // addItem should NOT be called (btw stays in fixed area, not in history)
      expect(mockContext.ui.addItem).not.toHaveBeenCalled();
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
      await flushPromises();

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
        expect.stringMatching(/^test-session-id########btw-/),
      );
    });

    it('should trim history to last 20 messages for long conversations', async () => {
      // Build 24 history entries — exceeds the 20-message limit
      const longHistory = Array.from({ length: 12 }, (_, i) => [
        { role: 'user', parts: [{ text: `Q${i}` }] },
        { role: 'model', parts: [{ text: `A${i}` }] },
      ]).flat();
      mockGetHistory.mockReturnValue(longHistory);
      mockGenerateContent.mockResolvedValue({
        candidates: [{ content: { parts: [{ text: 'answer' }] } }],
      });

      await btwCommand.action!(mockContext, 'test');
      await flushPromises();

      const calledContents = mockGenerateContent.mock.calls[0][0];
      // 20 history entries + 1 btw question = 21
      expect(calledContents).toHaveLength(21);
      // First entry should be user (Q2, since slice(-20) on 24 starts at index 4)
      expect(calledContents[0].role).toBe('user');
      expect(calledContents[0].parts[0].text).toBe('Q2');
    });

    it('should trim history and skip leading model entry to preserve alternation', async () => {
      // Build 21 entries: 10 full turns + 1 trailing user message.
      // slice(-20) yields [M0, U1, M1, ..., U9, M9, U10] — starts with model.
      // trimHistory should drop that leading model entry.
      const oddHistory = [
        ...Array.from({ length: 11 }, (_, i) => [
          { role: 'user', parts: [{ text: `Q${i}` }] },
          { role: 'model', parts: [{ text: `A${i}` }] },
        ]).flat(),
      ].slice(0, 21); // [U0, M0, U1, M1, ..., U9, M9, U10]
      expect(oddHistory).toHaveLength(21);

      mockGetHistory.mockReturnValue(oddHistory);
      mockGenerateContent.mockResolvedValue({
        candidates: [{ content: { parts: [{ text: 'answer' }] } }],
      });

      await btwCommand.action!(mockContext, 'test');
      await flushPromises();

      const calledContents = mockGenerateContent.mock.calls[0][0];
      // slice(-20) = 20 entries starting with M0 (model) → slice(1) = 19, + 1 btw = 20
      expect(calledContents).toHaveLength(20);
      expect(calledContents[0].role).toBe('user');
      expect(calledContents[0].parts[0].text).toBe('Q1');
    });

    it('should add error item on failure and clear btwItem', async () => {
      mockGenerateContent.mockRejectedValue(new Error('API error'));

      await btwCommand.action!(mockContext, 'test question');
      await flushPromises();

      // btwItem should be cleared on error
      expect(mockContext.ui.setBtwItem).toHaveBeenCalledWith(null);

      // Error goes to history
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.ERROR,
          text: 'Failed to answer btw question: API error',
        },
        expect.any(Number),
      );
    });

    it('should handle non-Error exceptions', async () => {
      mockGenerateContent.mockRejectedValue('string error');

      await btwCommand.action!(mockContext, 'test question');
      await flushPromises();

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.ERROR,
          text: 'Failed to answer btw question: string error',
        },
        expect.any(Number),
      );
    });

    it('should not block when another pendingItem exists', async () => {
      const busyContext = createMockCommandContext({
        services: {
          config: createConfig(),
        },
        ui: {
          pendingItem: { type: 'info' },
        },
      });

      mockGenerateContent.mockResolvedValue({
        candidates: [{ content: { parts: [{ text: 'answer' }] } }],
      });

      // btw should NOT be blocked by pendingItem anymore
      const result = await btwCommand.action!(busyContext, 'test question');
      expect(result).toBeUndefined();
      expect(busyContext.ui.setBtwItem).toHaveBeenCalled();
    });

    it('should not update btwItem when cancelled via btwAbortControllerRef', async () => {
      mockGenerateContent.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  candidates: [
                    { content: { parts: [{ text: 'late answer' }] } },
                  ],
                }),
              50,
            ),
          ),
      );

      await btwCommand.action!(mockContext, 'test question');

      // The btw command should have registered its AbortController
      expect(mockContext.ui.btwAbortControllerRef.current).toBeInstanceOf(
        AbortController,
      );

      // Simulate user pressing ESC: cancel the in-flight btw
      mockContext.ui.btwAbortControllerRef.current!.abort();

      await flushPromises();

      // setBtwItem should only have the initial pending call (no completion)
      expect(mockContext.ui.setBtwItem).toHaveBeenCalledTimes(1);
      expect(mockContext.ui.addItem).not.toHaveBeenCalled();
    });

    it('should clear btwAbortControllerRef after successful completion', async () => {
      mockGenerateContent.mockResolvedValue({
        candidates: [{ content: { parts: [{ text: 'answer' }] } }],
      });

      await btwCommand.action!(mockContext, 'test question');

      // Ref is set during the call
      expect(mockContext.ui.btwAbortControllerRef.current).toBeInstanceOf(
        AbortController,
      );

      await flushPromises();

      // After completion, ref should be cleaned up
      expect(mockContext.ui.btwAbortControllerRef.current).toBeNull();
    });

    it('should clear btwAbortControllerRef after error', async () => {
      mockGenerateContent.mockRejectedValue(new Error('API error'));

      await btwCommand.action!(mockContext, 'test question');

      expect(mockContext.ui.btwAbortControllerRef.current).toBeInstanceOf(
        AbortController,
      );

      await flushPromises();

      expect(mockContext.ui.btwAbortControllerRef.current).toBeNull();
    });

    it('should cancel previous btw when starting a new one', async () => {
      mockGenerateContent.mockResolvedValue({
        candidates: [{ content: { parts: [{ text: 'answer' }] } }],
      });

      await btwCommand.action!(mockContext, 'first question');

      // cancelBtw should have been called to clean up any previous btw
      expect(mockContext.ui.cancelBtw).toHaveBeenCalledTimes(1);

      // Second btw call
      await btwCommand.action!(mockContext, 'second question');

      // cancelBtw called again for the second invocation
      expect(mockContext.ui.cancelBtw).toHaveBeenCalledTimes(2);
    });

    it('should return fallback text when response has no parts', async () => {
      mockGenerateContent.mockResolvedValue({
        candidates: [{ content: { parts: [] } }],
      });

      await btwCommand.action!(mockContext, 'test question');
      await flushPromises();

      expect(mockContext.ui.setBtwItem).toHaveBeenCalledWith({
        type: MessageType.BTW,
        btw: {
          question: 'test question',
          answer: 'No response received.',
          isPending: false,
        },
      });
    });

    it('should return void immediately without blocking', async () => {
      mockGenerateContent.mockResolvedValue({
        candidates: [{ content: { parts: [{ text: 'answer' }] } }],
      });

      const result = await btwCommand.action!(mockContext, 'test question');

      expect(result).toBeUndefined();

      // Only the pending setBtwItem called so far
      expect(mockContext.ui.setBtwItem).toHaveBeenCalledTimes(1);

      await flushPromises();

      // Now the completed setBtwItem has been called
      expect(mockContext.ui.setBtwItem).toHaveBeenCalledTimes(2);
    });
  });

  describe('non-interactive mode', () => {
    let nonInteractiveContext: CommandContext;

    beforeEach(() => {
      nonInteractiveContext = createMockCommandContext({
        executionMode: 'non_interactive',
        services: {
          config: createConfig(),
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
          config: createConfig(),
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
