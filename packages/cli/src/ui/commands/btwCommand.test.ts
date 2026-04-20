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

// Must use vi.hoisted so the mock factory can reference it before module eval.
const mockRunForkedAgent = vi.hoisted(() => vi.fn());
const mockGetCacheSafeParams = vi.hoisted(() =>
  vi.fn().mockReturnValue({
    generationConfig: {},
    history: [],
    model: 'test-model',
    version: 1,
  }),
);

vi.mock('@qwen-code/qwen-code-core', () => ({
  runForkedAgent: mockRunForkedAgent,
  getCacheSafeParams: mockGetCacheSafeParams,
}));

describe('btwCommand', () => {
  let mockContext: CommandContext;

  const createConfig = (overrides: Record<string, unknown> = {}) => ({
    getGeminiClient: () => ({}),
    getModel: () => 'test-model',
    getSessionId: () => 'test-session-id',
    getApprovalMode: () => 'default',
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCacheSafeParams.mockReturnValue({
      generationConfig: {},
      history: [],
      model: 'test-model',
      version: 1,
    });
    mockContext = createMockCommandContext({
      services: {
        config: createConfig(),
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

  describe('interactive mode', () => {
    const flushPromises = () =>
      new Promise<void>((resolve) => setTimeout(resolve, 0));

    it('should set btwItem and update it on success', async () => {
      mockRunForkedAgent.mockResolvedValue({
        text: 'The answer is 42.',
        usage: { inputTokens: 10, outputTokens: 5, cacheHitTokens: 3 },
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

    it('should invoke runForkedAgent with cacheSafeParams and userMessage', async () => {
      mockRunForkedAgent.mockResolvedValue({
        text: 'answer',
        usage: { inputTokens: 5, outputTokens: 2, cacheHitTokens: 0 },
      });

      await btwCommand.action!(mockContext, 'my question');
      await flushPromises();

      expect(mockRunForkedAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          cacheSafeParams: expect.objectContaining({ model: 'test-model' }),
          userMessage: expect.stringContaining('my question'),
        }),
      );
    });

    it('should fall back to live Gemini client context when no saved cache params exist', async () => {
      mockGetCacheSafeParams.mockReturnValue(null);
      mockRunForkedAgent.mockResolvedValue({
        text: 'answer',
        usage: { inputTokens: 5, outputTokens: 2, cacheHitTokens: 0 },
      });

      const geminiClient = {
        getHistory: vi
          .fn()
          .mockReturnValue([
            { role: 'user', parts: [{ text: '杭州天气如何？' }] },
          ]),
        getChat: vi.fn().mockReturnValue({
          getGenerationConfig: vi.fn().mockReturnValue({
            systemInstruction: 'You are helpful',
            tools: [],
          }),
        }),
      };

      const liveContext = createMockCommandContext({
        services: {
          config: createConfig({
            getGeminiClient: () => geminiClient,
          }),
        },
      });

      await btwCommand.action!(liveContext, 'how ?');
      await flushPromises();

      expect(mockRunForkedAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          cacheSafeParams: expect.objectContaining({
            generationConfig: expect.objectContaining({
              systemInstruction: 'You are helpful',
            }),
            history: [{ role: 'user', parts: [{ text: '杭州天气如何？' }] }],
            model: 'test-model',
          }),
          userMessage: expect.stringContaining('how ?'),
        }),
      );
    });

    it('should prefer live Gemini client history over a stale saved cache snapshot', async () => {
      mockGetCacheSafeParams.mockReturnValue({
        generationConfig: {
          systemInstruction: 'stale system prompt',
          tools: [],
        },
        history: [{ role: 'user', parts: [{ text: '旧问题' }] }],
        model: 'stale-model',
        version: 99,
      });
      mockRunForkedAgent.mockResolvedValue({
        text: 'answer',
        usage: { inputTokens: 5, outputTokens: 2, cacheHitTokens: 0 },
      });

      const geminiClient = {
        getHistory: vi.fn().mockReturnValue([
          { role: 'user', parts: [{ text: '杭州天气如何？' }] },
          { role: 'user', parts: [{ text: '请顺便解释一下湿度怎么看' }] },
        ]),
        getChat: vi.fn().mockReturnValue({
          getGenerationConfig: vi.fn().mockReturnValue({
            systemInstruction: 'live system prompt',
            tools: [],
          }),
        }),
      };

      const liveContext = createMockCommandContext({
        services: {
          config: createConfig({
            getGeminiClient: () => geminiClient,
          }),
        },
      });

      await btwCommand.action!(liveContext, 'how ?');
      await flushPromises();

      expect(mockRunForkedAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          cacheSafeParams: expect.objectContaining({
            generationConfig: expect.objectContaining({
              systemInstruction: 'live system prompt',
            }),
            history: [
              { role: 'user', parts: [{ text: '杭州天气如何？' }] },
              { role: 'user', parts: [{ text: '请顺便解释一下湿度怎么看' }] },
            ],
            model: 'test-model',
          }),
        }),
      );
    });

    it('should add error item on failure and clear btwItem', async () => {
      mockRunForkedAgent.mockRejectedValue(new Error('API error'));

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
      mockRunForkedAgent.mockRejectedValue('string error');

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
      mockRunForkedAgent.mockResolvedValue({
        text: 'answer',
        usage: { inputTokens: 5, outputTokens: 2, cacheHitTokens: 0 },
      });

      const busyContext = createMockCommandContext({
        services: {
          config: createConfig(),
        },
        ui: {
          pendingItem: { type: 'info' },
        },
      });

      // btw should NOT be blocked by pendingItem
      const result = await btwCommand.action!(busyContext, 'test question');
      expect(result).toBeUndefined();
      expect(busyContext.ui.setBtwItem).toHaveBeenCalled();
    });

    it('should not update btwItem when cancelled via btwAbortControllerRef', async () => {
      mockRunForkedAgent.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  text: 'late answer',
                  usage: { inputTokens: 5, outputTokens: 2, cacheHitTokens: 0 },
                }),
              50,
            ),
          ),
      );

      await btwCommand.action!(mockContext, 'test question');

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
      mockRunForkedAgent.mockResolvedValue({
        text: 'answer',
        usage: { inputTokens: 5, outputTokens: 2, cacheHitTokens: 0 },
      });

      await btwCommand.action!(mockContext, 'test question');

      expect(mockContext.ui.btwAbortControllerRef.current).toBeInstanceOf(
        AbortController,
      );

      await flushPromises();

      expect(mockContext.ui.btwAbortControllerRef.current).toBeNull();
    });

    it('should clear btwAbortControllerRef after error', async () => {
      mockRunForkedAgent.mockRejectedValue(new Error('API error'));

      await btwCommand.action!(mockContext, 'test question');

      expect(mockContext.ui.btwAbortControllerRef.current).toBeInstanceOf(
        AbortController,
      );

      await flushPromises();

      expect(mockContext.ui.btwAbortControllerRef.current).toBeNull();
    });

    it('should cancel previous btw when starting a new one', async () => {
      mockRunForkedAgent.mockResolvedValue({
        text: 'answer',
        usage: { inputTokens: 5, outputTokens: 2, cacheHitTokens: 0 },
      });

      await btwCommand.action!(mockContext, 'first question');

      expect(mockContext.ui.cancelBtw).toHaveBeenCalledTimes(1);

      await btwCommand.action!(mockContext, 'second question');

      expect(mockContext.ui.cancelBtw).toHaveBeenCalledTimes(2);
    });

    it('should return fallback text when text is null', async () => {
      mockRunForkedAgent.mockResolvedValue({
        text: null,
        usage: { inputTokens: 5, outputTokens: 0, cacheHitTokens: 0 },
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
      mockRunForkedAgent.mockResolvedValue({
        text: 'answer',
        usage: { inputTokens: 5, outputTokens: 2, cacheHitTokens: 0 },
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
      mockRunForkedAgent.mockResolvedValue({
        text: 'the answer',
        usage: { inputTokens: 5, outputTokens: 2, cacheHitTokens: 0 },
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
      mockRunForkedAgent.mockRejectedValue(new Error('network error'));

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
      mockRunForkedAgent.mockResolvedValue({
        text: 'streamed answer',
        usage: { inputTokens: 5, outputTokens: 3, cacheHitTokens: 0 },
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
      mockRunForkedAgent.mockRejectedValue(new Error('api failure'));

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
