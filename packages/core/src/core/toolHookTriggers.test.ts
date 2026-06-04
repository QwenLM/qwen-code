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
  firePostToolBatchHook,
  fireNotificationHook,
  appendAdditionalContext,
  firePermissionRequestHook,
} from './toolHookTriggers.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { NotificationType } from '../hooks/types.js';
import { MessageBusType } from '../confirmation-bus/types.js';

const debugLoggerWarnSpy = vi.hoisted(() => vi.fn());

vi.mock('../utils/debugLogger.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/debugLogger.js')>();
  return {
    ...actual,
    createDebugLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: debugLoggerWarnSpy,
      error: vi.fn(),
    }),
  };
});

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

    it('should return shouldProceed: true with sentinel hookError when hook execution fails without an error message', async () => {
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

      // #4321 review-7 SF-H1: runner contract violation (success:false
      // with no error.message) used to silently return allow with no
      // telemetry. Now synthesizes a sentinel hookError so the span
      // records `success: false` + the description of what went wrong.
      expect(result.shouldProceed).toBe(true);
      expect(result.hookError).toMatch(/success: false/);
    });

    it('synthesizes sentinel hookError when runner returns empty-string error message (#4321)', async () => {
      // #4321 review-9: pin the `||` (not `??`) semantics. A future
      // regression back to `??` would preserve `hookError: ""` here
      // which downstream `r.hookError ? ...` truthiness then silently
      // drops — same allow-without-telemetry pathology SF-H1 closed.
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: { message: '' },
      });

      const result = await firePreToolUseHook(
        mockMessageBus,
        'test-tool',
        {},
        'test-id',
        'auto',
      );

      expect(result.shouldProceed).toBe(true);
      expect(result.hookError).toMatch(/success: false/);
      // Specifically NOT empty: an empty string would round-trip through
      // a downstream truthiness check as missing.
      expect(result.hookError).not.toBe('');
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

      // #4321 review: hookError surfaces the swallowed transport error so
      // observers (telemetry spans, debug logs) can distinguish a failed
      // hook from a successful "allow" decision.
      expect(result).toEqual({
        shouldProceed: true,
        hookError: 'Network error',
      });
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

    it('should return shouldStop: false with sentinel hookError when hook execution fails without an error message', async () => {
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

      // #4321 review-7 SF-H1 — see firePreToolUseHook counterpart.
      expect(result.shouldStop).toBe(false);
      expect(result.hookError).toMatch(/success: false/);
    });

    it('synthesizes sentinel hookError when runner returns empty-string error message (#4321)', async () => {
      // #4321 review-9 — see firePreToolUseHook counterpart.
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: { message: '' },
      });

      const result = await firePostToolUseHook(
        mockMessageBus,
        'test-tool',
        {},
        {},
        'test-id',
        'auto',
      );

      expect(result.shouldStop).toBe(false);
      expect(result.hookError).toMatch(/success: false/);
      expect(result.hookError).not.toBe('');
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

      // #4321 review: hookError now surfaced to caller (see PreToolUse parallel test).
      expect(result.shouldStop).toBe(false);
      expect(result.hookError).toBeDefined();
    });
  });

  describe('firePostToolBatchHook', () => {
    it('should return shouldStop: false when no messageBus is provided', async () => {
      const result = await firePostToolBatchHook(undefined, []);

      expect(result).toEqual({ shouldStop: false });
    });

    it('should send resolved tool calls and return additional context', async () => {
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        output: {
          hookSpecificOutput: {
            hookEventName: 'PostToolBatch',
            additionalContext: 'batch note',
          },
        },
      });

      const result = await firePostToolBatchHook(
        mockMessageBus,
        [
          {
            tool_name: 'read_file',
            tool_input: { path: 'README.md' },
            tool_use_id: 'call-1',
            status: 'success',
            tool_response: { output: 'contents' },
          },
        ],
        'auto',
      );

      expect(mockMessageBus.request).toHaveBeenCalledWith(
        {
          type: MessageBusType.HOOK_EXECUTION_REQUEST,
          eventName: 'PostToolBatch',
          input: {
            permission_mode: 'auto',
            tool_calls: [
              {
                tool_name: 'read_file',
                tool_input: { path: 'README.md' },
                tool_use_id: 'call-1',
                status: 'success',
                tool_response: { output: 'contents' },
              },
            ],
          },
          signal: undefined,
        },
        MessageBusType.HOOK_EXECUTION_RESPONSE,
        15_000,
        undefined,
      );
      expect(result).toEqual({
        shouldStop: false,
        additionalContext: 'batch note',
      });
    });

    it('should surface stop decisions', async () => {
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        output: {
          continue: false,
          stopReason: 'stop after batch',
        },
      });

      const result = await firePostToolBatchHook(mockMessageBus, []);

      expect(result).toEqual({
        shouldStop: true,
        stopReason: 'stop after batch',
        additionalContext: undefined,
      });
    });

    it('should stop on deny decisions', async () => {
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        output: {
          decision: 'deny',
          reason: 'blocked after batch',
        },
      });

      const result = await firePostToolBatchHook(mockMessageBus, []);

      expect(result).toEqual({
        shouldStop: true,
        stopReason: 'blocked after batch',
        additionalContext: undefined,
      });
    });

    it('should return hookError when hook execution fails without an error message', async () => {
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
      });

      const result = await firePostToolBatchHook(mockMessageBus, []);

      expect(result.shouldStop).toBe(false);
      expect(result.hookError).toMatch(/success: false/);
      expect(debugLoggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('PostToolBatch hook returned failure'),
      );
    });

    it('should return hookError when hook returns success without output', async () => {
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        output: undefined,
      });

      const result = await firePostToolBatchHook(mockMessageBus, []);

      expect(result.shouldStop).toBe(false);
      expect(result.hookError).toMatch(/no output/);
    });

    it('should return hookError when messageBus.request throws', async () => {
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('bus timeout'),
      );

      const result = await firePostToolBatchHook(mockMessageBus, []);

      expect(result.shouldStop).toBe(false);
      expect(result.hookError).toContain('bus timeout');
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

    it('should return sentinel hookError when hook execution fails without an error message', async () => {
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

      // #4321 review-7 SF-H1 — see firePreToolUseHook counterpart.
      expect(result.hookError).toMatch(/success: false/);
    });

    it('synthesizes sentinel hookError when runner returns empty-string error message (#4321)', async () => {
      // #4321 review-9 — see firePreToolUseHook counterpart.
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: { message: '' },
      });

      const result = await firePostToolUseFailureHook(
        mockMessageBus,
        'test-id',
        'test-tool',
        {},
        'error message',
      );

      expect(result.hookError).toMatch(/success: false/);
      expect(result.hookError).not.toBe('');
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

      // #4321 review: hookError now surfaced to caller.
      expect(result.hookError).toBeDefined();
      expect(result.additionalContext).toBeUndefined();
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

    it('wraps single non-array PartListUnion content so the addition still lands', () => {
      // Regression: `ReadFile` returns `{ inlineData: {...} }` for images
      // and PDFs (a single Part, not an array). The previous "return
      // content unchanged" silently dropped any hook-injected reminder
      // — including the path-conditional skill activation `<system-reminder>`
      // and the ConditionalRulesRegistry rule injection. Wrap into an array
      // so the additional context lands.
      const originalContent = {
        inlineData: { data: 'base64', mimeType: 'image/png' },
      };
      const result = appendAdditionalContext(
        originalContent,
        'additional context',
      );

      expect(result).toEqual([originalContent, { text: 'additional context' }]);
    });

    it('should return original array content when no additional context is provided', () => {
      const originalContent = [{ text: 'original' }];
      const result = appendAdditionalContext(originalContent, undefined);

      expect(result).toEqual([{ text: 'original' }]);
    });
  });

  describe('fireNotificationHook', () => {
    it('should return empty object when no messageBus is provided', async () => {
      const result = await fireNotificationHook(
        undefined,
        'Test notification',
        NotificationType.PermissionPrompt,
        'Test Title',
      );

      expect(result).toEqual({});
    });

    it('should return empty object when hook execution fails', async () => {
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
      });

      const result = await fireNotificationHook(
        mockMessageBus,
        'Test notification',
        NotificationType.PermissionPrompt,
      );

      expect(result).toEqual({});
    });

    it('should return empty object when hook output is empty', async () => {
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        output: {},
      });

      const result = await fireNotificationHook(
        mockMessageBus,
        'Test notification',
        NotificationType.IdlePrompt,
      );

      expect(result).toEqual({});
    });

    it('should return additional context when available', async () => {
      const mockOutput = {
        hookSpecificOutput: {
          additionalContext: 'Additional context from notification hook',
        },
      };
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        output: mockOutput,
      });

      const result = await fireNotificationHook(
        mockMessageBus,
        'Test notification',
        NotificationType.AuthSuccess,
      );

      expect(result).toEqual({
        additionalContext: 'Additional context from notification hook',
      });
    });

    it('should send correct parameters to MessageBus for permission_prompt', async () => {
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        output: {},
      });

      await fireNotificationHook(
        mockMessageBus,
        'Qwen Code needs your permission to use Bash',
        NotificationType.PermissionPrompt,
        'Permission needed',
      );

      expect(mockMessageBus.request).toHaveBeenCalledWith(
        {
          type: MessageBusType.HOOK_EXECUTION_REQUEST,
          eventName: 'Notification',
          input: {
            message: 'Qwen Code needs your permission to use Bash',
            notification_type: 'permission_prompt',
            title: 'Permission needed',
          },
        },
        MessageBusType.HOOK_EXECUTION_RESPONSE,
      );
    });

    it('should send correct parameters to MessageBus for idle_prompt', async () => {
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        output: {},
      });

      await fireNotificationHook(
        mockMessageBus,
        'Qwen Code is waiting for your input',
        NotificationType.IdlePrompt,
        'Waiting for input',
      );

      expect(mockMessageBus.request).toHaveBeenCalledWith(
        {
          type: MessageBusType.HOOK_EXECUTION_REQUEST,
          eventName: 'Notification',
          input: {
            message: 'Qwen Code is waiting for your input',
            notification_type: 'idle_prompt',
            title: 'Waiting for input',
          },
        },
        MessageBusType.HOOK_EXECUTION_RESPONSE,
      );
    });

    it('should send correct parameters to MessageBus for auth_success', async () => {
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        output: {},
      });

      await fireNotificationHook(
        mockMessageBus,
        'Authentication successful',
        NotificationType.AuthSuccess,
      );

      expect(mockMessageBus.request).toHaveBeenCalledWith(
        {
          type: MessageBusType.HOOK_EXECUTION_REQUEST,
          eventName: 'Notification',
          input: {
            message: 'Authentication successful',
            notification_type: 'auth_success',
            title: undefined,
          },
        },
        MessageBusType.HOOK_EXECUTION_RESPONSE,
      );
    });

    it('should send correct parameters to MessageBus for elicitation_dialog', async () => {
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        output: {},
      });

      await fireNotificationHook(
        mockMessageBus,
        'Dialog shown to user',
        NotificationType.ElicitationDialog,
        'Dialog',
      );

      expect(mockMessageBus.request).toHaveBeenCalledWith(
        {
          type: MessageBusType.HOOK_EXECUTION_REQUEST,
          eventName: 'Notification',
          input: {
            message: 'Dialog shown to user',
            notification_type: 'elicitation_dialog',
            title: 'Dialog',
          },
        },
        MessageBusType.HOOK_EXECUTION_RESPONSE,
      );
    });

    it('should handle hook execution errors gracefully', async () => {
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Network error'),
      );

      const result = await fireNotificationHook(
        mockMessageBus,
        'Test notification',
        NotificationType.PermissionPrompt,
      );

      expect(result).toEqual({});
    });

    it('should handle notification without title', async () => {
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        output: {},
      });

      await fireNotificationHook(
        mockMessageBus,
        'Test notification without title',
        NotificationType.IdlePrompt,
      );

      expect(mockMessageBus.request).toHaveBeenCalledWith(
        {
          type: MessageBusType.HOOK_EXECUTION_REQUEST,
          eventName: 'Notification',
          input: {
            message: 'Test notification without title',
            notification_type: 'idle_prompt',
            title: undefined,
          },
        },
        MessageBusType.HOOK_EXECUTION_RESPONSE,
      );
    });
  });

  describe('firePermissionRequestHook', () => {
    it('should return hasDecision: false when no messageBus is provided', async () => {
      const result = await firePermissionRequestHook(
        undefined,
        'test-tool',
        {},
        'auto',
      );

      expect(result).toEqual({ hasDecision: false });
    });

    it('should return hasDecision: false when hook execution fails', async () => {
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
      });

      const result = await firePermissionRequestHook(
        mockMessageBus,
        'test-tool',
        {},
        'auto',
      );

      expect(result).toEqual({ hasDecision: false });
    });

    it('should return hasDecision: false when hook output is empty', async () => {
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        output: {},
      });

      const result = await firePermissionRequestHook(
        mockMessageBus,
        'test-tool',
        {},
        'auto',
      );

      expect(result).toEqual({ hasDecision: false });
    });

    it('should return hasDecision: true with allow decision when tool is allowed', async () => {
      const mockOutput = {
        hookSpecificOutput: {
          decision: {
            behavior: 'allow',
            updatedInput: { command: 'ls -la' },
            message: 'Tool allowed by policy',
          },
        },
      };
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        output: mockOutput,
      });

      const result = await firePermissionRequestHook(
        mockMessageBus,
        'run_shell_command',
        { command: 'ls' },
        'auto',
      );

      expect(result).toEqual({
        hasDecision: true,
        shouldAllow: true,
        updatedInput: { command: 'ls -la' },
        denyMessage: undefined,
        shouldInterrupt: undefined,
      });
    });

    it('should return hasDecision: true with deny decision when tool is denied', async () => {
      const mockOutput = {
        hookSpecificOutput: {
          decision: {
            behavior: 'deny',
            message: 'Tool denied by policy',
            interrupt: true,
          },
        },
      };
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        output: mockOutput,
      });

      const result = await firePermissionRequestHook(
        mockMessageBus,
        'run_shell_command',
        { command: 'rm -rf /' },
        'auto',
      );

      expect(result).toEqual({
        hasDecision: true,
        shouldAllow: false,
        denyMessage: 'Tool denied by policy',
        shouldInterrupt: true,
      });
    });

    it('should send correct parameters to MessageBus', async () => {
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        output: {},
      });

      await firePermissionRequestHook(
        mockMessageBus,
        'run_shell_command',
        { command: 'ls' },
        'auto',
        [
          {
            type: 'always_allow',
            tool: 'run_shell_command',
          },
        ],
      );

      expect(mockMessageBus.request).toHaveBeenCalledWith(
        {
          type: MessageBusType.HOOK_EXECUTION_REQUEST,
          eventName: 'PermissionRequest',
          input: {
            tool_name: 'run_shell_command',
            tool_input: { command: 'ls' },
            permission_mode: 'auto',
            permission_suggestions: [
              {
                type: 'always_allow',
                tool: 'run_shell_command',
              },
            ],
          },
        },
        MessageBusType.HOOK_EXECUTION_RESPONSE,
      );
    });

    it('should handle missing updated_input in allow decision', async () => {
      const mockOutput = {
        hookSpecificOutput: {
          decision: {
            behavior: 'allow',
            message: 'Tool allowed',
          },
        },
      };
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        output: mockOutput,
      });

      const result = await firePermissionRequestHook(
        mockMessageBus,
        'test-tool',
        {},
        'auto',
      );

      expect(result).toEqual({
        hasDecision: true,
        shouldAllow: true,
        denyMessage: undefined,
        shouldInterrupt: undefined,
      });
    });

    it('should handle missing message in decision', async () => {
      const mockOutput = {
        hookSpecificOutput: {
          decision: {
            behavior: 'deny',
          },
        },
      };
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        output: mockOutput,
      });

      const result = await firePermissionRequestHook(
        mockMessageBus,
        'test-tool',
        {},
        'auto',
      );

      expect(result).toEqual({
        hasDecision: true,
        shouldAllow: false,
        denyMessage: undefined,
        shouldInterrupt: undefined,
      });
    });

    it('should handle hook execution errors gracefully', async () => {
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Network error'),
      );

      const result = await firePermissionRequestHook(
        mockMessageBus,
        'test-tool',
        {},
        'auto',
      );

      expect(result).toEqual({ hasDecision: false });
    });

    it('should handle permission_suggestions being undefined', async () => {
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        output: {},
      });

      await firePermissionRequestHook(
        mockMessageBus,
        'run_shell_command',
        { command: 'ls' },
        'auto',
        undefined,
      );

      expect(mockMessageBus.request).toHaveBeenCalledWith(
        {
          type: MessageBusType.HOOK_EXECUTION_REQUEST,
          eventName: 'PermissionRequest',
          input: {
            tool_name: 'run_shell_command',
            tool_input: { command: 'ls' },
            permission_mode: 'auto',
            permission_suggestions: undefined,
          },
        },
        MessageBusType.HOOK_EXECUTION_RESPONSE,
      );
    });

    it('should handle different permission modes', async () => {
      const mockMessageBus = createMockMessageBus();
      (mockMessageBus.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        output: { hookSpecificOutput: { decision: { behavior: 'allow' } } },
      });

      const result1 = await firePermissionRequestHook(
        mockMessageBus,
        'test-tool',
        {},
        'plan',
      );

      expect(result1.hasDecision).toBe(true);

      const result2 = await firePermissionRequestHook(
        mockMessageBus,
        'test-tool',
        {},
        'yolo',
      );

      expect(result2.hasDecision).toBe(true);
    });
  });
});
