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
} from '@qwen-code/qwen-code-core';

// Mock the telemetry service
vi.mock('@qwen-code/qwen-code-core', async () => {
  const actual = await vi.importActual('@qwen-code/qwen-code-core');
  return {
    ...actual,
    uiTelemetryService: {
      reset: vi.fn(),
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

  it('should set debug message, start a new session, reset chat, and clear UI when config is available', async () => {
    if (!clearCommand.action) {
      throw new Error('clearCommand must have an action.');
    }

    await clearCommand.action(mockContext, '');

    expect(mockContext.ui.setDebugMessage).toHaveBeenCalledWith(
      'Starting a new session, resetting chat, and clearing terminal.',
    );
    expect(mockContext.ui.setDebugMessage).toHaveBeenCalledTimes(1);

    expect(mockStartNewSession).toHaveBeenCalledTimes(1);
    expect(mockContext.session.startNewSession).toHaveBeenCalledWith(
      'new-session-id',
    );
    expect(mockResetChat).toHaveBeenCalledTimes(1);
    expect(mockContext.ui.clear).toHaveBeenCalledTimes(1);

    // Check that all expected operations were called
    expect(mockContext.ui.setDebugMessage).toHaveBeenCalled();
    expect(mockStartNewSession).toHaveBeenCalled();
    expect(mockContext.session.startNewSession).toHaveBeenCalled();
    expect(mockResetChat).toHaveBeenCalled();
    expect(mockContext.ui.clear).toHaveBeenCalled();
  });

  it('should fire SessionEnd event before clearing and SessionStart event after clearing', async () => {
    if (!clearCommand.action) {
      throw new Error('clearCommand must have an action.');
    }

    await clearCommand.action(mockContext, '');

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

    await clearCommand.action(mockContext, '');

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

    await clearCommand.action(mockContext, '');

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

    await clearCommand.action(mockContext, '');

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
    });

    await clearCommand.action(nullConfigContext, '');

    expect(nullConfigContext.ui.setDebugMessage).toHaveBeenCalledWith(
      'Starting a new session and clearing.',
    );
    expect(mockResetChat).not.toHaveBeenCalled();
    expect(nullConfigContext.ui.clear).toHaveBeenCalledTimes(1);
  });

  describe('non-interactive mode', () => {
    let nonInteractiveContext: ReturnType<typeof createMockCommandContext>;

    beforeEach(() => {
      nonInteractiveContext = createMockCommandContext({
        executionMode: 'non_interactive',
        services: {
          config: {
            getHookSystem: mockGetHookSystem,
            startNewSession: mockStartNewSession,
            getGeminiClient: vi.fn().mockReturnValue({
              resetChat: mockResetChat,
            } as unknown as GeminiClient),
            getModel: vi.fn().mockReturnValue('test-model'),
            getApprovalMode: vi.fn().mockReturnValue('default'),
            getToolRegistry: vi.fn().mockReturnValue({
              getAllTools: vi.fn().mockReturnValue([]),
            }),
          },
        },
        session: {
          startNewSession: vi.fn(),
        },
      });
    });

    it('should return context boundary message in non-interactive mode', async () => {
      if (!clearCommand.action)
        throw new Error('clearCommand must have an action.');

      const result = await clearCommand.action(nonInteractiveContext, '');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: 'Context cleared. Previous messages are no longer in context.',
      });
    });

    it('should still call resetChat in non-interactive mode', async () => {
      if (!clearCommand.action)
        throw new Error('clearCommand must have an action.');

      await clearCommand.action(nonInteractiveContext, '');

      expect(mockResetChat).toHaveBeenCalledTimes(1);
    });

    it('should still fire session events in non-interactive mode', async () => {
      if (!clearCommand.action)
        throw new Error('clearCommand must have an action.');

      await clearCommand.action(nonInteractiveContext, '');

      expect(mockFireSessionEndEvent).toHaveBeenCalledWith(
        SessionEndReason.Clear,
      );
      expect(mockFireSessionStartEvent).toHaveBeenCalled();
    });
  });
});
