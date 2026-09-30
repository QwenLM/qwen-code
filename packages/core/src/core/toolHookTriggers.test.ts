/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, type Mock } from 'vitest';
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

/** A MessageBus whose `request` resolves with `response`. */
function busResolving(response: unknown): MessageBus {
  const bus = createMockMessageBus();
  (bus.request as Mock).mockResolvedValue(response);
  return bus;
}

/** A MessageBus whose hook run succeeds with `output`. */
const busWithOutput = (output: unknown) =>
  busResolving({ success: true, output });

/** A MessageBus whose `request` rejects with `Error(message)`. */
function busRejecting(message: string): MessageBus {
  const bus = createMockMessageBus();
  (bus.request as Mock).mockRejectedValue(new Error(message));
  return bus;
}

/** A runner failure carrying an empty error message. */
const EMPTY_ERROR = { success: false, error: { message: '' } };

describe('toolHookTriggers', () => {
  it('transports the owner on all six helpers without adding it to stdin', async () => {
    const bus = createMockMessageBus();
    const owner = { runtimeId: 'runtime', sessionId: 'session', agentId: 'A' };
    vi.mocked(bus.request).mockResolvedValue({
      type: MessageBusType.HOOK_EXECUTION_RESPONSE,
      correlationId: 'hook-response',
      success: true,
      output: {},
    });
    await firePreToolUseHook(
      bus,
      'read',
      {},
      'tool',
      'default',
      undefined,
      'call',
      owner,
    );
    await firePostToolUseHook(
      bus,
      'read',
      {},
      {},
      'tool',
      'default',
      undefined,
      'call',
      undefined,
      owner,
    );
    await firePostToolUseFailureHook(
      bus,
      'tool',
      'read',
      {},
      'error',
      false,
      'default',
      undefined,
      'call',
      undefined,
      owner,
    );
    await firePostToolBatchHook(bus, [], 'default', undefined, owner);
    await fireNotificationHook(
      bus,
      'message',
      NotificationType.PermissionPrompt,
      undefined,
      undefined,
      owner,
    );
    await firePermissionRequestHook(
      bus,
      'read',
      {},
      'default',
      undefined,
      undefined,
      owner,
    );
    expect(bus.request).toHaveBeenCalledTimes(6);
    for (const [request] of vi.mocked(bus.request).mock.calls) {
      expect(request).toHaveProperty('owner', owner);
      expect(request).not.toHaveProperty('input.owner');
    }
  });

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
    const pre = (bus?: MessageBus) =>
      firePreToolUseHook(bus, 'test-tool', {}, 'test-id', 'auto');

    it('should return shouldProceed: true when no messageBus is provided', async () => {
      expect(await pre()).toEqual({ shouldProceed: true });
    });

    it('should return shouldProceed: true with sentinel hookError when hook execution fails without an error message', async () => {
      const result = await pre(busResolving({ success: false }));

      // #4321 review-7 SF-H1: runner contract violation (success:false with no
      // error.message) used to silently return allow with no telemetry. Now a
      // sentinel hookError lets the span record `success: false` + what went
      // wrong.
      expect(result.shouldProceed).toBe(true);
      expect(result.hookError).toMatch(/success: false/);
    });

    it('synthesizes sentinel hookError when runner returns empty-string error message (#4321)', async () => {
      // #4321 review-9: pin the `||` (not `??`) semantics. A regression back
      // to `??` would keep `hookError: ""`, which downstream
      // `r.hookError ? ...` truthiness then silently drops: the same
      // allow-without-telemetry pathology SF-H1 closed.
      const result = await pre(busResolving(EMPTY_ERROR));

      expect(result.shouldProceed).toBe(true);
      expect(result.hookError).toMatch(/success: false/);
      // Specifically NOT empty: an empty string would round-trip through
      // a downstream truthiness check as missing.
      expect(result.hookError).not.toBe('');
    });

    it('should return shouldProceed: true when hook output is empty', async () => {
      expect(await pre(busWithOutput({}))).toEqual({ shouldProceed: true });
    });

    it('should return shouldProceed: false with denied type when tool is denied', async () => {
      const result = await pre(
        busWithOutput({
          hookSpecificOutput: {
            permissionDecision: 'deny',
            permissionDecisionReason: 'Tool not allowed',
          },
        }),
      );

      expect(result).toEqual({
        shouldProceed: false,
        blockReason: 'Tool not allowed',
        blockType: 'denied',
      });
    });

    it('should return shouldProceed: false with ask type when confirmation is required', async () => {
      const result = await pre(
        busWithOutput({
          hookSpecificOutput: {
            permissionDecision: 'ask',
            permissionDecisionReason: 'User confirmation required',
          },
        }),
      );

      expect(result).toEqual({
        shouldProceed: false,
        blockReason: 'User confirmation required',
        blockType: 'ask',
      });
    });

    it('should return shouldProceed: false with stop type when execution should stop', async () => {
      const result = await pre(
        busWithOutput({
          continue: false,
          reason: 'Execution stopped by policy',
        }),
      );

      expect(result).toEqual({
        shouldProceed: false,
        blockReason: 'Execution stopped by policy',
        blockType: 'stop',
      });
    });

    it('should return shouldProceed: true with additional context when available', async () => {
      const result = await pre(
        busWithOutput({
          hookSpecificOutput: { additionalContext: 'Additional context here' },
        }),
      );

      expect(result).toEqual({
        shouldProceed: true,
        additionalContext: 'Additional context here',
      });
    });

    it.each([
      [
        'denied',
        {
          hookSpecificOutput: {
            permissionDecision: 'deny',
            permissionDecisionReason: 'Tool not allowed',
            additionalContext: 'deny <note>',
          },
        },
      ],
      [
        'ask',
        {
          hookSpecificOutput: {
            permissionDecision: 'ask',
            additionalContext: 'ask <note>',
          },
        },
      ],
      [
        'stop',
        {
          continue: false,
          reason: 'halt',
          hookSpecificOutput: { additionalContext: 'stop <note>' },
        },
      ],
    ] as const)(
      'keeps sanitized additional context on the %s branch',
      async (blockType, output) => {
        const mockMessageBus = createMockMessageBus();
        (mockMessageBus.request as ReturnType<typeof vi.fn>).mockResolvedValue({
          success: true,
          output,
        });

        const result = await firePreToolUseHook(
          mockMessageBus,
          'test-tool',
          {},
          'test-id',
          'auto',
        );

        expect(result.shouldProceed).toBe(false);
        expect(result.blockType).toBe(blockType);
        expect(result.additionalContext).toBe(
          `${blockType === 'denied' ? 'deny' : blockType} &lt;note&gt;`,
        );
      },
    );

    it('should handle hook execution errors gracefully', async () => {
      const result = await pre(busRejecting('Network error'));

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
    const post = (bus?: MessageBus) =>
      firePostToolUseHook(bus, 'test-tool', {}, {}, 'test-id', 'auto');

    it('should return shouldStop: false when no messageBus is provided', async () => {
      expect(await post()).toEqual({ shouldStop: false });
    });

    it('should return shouldStop: false with sentinel hookError when hook execution fails without an error message', async () => {
      const result = await post(busResolving({ success: false }));

      // #4321 review-7 SF-H1 — see firePreToolUseHook counterpart.
      expect(result.shouldStop).toBe(false);
      expect(result.hookError).toMatch(/success: false/);
    });

    it('synthesizes sentinel hookError when runner returns empty-string error message (#4321)', async () => {
      // #4321 review-9 — see firePreToolUseHook counterpart.
      const result = await post(busResolving(EMPTY_ERROR));

      expect(result.shouldStop).toBe(false);
      expect(result.hookError).toMatch(/success: false/);
      expect(result.hookError).not.toBe('');
    });

    it('should return shouldStop: false when hook output is empty', async () => {
      expect(await post(busWithOutput({}))).toEqual({ shouldStop: false });
    });

    it('should return shouldStop: true with stop reason when execution should stop', async () => {
      const result = await post(
        busWithOutput({
          continue: false,
          reason: 'Execution stopped by policy',
        }),
      );

      expect(result).toEqual({
        shouldStop: true,
        stopReason: 'Execution stopped by policy',
      });
    });

    it('returns PostToolUse artifacts and context when execution stops', async () => {
      const audit = {
        title: 'Audit report',
        workspacePath: 'reports/audit.html',
      };
      const result = await post(
        busWithOutput({
          continue: false,
          reason: 'Blocked after audit',
          hookSpecificOutput: {
            additionalContext: 'Audit details',
            artifacts: [{ ...audit }],
          },
        }),
      );

      expect(result).toEqual({
        shouldStop: true,
        stopReason: 'Blocked after audit',
        additionalContext: 'Audit details',
        artifacts: [audit],
      });
    });

    it('should return shouldStop: false with additional context when available', async () => {
      const result = await post(
        busWithOutput({
          hookSpecificOutput: { additionalContext: 'Additional context here' },
        }),
      );

      expect(result).toEqual({
        shouldStop: false,
        additionalContext: 'Additional context here',
      });
    });

    it('returns PostToolUse artifacts', async () => {
      const report = {
        title: 'Tool report',
        workspacePath: 'reports/tool.html',
      };
      const result = await post(
        busWithOutput({
          hookSpecificOutput: {
            artifacts: [
              { ...report },
              { title: 'Malformed report', workspacePath: 123 },
            ],
          },
        }),
      );

      expect(result).toEqual({ shouldStop: false, artifacts: [report] });
    });

    it('should handle hook execution errors gracefully', async () => {
      const result = await post(busRejecting('Network error'));

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
      const bus = busWithOutput({
        hookSpecificOutput: {
          hookEventName: 'PostToolBatch',
          additionalContext: 'batch note',
        },
      });
      const toolCall = () => ({
        tool_name: 'read_file',
        tool_input: { path: 'README.md' },
        tool_use_id: 'call-1',
        status: 'success' as const,
        tool_response: { output: 'contents' },
      });

      const result = await firePostToolBatchHook(bus, [toolCall()], 'auto');

      expect(bus.request).toHaveBeenCalledWith(
        {
          type: MessageBusType.HOOK_EXECUTION_REQUEST,
          eventName: 'PostToolBatch',
          input: { permission_mode: 'auto', tool_calls: [toolCall()] },
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
      const bus = busWithOutput({
        continue: false,
        stopReason: 'stop after batch',
      });

      expect(await firePostToolBatchHook(bus, [])).toEqual({
        shouldStop: true,
        stopReason: 'stop after batch',
        additionalContext: undefined,
      });
    });

    it('returns PostToolBatch artifacts', async () => {
      const report = { title: 'Batch report', workspacePath: 'batch.html' };
      const bus = busWithOutput({
        hookSpecificOutput: {
          artifacts: [
            { ...report },
            { title: 'Bad report', workspacePath: 123 },
          ],
        },
      });

      expect(await firePostToolBatchHook(bus, [])).toEqual({
        shouldStop: false,
        additionalContext: undefined,
        artifacts: [report],
      });
    });

    it('should stop on deny decisions', async () => {
      const bus = busWithOutput({
        decision: 'deny',
        reason: 'blocked after batch',
      });

      expect(await firePostToolBatchHook(bus, [])).toEqual({
        shouldStop: true,
        stopReason: 'blocked after batch',
        additionalContext: undefined,
      });
    });

    it('should return hookError when hook execution fails without an error message', async () => {
      const bus = busResolving({ success: false });
      const result = await firePostToolBatchHook(bus, []);

      expect(result.shouldStop).toBe(false);
      expect(result.hookError).toMatch(/success: false/);
      expect(debugLoggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('PostToolBatch hook returned failure'),
      );
    });

    it('should return hookError when hook returns success without output', async () => {
      const result = await firePostToolBatchHook(busWithOutput(undefined), []);

      expect(result.shouldStop).toBe(false);
      expect(result.hookError).toMatch(/no output/);
    });

    it('should return hookError when messageBus.request throws', async () => {
      const result = await firePostToolBatchHook(
        busRejecting('bus timeout'),
        [],
      );

      expect(result.shouldStop).toBe(false);
      expect(result.hookError).toContain('bus timeout');
    });
  });

  describe('firePostToolUseFailureHook', () => {
    const failure = (bus?: MessageBus) =>
      firePostToolUseFailureHook(
        bus,
        'test-id',
        'test-tool',
        {},
        'error message',
      );

    it('should return empty object when no messageBus is provided', async () => {
      expect(await failure()).toEqual({});
    });

    it('should return sentinel hookError when hook execution fails without an error message', async () => {
      const result = await failure(busResolving({ success: false }));

      // #4321 review-7 SF-H1 — see firePreToolUseHook counterpart.
      expect(result.hookError).toMatch(/success: false/);
    });

    it('synthesizes sentinel hookError when runner returns empty-string error message (#4321)', async () => {
      // #4321 review-9 — see firePreToolUseHook counterpart.
      const result = await failure(busResolving(EMPTY_ERROR));

      expect(result.hookError).toMatch(/success: false/);
      expect(result.hookError).not.toBe('');
    });

    it('should return empty object when hook output is empty', async () => {
      expect(await failure(busWithOutput({}))).toEqual({});
    });

    it('should return additional context when available', async () => {
      const additionalContext = 'Additional context about the failure';
      const result = await failure(
        busWithOutput({ hookSpecificOutput: { additionalContext } }),
      );

      expect(result).toEqual({ additionalContext });
    });

    it('returns PostToolUseFailure artifacts', async () => {
      const report = {
        title: 'Failure report',
        workspacePath: 'reports/failure.html',
      };
      const result = await failure(
        busWithOutput({
          hookSpecificOutput: {
            artifacts: [
              { ...report },
              { title: 'Malformed failure report', metadata: [] },
            ],
          },
        }),
      );

      expect(result).toEqual({ artifacts: [report] });
    });

    it('should handle hook execution errors gracefully', async () => {
      const result = await failure(busRejecting('Network error'));

      // #4321 review: hookError now surfaced to caller.
      expect(result.hookError).toBeDefined();
      expect(result.additionalContext).toBeUndefined();
    });
  });

  describe('appendAdditionalContext', () => {
    it('preserves structured media and its ordering when adding hook context', () => {
      const parts = [
        { text: 'resource media-1' },
        { fileData: { mimeType: 'image/png', fileUri: 'oss://image' } },
      ];
      const response = (output: string) => [
        {
          functionResponse: {
            id: 'call-1',
            name: 'exec',
            response: { output },
            parts,
          },
        },
      ];
      const original = response('read completed');
      expect(appendAdditionalContext(original, 'hook context')).toEqual(
        response('read completed\n\nhook context'),
      );
      expect(original[0].functionResponse.response.output).toBe(
        'read completed',
      );
    });

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
      const result = appendAdditionalContext(
        [{ text: 'original' }],
        'additional context',
      );

      expect(result).toEqual([
        { text: 'original' },
        { text: 'additional context' },
      ]);
    });

    it('wraps single non-array PartListUnion content so the addition still lands', () => {
      // Regression: `ReadFile` returns a single `{ inlineData: {...} }` Part
      // (not an array) for images and PDFs. Returning such content unchanged
      // silently dropped every hook-injected reminder, including the
      // path-conditional skill activation `<system-reminder>` and the
      // ConditionalRulesRegistry rule injection. Wrap it into an array.
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
      const result = appendAdditionalContext([{ text: 'original' }], undefined);

      expect(result).toEqual([{ text: 'original' }]);
    });
  });

  describe('fireNotificationHook', () => {
    const notify = (bus: MessageBus | undefined, type: NotificationType) =>
      fireNotificationHook(bus, 'Test notification', type);

    /** Fires on an empty-output bus and checks the request it sent. */
    async function expectNotificationRequest(
      message: string,
      type: NotificationType,
      notificationType: string,
      title?: string,
    ) {
      const bus = busWithOutput({});
      await fireNotificationHook(bus, message, type, title);
      expect(bus.request).toHaveBeenCalledWith(
        {
          type: MessageBusType.HOOK_EXECUTION_REQUEST,
          eventName: 'Notification',
          input: { message, notification_type: notificationType, title },
        },
        MessageBusType.HOOK_EXECUTION_RESPONSE,
      );
    }

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
      const bus = busResolving({ success: false });
      const result = await notify(bus, NotificationType.PermissionPrompt);

      expect(result).toEqual({});
    });

    it('should return empty object when hook output is empty', async () => {
      const result = await notify(
        busWithOutput({}),
        NotificationType.IdlePrompt,
      );

      expect(result).toEqual({});
    });

    it('should return additional context when available', async () => {
      const additionalContext = 'Additional context from notification hook';
      const bus = busWithOutput({ hookSpecificOutput: { additionalContext } });
      const result = await notify(bus, NotificationType.AuthSuccess);

      expect(result).toEqual({ additionalContext });
    });

    it('should return terminal sequence when available', async () => {
      const bus = busWithOutput({ terminalSequence: '\x07' });
      const result = await notify(bus, NotificationType.PermissionPrompt);

      expect(result).toEqual({ terminalSequence: '\x07' });
    });

    it.each([
      [
        'permission_prompt',
        NotificationType.PermissionPrompt,
        'Qwen Code needs your permission to use Bash',
        'Permission needed',
      ],
      [
        'idle_prompt',
        NotificationType.IdlePrompt,
        'Qwen Code is waiting for your input',
        'Waiting for input',
      ],
      [
        'auth_success',
        NotificationType.AuthSuccess,
        'Authentication successful',
        undefined,
      ],
      [
        'elicitation_dialog',
        NotificationType.ElicitationDialog,
        'Dialog shown to user',
        'Dialog',
      ],
    ])(
      'should send correct parameters to MessageBus for %s',
      (notificationType, type, message, title) =>
        expectNotificationRequest(message, type, notificationType, title),
    );

    it('should handle hook execution errors gracefully', async () => {
      const bus = busRejecting('Network error');
      const result = await notify(bus, NotificationType.PermissionPrompt);

      expect(result).toEqual({});
    });

    it('should handle notification without title', async () => {
      await expectNotificationRequest(
        'Test notification without title',
        NotificationType.IdlePrompt,
        'idle_prompt',
      );
    });
  });

  describe('firePermissionRequestHook', () => {
    const permission = (bus?: MessageBus) =>
      firePermissionRequestHook(bus, 'test-tool', {}, 'auto');
    const decision = (value: Record<string, unknown>) =>
      busWithOutput({ hookSpecificOutput: { decision: value } });

    /** Fires for `ls` with `suggestions` and checks the request it sent. */
    async function expectPermissionRequest(suggestions?: unknown[]) {
      const expected = structuredClone(suggestions);
      const bus = busWithOutput({});
      await firePermissionRequestHook(
        bus,
        'run_shell_command',
        { command: 'ls' },
        'auto',
        suggestions as Parameters<typeof firePermissionRequestHook>[4],
      );
      expect(bus.request).toHaveBeenCalledWith(
        {
          type: MessageBusType.HOOK_EXECUTION_REQUEST,
          eventName: 'PermissionRequest',
          input: {
            tool_name: 'run_shell_command',
            tool_input: { command: 'ls' },
            permission_mode: 'auto',
            permission_suggestions: expected,
          },
        },
        MessageBusType.HOOK_EXECUTION_RESPONSE,
      );
    }

    it('should return hasDecision: false when no messageBus is provided', async () => {
      expect(await permission()).toEqual({ hasDecision: false });
    });

    it('should return hasDecision: false when hook execution fails', async () => {
      const result = await permission(busResolving({ success: false }));

      expect(result).toEqual({ hasDecision: false });
    });

    it('should return hasDecision: false when hook output is empty', async () => {
      expect(await permission(busWithOutput({}))).toEqual({
        hasDecision: false,
      });
    });

    it('should return hasDecision: true with allow decision when tool is allowed', async () => {
      const bus = decision({
        behavior: 'allow',
        updatedInput: { command: 'ls -la' },
        message: 'Tool allowed by policy',
      });
      const result = await firePermissionRequestHook(
        bus,
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
      const bus = decision({
        behavior: 'deny',
        message: 'Tool denied by policy',
        interrupt: true,
      });
      const result = await firePermissionRequestHook(
        bus,
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
      await expectPermissionRequest([
        { type: 'always_allow', tool: 'run_shell_command' },
      ]);
    });

    it('should handle missing updated_input in allow decision', async () => {
      const bus = decision({ behavior: 'allow', message: 'Tool allowed' });

      expect(await permission(bus)).toEqual({
        hasDecision: true,
        shouldAllow: true,
        denyMessage: undefined,
        shouldInterrupt: undefined,
      });
    });

    it('should handle missing message in decision', async () => {
      expect(await permission(decision({ behavior: 'deny' }))).toEqual({
        hasDecision: true,
        shouldAllow: false,
        denyMessage: undefined,
        shouldInterrupt: undefined,
      });
    });

    it('should handle hook execution errors gracefully', async () => {
      const result = await permission(busRejecting('Network error'));

      expect(result).toEqual({ hasDecision: false });
    });

    it('should handle permission_suggestions being undefined', async () => {
      await expectPermissionRequest(undefined);
    });

    it('should handle different permission modes', async () => {
      const bus = decision({ behavior: 'allow' });
      const fire = (mode: string) =>
        firePermissionRequestHook(bus, 'test-tool', {}, mode);

      expect((await fire('plan')).hasDecision).toBe(true);
      expect((await fire('yolo')).hasDecision).toBe(true);
    });
  });
});
