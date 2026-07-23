/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { advisorCommand, buildAdvisorPrompt } from './advisor-command.js';
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

const mockRunForkedAgent = vi.hoisted(() => vi.fn());
const mockBuildBtwCacheSafeParams = vi.hoisted(() =>
  vi.fn().mockReturnValue({
    generationConfig: {},
    history: [],
    model: 'test-model',
    version: 0,
  }),
);

vi.mock('@qwen-code/qwen-code-core', () => ({
  BTW_MAX_INPUT_LENGTH: 4096,
  runForkedAgent: mockRunForkedAgent,
  buildBtwCacheSafeParams: mockBuildBtwCacheSafeParams,
}));

describe('advisorCommand', () => {
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
    mockBuildBtwCacheSafeParams.mockReturnValue({
      generationConfig: {},
      history: [],
      model: 'test-model',
      version: 0,
    });
    mockContext = createMockCommandContext({
      services: {
        config: createConfig(),
      },
    });
  });

  it('should have correct metadata', () => {
    expect(advisorCommand.name).toBe('advisor');
    expect(advisorCommand.kind).toBe(CommandKind.BUILT_IN);
    expect(advisorCommand.description).toBeTruthy();
  });

  it('should return error when focus exceeds max length', async () => {
    const result = await advisorCommand.action!(mockContext, 'x'.repeat(4097));

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: expect.stringContaining('too long'),
    });
  });

  it('should return error when config is not loaded', async () => {
    const noConfigContext = createMockCommandContext({
      services: { config: null },
    });

    const result = await advisorCommand.action!(noConfigContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Config not loaded.',
    });
  });

  describe('interactive mode', () => {
    it('should show pending item, add review, then clear pending', async () => {
      mockRunForkedAgent.mockResolvedValue({
        text: '## Verdict\nSound.',
        usage: { inputTokens: 10, outputTokens: 5, cacheHitTokens: 3 },
      });

      await advisorCommand.action!(mockContext, '');

      expect(mockContext.ui.setPendingItem).toHaveBeenNthCalledWith(1, {
        type: MessageType.INFO,
        text: 'Consulting advisor...',
      });
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        { type: MessageType.INFO, text: '## Verdict\nSound.' },
        expect.any(Number),
      );
      expect(mockContext.ui.setPendingItem).toHaveBeenLastCalledWith(null);
    });

    it('should pass focus into the advisor prompt', async () => {
      mockRunForkedAgent.mockResolvedValue({
        text: 'review',
        usage: { inputTokens: 1, outputTokens: 1, cacheHitTokens: 0 },
      });

      await advisorCommand.action!(mockContext, 'check the error handling');

      expect(mockRunForkedAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          cacheSafeParams: expect.objectContaining({ model: 'test-model' }),
          userMessage: expect.stringContaining('check the error handling'),
        }),
      );
    });

    it('should not pass model override when advisorModel is unset', async () => {
      mockRunForkedAgent.mockResolvedValue({
        text: 'review',
        usage: { inputTokens: 1, outputTokens: 1, cacheHitTokens: 0 },
      });

      await advisorCommand.action!(mockContext, '');

      expect(mockRunForkedAgent).toHaveBeenCalledWith(
        expect.not.objectContaining({ model: expect.anything() }),
      );
    });

    it('should pass advisorModel setting as model override', async () => {
      mockRunForkedAgent.mockResolvedValue({
        text: 'review',
        usage: { inputTokens: 1, outputTokens: 1, cacheHitTokens: 0 },
      });
      const contextWithModel = createMockCommandContext({
        services: {
          config: createConfig(),
          settings: {
            merged: { advisorModel: 'stronger-model' },
          },
        },
      });

      await advisorCommand.action!(contextWithModel, '');

      expect(mockRunForkedAgent).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'stronger-model' }),
      );
    });

    it('should error when no conversation context is available', async () => {
      mockBuildBtwCacheSafeParams.mockReturnValue(null);

      await advisorCommand.action!(mockContext, '');

      expect(mockRunForkedAgent).not.toHaveBeenCalled();
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.ERROR,
          text: expect.stringContaining('No conversation context'),
        }),
        expect.any(Number),
      );
      expect(mockContext.ui.setPendingItem).toHaveBeenLastCalledWith(null);
    });

    it('should add error item on failure and clear pending', async () => {
      mockRunForkedAgent.mockRejectedValue(new Error('API error'));

      await advisorCommand.action!(mockContext, '');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.ERROR,
          text: 'Advisor review failed: API error',
        },
        expect.any(Number),
      );
      expect(mockContext.ui.setPendingItem).toHaveBeenLastCalledWith(null);
    });

    it('should block when another pendingItem exists', async () => {
      const busyContext = createMockCommandContext({
        services: { config: createConfig() },
        ui: { pendingItem: { type: 'info' } },
      });

      await advisorCommand.action!(busyContext, '');

      expect(mockRunForkedAgent).not.toHaveBeenCalled();
      expect(busyContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({ type: MessageType.ERROR }),
        expect.any(Number),
      );
    });

    it('should not add items after abort', async () => {
      const abortController = new AbortController();
      mockRunForkedAgent.mockImplementation(async () => {
        abortController.abort();
        return {
          text: 'late review',
          usage: { inputTokens: 1, outputTokens: 1, cacheHitTokens: 0 },
        };
      });
      const abortableContext = createMockCommandContext({
        services: { config: createConfig() },
        abortSignal: abortController.signal,
      });

      await advisorCommand.action!(abortableContext, '');

      expect(abortableContext.ui.addItem).not.toHaveBeenCalled();
      expect(abortableContext.ui.setPendingItem).toHaveBeenLastCalledWith(null);
    });

    it('should show fallback text when result text is empty', async () => {
      mockRunForkedAgent.mockResolvedValue({
        text: null,
        usage: { inputTokens: 1, outputTokens: 0, cacheHitTokens: 0 },
      });

      await advisorCommand.action!(mockContext, '');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        { type: MessageType.INFO, text: 'No response received.' },
        expect.any(Number),
      );
    });
  });

  describe('acp mode', () => {
    it('should return message result with review on success', async () => {
      mockRunForkedAgent.mockResolvedValue({
        text: 'review text',
        usage: { inputTokens: 10, outputTokens: 5, cacheHitTokens: 3 },
      });
      const acpContext = createMockCommandContext({
        executionMode: 'acp',
        services: { config: createConfig() },
      });

      const result = await advisorCommand.action!(acpContext, '');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: 'review text',
      });
      expect(acpContext.ui.setPendingItem).not.toHaveBeenCalled();
    });

    it('should return error message on failure', async () => {
      mockRunForkedAgent.mockRejectedValue(new Error('Model error'));
      const acpContext = createMockCommandContext({
        executionMode: 'acp',
        services: { config: createConfig() },
      });

      const result = await advisorCommand.action!(acpContext, '');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: 'Advisor review failed: Model error',
      });
    });
  });

  describe('buildAdvisorPrompt', () => {
    it('should default to reviewing the conversation when focus is empty', () => {
      expect(buildAdvisorPrompt('')).toContain(
        'Review the conversation above.',
      );
    });

    it('should include the focus text', () => {
      const prompt = buildAdvisorPrompt('is the fix correct?');
      expect(prompt).toContain('is the fix correct?');
      expect(prompt).not.toContain('Review the conversation above.');
    });
  });
});
