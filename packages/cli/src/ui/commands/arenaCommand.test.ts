/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  type ArenaManager,
  ArenaAgentStatus,
  ArenaSessionStatus,
} from '@qwen-code/qwen-code-core';
import { arenaCommand } from './arenaCommand.js';
import type {
  CommandContext,
  OpenDialogActionReturn,
  SlashCommand,
} from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

function getArenaSubCommand(
  name: 'start' | 'stop' | 'status' | 'select',
): SlashCommand {
  const command = arenaCommand.subCommands?.find((item) => item.name === name);
  if (!command?.action) {
    throw new Error(`Arena subcommand "${name}" is missing an action`);
  }
  return command;
}

describe('arenaCommand stop subcommand', () => {
  let mockContext: CommandContext;
  let mockConfig: {
    getArenaManager: ReturnType<typeof vi.fn>;
    setArenaManager: ReturnType<typeof vi.fn>;
    cleanupArenaRuntime: ReturnType<typeof vi.fn>;
    getAgentsSettings: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockConfig = {
      getArenaManager: vi.fn(() => null),
      setArenaManager: vi.fn(),
      cleanupArenaRuntime: vi.fn().mockResolvedValue(undefined),
      getAgentsSettings: vi.fn(() => ({})),
    };

    mockContext = createMockCommandContext({
      invocation: {
        raw: '/arena stop',
        name: 'arena',
        args: 'stop',
      },
      executionMode: 'interactive',
      services: {
        config: mockConfig as never,
      },
    });
  });

  it('returns an error when no arena session is running', async () => {
    const stopCommand = getArenaSubCommand('stop');
    const result = await stopCommand.action!(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'No running Arena session found.',
    });
  });

  it('opens stop dialog when a running session exists', async () => {
    const mockManager = {
      getSessionStatus: vi.fn(() => ArenaSessionStatus.RUNNING),
    } as unknown as ArenaManager;
    mockConfig.getArenaManager = vi.fn(() => mockManager);

    const stopCommand = getArenaSubCommand('stop');
    const result = (await stopCommand.action!(
      mockContext,
      '',
    )) as OpenDialogActionReturn;

    expect(result).toEqual({
      type: 'dialog',
      dialog: 'arena_stop',
    });
  });

  it('opens stop dialog when a completed session exists', async () => {
    const mockManager = {
      getSessionStatus: vi.fn(() => ArenaSessionStatus.COMPLETED),
    } as unknown as ArenaManager;
    mockConfig.getArenaManager = vi.fn(() => mockManager);

    const stopCommand = getArenaSubCommand('stop');
    const result = (await stopCommand.action!(
      mockContext,
      '',
    )) as OpenDialogActionReturn;

    expect(result).toEqual({
      type: 'dialog',
      dialog: 'arena_stop',
    });
  });
});

describe('arenaCommand status subcommand', () => {
  let mockContext: CommandContext;
  let mockConfig: {
    getArenaManager: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockConfig = {
      getArenaManager: vi.fn(() => null),
    };

    mockContext = createMockCommandContext({
      invocation: {
        raw: '/arena status',
        name: 'arena',
        args: 'status',
      },
      executionMode: 'interactive',
      services: {
        config: mockConfig as never,
      },
    });
  });

  it('returns an error when no arena session exists', async () => {
    const statusCommand = getArenaSubCommand('status');
    const result = await statusCommand.action!(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'No Arena session found. Start one with /arena start.',
    });
  });

  it('opens status dialog when a session exists', async () => {
    const mockManager = {
      getSessionStatus: vi.fn(() => ArenaSessionStatus.RUNNING),
    } as unknown as ArenaManager;
    mockConfig.getArenaManager = vi.fn(() => mockManager);

    const statusCommand = getArenaSubCommand('status');
    const result = (await statusCommand.action!(
      mockContext,
      '',
    )) as OpenDialogActionReturn;

    expect(result).toEqual({
      type: 'dialog',
      dialog: 'arena_status',
    });
  });

  it('opens status dialog for completed session', async () => {
    const mockManager = {
      getSessionStatus: vi.fn(() => ArenaSessionStatus.COMPLETED),
    } as unknown as ArenaManager;
    mockConfig.getArenaManager = vi.fn(() => mockManager);

    const statusCommand = getArenaSubCommand('status');
    const result = (await statusCommand.action!(
      mockContext,
      '',
    )) as OpenDialogActionReturn;

    expect(result).toEqual({
      type: 'dialog',
      dialog: 'arena_status',
    });
  });
});

describe('arenaCommand select subcommand', () => {
  let mockContext: CommandContext;
  let mockConfig: {
    getArenaManager: ReturnType<typeof vi.fn>;
    setArenaManager: ReturnType<typeof vi.fn>;
    cleanupArenaRuntime: ReturnType<typeof vi.fn>;
    getAgentsSettings: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockConfig = {
      getArenaManager: vi.fn(() => null),
      setArenaManager: vi.fn(),
      cleanupArenaRuntime: vi.fn().mockResolvedValue(undefined),
      getAgentsSettings: vi.fn(() => ({})),
    };

    mockContext = createMockCommandContext({
      invocation: {
        raw: '/arena select',
        name: 'arena',
        args: 'select',
      },
      executionMode: 'interactive',
      services: {
        config: mockConfig as never,
      },
    });
  });

  it('returns error when no arena session exists', async () => {
    const selectCommand = getArenaSubCommand('select');
    const result = await selectCommand.action!(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'No arena session found. Start one with /arena start.',
    });
  });

  it('returns error when arena is still running', async () => {
    const mockManager = {
      getSessionStatus: vi.fn(() => ArenaSessionStatus.RUNNING),
    } as unknown as ArenaManager;
    mockConfig.getArenaManager = vi.fn(() => mockManager);

    const selectCommand = getArenaSubCommand('select');
    const result = await selectCommand.action!(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content:
        'Arena session is still running. Wait for it to complete or use /arena stop first.',
    });
  });

  it('returns error when all agents failed', async () => {
    const mockManager = {
      getSessionStatus: vi.fn(() => ArenaSessionStatus.COMPLETED),
      getAgentStates: vi.fn(() => [
        {
          agentId: 'agent-1',
          status: ArenaAgentStatus.TERMINATED,
          model: { modelId: 'model-1' },
        },
      ]),
    } as unknown as ArenaManager;
    mockConfig.getArenaManager = vi.fn(() => mockManager);

    const selectCommand = getArenaSubCommand('select');
    const result = await selectCommand.action!(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content:
        'No successful agent results to select from. All agents failed or were cancelled.\n' +
        'Use /arena select --discard to clean up worktrees, or /arena stop to end the session.',
    });
  });

  it('opens dialog when no args provided and agents have results', async () => {
    const mockManager = {
      getSessionStatus: vi.fn(() => ArenaSessionStatus.COMPLETED),
      getAgentStates: vi.fn(() => [
        {
          agentId: 'agent-1',
          status: ArenaAgentStatus.COMPLETED,
          model: { modelId: 'model-1' },
        },
        {
          agentId: 'agent-2',
          status: ArenaAgentStatus.COMPLETED,
          model: { modelId: 'model-2' },
        },
      ]),
    } as unknown as ArenaManager;
    mockConfig.getArenaManager = vi.fn(() => mockManager);

    const selectCommand = getArenaSubCommand('select');
    const result = await selectCommand.action!(mockContext, '');

    expect(result).toEqual({
      type: 'dialog',
      dialog: 'arena_select',
    });
  });

  it('applies changes directly when model name is provided', async () => {
    const mockManager = {
      getSessionStatus: vi.fn(() => ArenaSessionStatus.COMPLETED),
      getAgentStates: vi.fn(() => [
        {
          agentId: 'agent-1',
          status: ArenaAgentStatus.COMPLETED,
          model: { modelId: 'gpt-4o', displayName: 'gpt-4o' },
        },
        {
          agentId: 'agent-2',
          status: ArenaAgentStatus.COMPLETED,
          model: { modelId: 'claude-sonnet', displayName: 'claude-sonnet' },
        },
      ]),
      applyAgentResult: vi.fn().mockResolvedValue({ success: true }),
      cleanup: vi.fn().mockResolvedValue(undefined),
    } as unknown as ArenaManager;
    mockConfig.getArenaManager = vi.fn(() => mockManager);

    const selectCommand = getArenaSubCommand('select');
    const result = await selectCommand.action!(mockContext, 'gpt-4o');

    expect(mockManager.applyAgentResult).toHaveBeenCalledWith('agent-1');
    expect(mockConfig.cleanupArenaRuntime).toHaveBeenCalled();
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content:
        'Applied changes from gpt-4o to workspace. Arena session complete.',
    });
  });

  it('returns error when specified model not found', async () => {
    const mockManager = {
      getSessionStatus: vi.fn(() => ArenaSessionStatus.COMPLETED),
      getAgentStates: vi.fn(() => [
        {
          agentId: 'agent-1',
          status: ArenaAgentStatus.COMPLETED,
          model: { modelId: 'gpt-4o', displayName: 'gpt-4o' },
        },
      ]),
    } as unknown as ArenaManager;
    mockConfig.getArenaManager = vi.fn(() => mockManager);

    const selectCommand = getArenaSubCommand('select');
    const result = await selectCommand.action!(mockContext, 'nonexistent');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'No idle agent found matching "nonexistent".',
    });
  });

  it('asks for confirmation when --discard flag is used', async () => {
    const mockManager = {
      getSessionStatus: vi.fn(() => ArenaSessionStatus.COMPLETED),
      getAgentStates: vi.fn(() => [
        {
          agentId: 'agent-1',
          status: ArenaAgentStatus.COMPLETED,
          model: { modelId: 'gpt-4o' },
        },
      ]),
    } as unknown as ArenaManager;
    mockConfig.getArenaManager = vi.fn(() => mockManager);

    const selectCommand = getArenaSubCommand('select');
    const result = await selectCommand.action!(mockContext, '--discard');

    expect(result).toEqual({
      type: 'confirm_action',
      prompt: 'Discard all Arena results and clean up worktrees?',
      originalInvocation: { raw: '/arena select' },
    });
  });

  it('discards results after --discard confirmation', async () => {
    const mockManager = {
      getSessionStatus: vi.fn(() => ArenaSessionStatus.COMPLETED),
      getAgentStates: vi.fn(() => [
        {
          agentId: 'agent-1',
          status: ArenaAgentStatus.COMPLETED,
          model: { modelId: 'gpt-4o' },
        },
      ]),
      cleanup: vi.fn().mockResolvedValue(undefined),
    } as unknown as ArenaManager;
    mockConfig.getArenaManager = vi.fn(() => mockManager);
    mockContext.overwriteConfirmed = true;

    const selectCommand = getArenaSubCommand('select');
    const result = await selectCommand.action!(mockContext, '--discard');

    expect(mockConfig.cleanupArenaRuntime).toHaveBeenCalled();
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Arena results discarded. All worktrees cleaned up.',
    });
  });
});
