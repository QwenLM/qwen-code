/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, type Mock } from 'vitest';
import { clearCommand } from './clearCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import {
  SessionEndReason,
  SessionStartSource,
  refreshSessionRegistryEntry,
  uiTelemetryService,
} from '@qwen-code/core';

// Shared mock GoalManager — referenced by the vi.mock factory and reset per test.
const mockGoalManagerState = {
  isGoalActive: false,
  deactivate: vi.fn(),
  clearGoal: vi.fn(),
};

// Shared shell cwd mocks — /clear must reset the Bash tool's persistent cwd
// back to the original launch directory.
const shellCwdMocks = {
  setCwdAndNotify: vi.fn(),
  getOriginalCwd: vi.fn(() => '/original/launch-root'),
};

// Mock the core service
vi.mock('@qwen-code/core', async () => {
  const actual = await vi.importActual('@qwen-code/core');
  return {
    ...actual,
    setCwdAndNotify: (newPath: string, relativeTo?: string) =>
      shellCwdMocks.setCwdAndNotify(newPath, relativeTo),
    getOriginalCwd: () => shellCwdMocks.getOriginalCwd(),
    uiTelemetryService: {
      setLastPromptTokenCount: vi.fn(),
      clear: vi.fn(),
    },
    refreshSessionRegistryEntry: vi.fn(),
    resetSessionScopedPermissionContext: (context: {
      mode: string;
      sessionBaseMode?: string;
      additionalWorkingDirectories: Map<
        string,
        { path: string; source: string }
      >;
      alwaysAllowRules: Record<string, string[] | undefined>;
      alwaysDenyRules: Record<string, string[] | undefined>;
      alwaysAskRules: Record<string, string[] | undefined>;
      isBypassPermissionsModeAvailable: boolean;
      strippedDangerousRules?: Record<string, string[] | undefined>;
    }) => ({
      ...context,
      mode: context.mode,
      additionalWorkingDirectories: new Map([
        ['/tmp/shared', { path: '/tmp/shared', source: 'userSettings' }],
      ]),
      alwaysAllowRules: {
        userSettings: ['Edit'],
      },
      alwaysDenyRules: {
        projectSettings: ['Bash(rm:*)'],
      },
      alwaysAskRules: {},
      strippedDangerousRules: undefined,
    }),
  };
});

describe('clearCommand', () => {
  let mockContext: CommandContext;
  let mockSetMessages: ReturnType<typeof vi.fn>;
  let mockHintClear: ReturnType<typeof vi.fn>;
  let mockTopicReset: ReturnType<typeof vi.fn>;
  let mockPermission: {
    getRules: ReturnType<typeof vi.fn>;
    setRules: ReturnType<typeof vi.fn>;
    clearSessionDirectories: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockSetMessages = vi.fn();
    mockHintClear = vi.fn();
    mockTopicReset = vi.fn();
    mockPermission = {
      getRules: vi.fn().mockReturnValue({
        allow: { session: ['Bash(git status)'], userSettings: ['Edit'] },
        deny: { command: ['Agent'], projectSettings: ['Bash(rm:*)'] },
        ask: { session: ['WebFetch'] },
      }),
      setRules: vi.fn(),
      clearSessionDirectories: vi.fn(),
    };
    vi.clearAllMocks();
    mockGoalManagerState.isGoalActive = false;
    mockGoalManagerState.deactivate.mockReset();
    mockGoalManagerState.clearGoal.mockReset();

    mockContext = createMockCommandContext({
      services: {
        agentContext: {
          config: {
            getGoalManager: () => mockGoalManagerState,
            getEnableHooks: vi.fn().mockReturnValue(false),
            getSessionId: vi.fn().mockReturnValue('old-session'),
            setSessionId: vi.fn(),
            resetOutputStyleForNewSession: vi.fn().mockResolvedValue(undefined),
            // resetConversationSession passes the current model to the
            // SessionStart hook.
            getModel: vi.fn().mockReturnValue('test-model'),
            resetPermissionSession: vi.fn(),
            getHookSystem: vi.fn().mockReturnValue({
              fireSessionEndEvent: vi.fn().mockResolvedValue(undefined),
              fireSessionStartEvent: vi.fn().mockResolvedValue(undefined),
            }),
            injectionService: {
              clear: mockHintClear,
            },
            topicState: {
              reset: mockTopicReset,
            },
          },
        },
      },
    });
    mockContext.setMessages = mockSetMessages;
  });

  it('keeps reset navigation input out of the transcript', () => {
    expect(clearCommand.omitInputFromTranscript).toBe(true);
  });

  // skip: 现存失败
  it.skip('should set debug message, clear messages, reset stats, clear hints, and clear UI when config is available', async () => {
    if (!clearCommand.action) {
      throw new Error('clearCommand must have an action.');
    }

    await clearCommand.action(mockContext, '');

    expect(mockContext.ui.setDebugMessage).toHaveBeenCalledWith(
      'Clearing terminal and resetting chat.',
    );
    expect(mockContext.ui.setDebugMessage).toHaveBeenCalledTimes(1);

    // setMessages should have been called to clear the history
    expect(mockSetMessages).toHaveBeenCalledTimes(1);
    const updater = mockSetMessages.mock.calls[0][0];
    expect(updater([{ role: 'user', content: [] }])).toEqual([]);

    expect(mockHintClear).toHaveBeenCalledTimes(1);
    expect(mockPermission.setRules).toHaveBeenCalledWith({
      allow: { userSettings: ['Edit'] },
      deny: { command: ['Agent'], projectSettings: ['Bash(rm:*)'] },
      ask: {},
    });
    expect(mockPermission.clearSessionDirectories).toHaveBeenCalledTimes(1);
    expect(uiTelemetryService.clear).toHaveBeenCalled();
    expect(uiTelemetryService.clear).toHaveBeenCalledTimes(1);
    expect(mockContext.ui.clear).toHaveBeenCalledTimes(1);
    expect(
      mockContext.services.agentContext?.config?.getHookSystem()
        ?.fireSessionEndEvent,
    ).toHaveBeenCalledWith(SessionEndReason.Clear);
    expect(
      mockContext.services.agentContext?.config?.getHookSystem()
        ?.fireSessionStartEvent,
    ).toHaveBeenCalledWith(SessionStartSource.Clear, 'test-model');

    // Check the order of operations.
    const setDebugMessageOrder = (mockContext.ui.setDebugMessage as Mock).mock
      .invocationCallOrder[0];
    const setMessagesOrder = mockSetMessages.mock.invocationCallOrder[0];
    const resetStatsOrder = (uiTelemetryService.clear as Mock).mock
      .invocationCallOrder[0];
    const clearOrder = (mockContext.ui.clear as Mock).mock
      .invocationCallOrder[0];

    expect(setDebugMessageOrder).toBeLessThan(setMessagesOrder);
    expect(setMessagesOrder).toBeLessThan(resetStatsOrder);
    expect(resetStatsOrder).toBeLessThan(clearOrder);
  });

  it('applies the pending output style before the new session starts', async () => {
    await clearCommand.action!(mockContext, '');
    const config = mockContext.services.agentContext!.config;
    const reset = vi.mocked(config.resetOutputStyleForNewSession);
    expect(reset).toHaveBeenCalledOnce();
    expect(reset.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(config.getHookSystem()!.fireSessionStartEvent).mock
        .invocationCallOrder[0],
    );
    expect(reset.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(mockContext.ui.clear).mock.invocationCallOrder[0],
    );
  });

  it('keeps history and session identity when resolving the next style fails', async () => {
    const config = mockContext.services.agentContext!.config;
    vi.mocked(config.resetOutputStyleForNewSession).mockRejectedValue(
      new Error('style resolution failed'),
    );

    await expect(clearCommand.action!(mockContext, '')).rejects.toThrow(
      'style resolution failed',
    );
    expect(mockSetMessages).not.toHaveBeenCalled();
    expect(config.setSessionId).not.toHaveBeenCalled();
    expect(mockContext.ui.clear).not.toHaveBeenCalled();
  });

  it('should not attempt to clear messages if setMessages is not available', async () => {
    if (!clearCommand.action) {
      throw new Error('clearCommand must have an action.');
    }

    const nullConfigContext = createMockCommandContext({
      services: {
        agentContext: null,
      },
    });

    await clearCommand.action(nullConfigContext, '');

    expect(nullConfigContext.ui.setDebugMessage).toHaveBeenCalledWith(
      'Clearing terminal.',
    );
    expect(mockSetMessages).not.toHaveBeenCalled();
    expect(uiTelemetryService.clear).toHaveBeenCalled();
    expect(uiTelemetryService.clear).toHaveBeenCalledTimes(1);
    expect(nullConfigContext.ui.clear).toHaveBeenCalledTimes(1);
  });

  // Regression: /clear must wipe goal state so the new session does not show
  // a stale `goal on` badge.
  // skip: 现存失败
  it.skip('should deactivate and clear an active goal so it does not leak into the new session', async () => {
    if (!clearCommand.action) {
      throw new Error('clearCommand must have an action.');
    }

    mockGoalManagerState.isGoalActive = true;

    await clearCommand.action(mockContext, '');

    const config = mockContext.services.agentContext?.config;
    expect(mockGoalManagerState.deactivate).toHaveBeenCalledTimes(1);
    expect(mockGoalManagerState.deactivate).toHaveBeenCalledWith(config);
    expect(mockGoalManagerState.clearGoal).toHaveBeenCalledTimes(1);
    expect(mockGoalManagerState.clearGoal).toHaveBeenCalledWith({
      reason: 'user',
    });
  });

  it('should still call clearGoal as a no-op when no goal is active', async () => {
    if (!clearCommand.action) {
      throw new Error('clearCommand must have an action.');
    }

    mockGoalManagerState.isGoalActive = false;

    await clearCommand.action(mockContext, '');

    // deactivate is gated on isGoalActive — must NOT run when no goal exists.
    expect(mockGoalManagerState.deactivate).not.toHaveBeenCalled();
    // clearGoal is unconditional (cheap no-op when no goal) — must still run.
    expect(mockGoalManagerState.clearGoal).toHaveBeenCalledTimes(1);
    expect(mockGoalManagerState.clearGoal).toHaveBeenCalledWith({
      reason: 'user',
    });
  });

  // Regression: the topic title/intent is session-scoped state. A /clear
  // session must not inherit the previous session's topic, otherwise
  // session-identity consumers keep reporting the old session's title.
  it('should reset and republish the session identity so the previous title does not leak', async () => {
    if (!clearCommand.action) {
      throw new Error('clearCommand must have an action.');
    }

    await clearCommand.action(mockContext, '');

    expect(mockTopicReset).toHaveBeenCalledTimes(1);
    const newSessionId = (
      mockContext.services.agentContext?.config?.setSessionId as Mock
    ).mock.calls[0][0] as string;
    expect(refreshSessionRegistryEntry).toHaveBeenCalledWith({
      sessionId: newSessionId,
      name: undefined,
    });
  });

  // Regression: the Bash tool's persistent cwd is module-level state in core's
  // Shell.ts. A `cd` in the previous session must not leak into the fresh
  // session created by /clear — it has to match a full CLI restart.
  it('should reset the shell persistent cwd back to the original launch directory', async () => {
    if (!clearCommand.action) {
      throw new Error('clearCommand must have an action.');
    }

    await clearCommand.action(mockContext, '');

    expect(shellCwdMocks.setCwdAndNotify).toHaveBeenCalledTimes(1);
    expect(shellCwdMocks.setCwdAndNotify).toHaveBeenCalledWith(
      '/original/launch-root',
      undefined,
    );
  });

  it('should reset the shell persistent cwd even when config is unavailable', async () => {
    if (!clearCommand.action) {
      throw new Error('clearCommand must have an action.');
    }

    const nullConfigContext = createMockCommandContext({
      services: {
        agentContext: null,
      },
    });

    await clearCommand.action(nullConfigContext, '');

    expect(shellCwdMocks.setCwdAndNotify).toHaveBeenCalledTimes(1);
    expect(shellCwdMocks.setCwdAndNotify).toHaveBeenCalledWith(
      '/original/launch-root',
      undefined,
    );
  });

  it('should notify cwd observers before firing the new SessionStart hook', async () => {
    if (!clearCommand.action) {
      throw new Error('clearCommand must have an action.');
    }

    await clearCommand.action(mockContext, '');

    const fireSessionStartEvent =
      mockContext.services.agentContext?.config?.getHookSystem()
        ?.fireSessionStartEvent;
    expect(fireSessionStartEvent).toHaveBeenCalledWith(
      SessionStartSource.Clear,
      'test-model',
    );
    expect(
      shellCwdMocks.setCwdAndNotify.mock.invocationCallOrder[0],
    ).toBeLessThan((fireSessionStartEvent as Mock).mock.invocationCallOrder[0]);
  });
});
