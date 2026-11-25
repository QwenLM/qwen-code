/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { subtaskCommand } from './subtaskCommand.js';
import type { CommandContext } from './types.js';

const { isAgentSessionsEnabledMock, isInForkChildMock, spawnForkSubtaskMock } =
  vi.hoisted(() => ({
    isAgentSessionsEnabledMock: vi.fn(),
    isInForkChildMock: vi.fn(),
    spawnForkSubtaskMock: vi.fn(),
  }));

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    isAgentSessionsEnabled: isAgentSessionsEnabledMock,
    isInForkChild: isInForkChildMock,
    spawnForkSubtask: spawnForkSubtaskMock,
  };
});

function makeContext(
  agentContext: unknown = {
    getSystemPrompt: () => [{ type: 'text', text: 'rendered system prompt' }],
    getConversationMessages: () => [],
  },
): CommandContext {
  return { services: { agentContext } } as unknown as CommandContext;
}

describe('subtaskCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isAgentSessionsEnabledMock.mockReturnValue(true);
    isInForkChildMock.mockReturnValue(false);
    spawnForkSubtaskMock.mockResolvedValue({
      name: 'do-x',
      agentId: 'abcd1234',
    });
  });

  it('is registered as a safe-concurrent built-in with an argument hint', () => {
    expect(subtaskCommand.name).toBe('subtask');
    expect(subtaskCommand.isSafeConcurrent).toBe(true);
    expect(subtaskCommand.takesArgs).toBe(true);
    expect(subtaskCommand.autoExecute).toBe(false);
    expect(subtaskCommand.argumentHint).toBe('<directive>');
  });

  it('shows a usage hint for an empty directive and does not spawn', async () => {
    const result = await subtaskCommand.action?.(makeContext(), '   ');
    expect(result).toMatchObject({ type: 'message', messageType: 'info' });
    expect(spawnForkSubtaskMock).not.toHaveBeenCalled();
  });

  it('blocks when agent sessions are disabled', async () => {
    isAgentSessionsEnabledMock.mockReturnValue(false);
    const result = await subtaskCommand.action?.(makeContext(), 'do x');
    expect(result).toMatchObject({
      type: 'message',
      messageType: 'info',
      content: '/subtask requires agent sessions, which are disabled.',
    });
    expect(spawnForkSubtaskMock).not.toHaveBeenCalled();
  });

  it('errors when session context is unavailable', async () => {
    const result = await subtaskCommand.action?.(makeContext(null), 'do x');
    expect(result).toMatchObject({ type: 'message', messageType: 'error' });
    expect(spawnForkSubtaskMock).not.toHaveBeenCalled();
  });

  it('blocks before the first conversation turn (no rendered system prompt)', async () => {
    const result = await subtaskCommand.action?.(
      makeContext({
        getSystemPrompt: () => [],
        getConversationMessages: () => [],
      }),
      'do x',
    );
    expect(result).toMatchObject({
      type: 'message',
      messageType: 'info',
      content: 'Cannot start a subtask before the first conversation turn.',
    });
    expect(spawnForkSubtaskMock).not.toHaveBeenCalled();
  });

  it('blocks (anti-recursion) when invoked from inside a fork child', async () => {
    isInForkChildMock.mockReturnValue(true);
    const result = await subtaskCommand.action?.(makeContext(), 'do x');
    expect(result).toMatchObject({
      type: 'message',
      messageType: 'info',
      content: 'Cannot start a subtask from inside a forked worker.',
    });
    expect(spawnForkSubtaskMock).not.toHaveBeenCalled();
  });

  it('spawns the fork and returns the confirmation with the id suffix', async () => {
    const agentContext = {
      getSystemPrompt: () => [{ type: 'text', text: 'rendered system prompt' }],
      getConversationMessages: () => [],
    };
    const result = await subtaskCommand.action?.(
      makeContext(agentContext),
      'do x',
    );
    expect(spawnForkSubtaskMock).toHaveBeenCalledWith(agentContext, 'do x');
    expect(result).toEqual({
      type: 'local_command_result',
      text: "⑂ forked do-x (1234) — you'll be notified when it finishes.",
    });
  });

  it('renders name-only when the launch result omits the agent id', async () => {
    spawnForkSubtaskMock.mockResolvedValue({ name: 'do-x', agentId: '' });
    const result = await subtaskCommand.action?.(makeContext(), 'do x');
    expect(result).toEqual({
      type: 'local_command_result',
      text: "⑂ forked do-x — you'll be notified when it finishes.",
    });
  });

  it('returns an error message when the spawn fails', async () => {
    spawnForkSubtaskMock.mockRejectedValue(new Error('boom'));
    const result = await subtaskCommand.action?.(makeContext(), 'do x');
    expect(result).toMatchObject({
      type: 'message',
      messageType: 'error',
      content: 'Failed to start subtask: boom',
    });
  });
});
