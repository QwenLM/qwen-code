/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import {
  SessionEndReason,
  SessionStartSource,
} from '@qwen-code/qwen-code-core';

// Hoisted spies for the kind-local abort helpers and the
// resetBackgroundStateForSessionSwitch helper. The mock factory below
// runs before the test body, so any spy referenced inside it must be
// hoisted via vi.hoisted(). The clear flow calls each of these in a
// fixed order; tests assert that order via invocationCallOrder.
const mockAgentAbortAll = vi.hoisted(() => vi.fn());
const mockMonitorAbortAll = vi.hoisted(() => vi.fn());
const mockShellAbortAll = vi.hoisted(() => vi.fn());

vi.mock('@qwen-code/qwen-code-core', async () => {
  const actual = await vi.importActual('@qwen-code/qwen-code-core');
  return {
    ...actual,
    agentAbortAll: mockAgentAbortAll,
    monitorAbortAll: mockMonitorAbortAll,
    shellAbortAll: mockShellAbortAll,
    uiTelemetryService: {
      reset: vi.fn(),
    },
  };
});

const mockResetBackgroundStateForSessionSwitch = vi.hoisted(() => vi.fn());
const mockHasBlockingBackgroundWork = vi.hoisted(() =>
  vi.fn().mockReturnValue(false),
);
vi.mock('../utils/backgroundWorkUtils.js', () => ({
  hasBlockingBackgroundWork: mockHasBlockingBackgroundWork,
  resetBackgroundStateForSessionSwitch:
    mockResetBackgroundStateForSessionSwitch,
}));

import { clearCommand } from './clearCommand.js';
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

    const stubRegistry = {
      getAll: () => [],
      getByKind: () => [],
      get: vi.fn(),
      register: vi.fn(),
      update: vi.fn(),
      evict: vi.fn(),
      kill: vi.fn(),
      subscribe: vi.fn(() => () => {}),
    };

    mockContext = createMockCommandContext({
      services: {
        config: {
          getGeminiClient: () =>
            ({
              resetChat: mockResetChat,
            }) as unknown as GeminiClient,
          getTaskRegistry: vi.fn().mockReturnValue(stubRegistry),
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
      expect.any(String),
    );

    const sessionEndCallOrder =
      mockFireSessionEndEvent.mock.invocationCallOrder[0];
    const sessionStartCallOrder =
      mockFireSessionStartEvent.mock.invocationCallOrder[0];
    expect(sessionEndCallOrder).toBeLessThan(sessionStartCallOrder);
  });

  it('aborts old background work before starting a new session', async () => {
    if (!clearCommand.action) {
      throw new Error('clearCommand must have an action.');
    }

    await clearCommand.action(mockContext, '');

    expect(mockAgentAbortAll).toHaveBeenCalledWith(expect.anything(), {
      notify: false,
    });
    expect(mockMonitorAbortAll).toHaveBeenCalledWith(expect.anything(), {
      notify: false,
    });
    expect(mockShellAbortAll).toHaveBeenCalledTimes(1);
    expect(mockResetBackgroundStateForSessionSwitch).toHaveBeenCalledTimes(1);

    const agentAbort = mockAgentAbortAll.mock.invocationCallOrder[0];
    const monitorAbort = mockMonitorAbortAll.mock.invocationCallOrder[0];
    const shellAbort = mockShellAbortAll.mock.invocationCallOrder[0];
    const reset =
      mockResetBackgroundStateForSessionSwitch.mock.invocationCallOrder[0];
    const newSession = mockStartNewSession.mock.invocationCallOrder[0];

    expect(agentAbort).toBeLessThan(newSession);
    expect(monitorAbort).toBeLessThan(newSession);
    expect(shellAbort).toBeLessThan(newSession);
    expect(reset).toBeLessThan(newSession);
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

  it('should handle missing hook system gracefully', async () => {
    if (!clearCommand.action) {
      throw new Error('clearCommand must have an action.');
    }

    mockGetHookSystem.mockReturnValue(undefined);

    await clearCommand.action(mockContext, '');

    expect(mockFireSessionEndEvent).not.toHaveBeenCalled();
    expect(mockFireSessionStartEvent).not.toHaveBeenCalled();
    expect(mockStartNewSession).toHaveBeenCalledTimes(1);
    expect(mockResetChat).toHaveBeenCalledTimes(1);
  });

  it('should handle missing config gracefully', async () => {
    if (!clearCommand.action) {
      throw new Error('clearCommand must have an action.');
    }

    const ctxNoConfig = createMockCommandContext({
      services: {},
    });

    const result = await clearCommand.action(ctxNoConfig, '');

    expect(result).toBeUndefined();
    expect(mockStartNewSession).not.toHaveBeenCalled();
  });

  describe('non-interactive mode', () => {
    let nonInteractiveContext: ReturnType<typeof createMockCommandContext>;

    beforeEach(() => {
      const stubRegistry = {
        getAll: () => [],
        getByKind: () => [],
        get: vi.fn(),
        register: vi.fn(),
        update: vi.fn(),
        evict: vi.fn(),
        kill: vi.fn(),
        subscribe: vi.fn(() => () => {}),
      };
      nonInteractiveContext = createMockCommandContext({
        executionMode: 'non_interactive',
        services: {
          config: {
            getGeminiClient: () =>
              ({ resetChat: mockResetChat }) as unknown as GeminiClient,
            getTaskRegistry: vi.fn().mockReturnValue(stubRegistry),
            startNewSession: mockStartNewSession,
            getHookSystem: mockGetHookSystem,
            getDebugLogger: () => ({ warn: vi.fn() }),
            getModel: () => 'test-model',
            getToolRegistry: () => undefined,
            getApprovalMode: () => 'default',
          },
        },
        session: { startNewSession: vi.fn() },
      });
    });

    it('returns the context-cleared message and resets chat when not blocked', async () => {
      if (!clearCommand.action)
        throw new Error('clearCommand must have an action.');
      mockHasBlockingBackgroundWork.mockReturnValue(false);

      const result = await clearCommand.action(nonInteractiveContext, '');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: 'Context cleared. Previous messages are no longer in context.',
      });
      expect(mockResetChat).toHaveBeenCalledTimes(1);
      expect(mockFireSessionEndEvent).toHaveBeenCalledWith(
        SessionEndReason.Clear,
      );
      expect(mockFireSessionStartEvent).not.toHaveBeenCalled();
    });

    it('blocks session clearing while background work is still running', async () => {
      if (!clearCommand.action)
        throw new Error('clearCommand must have an action.');
      mockHasBlockingBackgroundWork.mockReturnValue(true);

      const result = await clearCommand.action(nonInteractiveContext, '');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content:
          "Stop the current session's running background tasks before starting a new session.",
      });
      expect(mockStartNewSession).not.toHaveBeenCalled();
      expect(mockResetChat).not.toHaveBeenCalled();
    });
  });
});
