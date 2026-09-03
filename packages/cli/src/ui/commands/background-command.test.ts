/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { backgroundCommand } from './background-command.js';
import { CommandKind, type AgentViewIdleGateState } from './types.js';
import type { AgentViewWorkerSidebandEnv } from '../../agent-view/worker-sideband.js';

const mockReadAgentViewWorkerSidebandEnv = vi.hoisted(() =>
  vi.fn<() => AgentViewWorkerSidebandEnv | undefined>(() => undefined),
);

vi.mock('../../agent-view/worker-sideband.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../agent-view/worker-sideband.js')
  >()),
  readAgentViewWorkerSidebandEnv: mockReadAgentViewWorkerSidebandEnv,
}));

describe('backgroundCommand', () => {
  beforeEach(() => {
    mockReadAgentViewWorkerSidebandEnv.mockReturnValue(undefined);
  });

  it('has command metadata', () => {
    expect(backgroundCommand.name).toBe('background');
    expect(backgroundCommand.altNames).toEqual(['bg']);
    expect(backgroundCommand.kind).toBe(CommandKind.BUILT_IN);
    expect(backgroundCommand.supportedModes).toEqual(['interactive']);
  });

  it('returns detach action when idle', async () => {
    const result = await backgroundCommand.action?.(
      createMockCommandContext({
        services: { config: mockConfig({ sessionExists: true }) },
        ui: { isIdleRef: { current: true } },
      }),
      '',
    );

    expect(result).toEqual({ type: 'agent_view_detach' });
  });

  it('rejects while a turn is running', async () => {
    const result = await backgroundCommand.action?.(
      createMockCommandContext({
        services: { config: mockConfig({ sessionExists: true }) },
        ui: { isIdleRef: { current: false } },
      }),
      '',
    );

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Cannot detach Agent View while a turn is running.',
    });
  });

  it.each([
    [
      'a question is waiting',
      { hasPendingUserQuestion: true },
      'Cannot detach Agent View while a question is waiting.',
    ],
    [
      'a tool confirmation is pending',
      { hasPendingToolConfirmation: true },
      'Cannot detach Agent View while a tool confirmation is pending.',
    ],
    [
      'a command confirmation is pending',
      { hasPendingCommandConfirmation: true },
      'Cannot detach Agent View while a command confirmation is pending.',
    ],
    [
      'a foreground shell is active',
      { hasForegroundShell: true },
      'Cannot detach Agent View while a foreground shell is active.',
    ],
    [
      'the background tasks dialog is open',
      { hasBackgroundFocusDialog: true },
      'Cannot detach Agent View while the background tasks dialog is open.',
    ],
    [
      'prompts are queued',
      { hasQueuedPrompt: true },
      'Cannot detach Agent View while prompts are queued.',
    ],
  ] satisfies Array<[string, AgentViewIdleGateState, string]>)(
    'rejects while %s',
    async (_name, gateState, content) => {
      const result = await backgroundCommand.action?.(
        createMockCommandContext({
          services: { config: mockConfig({ sessionExists: true }) },
          ui: {
            isIdleRef: { current: true },
            agentViewIdleGateStateRef: { current: gateState },
          },
        }),
        '',
      );

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content,
      });
    },
  );

  it('detaches managed Agent View workers while a turn is running', async () => {
    mockReadAgentViewWorkerSidebandEnv.mockReturnValue({
      sessionId: 'session-1',
      sidebandEndpoint: 'unix:/tmp/qwen-agent-view.sock',
      token: 'token-1',
      activeCwd: '/repo',
    });

    const result = await backgroundCommand.action?.(
      createMockCommandContext({
        services: { config: null },
        ui: {
          isIdleRef: { current: false },
          agentViewIdleGateStateRef: {
            current: {
              hasPendingToolConfirmation: true,
              hasQueuedPrompt: true,
            },
          },
        },
      }),
      '',
    );

    expect(result).toEqual({ type: 'agent_view_detach' });
  });

  it('rejects before configuration is loaded', async () => {
    const result = await backgroundCommand.action?.(
      createMockCommandContext({
        services: { config: null },
        ui: { isIdleRef: { current: true } },
      }),
      '',
    );

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Cannot detach Agent View before configuration is loaded.',
    });
  });

  it('rejects ordinary sessions when Agent View is disabled', async () => {
    const config = mockConfig({ sessionExists: true });
    config.isAgentViewEnabled = () => false;

    const result = await backgroundCommand.action?.(
      createMockCommandContext({
        services: { config },
        ui: { isIdleRef: { current: true } },
      }),
      '',
    );

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content:
        'Agent View is disabled. Set `experimental.agentView` to `true` in settings to enable it.',
    });
  });

  it('rejects before the current session can be resumed', async () => {
    const result = await backgroundCommand.action?.(
      createMockCommandContext({
        services: { config: mockConfig({ sessionExists: false }) },
        ui: { isIdleRef: { current: true } },
      }),
      '',
    );

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Cannot detach Agent View before the session is saved.',
    });
  });

  it('rejects while background work is running', async () => {
    const config = mockConfig({ sessionExists: true, hasBackgroundWork: true });

    const result = await backgroundCommand.action?.(
      createMockCommandContext({
        services: { config },
        ui: { isIdleRef: { current: true } },
      }),
      '',
    );

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content:
        "Stop the current session's running background tasks before detaching it.",
    });
  });
});

function mockConfig(options: {
  sessionExists: boolean;
  hasBackgroundWork?: boolean;
}) {
  return {
    isAgentViewEnabled: () => true,
    getSessionId: () => '123e4567-e89b-12d3-a456-426614174000',
    getSessionService: () => ({
      sessionExists: vi.fn().mockResolvedValue(options.sessionExists),
    }),
    getBackgroundTaskRegistry: () => ({
      hasRunningTasks: () => options.hasBackgroundWork === true,
      getAll: () => [],
    }),
    getMonitorRegistry: () => ({ getRunning: () => [] }),
    getBackgroundShellRegistry: () => ({
      hasRunningEntries: () => false,
      getAll: () => [],
    }),
    getWorkflowRunRegistry: () => ({
      hasRunningEntries: () => false,
      list: () => [],
      listStartingRunIds: () => [],
    }),
  };
}
