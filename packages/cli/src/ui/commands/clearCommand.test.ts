/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { clearCommand } from './clearCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { SessionEndReason, ideContextStore } from '@qwen-code/qwen-code-core';

// Mock the telemetry service and IDE context store
vi.mock('@qwen-code/qwen-code-core', async () => {
  const actual = await vi.importActual('@qwen-code/qwen-code-core');
  return {
    ...actual,
    uiTelemetryService: {
      reset: vi.fn(),
      getMetrics: vi.fn(() => ({ models: {} })),
      getSessionStartTime: vi.fn(() => new Date()),
    },
    ideContextStore: {
      clear: vi.fn(),
    },
    persistSessionUsage: vi.fn(),
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
  let mockAbortBackgroundTasks: ReturnType<typeof vi.fn>;
  let mockAbortMonitors: ReturnType<typeof vi.fn>;
  let mockAbortBackgroundShells: ReturnType<typeof vi.fn>;
  let mockResetBackgroundTasks: ReturnType<typeof vi.fn>;
  let mockResetMonitors: ReturnType<typeof vi.fn>;
  let mockResetBackgroundShells: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockResetChat = vi.fn().mockResolvedValue(undefined);
    mockStartNewSession = vi.fn().mockReturnValue('new-session-id');
    mockFireSessionEndEvent = vi.fn().mockResolvedValue(undefined);
    mockFireSessionStartEvent = vi.fn().mockResolvedValue(undefined);
    mockGetHookSystem = vi.fn().mockReturnValue({
      fireSessionEndEvent: mockFireSessionEndEvent,
      fireSessionStartEvent: mockFireSessionStartEvent,
    });
    mockAbortBackgroundTasks = vi.fn();
    mockAbortMonitors = vi.fn();
    mockAbortBackgroundShells = vi.fn();
    mockResetBackgroundTasks = vi.fn();
    mockResetMonitors = vi.fn();
    mockResetBackgroundShells = vi.fn();
    vi.clearAllMocks();
    // `clearAllMocks` zeroes call counters but does NOT clear
    // implementations. The module-level `ideContextStore.clear` mock can
    // pick up a per-test `mockImplementation(...)` override — notably the
    // ordering test at ~line 373 that pushes onto a per-test `callOrder`
    // closure — and that override would otherwise leak into every test
    // that runs afterward. Reset just this mock so the rest of the
    // per-`beforeEach` fresh-`vi.fn()` assignments above keep their
    // explicitly-staged implementations.
    (ideContextStore.clear as ReturnType<typeof vi.fn>).mockReset();

    mockContext = createMockCommandContext({
      services: {
        config: {
          getGeminiClient: () =>
            ({
              resetChat: mockResetChat,
            }) as unknown as GeminiClient,
          getBackgroundTaskRegistry: vi.fn().mockReturnValue({
            hasUnfinalizedTasks: vi.fn().mockReturnValue(false),
            reset: mockResetBackgroundTasks,
            abortAll: mockAbortBackgroundTasks,
          }),
          getBackgroundShellRegistry: vi.fn().mockReturnValue({
            getAll: vi.fn().mockReturnValue([]),
            hasRunningEntries: vi.fn().mockReturnValue(false),
            reset: mockResetBackgroundShells,
            abortAll: mockAbortBackgroundShells,
          }),
          startNewSession: mockStartNewSession,
          getHookSystem: mockGetHookSystem,
          getDebugLogger: () => ({
            warn: vi.fn(),
          }),
          getModel: () => 'test-model',
          getToolRegistry: () => undefined,
          getApprovalMode: () => 'default',
          getSessionId: () => 'test-session-id',
          getProjectRoot: () => '/test/project',
          getMonitorRegistry: () => ({
            getRunning: vi.fn().mockReturnValue([]),
            abortAll: mockAbortMonitors,
            reset: mockResetMonitors,
          }),
          getWorkflowRunRegistry: () => ({
            hasRunningEntries: vi.fn().mockReturnValue(false),
            reset: vi.fn(),
            abortAll: vi.fn(),
          }),
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

    // bare /clear should NOT clear the IDE context store
    expect(ideContextStore.clear).not.toHaveBeenCalled();
  });

  it('should fire SessionEnd event before clearing', async () => {
    if (!clearCommand.action) {
      throw new Error('clearCommand must have an action.');
    }

    await clearCommand.action(mockContext, '');

    expect(mockGetHookSystem).toHaveBeenCalled();
    expect(mockFireSessionEndEvent).toHaveBeenCalledWith(
      SessionEndReason.Clear,
    );
    expect(mockFireSessionStartEvent).not.toHaveBeenCalled();
  });

  it('aborts old background work before starting a new session', async () => {
    if (!clearCommand.action) {
      throw new Error('clearCommand must have an action.');
    }

    await clearCommand.action(mockContext, '');

    expect(mockAbortBackgroundTasks).toHaveBeenCalledWith({ notify: false });
    expect(mockAbortMonitors).toHaveBeenCalledWith({ notify: false });
    expect(mockAbortBackgroundShells).toHaveBeenCalledTimes(1);
    expect(mockAbortBackgroundTasks.mock.invocationCallOrder[0]).toBeLessThan(
      mockStartNewSession.mock.invocationCallOrder[0],
    );
    expect(mockAbortMonitors.mock.invocationCallOrder[0]).toBeLessThan(
      mockStartNewSession.mock.invocationCallOrder[0],
    );
    expect(mockAbortBackgroundShells.mock.invocationCallOrder[0]).toBeLessThan(
      mockResetBackgroundShells.mock.invocationCallOrder[0],
    );
    expect(mockAbortBackgroundTasks.mock.invocationCallOrder[0]).toBeLessThan(
      mockResetBackgroundTasks.mock.invocationCallOrder[0],
    );
    expect(mockAbortMonitors.mock.invocationCallOrder[0]).toBeLessThan(
      mockResetMonitors.mock.invocationCallOrder[0],
    );
    expect(mockResetBackgroundShells.mock.invocationCallOrder[0]).toBeLessThan(
      mockStartNewSession.mock.invocationCallOrder[0],
    );
    expect(mockResetBackgroundTasks.mock.invocationCallOrder[0]).toBeLessThan(
      mockStartNewSession.mock.invocationCallOrder[0],
    );
    expect(mockResetMonitors.mock.invocationCallOrder[0]).toBeLessThan(
      mockStartNewSession.mock.invocationCallOrder[0],
    );
  });

  it('should persist usage when session has activity before clearing', async () => {
    const core = await import('@qwen-code/qwen-code-core');
    (
      core.uiTelemetryService.getMetrics as ReturnType<typeof vi.fn>
    ).mockReturnValue({
      models: { 'test-model': { api: { totalRequests: 5 } } },
    });

    await clearCommand.action!(mockContext, '');

    expect(core.persistSessionUsage).toHaveBeenCalledTimes(1);
  });

  it('should not persist usage when session has no activity', async () => {
    const core = await import('@qwen-code/qwen-code-core');
    (
      core.uiTelemetryService.getMetrics as ReturnType<typeof vi.fn>
    ).mockReturnValue({
      models: {},
    });

    await clearCommand.action!(mockContext, '');

    expect(core.persistSessionUsage).not.toHaveBeenCalled();
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
    // SessionEnd hook should have been called but not necessarily resolved
    expect(mockFireSessionEndEvent).toHaveBeenCalled();
    expect(mockFireSessionStartEvent).not.toHaveBeenCalled();
    // SessionEnd hook should NOT have resolved yet since it has a 5s timeout
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

  describe('--all flag', () => {
    it('returns confirm_action when --all is used and not yet confirmed (interactive)', async () => {
      if (!clearCommand.action) {
        throw new Error('clearCommand must have an action.');
      }

      const result = await clearCommand.action(mockContext, '--all');

      expect(result).toEqual({
        type: 'confirm_action',
        prompt: 'Are you sure you want to completely reset the session?',
        originalInvocation: { raw: '/clear --all' },
      });
      // Nothing should be cleared yet — waiting for confirmation
      expect(mockContext.ui.clear).not.toHaveBeenCalled();
      expect(mockResetChat).not.toHaveBeenCalled();
      expect(ideContextStore.clear).not.toHaveBeenCalled();
    });

    it('uses context.invocation.raw verbatim when present', async () => {
      if (!clearCommand.action) {
        throw new Error('clearCommand must have an action.');
      }

      const ctx = createMockCommandContext({
        services: mockContext.services,
        session: mockContext.session,
        invocation: { raw: '/reset --all' },
      });

      const result = await clearCommand.action(ctx, '--all');

      expect(result).toMatchObject({
        type: 'confirm_action',
        originalInvocation: { raw: '/reset --all' },
      });
    });

    it('clears IDE context store after confirmation with --all', async () => {
      if (!clearCommand.action) {
        throw new Error('clearCommand must have an action.');
      }

      mockContext.overwriteConfirmed = true;
      await clearCommand.action(mockContext, '--all');

      expect(ideContextStore.clear).toHaveBeenCalledTimes(1);
      expect(mockStartNewSession).toHaveBeenCalledTimes(1);
      expect(mockResetChat).toHaveBeenCalledTimes(1);
      expect(mockContext.ui.clear).toHaveBeenCalledTimes(1);
    });

    it('clears IDE context store on --all even when config is null', async () => {
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

      await clearCommand.action(nullConfigContext, '--all');

      expect(ideContextStore.clear).toHaveBeenCalledTimes(1);
      expect(nullConfigContext.ui.clear).toHaveBeenCalledTimes(1);
      expect(mockResetChat).not.toHaveBeenCalled();
    });

    it('continues session teardown even if ideContextStore.clear() throws', async () => {
      if (!clearCommand.action) {
        throw new Error('clearCommand must have an action.');
      }

      (ideContextStore.clear as ReturnType<typeof vi.fn>).mockImplementation(
        () => {
          throw new Error('subscriber blew up');
        },
      );

      mockContext.overwriteConfirmed = true;
      await clearCommand.action(mockContext, '--all');

      expect(ideContextStore.clear).toHaveBeenCalledTimes(1);
      expect(mockStartNewSession).toHaveBeenCalledTimes(1);
      expect(mockResetChat).toHaveBeenCalledTimes(1);
      expect(mockContext.ui.clear).toHaveBeenCalledTimes(1);
    });

    it('treats --all as exact token (does not match --allow etc.)', async () => {
      if (!clearCommand.action) {
        throw new Error('clearCommand must have an action.');
      }

      const result = await clearCommand.action(mockContext, '--allow');

      // --allow is not --all, so no confirmation, bare clear behavior
      expect(result).toBeUndefined();
      expect(ideContextStore.clear).not.toHaveBeenCalled();
      expect(mockContext.ui.clear).toHaveBeenCalledTimes(1);
    });

    it('clears IDE context store BEFORE resetChat so it survives a resetChat throw', async () => {
      if (!clearCommand.action) {
        throw new Error('clearCommand must have an action.');
      }

      const callOrder: string[] = [];
      (ideContextStore.clear as ReturnType<typeof vi.fn>).mockImplementation(
        () => {
          callOrder.push('ideContextStore.clear');
        },
      );
      mockResetChat.mockImplementation(async () => {
        callOrder.push('resetChat');
        throw new Error('reset failed');
      });

      mockContext.overwriteConfirmed = true;

      await expect(clearCommand.action(mockContext, '--all')).rejects.toThrow(
        'reset failed',
      );

      expect(callOrder.indexOf('ideContextStore.clear')).toBeGreaterThanOrEqual(
        0,
      );
      expect(callOrder.indexOf('resetChat')).toBeGreaterThan(
        callOrder.indexOf('ideContextStore.clear'),
      );
      expect(ideContextStore.clear).toHaveBeenCalledTimes(1);
    });

    it('returns block message and does NOT prompt for confirmation when --all + blocking background work (interactive)', async () => {
      if (!clearCommand.action) {
        throw new Error('clearCommand must have an action.');
      }

      const blockedContext = createMockCommandContext({
        services: {
          config: {
            getBackgroundTaskRegistry: vi.fn().mockReturnValue({
              hasUnfinalizedTasks: vi.fn().mockReturnValue(true),
              reset: vi.fn(),
            }),
            getBackgroundShellRegistry: vi.fn().mockReturnValue({
              getAll: vi.fn().mockReturnValue([]),
              hasRunningEntries: vi.fn().mockReturnValue(false),
              reset: vi.fn(),
            }),
            getMonitorRegistry: vi.fn().mockReturnValue({
              getRunning: vi.fn().mockReturnValue([]),
              reset: vi.fn(),
            }),
            getHookSystem: mockGetHookSystem,
            startNewSession: mockStartNewSession,
            getGeminiClient: vi.fn().mockReturnValue({
              resetChat: mockResetChat,
            } as unknown as GeminiClient),
            getDebugLogger: vi.fn().mockReturnValue({ warn: vi.fn() }),
          },
        },
        session: {
          startNewSession: vi.fn(),
        },
      });

      const result = await clearCommand.action(blockedContext, '--all');

      // Should not return confirm_action — block check runs first
      expect(result).toBeUndefined();
      expect(blockedContext.ui.setDebugMessage).toHaveBeenCalledWith(
        "Stop the current session's running background tasks before starting a new session.",
      );
      expect(ideContextStore.clear).not.toHaveBeenCalled();
      expect(mockStartNewSession).not.toHaveBeenCalled();
      expect(mockResetChat).not.toHaveBeenCalled();
    });

    it('returns error and does NOT clear IDE store when --all + blocking background work (non-interactive)', async () => {
      if (!clearCommand.action) {
        throw new Error('clearCommand must have an action.');
      }

      const blockedContext = createMockCommandContext({
        executionMode: 'non_interactive',
        services: {
          config: {
            getBackgroundTaskRegistry: vi.fn().mockReturnValue({
              hasUnfinalizedTasks: vi.fn().mockReturnValue(true),
              reset: vi.fn(),
            }),
            getBackgroundShellRegistry: vi.fn().mockReturnValue({
              getAll: vi.fn().mockReturnValue([]),
              hasRunningEntries: vi.fn().mockReturnValue(false),
              reset: vi.fn(),
            }),
            getMonitorRegistry: vi.fn().mockReturnValue({
              getRunning: vi.fn().mockReturnValue([]),
              reset: vi.fn(),
            }),
            getHookSystem: mockGetHookSystem,
            startNewSession: mockStartNewSession,
            getGeminiClient: vi.fn().mockReturnValue({
              resetChat: mockResetChat,
            } as unknown as GeminiClient),
            getDebugLogger: vi.fn().mockReturnValue({ warn: vi.fn() }),
          },
        },
        session: {
          startNewSession: vi.fn(),
        },
      });

      const result = await clearCommand.action(blockedContext, '--all');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content:
          "Stop the current session's running background tasks before starting a new session.",
      });
      expect(ideContextStore.clear).not.toHaveBeenCalled();
      expect(mockStartNewSession).not.toHaveBeenCalled();
      expect(mockResetChat).not.toHaveBeenCalled();
    });
  });

  describe('non-interactive mode', () => {
    let nonInteractiveContext: ReturnType<typeof createMockCommandContext>;

    beforeEach(() => {
      nonInteractiveContext = createMockCommandContext({
        executionMode: 'non_interactive',
        services: {
          config: {
            getHookSystem: mockGetHookSystem,
            getBackgroundTaskRegistry: vi.fn().mockReturnValue({
              hasUnfinalizedTasks: vi.fn().mockReturnValue(false),
              reset: mockResetBackgroundTasks,
              abortAll: mockAbortBackgroundTasks,
            }),
            getBackgroundShellRegistry: vi.fn().mockReturnValue({
              getAll: vi.fn().mockReturnValue([]),
              hasRunningEntries: vi.fn().mockReturnValue(false),
              reset: mockResetBackgroundShells,
              abortAll: mockAbortBackgroundShells,
            }),
            startNewSession: mockStartNewSession,
            getGeminiClient: vi.fn().mockReturnValue({
              resetChat: mockResetChat,
            } as unknown as GeminiClient),
            getModel: vi.fn().mockReturnValue('test-model'),
            getApprovalMode: vi.fn().mockReturnValue('default'),
            getToolRegistry: vi.fn().mockReturnValue({
              getAllTools: vi.fn().mockReturnValue([]),
            }),
            getMonitorRegistry: () => ({
              getRunning: vi.fn().mockReturnValue([]),
              abortAll: mockAbortMonitors,
              reset: mockResetMonitors,
            }),
            getWorkflowRunRegistry: () => ({
              hasRunningEntries: vi.fn().mockReturnValue(false),
              reset: vi.fn(),
              abortAll: vi.fn(),
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

    it('should still fire SessionEnd in non-interactive mode', async () => {
      if (!clearCommand.action)
        throw new Error('clearCommand must have an action.');

      await clearCommand.action(nonInteractiveContext, '');

      expect(mockFireSessionEndEvent).toHaveBeenCalledWith(
        SessionEndReason.Clear,
      );
      expect(mockFireSessionStartEvent).not.toHaveBeenCalled();
    });

    it('--all skips confirmation in non-interactive mode and clears IDE store', async () => {
      if (!clearCommand.action)
        throw new Error('clearCommand must have an action.');

      const result = await clearCommand.action(nonInteractiveContext, '--all');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: 'Context cleared. Previous messages are no longer in context.',
      });
      expect(ideContextStore.clear).toHaveBeenCalledTimes(1);
      expect(mockResetChat).toHaveBeenCalledTimes(1);
    });

    it('blocks session clearing while background work is still running', async () => {
      if (!clearCommand.action)
        throw new Error('clearCommand must have an action.');

      const blockedContext = createMockCommandContext({
        executionMode: 'non_interactive',
        services: {
          config: {
            getBackgroundTaskRegistry: vi.fn().mockReturnValue({
              hasUnfinalizedTasks: vi.fn().mockReturnValue(true),
              reset: vi.fn(),
            }),
            getBackgroundShellRegistry: vi.fn().mockReturnValue({
              getAll: vi.fn().mockReturnValue([]),
              hasRunningEntries: vi.fn().mockReturnValue(false),
              reset: vi.fn(),
            }),
            getMonitorRegistry: vi.fn().mockReturnValue({
              getRunning: vi.fn().mockReturnValue([]),
              reset: vi.fn(),
            }),
            getWorkflowRunRegistry: vi.fn().mockReturnValue({
              hasRunningEntries: vi.fn().mockReturnValue(false),
              reset: vi.fn(),
              abortAll: vi.fn(),
            }),
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
            getDebugLogger: vi.fn().mockReturnValue({ warn: vi.fn() }),
          },
        },
        session: {
          startNewSession: vi.fn(),
        },
      });

      const result = await clearCommand.action(blockedContext, '');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content:
          "Stop the current session's running background tasks before starting a new session.",
      });
      expect(mockStartNewSession).not.toHaveBeenCalled();
      expect(mockResetChat).not.toHaveBeenCalled();
    });

    it('blocks session clearing while a monitor is still running', async () => {
      if (!clearCommand.action)
        throw new Error('clearCommand must have an action.');

      const blockedContext = createMockCommandContext({
        executionMode: 'non_interactive',
        services: {
          config: {
            getBackgroundTaskRegistry: vi.fn().mockReturnValue({
              hasUnfinalizedTasks: vi.fn().mockReturnValue(false),
              reset: vi.fn(),
            }),
            getBackgroundShellRegistry: vi.fn().mockReturnValue({
              getAll: vi.fn().mockReturnValue([]),
              hasRunningEntries: vi.fn().mockReturnValue(false),
              reset: vi.fn(),
            }),
            getMonitorRegistry: vi.fn().mockReturnValue({
              getRunning: vi.fn().mockReturnValue([
                {
                  monitorId: 'mon_123',
                  status: 'running',
                },
              ]),
              reset: vi.fn(),
            }),
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
            getDebugLogger: vi.fn().mockReturnValue({ warn: vi.fn() }),
          },
        },
        session: {
          startNewSession: vi.fn(),
        },
      });

      const result = await clearCommand.action(blockedContext, '');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content:
          "Stop the current session's running background tasks before starting a new session.",
      });
      expect(mockStartNewSession).not.toHaveBeenCalled();
      expect(mockResetChat).not.toHaveBeenCalled();
    });

    it('blocks session clearing while a background shell is still running', async () => {
      if (!clearCommand.action)
        throw new Error('clearCommand must have an action.');

      const blockedContext = createMockCommandContext({
        executionMode: 'non_interactive',
        services: {
          config: {
            getBackgroundTaskRegistry: vi.fn().mockReturnValue({
              hasUnfinalizedTasks: vi.fn().mockReturnValue(false),
              reset: vi.fn(),
            }),
            getBackgroundShellRegistry: vi.fn().mockReturnValue({
              getAll: vi.fn().mockReturnValue([
                {
                  shellId: 'shell_123',
                  status: 'running',
                },
              ]),
              hasRunningEntries: vi.fn().mockReturnValue(true),
              reset: vi.fn(),
            }),
            getMonitorRegistry: vi.fn().mockReturnValue({
              getRunning: vi.fn().mockReturnValue([]),
              reset: vi.fn(),
            }),
            getWorkflowRunRegistry: vi.fn().mockReturnValue({
              hasRunningEntries: vi.fn().mockReturnValue(false),
              reset: vi.fn(),
              abortAll: vi.fn(),
            }),
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
            getDebugLogger: vi.fn().mockReturnValue({ warn: vi.fn() }),
          },
        },
        session: {
          startNewSession: vi.fn(),
        },
      });

      const result = await clearCommand.action(blockedContext, '');

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

  describe('completion', () => {
    it('returns --all suggestion when partialArg is empty', async () => {
      if (!clearCommand.completion)
        throw new Error('clearCommand must have completion.');

      const result = await clearCommand.completion(mockContext, '');

      expect(result).toEqual([
        {
          value: '--all',
          description: 'Complete reset (also clears IDE/editor context store)',
        },
      ]);
    });

    it('filters by prefix when partialArg is given', async () => {
      if (!clearCommand.completion)
        throw new Error('clearCommand must have completion.');

      const result = await clearCommand.completion(mockContext, '--a');

      expect(result).toEqual([
        {
          value: '--all',
          description: 'Complete reset (also clears IDE/editor context store)',
        },
      ]);
    });

    it('returns null when no suggestion matches', async () => {
      if (!clearCommand.completion)
        throw new Error('clearCommand must have completion.');

      const result = await clearCommand.completion(mockContext, '--z');

      expect(result).toBeNull();
    });
  });
});
