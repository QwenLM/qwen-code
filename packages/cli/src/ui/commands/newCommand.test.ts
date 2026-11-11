/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, type Mock } from 'vitest';
import { newCommand } from './newCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { createPermissionModuleStub } from '../../test-utils/permissionPrompt.js';
import {
  SessionEndReason,
  SessionStartSource,
  refreshSessionRegistryEntry,
  uiTelemetryService,
} from '@qwen-code/core';

// Shared shell cwd mocks — /new must reset the Bash tool's persistent cwd
// back to the original launch directory, same as /clear.
const shellCwdMocks = {
  setCwdAndNotify: vi.fn(),
  getOriginalCwd: vi.fn(() => '/original/launch-root'),
};

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
    // `resetSessionScopedRules` is deliberately NOT stubbed: it is the real
    // behaviour under test here, and it operates on the permission module the
    // config carries rather than returning a rebuilt context.
  };
});

describe('newCommand', () => {
  let mockContext: CommandContext;
  let mockSetMessages: ReturnType<typeof vi.fn>;
  let mockHintClear: ReturnType<typeof vi.fn>;
  let mockTopicReset: ReturnType<typeof vi.fn>;
  let permission: ReturnType<typeof createPermissionModuleStub>;

  beforeEach(() => {
    mockSetMessages = vi.fn();
    mockHintClear = vi.fn();
    mockTopicReset = vi.fn();
    vi.clearAllMocks();

    // A session-scoped rule in every behaviour bucket, alongside rules from
    // sources that outlive the session. /new must take exactly the first kind.
    permission = createPermissionModuleStub({
      rules: {
        allow: { session: ['Bash(git status)'], userSettings: ['Edit'] },
        deny: { session: ['WebSearch'], projectSettings: ['Bash(rm:*)'] },
        ask: { session: ['WebFetch'], command: ['Agent'] },
      },
      directories: ['/tmp/session', '/tmp/shared'],
    });

    mockContext = createMockCommandContext({
      services: {
        agentContext: {
          config: {
            getEnableHooks: vi.fn().mockReturnValue(false),
            getSessionId: vi.fn().mockReturnValue('old-session'),
            setSessionId: vi.fn(),
            resetOutputStyleForNewSession: vi.fn().mockResolvedValue(undefined),
            getGoalManager: vi.fn().mockReturnValue({ clearGoal: vi.fn() }),
            getModel: vi.fn().mockReturnValue('test-model'),
            permission,
            resetPermissionSession: vi.fn(() =>
              permission.resetSessionScopedRules(),
            ),
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

  it('should expose /new as an independent built-in command', () => {
    expect(newCommand.name).toBe('new');
    expect(newCommand.altNames).toBeUndefined();
    expect(newCommand.omitInputFromTranscript).toBe(true);
  });

  it('should reset the session and fire new-specific hook triggers', async () => {
    if (!newCommand.action) {
      throw new Error('newCommand must have an action.');
    }

    await newCommand.action(mockContext, '');

    const config = mockContext.services.agentContext!.config;
    expect(config.resetOutputStyleForNewSession).toHaveBeenCalledOnce();
    expect(
      vi.mocked(config.resetOutputStyleForNewSession).mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(config.getHookSystem()!.fireSessionStartEvent).mock
        .invocationCallOrder[0],
    );

    expect(mockContext.ui.setDebugMessage).toHaveBeenCalledWith(
      'Clearing terminal and resetting chat.',
    );
    expect(mockSetMessages).toHaveBeenCalledTimes(1);
    expect(mockHintClear).toHaveBeenCalledTimes(1);
    // The whole of what /new does to permissions: drop the rules the session
    // itself wrote, keep everything that came from settings or the command line.
    expect(permission.setRules).toHaveBeenCalledTimes(1);
    expect(permission.getRules()).toEqual({
      allow: { userSettings: ['Edit'] },
      deny: { projectSettings: ['Bash(rm:*)'] },
      ask: { command: ['Agent'] },
    });
    // Session-trusted directories survive: the module's directory list is a bare
    // string[] with no source attribution, so there is nothing to select on.
    expect(permission.getAdditionalDirectories()).toEqual([
      '/tmp/session',
      '/tmp/shared',
    ]);
    expect(uiTelemetryService.clear).toHaveBeenCalledTimes(1);
    expect(mockContext.ui.clear).toHaveBeenCalledTimes(1);
    expect(
      mockContext.services.agentContext?.config?.getHookSystem()
        ?.fireSessionEndEvent,
    ).toHaveBeenCalledWith(SessionEndReason.Clear);
    expect(
      mockContext.services.agentContext?.config?.getHookSystem()
        ?.fireSessionStartEvent,
    ).toHaveBeenCalledWith(SessionStartSource.New, 'test-model');

    const setDebugMessageOrder = (mockContext.ui.setDebugMessage as Mock).mock
      .invocationCallOrder[0];
    const setMessagesOrder = mockSetMessages.mock.invocationCallOrder[0];
    const resetTelemetryOrder = (uiTelemetryService.clear as Mock).mock
      .invocationCallOrder[0];
    const clearOrder = (mockContext.ui.clear as Mock).mock
      .invocationCallOrder[0];

    expect(setDebugMessageOrder).toBeLessThan(setMessagesOrder);
    expect(setMessagesOrder).toBeLessThan(resetTelemetryOrder);
    expect(resetTelemetryOrder).toBeLessThan(clearOrder);
  });

  // Regression: the topic title/intent is session-scoped state. A /new
  // session must not inherit the previous session's topic, otherwise
  // session-identity consumers keep reporting the old session's title.
  it('should reset and republish the session identity so the previous title does not leak', async () => {
    if (!newCommand.action) {
      throw new Error('newCommand must have an action.');
    }

    await newCommand.action(mockContext, '');

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
  // session created by /new — it has to match a full CLI restart.
  it('should reset the shell persistent cwd back to the original launch directory', async () => {
    if (!newCommand.action) {
      throw new Error('newCommand must have an action.');
    }

    await newCommand.action(mockContext, '');

    expect(shellCwdMocks.setCwdAndNotify).toHaveBeenCalledTimes(1);
    expect(shellCwdMocks.setCwdAndNotify).toHaveBeenCalledWith(
      '/original/launch-root',
      undefined,
    );
  });
});
