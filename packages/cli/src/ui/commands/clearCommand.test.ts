/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { clearCommand } from './clearCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import {
  SessionEndReason,
  SessionStartSource,
  ideContextStore,
} from '@qwen-code/qwen-code-core';

// Mock the telemetry service
vi.mock('@qwen-code/qwen-code-core', async () => {
  const actual = await vi.importActual('@qwen-code/qwen-code-core');
  return {
    ...actual,
    uiTelemetryService: {
      reset: vi.fn(),
    },
    ideContextStore: {
      clear: vi.fn(),
    },
  };
});

import type { GeminiClient } from '@qwen-code/qwen-code-core';

describe('clearCommand', () => {
  let mockContext: CommandContext;
  let mockResetChat: ReturnType<typeof vi.fn>;
  let mockStartNewSession: ReturnType<typeof vi.fn>;
  let mockFireSessionEndEvent: ReturnType<typeof vi.fn>;
  let mockFireSessionStartEvent: ReturnType<typeof vi.fn>;
  let mockGetHookSystem: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockResetChat = vi.fn().mockResolvedValue(undefined);
    mockStartNewSession = vi.fn().mockReturnValue('new-session-id');
    mockFireSessionEndEvent = vi.fn().mockResolvedValue(undefined);
    mockFireSessionStartEvent = vi.fn().mockResolvedValue(undefined);
    mockGetHookSystem = vi.fn().mockReturnValue({
      fireSessionEndEvent: mockFireSessionEndEvent,
      fireSessionStartEvent: mockFireSessionStartEvent,
    });
    vi.clearAllMocks();

    mockContext = createMockCommandContext({
      services: {
        config: {
          getGeminiClient: () =>
            ({
              resetChat: mockResetChat,
            }) as unknown as GeminiClient,
          startNewSession: mockStartNewSession,
          getHookSystem: mockGetHookSystem,
          getDebugLogger: () => ({
            warn: vi.fn(),
          }),
          getModel: () => 'test-model',
          getToolRegistry: () => undefined,
          getApprovalMode: () => 'default',
        },
      },
      session: {
        startNewSession: vi.fn(),
      },
    });
  });

  it('should only clear UI when called without flags', async () => {
    if (!clearCommand.action) {
      throw new Error('clearCommand must have an action.');
    }

    await clearCommand.action(mockContext, '');

    expect(mockContext.ui.clear).toHaveBeenCalledTimes(1);
    expect(mockResetChat).not.toHaveBeenCalled();
    expect(mockStartNewSession).not.toHaveBeenCalled();
  });

  it('should return confirm_action when called with --history and not confirmed', async () => {
    if (!clearCommand.action) {
      throw new Error('clearCommand must have an action.');
    }

    const result = await clearCommand.action(mockContext, '--history');

    expect(result).toEqual({
      type: 'confirm_action',
      prompt: 'Are you sure you want to clear the conversation history?',
      originalInvocation: { raw: '/clear --history' },
    });
    expect(mockContext.ui.clear).not.toHaveBeenCalled();
    expect(mockResetChat).not.toHaveBeenCalled();
  });

  it('should return confirm_action when called with --all and not confirmed', async () => {
    if (!clearCommand.action) {
      throw new Error('clearCommand must have an action.');
    }

    const result = await clearCommand.action(mockContext, '--all');

    expect(result).toEqual({
      type: 'confirm_action',
      prompt: 'Are you sure you want to completely reset the session?',
      originalInvocation: { raw: '/clear --all' },
    });
    expect(mockContext.ui.clear).not.toHaveBeenCalled();
    expect(mockResetChat).not.toHaveBeenCalled();
  });

  it('should set debug message, start a new session, reset chat, and clear UI when confirmed with --history', async () => {
    if (!clearCommand.action) {
      throw new Error('clearCommand must have an action.');
    }

    mockContext.overwriteConfirmed = true;
    await clearCommand.action(mockContext, '--history');

    expect(mockContext.ui.setDebugMessage).toHaveBeenCalledWith(
      'Starting a new session, resetting chat, and clearing terminal.',
    );
    expect(mockStartNewSession).toHaveBeenCalledTimes(1);
    expect(mockContext.session.startNewSession).toHaveBeenCalledWith(
      'new-session-id',
    );
    expect(mockResetChat).toHaveBeenCalledTimes(1);
    expect(mockContext.ui.clear).toHaveBeenCalledTimes(1);
    expect(ideContextStore.clear).not.toHaveBeenCalled();
  });

  it('should completely reset session when confirmed with --all', async () => {
    if (!clearCommand.action) {
      throw new Error('clearCommand must have an action.');
    }

    mockContext.overwriteConfirmed = true;
    await clearCommand.action(mockContext, '--all');

    expect(mockStartNewSession).toHaveBeenCalledTimes(1);
    expect(mockResetChat).toHaveBeenCalledTimes(1);
    expect(mockContext.ui.clear).toHaveBeenCalledTimes(1);
    expect(ideContextStore.clear).toHaveBeenCalledTimes(1);
  });

  it('should fire SessionEnd event before clearing and SessionStart event after clearing when confirmed', async () => {
    if (!clearCommand.action) {
      throw new Error('clearCommand must have an action.');
    }

    mockContext.overwriteConfirmed = true;
    await clearCommand.action(mockContext, '--history');

    expect(mockGetHookSystem).toHaveBeenCalled();
    expect(mockFireSessionEndEvent).toHaveBeenCalledWith(
      SessionEndReason.Clear,
    );
    expect(mockFireSessionStartEvent).toHaveBeenCalledWith(
      SessionStartSource.Clear,
      'test-model',
      expect.any(String), // permissionMode
    );

    // SessionEnd should be called before SessionStart
    const sessionEndCallOrder =
      mockFireSessionEndEvent.mock.invocationCallOrder[0];
    const sessionStartCallOrder =
      mockFireSessionStartEvent.mock.invocationCallOrder[0];
    expect(sessionEndCallOrder).toBeLessThan(sessionStartCallOrder);
  });

  it('should handle hook errors gracefully and continue execution', async () => {
    if (!clearCommand.action) {
      throw new Error('clearCommand must have an action.');
    }

    mockFireSessionEndEvent.mockRejectedValue(
      new Error('SessionEnd hook failed'),
    );
    mockFireSessionStartEvent.mockRejectedValue(
      new Error('SessionStart hook failed'),
    );

    mockContext.overwriteConfirmed = true;
    await clearCommand.action(mockContext, '--history');

    // Should still complete the clear operation despite hook errors
    expect(mockStartNewSession).toHaveBeenCalledTimes(1);
    expect(mockResetChat).toHaveBeenCalledTimes(1);
    expect(mockContext.ui.clear).toHaveBeenCalledTimes(1);
  });

  it('should clear UI before resetChat for immediate responsiveness', async () => {
    if (!clearCommand.action) {
      throw new Error('clearCommand must have an action.');
    }

    const callOrder: string[] = [];
    (mockContext.ui.clear as ReturnType<typeof vi.fn>).mockImplementation(
      () => {
        callOrder.push('ui.clear');
      },
    );
    mockResetChat.mockImplementation(async () => {
      callOrder.push('resetChat');
    });

    mockContext.overwriteConfirmed = true;
    await clearCommand.action(mockContext, '--history');

    // ui.clear should be called before resetChat for immediate UI feedback
    const clearIndex = callOrder.indexOf('ui.clear');
    const resetIndex = callOrder.indexOf('resetChat');
    expect(clearIndex).toBeGreaterThanOrEqual(0);
    expect(resetIndex).toBeGreaterThanOrEqual(0);
    expect(clearIndex).toBeLessThan(resetIndex);
  });

  it('should not await hook events (fire-and-forget)', async () => {
    if (!clearCommand.action) {
      throw new Error('clearCommand must have an action.');
    }

    // Make hooks take a long time - they should not block
    let sessionEndResolved = false;
    let sessionStartResolved = false;
    mockFireSessionEndEvent.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            sessionEndResolved = true;
            resolve(undefined);
          }, 5000);
        }),
    );
    mockFireSessionStartEvent.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            sessionStartResolved = true;
            resolve(undefined);
          }, 5000);
        }),
    );

    mockContext.overwriteConfirmed = true;
    await clearCommand.action(mockContext, '--history');

    // The action should complete immediately without waiting for hooks
    expect(mockContext.ui.clear).toHaveBeenCalledTimes(1);
    expect(mockResetChat).toHaveBeenCalledTimes(1);
    // Hooks should have been called but not necessarily resolved
    expect(mockFireSessionEndEvent).toHaveBeenCalled();
    expect(mockFireSessionStartEvent).toHaveBeenCalled();
    // Hooks should NOT have resolved yet since they have 5s timeouts
    expect(sessionEndResolved).toBe(false);
    expect(sessionStartResolved).toBe(false);
  });

  it('should not attempt to reset chat if config service is not available', async () => {
    if (!clearCommand.action) {
      throw new Error('clearCommand must have an action.');
    }

    const nullConfigContext = createMockCommandContext({
      services: {
        config: null,
      },
      session: {
        startNewSession: vi.fn(),
      },
      overwriteConfirmed: true,
    });

    await clearCommand.action(nullConfigContext, '--history');

    expect(nullConfigContext.ui.setDebugMessage).toHaveBeenCalledWith(
      'Starting a new session and clearing.',
    );
    expect(mockResetChat).not.toHaveBeenCalled();
    expect(nullConfigContext.ui.clear).toHaveBeenCalledTimes(1);
  });
});
