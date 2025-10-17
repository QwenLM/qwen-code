/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { approvalModeCommand } from './approvalModeCommand.js';
import {
  type CommandContext,
  CommandKind,
  type MessageActionReturn,
} from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { ApprovalMode } from '@qwen-code/qwen-code-core';
import { SettingScope, type LoadedSettings } from '../../config/settings.js';

describe('approvalModeCommand', () => {
  let mockContext: CommandContext;
  let setApprovalModeMock: ReturnType<typeof vi.fn>;
  let setSettingsValueMock: ReturnType<typeof vi.fn>;
  const originalEnv = { ...process.env };
  const userSettingsPath = '/mock/user/settings.json';
  const projectSettingsPath = '/mock/project/settings.json';
  const userSettingsFile = { path: userSettingsPath, settings: {} };
  const projectSettingsFile = { path: projectSettingsPath, settings: {} };

  const getModeSubCommand = (mode: ApprovalMode) =>
    approvalModeCommand.subCommands?.find((cmd) => cmd.name === mode);

  const getScopeSubCommand = (
    mode: ApprovalMode,
    scope: '--session' | '--user' | '--project',
  ) => getModeSubCommand(mode)?.subCommands?.find((cmd) => cmd.name === scope);

  beforeEach(() => {
    setApprovalModeMock = vi.fn();
    setSettingsValueMock = vi.fn();

    mockContext = createMockCommandContext({
      services: {
        config: {
          getApprovalMode: vi.fn().mockReturnValue(ApprovalMode.DEFAULT),
          setApprovalMode: setApprovalModeMock,
        },
        settings: {
          merged: {},
          setValue: setSettingsValueMock,
          forScope: vi
            .fn()
            .mockImplementation((scope: SettingScope) =>
              scope === SettingScope.User
                ? userSettingsFile
                : scope === SettingScope.Workspace
                  ? projectSettingsFile
                  : { path: '', settings: {} },
            ),
        } as unknown as LoadedSettings,
      },
    } as unknown as CommandContext);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  it('should have the correct command properties', () => {
    expect(approvalModeCommand.name).toBe('approval-mode');
    expect(approvalModeCommand.kind).toBe(CommandKind.BUILT_IN);
    expect(approvalModeCommand.description).toBe(
      'View or change the approval mode for tool usage',
    );
  });

  it('should show current mode, options, and usage when no arguments provided', async () => {
    if (!approvalModeCommand.action) {
      throw new Error('approvalModeCommand must have an action.');
    }

    const result = (await approvalModeCommand.action(
      mockContext,
      '',
    )) as MessageActionReturn;

    expect(result.type).toBe('message');
    expect(result.messageType).toBe('info');
    const expectedMessage = [
      'Current approval mode: default',
      '',
      'Available approval modes:',
      '  - plan: Plan mode - Analyze only, do not modify files or execute commands',
      '  - default: Default mode - Require approval for file edits or shell commands',
      '  - auto-edit: Auto-edit mode - Automatically approve file edits',
      '  - yolo: YOLO mode - Automatically approve all tools',
      '',
      'Usage: /approval-mode <mode> [--session|--user|--project]',
    ].join('\n');
    expect(result.content).toBe(expectedMessage);
  });

  it('should display error when config is not available', async () => {
    if (!approvalModeCommand.action) {
      throw new Error('approvalModeCommand must have an action.');
    }

    const nullConfigContext = createMockCommandContext({
      services: {
        config: null,
      },
    } as unknown as CommandContext);

    const result = (await approvalModeCommand.action(
      nullConfigContext,
      '',
    )) as MessageActionReturn;

    expect(result.type).toBe('message');
    expect(result.messageType).toBe('error');
    expect(result.content).toBe('Configuration not available.');
  });

  it('should change approval mode when valid mode is provided', async () => {
    if (!approvalModeCommand.action) {
      throw new Error('approvalModeCommand must have an action.');
    }

    const result = (await approvalModeCommand.action(
      mockContext,
      'plan',
    )) as MessageActionReturn;

    expect(setApprovalModeMock).toHaveBeenCalledWith(ApprovalMode.PLAN);
    expect(setSettingsValueMock).not.toHaveBeenCalled();
    expect(result.type).toBe('message');
    expect(result.messageType).toBe('info');
    expect(result.content).toBe('Approval mode changed to: plan');
  });

  it('should accept canonical auto-edit mode value', async () => {
    if (!approvalModeCommand.action) {
      throw new Error('approvalModeCommand must have an action.');
    }

    const result = (await approvalModeCommand.action(
      mockContext,
      'auto-edit',
    )) as MessageActionReturn;

    expect(setApprovalModeMock).toHaveBeenCalledWith(ApprovalMode.AUTO_EDIT);
    expect(setSettingsValueMock).not.toHaveBeenCalled();
    expect(result.type).toBe('message');
    expect(result.messageType).toBe('info');
    expect(result.content).toBe('Approval mode changed to: auto-edit');
  });

  it('should accept auto-edit alias for compatibility', async () => {
    if (!approvalModeCommand.action) {
      throw new Error('approvalModeCommand must have an action.');
    }

    const result = (await approvalModeCommand.action(
      mockContext,
      'auto-edit',
    )) as MessageActionReturn;

    expect(setApprovalModeMock).toHaveBeenCalledWith(ApprovalMode.AUTO_EDIT);
    expect(setSettingsValueMock).not.toHaveBeenCalled();
    expect(result.content).toBe('Approval mode changed to: auto-edit');
  });

  it('should display error when invalid mode is provided', async () => {
    if (!approvalModeCommand.action) {
      throw new Error('approvalModeCommand must have an action.');
    }

    const result = (await approvalModeCommand.action(
      mockContext,
      'invalid',
    )) as MessageActionReturn;

    expect(result.type).toBe('message');
    expect(result.messageType).toBe('error');
    expect(result.content).toContain('Invalid approval mode: invalid');
    expect(result.content).toContain('Available approval modes:');
    expect(result.content).toContain(
      'Usage: /approval-mode <mode> [--session|--user|--project]',
    );
  });

  it('should display error when setApprovalMode throws an error', async () => {
    if (!approvalModeCommand.action) {
      throw new Error('approvalModeCommand must have an action.');
    }

    const errorMessage = 'Failed to set approval mode';
    mockContext.services.config!.setApprovalMode = vi
      .fn()
      .mockImplementation(() => {
        throw new Error(errorMessage);
      });

    const result = (await approvalModeCommand.action(
      mockContext,
      'plan',
    )) as MessageActionReturn;

    expect(result.type).toBe('message');
    expect(result.messageType).toBe('error');
    expect(result.content).toBe(
      `Failed to change approval mode: ${errorMessage}`,
    );
  });

  it('should allow selecting auto-edit with user scope via nested subcommands', async () => {
    if (!approvalModeCommand.subCommands) {
      throw new Error('approvalModeCommand must have subCommands.');
    }

    const userSubCommand = getScopeSubCommand(ApprovalMode.AUTO_EDIT, '--user');
    if (!userSubCommand?.action) {
      throw new Error('--user scope subcommand must have an action.');
    }

    const result = (await userSubCommand.action(
      mockContext,
      '',
    )) as MessageActionReturn;

    expect(setApprovalModeMock).toHaveBeenCalledWith(ApprovalMode.AUTO_EDIT);
    expect(setSettingsValueMock).toHaveBeenCalledWith(
      SettingScope.User,
      'approvalMode',
      'auto-edit',
    );
    expect(result.content).toBe(
      `Approval mode changed to: auto-edit (saved to user settings at ${userSettingsPath})`,
    );
  });

  it('should allow selecting plan with project scope via nested subcommands', async () => {
    if (!approvalModeCommand.subCommands) {
      throw new Error('approvalModeCommand must have subCommands.');
    }

    const projectSubCommand = getScopeSubCommand(
      ApprovalMode.PLAN,
      '--project',
    );
    if (!projectSubCommand?.action) {
      throw new Error('--project scope subcommand must have an action.');
    }

    const result = (await projectSubCommand.action(
      mockContext,
      '',
    )) as MessageActionReturn;

    expect(setApprovalModeMock).toHaveBeenCalledWith(ApprovalMode.PLAN);
    expect(setSettingsValueMock).toHaveBeenCalledWith(
      SettingScope.Workspace,
      'approvalMode',
      'plan',
    );
    expect(result.content).toBe(
      `Approval mode changed to: plan (saved to project settings at ${projectSettingsPath})`,
    );
  });

  it('should allow selecting plan with session scope via nested subcommands', async () => {
    if (!approvalModeCommand.subCommands) {
      throw new Error('approvalModeCommand must have subCommands.');
    }

    const sessionSubCommand = getScopeSubCommand(
      ApprovalMode.PLAN,
      '--session',
    );
    if (!sessionSubCommand?.action) {
      throw new Error('--session scope subcommand must have an action.');
    }

    const result = (await sessionSubCommand.action(
      mockContext,
      '',
    )) as MessageActionReturn;

    expect(setApprovalModeMock).toHaveBeenCalledWith(ApprovalMode.PLAN);
    expect(setSettingsValueMock).not.toHaveBeenCalled();
    expect(result.content).toBe('Approval mode changed to: plan');
  });

  it('should allow providing a scope argument after selecting a mode subcommand', async () => {
    if (!approvalModeCommand.subCommands) {
      throw new Error('approvalModeCommand must have subCommands.');
    }

    const planSubCommand = getModeSubCommand(ApprovalMode.PLAN);
    if (!planSubCommand?.action) {
      throw new Error('plan subcommand must have an action.');
    }

    const result = (await planSubCommand.action(
      mockContext,
      '--user',
    )) as MessageActionReturn;

    expect(setApprovalModeMock).toHaveBeenCalledWith(ApprovalMode.PLAN);
    expect(setSettingsValueMock).toHaveBeenCalledWith(
      SettingScope.User,
      'approvalMode',
      'plan',
    );
    expect(result.content).toBe(
      `Approval mode changed to: plan (saved to user settings at ${userSettingsPath})`,
    );
  });

  it('should support --user plan pattern (scope first)', async () => {
    if (!approvalModeCommand.action) {
      throw new Error('approvalModeCommand must have an action.');
    }

    const result = (await approvalModeCommand.action(
      mockContext,
      '--user plan',
    )) as MessageActionReturn;

    expect(setApprovalModeMock).toHaveBeenCalledWith(ApprovalMode.PLAN);
    expect(setSettingsValueMock).toHaveBeenCalledWith(
      SettingScope.User,
      'approvalMode',
      'plan',
    );
    expect(result.content).toBe(
      `Approval mode changed to: plan (saved to user settings at ${userSettingsPath})`,
    );
  });

  it('should support plan --user pattern (mode first)', async () => {
    if (!approvalModeCommand.action) {
      throw new Error('approvalModeCommand must have an action.');
    }

    const result = (await approvalModeCommand.action(
      mockContext,
      'plan --user',
    )) as MessageActionReturn;

    expect(setApprovalModeMock).toHaveBeenCalledWith(ApprovalMode.PLAN);
    expect(setSettingsValueMock).toHaveBeenCalledWith(
      SettingScope.User,
      'approvalMode',
      'plan',
    );
    expect(result.content).toBe(
      `Approval mode changed to: plan (saved to user settings at ${userSettingsPath})`,
    );
  });

  it('should support --project auto-edit pattern', async () => {
    if (!approvalModeCommand.action) {
      throw new Error('approvalModeCommand must have an action.');
    }

    const result = (await approvalModeCommand.action(
      mockContext,
      '--project auto-edit',
    )) as MessageActionReturn;

    expect(setApprovalModeMock).toHaveBeenCalledWith(ApprovalMode.AUTO_EDIT);
    expect(setSettingsValueMock).toHaveBeenCalledWith(
      SettingScope.Workspace,
      'approvalMode',
      'auto-edit',
    );
    expect(result.content).toBe(
      `Approval mode changed to: auto-edit (saved to project settings at ${projectSettingsPath})`,
    );
  });

  it('should display error when only scope flag is provided', async () => {
    if (!approvalModeCommand.action) {
      throw new Error('approvalModeCommand must have an action.');
    }

    const result = (await approvalModeCommand.action(
      mockContext,
      '--user',
    )) as MessageActionReturn;

    expect(result.type).toBe('message');
    expect(result.messageType).toBe('error');
    expect(result.content).toContain('Missing approval mode');
    expect(setApprovalModeMock).not.toHaveBeenCalled();
    expect(setSettingsValueMock).not.toHaveBeenCalled();
  });

  it('should display error when multiple scope flags are provided', async () => {
    if (!approvalModeCommand.action) {
      throw new Error('approvalModeCommand must have an action.');
    }

    const result = (await approvalModeCommand.action(
      mockContext,
      '--user --project plan',
    )) as MessageActionReturn;

    expect(result.type).toBe('message');
    expect(result.messageType).toBe('error');
    expect(result.content).toContain('Multiple scope flags provided');
    expect(setApprovalModeMock).not.toHaveBeenCalled();
    expect(setSettingsValueMock).not.toHaveBeenCalled();
  });

  it('should surface a helpful error when scope subcommands receive extra arguments', async () => {
    if (!approvalModeCommand.subCommands) {
      throw new Error('approvalModeCommand must have subCommands.');
    }

    const userSubCommand = getScopeSubCommand(ApprovalMode.DEFAULT, '--user');
    if (!userSubCommand?.action) {
      throw new Error('--user scope subcommand must have an action.');
    }

    const result = (await userSubCommand.action(
      mockContext,
      'extra',
    )) as MessageActionReturn;

    expect(result.type).toBe('message');
    expect(result.messageType).toBe('error');
    expect(result.content).toBe(
      'Scope subcommands do not accept additional arguments.',
    );
    expect(setApprovalModeMock).not.toHaveBeenCalled();
    expect(setSettingsValueMock).not.toHaveBeenCalled();
  });

  it('should provide completion for approval modes', async () => {
    if (!approvalModeCommand.completion) {
      throw new Error('approvalModeCommand must have a completion function.');
    }

    // Test partial mode completion
    const result = await approvalModeCommand.completion(mockContext, 'p');
    expect(result).toEqual(['plan']);

    const result2 = await approvalModeCommand.completion(mockContext, 'a');
    expect(result2).toEqual(['auto-edit']);

    // Test empty completion - should suggest available modes first
    const result3 = await approvalModeCommand.completion(mockContext, '');
    expect(result3).toEqual(['plan', 'default', 'auto-edit', 'yolo']);

    const result4 = await approvalModeCommand.completion(mockContext, 'AUTO');
    expect(result4).toEqual(['auto-edit']);

    // Test mode first pattern: 'plan ' should suggest scope flags
    const result5 = await approvalModeCommand.completion(mockContext, 'plan ');
    expect(result5).toEqual(['--session', '--project', '--user']);

    const result6 = await approvalModeCommand.completion(
      mockContext,
      'plan --u',
    );
    expect(result6).toEqual(['--user']);

    // Test scope first pattern: '--user ' should suggest modes
    const result7 = await approvalModeCommand.completion(
      mockContext,
      '--user ',
    );
    expect(result7).toEqual(['plan', 'default', 'auto-edit', 'yolo']);

    const result8 = await approvalModeCommand.completion(
      mockContext,
      '--user p',
    );
    expect(result8).toEqual(['plan']);

    // Test completed patterns should return empty
    const result9 = await approvalModeCommand.completion(
      mockContext,
      'plan --user ',
    );
    expect(result9).toEqual([]);

    const result10 = await approvalModeCommand.completion(
      mockContext,
      '--user plan ',
    );
    expect(result10).toEqual([]);
  });
});
