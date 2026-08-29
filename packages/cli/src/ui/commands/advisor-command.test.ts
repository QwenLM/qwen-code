/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, type Mock } from 'vitest';
import { advisorCommand } from './advisor-command.js';
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
    history: [{ role: 'user', parts: [{ text: 'hello' }] }],
    model: 'test-model',
    version: 0,
  }),
);

vi.mock('@qwen-code/qwen-code-core', () => ({
  BTW_MAX_INPUT_LENGTH: 4096,
  runForkedAgent: mockRunForkedAgent,
  buildBtwCacheSafeParams: mockBuildBtwCacheSafeParams,
}));

const ADVISOR_REVIEW = {
  verdict: 'Sound.',
  risks: 'None found.',
  missingEvidence: 'None.',
  recommendation: 'Proceed.',
};

const advisorResult = (model = 'test-model') => ({
  text: JSON.stringify(ADVISOR_REVIEW),
  jsonResult: ADVISOR_REVIEW,
  model,
  usage: { inputTokens: 1, outputTokens: 1, cacheHitTokens: 0 },
});

const ADVISOR_MARKDOWN = [
  '## Verdict',
  ADVISOR_REVIEW.verdict,
  '## Risks',
  ADVISOR_REVIEW.risks,
  '## Missing evidence',
  ADVISOR_REVIEW.missingEvidence,
  '## Recommendation',
  ADVISOR_REVIEW.recommendation,
].join('\n\n');

describe('advisorCommand', () => {
  let mockContext: CommandContext;

  const createConfig = (overrides: Record<string, unknown> = {}) => ({
    getLlmClient: () => ({
      getHistoryForForkWindow: () => [
        { role: 'user', parts: [{ text: 'hello' }] },
      ],
    }),
    getModel: () => 'test-model',
    getSessionId: () => 'test-session-id',
    getApprovalMode: () => 'default',
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildBtwCacheSafeParams.mockReturnValue({
      generationConfig: {},
      history: [{ role: 'user', parts: [{ text: 'hello' }] }],
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
    expect(advisorCommand.supportedModes).toEqual(['interactive', 'acp']);
  });

  it('should return error when focus exceeds max length', async () => {
    const result = await advisorCommand.action!(mockContext, 'x'.repeat(4097));

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      // The identity t() mock substitutes {{max}}, so pin the fully
      // interpolated text: a mismatched parameter name at the call site
      // would otherwise leave the raw '{{max}}' token invisible here.
      content: 'Focus too long (max 4096 chars)',
    });
  });

  it('should accept a focus at exactly the max length', async () => {
    mockRunForkedAgent.mockResolvedValue(advisorResult());

    const result = await advisorCommand.action!(mockContext, 'x'.repeat(4096));

    expect(result).toBeUndefined();
    expect(mockRunForkedAgent).toHaveBeenCalledTimes(1);
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

  it('should return error when no model is configured', async () => {
    const noModelContext = createMockCommandContext({
      services: {
        config: createConfig({ getModel: () => null }),
      },
    });

    const result = await advisorCommand.action!(noModelContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'No model configured.',
    });
    expect(mockRunForkedAgent).not.toHaveBeenCalled();
  });

  describe('interactive mode', () => {
    it('should show pending item, add an advisor review item, then clear pending', async () => {
      mockRunForkedAgent.mockResolvedValue(advisorResult('resolved-model'));

      const result = await advisorCommand.action!(mockContext, '');

      expect(mockContext.ui.setPendingItem).toHaveBeenNthCalledWith(1, {
        type: MessageType.INFO,
        text: 'Consulting advisor...',
      });
      // The indicator must be raised before the forked model call starts —
      // that call is the only window the pending state exists for.
      expect(
        (mockContext.ui.setPendingItem as Mock).mock.invocationCallOrder[0],
      ).toBeLessThan(mockRunForkedAgent.mock.invocationCallOrder[0]);
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.ADVISOR,
          text: ADVISOR_MARKDOWN,
          model: 'resolved-model',
        },
        expect.any(Number),
      );
      expect(mockContext.ui.addItem).toHaveBeenCalledTimes(1);
      expect(mockRunForkedAgent).toHaveBeenCalledTimes(1);
      expect(mockContext.ui.setPendingItem).toHaveBeenLastCalledWith(null);
      expect(result).toBeUndefined();
    });

    it('should pass focus into the advisor prompt', async () => {
      mockRunForkedAgent.mockResolvedValue(advisorResult());

      await advisorCommand.action!(mockContext, 'check the error handling');

      expect(mockRunForkedAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          cacheSafeParams: expect.objectContaining({ model: 'test-model' }),
          userMessage: expect.stringContaining('check the error handling'),
          jsonSchema: expect.objectContaining({
            type: 'object',
            required: ['verdict', 'risks', 'missingEvidence', 'recommendation'],
          }),
          disableModelFallbacks: true,
        }),
      );
      const prompt = mockRunForkedAgent.mock.calls[0][0].userMessage;
      for (const required of [
        'You have NO tools',
        'verdict',
        'risks',
        'missingEvidence',
        'recommendation',
      ]) {
        expect(prompt).toContain(required);
      }
      // The forked chat is built from exactly this object, so a gutted or
      // substituted copy would make the advisor review nothing.
      expect(mockRunForkedAgent.mock.calls[0][0].cacheSafeParams).toBe(
        mockBuildBtwCacheSafeParams.mock.results.at(-1)?.value,
      );
    });

    it('should trim padding around the focus before building the prompt', async () => {
      mockRunForkedAgent.mockResolvedValue(advisorResult());

      await advisorCommand.action!(mockContext, ' check the padding ');

      expect(mockRunForkedAgent.mock.calls[0][0].userMessage).toContain(
        'check the padding',
      );
    });

    it('should not pass model override when advisorModel is unset', async () => {
      mockRunForkedAgent.mockResolvedValue(advisorResult());

      await advisorCommand.action!(mockContext, '');

      const callArgs = mockRunForkedAgent.mock.calls[0][0];
      expect(callArgs).not.toHaveProperty('model');
      expect(callArgs.disableModelFallbacks).toBe(true);
    });

    it('should not pass model override when advisorModel is whitespace-only', async () => {
      mockRunForkedAgent.mockResolvedValue(advisorResult());
      const contextWithBlankModel = createMockCommandContext({
        services: {
          config: createConfig(),
          settings: {
            merged: { advisorModel: '   ' },
          },
        },
      });

      await advisorCommand.action!(contextWithBlankModel, '');

      const callArgs = mockRunForkedAgent.mock.calls[0][0];
      expect(callArgs).not.toHaveProperty('model');
    });

    it('should pass advisorModel setting as model override', async () => {
      mockRunForkedAgent.mockResolvedValue(advisorResult('stronger-model'));
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
        expect.objectContaining({
          model: 'stronger-model',
          disableModelFallbacks: true,
        }),
      );
    });

    it('should strip tools (never preserve) on the default path, matching /btw', async () => {
      mockRunForkedAgent.mockResolvedValue(advisorResult());

      await advisorCommand.action!(mockContext, '');

      const callArgs = mockRunForkedAgent.mock.calls[0][0];
      expect(callArgs).not.toHaveProperty('preserveTools');
    });

    it('should strip tools even when advisorModel is set', async () => {
      mockRunForkedAgent.mockResolvedValue(advisorResult('stronger-model'));
      const contextWithModel = createMockCommandContext({
        services: {
          config: createConfig(),
          settings: {
            merged: { advisorModel: 'stronger-model' },
          },
        },
      });

      await advisorCommand.action!(contextWithModel, '');

      const callArgs = mockRunForkedAgent.mock.calls[0][0];
      expect(callArgs).not.toHaveProperty('preserveTools');
    });

    it('should forward abortSignal to runForkedAgent', async () => {
      mockRunForkedAgent.mockResolvedValue(advisorResult());
      const abortController = new AbortController();
      const contextWithSignal = createMockCommandContext({
        services: { config: createConfig() },
        abortSignal: abortController.signal,
      });

      await advisorCommand.action!(contextWithSignal, '');

      expect(mockRunForkedAgent).toHaveBeenCalledWith(
        expect.objectContaining({ abortSignal: abortController.signal }),
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

    it('should ignore startup-only history', async () => {
      mockContext = createMockCommandContext({
        services: {
          config: createConfig({
            getLlmClient: () => ({
              getHistoryForForkWindow: () => [],
            }),
          }),
        },
      });

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

      const result = await advisorCommand.action!(mockContext, '');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.ERROR,
          text: 'Advisor review failed: API error',
        },
        expect.any(Number),
      );
      expect(mockContext.ui.setPendingItem).toHaveBeenLastCalledWith(null);
      expect(result).toBeUndefined();
    });

    it('should format non-Error rejections with a fallback', async () => {
      mockRunForkedAgent.mockRejectedValue(null);

      await advisorCommand.action!(mockContext, '');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.ERROR,
          text: 'Advisor review failed: Unknown error',
        },
        expect.any(Number),
      );
    });

    it('should preserve truthy non-Error rejection text', async () => {
      mockRunForkedAgent.mockRejectedValue('string error');

      await advisorCommand.action!(mockContext, '');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.ERROR,
          text: 'Advisor review failed: string error',
        },
        expect.any(Number),
      );
    });

    it('should block when another pendingItem exists', async () => {
      const busyContext = createMockCommandContext({
        services: { config: createConfig() },
        ui: { pendingItem: { type: 'info' } },
      });

      const result = await advisorCommand.action!(busyContext, '');

      expect(mockRunForkedAgent).not.toHaveBeenCalled();
      expect(busyContext.ui.addItem).not.toHaveBeenCalled();
      expect(busyContext.ui.setPendingItem).not.toHaveBeenCalled();
      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('Another operation is in progress'),
      });
    });

    it('should block when the main turn is still in flight', async () => {
      const busyContext = createMockCommandContext({
        services: { config: createConfig() },
        ui: { isIdleRef: { current: false }, pendingItem: null },
      });

      const result = await advisorCommand.action!(busyContext, '');

      expect(mockRunForkedAgent).not.toHaveBeenCalled();
      expect(busyContext.ui.addItem).not.toHaveBeenCalled();
      expect(busyContext.ui.setPendingItem).not.toHaveBeenCalled();
      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('Another operation is in progress'),
      });
    });

    it('should not add items after abort', async () => {
      const abortController = new AbortController();
      mockRunForkedAgent.mockImplementation(async () => {
        abortController.abort();
        return advisorResult();
      });
      const abortableContext = createMockCommandContext({
        services: { config: createConfig() },
        abortSignal: abortController.signal,
      });

      await advisorCommand.action!(abortableContext, '');

      expect(abortableContext.ui.addItem).not.toHaveBeenCalled();
      expect(abortableContext.ui.setPendingItem).toHaveBeenCalledWith({
        type: MessageType.INFO,
        text: 'Consulting advisor...',
      });
      expect(abortableContext.ui.setPendingItem).not.toHaveBeenLastCalledWith(
        null,
      );
    });

    it('should not add items when the forked agent rejects on abort', async () => {
      const abortController = new AbortController();
      mockRunForkedAgent.mockImplementation(async () => {
        abortController.abort();
        throw new Error('aborted');
      });
      const abortableContext = createMockCommandContext({
        services: { config: createConfig() },
        abortSignal: abortController.signal,
      });

      await advisorCommand.action!(abortableContext, '');

      expect(abortableContext.ui.addItem).not.toHaveBeenCalled();
      expect(abortableContext.ui.setPendingItem).toHaveBeenCalledWith({
        type: MessageType.INFO,
        text: 'Consulting advisor...',
      });
      expect(abortableContext.ui.setPendingItem).not.toHaveBeenLastCalledWith(
        null,
      );
    });

    it('should reject malformed advisor output', async () => {
      mockRunForkedAgent.mockResolvedValue({
        text: '{"verdict":"Sound."}',
        jsonResult: { verdict: 'Sound.' },
        model: 'test-model',
        usage: { inputTokens: 1, outputTokens: 0, cacheHitTokens: 0 },
      });

      await advisorCommand.action!(mockContext, '');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        {
          type: MessageType.ERROR,
          text: 'Advisor review failed: Advisor returned invalid structured output.',
        },
        expect.any(Number),
      );
    });
  });

  describe('acp mode', () => {
    it('should return message result with review on success', async () => {
      mockRunForkedAgent.mockResolvedValue(advisorResult());
      const acpContext = createMockCommandContext({
        executionMode: 'acp',
        services: { config: createConfig() },
      });

      const result = await advisorCommand.action!(acpContext, '');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: ADVISOR_MARKDOWN,
      });
      expect(mockRunForkedAgent).toHaveBeenCalledTimes(1);
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
});
