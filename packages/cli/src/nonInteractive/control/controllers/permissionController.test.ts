/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  InputFormat,
  ToolConfirmationOutcome,
} from '@qwen-code/qwen-code-core';
import { createMinimalSettings } from '../../../config/settings.js';
import type { StreamJsonOutputAdapter } from '../../io/StreamJsonOutputAdapter.js';
import type { IControlContext } from '../ControlContext.js';
import type { IPendingRequestRegistry } from './baseController.js';
import { PermissionController } from './permissionController.js';

function createContext(canUseToolTimeoutMs?: number): IControlContext {
  const abortController = new AbortController();

  return {
    config: {
      getDebugMode: vi.fn().mockReturnValue(false),
      getInputFormat: vi.fn().mockReturnValue(InputFormat.STREAM_JSON),
    } as unknown as IControlContext['config'],
    streamJson: {
      send: vi.fn(),
    } as unknown as StreamJsonOutputAdapter,
    sessionId: 'test-session-id',
    abortSignal: abortController.signal,
    debugMode: false,
    settings: createMinimalSettings(),
    permissionMode: 'default',
    sdkCanUseToolTimeoutMs: canUseToolTimeoutMs,
    sdkMcpServers: new Set<string>(),
    mcpClients: new Map(),
    inputClosed: false,
  };
}

function createRegistry(): IPendingRequestRegistry {
  return {
    registerIncomingRequest: vi.fn(),
    deregisterIncomingRequest: vi.fn(),
    registerOutgoingRequest: vi.fn(),
    deregisterOutgoingRequest: vi.fn(),
  };
}

describe('PermissionController', () => {
  it('uses SDK canUseTool timeout for outgoing permission requests', async () => {
    const context = createContext(120_000);
    const controller = new PermissionController(
      context,
      createRegistry(),
      'PermissionController',
    );
    const sendControlRequest = vi
      .spyOn(controller, 'sendControlRequest')
      .mockResolvedValue({
        subtype: 'success',
        request_id: 'request-1',
        response: { behavior: 'allow' },
      });
    const onConfirm = vi.fn();

    controller.getToolCallUpdateCallback()([
      {
        status: 'awaiting_approval',
        request: {
          callId: 'tool-call-1',
          name: 'ask_user_question',
          args: { questions: [] },
        },
        confirmationDetails: {
          type: 'ask_user_question',
          title: 'Please answer',
          onConfirm,
        },
      },
    ]);

    await vi.waitFor(() => {
      expect(sendControlRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          subtype: 'can_use_tool',
          tool_name: 'ask_user_question',
        }),
        120_000,
        context.abortSignal,
      );
    });
    await vi.waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
      );
    });
  });

  it('uses default timeout when SDK canUseTool timeout is undefined', async () => {
    const context = createContext(); // undefined timeout
    const controller = new PermissionController(
      context,
      createRegistry(),
      'PermissionController',
    );
    const sendControlRequest = vi
      .spyOn(controller, 'sendControlRequest')
      .mockResolvedValue({
        subtype: 'success',
        request_id: 'request-2',
        response: { behavior: 'allow' },
      });
    const onConfirm = vi.fn();

    controller.getToolCallUpdateCallback()([
      {
        status: 'awaiting_approval',
        request: {
          callId: 'tool-call-2',
          name: 'ask_user_question',
          args: { questions: [] },
        },
        confirmationDetails: {
          type: 'ask_user_question',
          title: 'Please answer',
          onConfirm,
        },
      },
    ]);

    await vi.waitFor(() => {
      expect(sendControlRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          subtype: 'can_use_tool',
          tool_name: 'ask_user_question',
        }),
        60_000, // DEFAULT_CAN_USE_TOOL_TIMEOUT_MS
        context.abortSignal,
      );
    });
    await vi.waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
      );
    });
  });

  it('calls onConfirm with Cancel when sendControlRequest rejects', async () => {
    const context = createContext(120_000);
    const controller = new PermissionController(
      context,
      createRegistry(),
      'PermissionController',
    );
    vi.spyOn(controller, 'sendControlRequest').mockRejectedValue(
      new Error('Request timeout'),
    );
    const onConfirm = vi.fn();

    controller.getToolCallUpdateCallback()([
      {
        status: 'awaiting_approval',
        request: {
          callId: 'tool-call-3',
          name: 'ask_user_question',
          args: { questions: [] },
        },
        confirmationDetails: {
          type: 'ask_user_question',
          title: 'Please answer',
          onConfirm,
        },
      },
    ]);

    await vi.waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.Cancel,
        expect.objectContaining({
          cancelMessage: expect.stringContaining('Request timeout'),
        }),
      );
    });
  });
});

/**
 * `buildPermissionSuggestions` is a pure transformation from a
 * confirmation-details payload to a `PermissionSuggestion[]`. It does
 * not touch the controller's context, registry, or pending-request
 * state, so the simple `createContext` / `createRegistry` helpers
 * above are sufficient. The tests below cover:
 *
 *   1. The exec branch passes through the command in `description` and
 *      appends one `⚠ <warning>` segment per warning when the payload
 *      carries a `warnings: string[]` field — see #4386 (round 3 review)
 *      for why this branch needs explicit coverage.
 *   2. Non-string entries in `warnings` are filtered out by the
 *      `typeof w === 'string'` type guard.
 *   3. When `warnings` is absent or empty, the description has no
 *      warning suffix and reads identically to the pre-#4386 output.
 *   4. Invalid / non-exec payloads still return a sane suggestion array
 *      (regression guard for the type-guard chain).
 */

function makeBuilderController(): PermissionController {
  return new PermissionController(
    createContext(),
    createRegistry(),
    'PermissionController',
  );
}

describe('PermissionController.buildPermissionSuggestions — exec warnings', () => {
  it('appends ⚠ segments for each string warning on exec confirmations', () => {
    const controller = makeBuilderController();
    const suggestions = controller.buildPermissionSuggestions({
      type: 'exec',
      command: 'python3 -c "print($(echo hello))"',
      warnings: [
        'Contains command substitution ($(...), backticks, <(...), or >(...)).',
      ],
    });

    expect(suggestions).not.toBeNull();
    const allow = suggestions!.find((s) => s.type === 'allow');
    expect(allow).toBeDefined();
    // Command is preserved.
    expect(allow!.description).toContain('python3 -c "print($(echo hello))"');
    // Warning is appended with the ⚠ glyph + space.
    expect(allow!.description).toMatch(/⚠ Contains command substitution/);
    // Deny entry never carries warnings.
    expect(suggestions!.find((s) => s.type === 'deny')?.description).toBe(
      'Block this command execution',
    );
  });

  it('joins multiple warnings with "; "', () => {
    const controller = makeBuilderController();
    const suggestions = controller.buildPermissionSuggestions({
      type: 'exec',
      command: 'cmd',
      warnings: ['warn-a', 'warn-b'],
    });

    const allow = suggestions!.find((s) => s.type === 'allow');
    expect(allow!.description).toContain('⚠ warn-a; ⚠ warn-b');
  });

  it('filters non-string entries out of warnings', () => {
    const controller = makeBuilderController();
    const suggestions = controller.buildPermissionSuggestions({
      type: 'exec',
      command: 'cmd',
      warnings: ['keep-me', 42, null, undefined, { x: 1 }, 'also-keep'],
    });

    const allow = suggestions!.find((s) => s.type === 'allow');
    expect(allow!.description).toContain('⚠ keep-me; ⚠ also-keep');
    expect(allow!.description).not.toMatch(/⚠ 42|⚠ null|⚠ undefined|⚠ \[/);
  });

  it('omits the warning suffix when warnings is absent', () => {
    const controller = makeBuilderController();
    const suggestions = controller.buildPermissionSuggestions({
      type: 'exec',
      command: 'npm install',
    });

    const allow = suggestions!.find((s) => s.type === 'allow');
    expect(allow!.description).toBe('Execute: npm install');
    // No bare "(" suffix means no empty parens leaked.
    expect(allow!.description).not.toContain('(');
  });

  it('omits the warning suffix when warnings is an empty array', () => {
    const controller = makeBuilderController();
    const suggestions = controller.buildPermissionSuggestions({
      type: 'exec',
      command: 'npm install',
      warnings: [],
    });

    const allow = suggestions!.find((s) => s.type === 'allow');
    expect(allow!.description).toBe('Execute: npm install');
  });

  it('omits the warning suffix when warnings is not an array', () => {
    const controller = makeBuilderController();
    const suggestions = controller.buildPermissionSuggestions({
      type: 'exec',
      command: 'npm install',
      // Defensive: hosts could send malformed payloads. The
      // `Array.isArray` guard must keep them on the empty-warnings path.
      warnings: 'not-an-array',
    });

    const allow = suggestions!.find((s) => s.type === 'allow');
    expect(allow!.description).toBe('Execute: npm install');
  });

  it('returns null for confirmation-details payloads without a type field', () => {
    const controller = makeBuilderController();
    expect(controller.buildPermissionSuggestions(null)).toBeNull();
    expect(controller.buildPermissionSuggestions({})).toBeNull();
    expect(controller.buildPermissionSuggestions({ command: 'x' })).toBeNull();
  });
});
