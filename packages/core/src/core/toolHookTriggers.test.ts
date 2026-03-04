/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  generateToolUseId,
  firePreToolUseHook,
  firePostToolUseHook,
  firePostToolUseFailureHook,
  appendAdditionalContext,
} from './toolHookTriggers.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';

// Mock the MessageBus
const createMockMessageBus = () =>
  ({
    request: vi.fn(),
  }) as unknown as MessageBus;

describe('toolHookTriggers', () => {
  describe('generateToolUseId', () => {
    it('should generate unique IDs with the correct prefix', () => {
      const id1 = generateToolUseId();
      const id2 = generateToolUseId();

      expect(id1).toMatch(/^toolu_\d+_[a-z0-9]+$/);
      expect(id2).toMatch(/^toolu_\d+_[a-z0-9]+$/);
      expect(id1).not.toBe(id2);
    });

    it('should generate IDs with current timestamp', () => {
      const mockTime = Date.now();
      vi.spyOn(global.Date, 'now').mockImplementation(() => mockTime);

      const id = generateToolUseId();

      expect(id).toContain(`toolu_${mockTime}`);
    });
  });

  describe('firePreToolUseHook', () => {
    it('should return shouldProceed: true when no messageBus is provided', async () => {
      const result = await firePreToolUseHook(
        undefined,
        'test-tool',
        {},
        'test-id',
        'auto',
      );

      expect(result).toEqual({ shouldProceed: true });
    });

    it('should return shouldProceed: true when hook execution fails', async () => {
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
      });

      const result = await firePreToolUseHook(
        mockMessageBus,
        'test-tool',
        {},
        'test-id',
        'auto',
      );

      expect(result).toEqual({ shouldProceed: true });
    });

    it('should return shouldProceed: true when hook output is empty', async () => {
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        output: {},
      });

      const result = await firePreToolUseHook(
        mockMessageBus,
        'test-tool',
        {},
        'test-id',
        'auto',
      );

      expect(result).toEqual({ shouldProceed: true });
    });

    it('should return shouldProceed: false with denied type when tool is denied', async () => {
      const mockOutput = {
        hookSpecificOutput: {
          permissionDecision: 'deny',
          permissionDecisionReason: 'Tool not allowed',
        },
      };
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        output: mockOutput,
      });

      const result = await firePreToolUseHook(
        mockMessageBus,
        'test-tool',
        {},
        'test-id',
        'auto',
      );

      expect(result).toEqual({
        shouldProceed: false,
        blockReason: 'Tool not allowed',
        blockType: 'denied',
      });
    });

    it('should return shouldProceed: false with ask type when confirmation is required', async () => {
      const mockOutput = {
        hookSpecificOutput: {
          permissionDecision: 'ask',
          permissionDecisionReason: 'User confirmation required',
        },
      };
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        output: mockOutput,
      });

      const result = await firePreToolUseHook(
        mockMessageBus,
        'test-tool',
        {},
        'test-id',
        'auto',
      );

      expect(result).toEqual({
        shouldProceed: false,
        blockReason: 'User confirmation required',
        blockType: 'ask',
      });
    });

    it('should return shouldProceed: false with stop type when execution should stop', async () => {
      const mockOutput = {
        continue: false,
        reason: 'Execution stopped by policy',
      };
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        output: mockOutput,
      });

      const result = await firePreToolUseHook(
        mockMessageBus,
        'test-tool',
        {},
        'test-id',
        'auto',
      );

      expect(result).toEqual({
        shouldProceed: false,
        blockReason: 'Execution stopped by policy',
        blockType: 'stop',
      });
    });

    it('should return shouldProceed: true with additional context when available', async () => {
      const mockOutput = {
        hookSpecificOutput: {
          additionalContext: 'Additional context here',
        },
      };
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        output: mockOutput,
      });

      const result = await firePreToolUseHook(
        mockMessageBus,
        'test-tool',
        {},
        'test-id',
        'auto',
      );

      expect(result).toEqual({
        shouldProceed: true,
        additionalContext: 'Additional context here',
      });
    });

    it('should handle hook execution errors gracefully', async () => {
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Network error'),
      );

      const result = await firePreToolUseHook(
        mockMessageBus,
        'test-tool',
        {},
        'test-id',
        'auto',
      );

      expect(result).toEqual({ shouldProceed: true });
    });
  });

  describe('firePostToolUseHook', () => {
    it('should return shouldStop: false when no messageBus is provided', async () => {
      const result = await firePostToolUseHook(
        undefined,
        'test-tool',
        {},
        {},
        'test-id',
        'auto',
      );

      expect(result).toEqual({ shouldStop: false });
    });

    it('should return shouldStop: false when hook execution fails', async () => {
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
      });

      const result = await firePostToolUseHook(
        mockMessageBus,
        'test-tool',
        {},
        {},
        'test-id',
        'auto',
      );

      expect(result).toEqual({ shouldStop: false });
    });

    it('should return shouldStop: false when hook output is empty', async () => {
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        output: {},
      });

      const result = await firePostToolUseHook(
        mockMessageBus,
        'test-tool',
        {},
        {},
        'test-id',
        'auto',
      );

      expect(result).toEqual({ shouldStop: false });
    });

    it('should return shouldStop: true with stop reason when execution should stop', async () => {
      const mockOutput = {
        continue: false,
        reason: 'Execution stopped by policy',
      };
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        output: mockOutput,
      });

      const result = await firePostToolUseHook(
        mockMessageBus,
        'test-tool',
        {},
        {},
        'test-id',
        'auto',
      );

      expect(result).toEqual({
        shouldStop: true,
        stopReason: 'Execution stopped by policy',
      });
    });

    it('should return shouldStop: false with additional context when available', async () => {
      const mockOutput = {
        hookSpecificOutput: {
          additionalContext: 'Additional context here',
        },
      };
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        output: mockOutput,
      });

      const result = await firePostToolUseHook(
        mockMessageBus,
        'test-tool',
        {},
        {},
        'test-id',
        'auto',
      );

      expect(result).toEqual({
        shouldStop: false,
        additionalContext: 'Additional context here',
      });
    });

    it('should handle hook execution errors gracefully', async () => {
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Network error'),
      );

      const result = await firePostToolUseHook(
        mockMessageBus,
        'test-tool',
        {},
        {},
        'test-id',
        'auto',
      );

      expect(result).toEqual({ shouldStop: false });
    });
  });

  describe('firePostToolUseFailureHook', () => {
    it('should return empty object when no messageBus is provided', async () => {
      const result = await firePostToolUseFailureHook(
        undefined,
        'test-id',
        'test-tool',
        {},
        'error message',
      );

      expect(result).toEqual({});
    });

    it('should return empty object when hook execution fails', async () => {
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
      });

      const result = await firePostToolUseFailureHook(
        mockMessageBus,
        'test-id',
        'test-tool',
        {},
        'error message',
      );

      expect(result).toEqual({});
    });

    it('should return empty object when hook output is empty', async () => {
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        output: {},
      });

      const result = await firePostToolUseFailureHook(
        mockMessageBus,
        'test-id',
        'test-tool',
        {},
        'error message',
      );

      expect(result).toEqual({});
    });

    it('should return additional context when available', async () => {
      const mockOutput = {
        hookSpecificOutput: {
          additionalContext: 'Additional context about the failure',
        },
      };
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        output: mockOutput,
      });

      const result = await firePostToolUseFailureHook(
        mockMessageBus,
        'test-id',
        'test-tool',
        {},
        'error message',
      );

      expect(result).toEqual({
        additionalContext: 'Additional context about the failure',
      });
    });

    it('should handle hook execution errors gracefully', async () => {
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Network error'),
      );

      const result = await firePostToolUseFailureHook(
        mockMessageBus,
        'test-id',
        'test-tool',
        {},
        'error message',
      );

      expect(result).toEqual({});
    });
  });

  describe('appendAdditionalContext', () => {
    it('should return original content when no additional context is provided', () => {
      const result = appendAdditionalContext('original content', undefined);
      expect(result).toBe('original content');
    });

    it('should append context to string content', () => {
      const result = appendAdditionalContext(
        'original content',
        'additional context',
      );
      expect(result).toBe('original content\n\nadditional context');
    });

    it('should append context as text part to PartListUnion array', () => {
      const originalContent = [{ text: 'original' }];
      const result = appendAdditionalContext(
        originalContent,
        'additional context',
      );

      expect(result).toEqual([
        { text: 'original' },
        { text: 'additional context' },
      ]);
    });

    it('should handle non-array PartListUnion content', () => {
      const originalContent = { text: 'original' };
      const result = appendAdditionalContext(
        originalContent,
        'additional context',
      );

      expect(result).toEqual({ text: 'original' });
    });

    it('should return original array content when no additional context is provided', () => {
      const originalContent = [{ text: 'original' }];
      const result = appendAdditionalContext(originalContent, undefined);

      expect(result).toEqual([{ text: 'original' }]);
    });
  });
});
