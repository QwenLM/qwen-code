/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAvailableCommands,
  handleSlashCommand,
} from './nonInteractiveCliCommands.js';
import {
  __resetActiveGoalStoreForTests,
  type Config,
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from './config/settings.js';
import { CommandKind, type ExecutionMode } from './ui/commands/types.js';
import { filterCommandsForMode } from './services/commandUtils.js';
import { goalCommand } from './ui/commands/goalCommand.js';

// Mock the CommandService
const mockGetCommands = vi.hoisted(() => vi.fn());
const mockGetCommandsForMode = vi.hoisted(() => vi.fn());
const mockGetModelInvocableCommands = vi.hoisted(() => vi.fn());
const mockCommandServiceCreate = vi.hoisted(() => vi.fn());
vi.mock('./services/CommandService.js', () => ({
  CommandService: {
    create: mockCommandServiceCreate,
  },
}));

describe('handleSlashCommand', () => {
  let mockConfig: Config;
  let mockSettings: LoadedSettings;
  let abortController: AbortController;
  let mockFireUserPromptExpansionEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetActiveGoalStoreForTests();
    // getCommandsForMode applies real mode filtering on top of getCommands()
    mockGetCommandsForMode.mockImplementation((mode: ExecutionMode) =>
      filterCommandsForMode(mockGetCommands(), mode),
    );
    mockGetModelInvocableCommands.mockImplementation(() =>
      mockGetCommands().filter(
        (command: { modelInvocable?: boolean; hidden?: boolean }) =>
          !command.hidden && command.modelInvocable === true,
      ),
    );
    mockCommandServiceCreate.mockResolvedValue({
      getCommands: mockGetCommands,
      getCommandsForMode: mockGetCommandsForMode,
      getModelInvocableCommands: mockGetModelInvocableCommands,
    });
    mockFireUserPromptExpansionEvent = vi.fn().mockResolvedValue(undefined);

    mockConfig = {
      getExperimentalZedIntegration: vi.fn().mockReturnValue(false),
      isInteractive: vi.fn().mockReturnValue(false),
      getSessionId: vi.fn().mockReturnValue('test-session'),
      getFolderTrustFeature: vi.fn().mockReturnValue(false),
      getFolderTrust: vi.fn().mockReturnValue(false),
      getProjectRoot: vi.fn().mockReturnValue('/test/project'),
      isTrustedFolder: vi.fn().mockReturnValue(true),
      getDisableAllHooks: vi.fn().mockReturnValue(false),
      hasHooksForEvent: vi.fn().mockReturnValue(true),
      getHookSystem: vi.fn().mockReturnValue({
        addFunctionHook: vi.fn().mockReturnValue('goal-hook-id'),
        removeFunctionHook: vi.fn().mockReturnValue(true),
        fireUserPromptExpansionEvent: mockFireUserPromptExpansionEvent,
      }),
      setModelInvocableCommandsProvider: vi.fn(),
      setModelInvocableCommandsExecutor: vi.fn(),
      getDisabledSlashCommands: vi.fn().mockReturnValue([]),
      storage: {},
    } as unknown as Config;

    mockSettings = {
      system: { path: '', settings: {} },
      systemDefaults: { path: '', settings: {} },
      user: { path: '', settings: {} },
      workspace: { path: '', settings: {} },
    } as LoadedSettings;

    abortController = new AbortController();
  });

  afterEach(() => {
    __resetActiveGoalStoreForTests();
  });

  it('should return no_command for non-slash input', async () => {
    const result = await handleSlashCommand(
      'regular text',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(result.type).toBe('no_command');
  });

  it('should return no_command for unknown slash commands', async () => {
    mockGetCommands.mockReturnValue([]);

    const result = await handleSlashCommand(
      '/unknowncommand',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(result.type).toBe('no_command');
  });

  it('should return unsupported for built-in commands without non-interactive supportedModes', async () => {
    const mockHelpCommand = {
      name: 'help',
      description: 'Show help',
      kind: CommandKind.BUILT_IN,
      // No supportedModes → BUILT_IN fallback → interactive only
      action: vi.fn(),
    };
    mockGetCommands.mockReturnValue([mockHelpCommand]);

    const result = await handleSlashCommand(
      '/help',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(result.type).toBe('unsupported');
    if (result.type === 'unsupported') {
      expect(result.reason).toContain('/help');
      expect(result.reason).toContain('not supported');
    }
  });

  it('should return unsupported for /help when using default allowed list', async () => {
    const mockHelpCommand = {
      name: 'help',
      description: 'Show help',
      kind: CommandKind.BUILT_IN,
      action: vi.fn(),
    };
    mockGetCommands.mockReturnValue([mockHelpCommand]);

    const result = await handleSlashCommand(
      '/help',
      abortController,
      mockConfig,
      mockSettings,
      // Default allowed list: ['init', 'summary', 'compress']
    );

    expect(result.type).toBe('unsupported');
    if (result.type === 'unsupported') {
      expect(result.reason).toBe(
        'The command "/help" is not supported in this mode.',
      );
    }
  });

  it('should execute local commands with non_interactive supportedModes', async () => {
    const mockInitCommand = {
      name: 'init',
      description: 'Initialize project',
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
      action: vi.fn().mockResolvedValue({
        type: 'message',
        messageType: 'info',
        content: 'Project initialized',
      }),
    };
    mockGetCommands.mockReturnValue([mockInitCommand]);

    const result = await handleSlashCommand(
      '/init',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(result.type).toBe('message');
    if (result.type === 'message') {
      expect(result.content).toBe('Project initialized');
    }
  });

  it('should execute /btw with non_interactive supportedModes', async () => {
    const mockBtwCommand = {
      name: 'btw',
      description: 'Ask a side question',
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
      action: vi.fn().mockResolvedValue({
        type: 'message',
        messageType: 'info',
        content: 'btw> question\nanswer',
      }),
    };
    mockGetCommands.mockReturnValue([mockBtwCommand]);

    const result = await handleSlashCommand(
      '/btw question',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(mockBtwCommand.action).toHaveBeenCalled();
    expect(result.type).toBe('message');
    if (result.type === 'message') {
      expect(result.content).toBe('btw> question\nanswer');
    }
  });

  it('should execute /goal in non-interactive mode as a submit_prompt command', async () => {
    mockGetCommands.mockReturnValue([goalCommand]);

    const result = await handleSlashCommand(
      '/goal write a hello world script',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(result.type).toBe('submit_prompt');
    if (result.type === 'submit_prompt') {
      expect(result.content).toEqual([
        expect.objectContaining({
          text: expect.stringContaining('write a hello world script'),
        }),
      ]);
      expect(result.outputHistoryItems).toEqual([
        expect.objectContaining({
          type: 'goal_status',
          kind: 'set',
          condition: 'write a hello world script',
          setAt: expect.any(Number),
        }),
      ]);
    }
  });

  it('should report no active goal for empty non-interactive /goal', async () => {
    mockGetCommands.mockReturnValue([goalCommand]);

    const result = await handleSlashCommand(
      '/goal',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(result).toMatchObject({
      type: 'message',
      messageType: 'info',
      content: 'No goal set. Usage: `/goal <condition>` (or `/goal clear`).',
    });
  });

  it('should report active goal status after setting a non-interactive /goal', async () => {
    mockGetCommands.mockReturnValue([goalCommand]);

    await handleSlashCommand(
      '/goal write a hello world script',
      abortController,
      mockConfig,
      mockSettings,
    );
    const result = await handleSlashCommand(
      '/goal',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(result).toMatchObject({
      type: 'message',
      messageType: 'info',
    });
    if (result.type === 'message') {
      expect(result.content).toContain(
        'Goal active: write a hello world script',
      );
      expect(result.content).toContain('not yet evaluated');
    }
  });

  it('should report cleared goal for non-interactive /goal clear', async () => {
    mockGetCommands.mockReturnValue([goalCommand]);

    await handleSlashCommand(
      '/goal write a hello world script',
      abortController,
      mockConfig,
      mockSettings,
    );
    const result = await handleSlashCommand(
      '/goal clear',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(result).toMatchObject({
      type: 'message',
      messageType: 'info',
      content: 'Goal cleared: write a hello world script',
    });
    if (result.type === 'message') {
      expect(result.outputHistoryItems).toEqual([
        expect.objectContaining({
          type: 'goal_status',
          kind: 'cleared',
          condition: 'write a hello world script',
          durationMs: expect.any(Number),
        }),
      ]);
    }
  });

  it('should report cleared goal for ACP /goal clear', async () => {
    vi.mocked(mockConfig.getExperimentalZedIntegration).mockReturnValue(true);
    mockGetCommands.mockReturnValue([goalCommand]);

    await handleSlashCommand(
      '/goal write a hello world script',
      abortController,
      mockConfig,
      mockSettings,
    );
    const result = await handleSlashCommand(
      '/goal clear',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(result).toMatchObject({
      type: 'message',
      messageType: 'info',
      content: 'Goal cleared: write a hello world script',
    });
  });

  it('should execute FILE commands in any mode without explicit supportedModes', async () => {
    const mockFileCommand = {
      name: 'custom',
      description: 'Custom file command',
      kind: CommandKind.FILE,
      action: vi.fn().mockResolvedValue({
        type: 'submit_prompt',
        content: [{ text: 'Custom prompt' }],
      }),
    };
    mockGetCommands.mockReturnValue([mockFileCommand]);

    const result = await handleSlashCommand(
      '/custom',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(result.type).toBe('submit_prompt');
    if (result.type === 'submit_prompt') {
      expect(result.content).toEqual([{ text: 'Custom prompt' }]);
    }
  });

  it('should fire UserPromptExpansion hooks for submit_prompt commands', async () => {
    const mockFileCommand = {
      name: 'custom',
      description: 'Custom file command',
      kind: CommandKind.FILE,
      action: vi.fn().mockResolvedValue({
        type: 'submit_prompt',
        content: [{ text: 'Expanded prompt' }],
      }),
    };
    mockGetCommands.mockReturnValue([mockFileCommand]);

    const result = await handleSlashCommand(
      '/custom with args',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(result.type).toBe('submit_prompt');
    expect(mockFireUserPromptExpansionEvent).toHaveBeenCalledWith(
      'custom',
      'with args',
      'Expanded prompt',
      abortController.signal,
    );
  });

  it('should append UserPromptExpansion additional context for submit_prompt commands', async () => {
    mockFireUserPromptExpansionEvent.mockResolvedValue({
      getBlockingError: () => ({ blocked: false }),
      shouldStopExecution: () => false,
      getAdditionalContext: () => 'Hook context',
    });
    const mockFileCommand = {
      name: 'custom',
      description: 'Custom file command',
      kind: CommandKind.FILE,
      action: vi.fn().mockResolvedValue({
        type: 'submit_prompt',
        content: [{ text: 'Expanded prompt' }],
      }),
    };
    mockGetCommands.mockReturnValue([mockFileCommand]);

    const result = await handleSlashCommand(
      '/custom with args',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(result.type).toBe('submit_prompt');
    if (result.type === 'submit_prompt') {
      expect(result.content).toEqual([
        { text: 'Expanded prompt' },
        { text: '\n\nHook context' },
      ]);
    }
  });

  it('should not fire UserPromptExpansion hooks when hooks are disabled', async () => {
    vi.mocked(mockConfig.getDisableAllHooks).mockReturnValue(true);
    const mockFileCommand = {
      name: 'custom',
      description: 'Custom file command',
      kind: CommandKind.FILE,
      action: vi.fn().mockResolvedValue({
        type: 'submit_prompt',
        content: 'Expanded prompt',
      }),
    };
    mockGetCommands.mockReturnValue([mockFileCommand]);

    const result = await handleSlashCommand(
      '/custom',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(mockFireUserPromptExpansionEvent).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'submit_prompt',
      content: 'Expanded prompt',
    });
  });

  it('should not fire UserPromptExpansion hooks when no hooks are configured', async () => {
    vi.mocked(mockConfig.hasHooksForEvent).mockReturnValue(false);
    const mockFileCommand = {
      name: 'custom',
      description: 'Custom file command',
      kind: CommandKind.FILE,
      action: vi.fn().mockResolvedValue({
        type: 'submit_prompt',
        content: 'Expanded prompt',
      }),
    };
    mockGetCommands.mockReturnValue([mockFileCommand]);

    const result = await handleSlashCommand(
      '/custom',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(mockFireUserPromptExpansionEvent).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'submit_prompt',
      content: 'Expanded prompt',
    });
  });

  it('should not fire UserPromptExpansion hooks when hook system is unavailable', async () => {
    vi.mocked(mockConfig.getHookSystem).mockReturnValue(undefined);
    const mockFileCommand = {
      name: 'custom',
      description: 'Custom file command',
      kind: CommandKind.FILE,
      action: vi.fn().mockResolvedValue({
        type: 'submit_prompt',
        content: 'Expanded prompt',
      }),
    };
    mockGetCommands.mockReturnValue([mockFileCommand]);

    const result = await handleSlashCommand(
      '/custom',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(mockFireUserPromptExpansionEvent).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'submit_prompt',
      content: 'Expanded prompt',
    });
  });

  it('should block submit_prompt commands when UserPromptExpansion blocks', async () => {
    mockFireUserPromptExpansionEvent.mockResolvedValue({
      getBlockingError: () => ({
        blocked: true,
        reason: 'Blocked by policy',
      }),
      shouldStopExecution: () => false,
    });
    const mockFileCommand = {
      name: 'custom',
      description: 'Custom file command',
      kind: CommandKind.FILE,
      action: vi.fn().mockResolvedValue({
        type: 'submit_prompt',
        content: 'Expanded prompt',
      }),
    };
    mockGetCommands.mockReturnValue([mockFileCommand]);

    const result = await handleSlashCommand(
      '/custom',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'UserPromptExpansion blocked: Blocked by policy',
    });
  });

  it('should return the block reason for blocked model-invocable command execution', async () => {
    mockFireUserPromptExpansionEvent.mockResolvedValue({
      getBlockingError: () => ({
        blocked: true,
        reason: 'Blocked by policy',
      }),
      shouldStopExecution: () => false,
      getEffectiveReason: () => 'fallback reason',
    });
    const mockFileCommand = {
      name: 'custom',
      description: 'Custom file command',
      kind: CommandKind.FILE,
      modelInvocable: true,
      action: vi.fn().mockResolvedValue({
        type: 'submit_prompt',
        content: 'Expanded prompt',
      }),
    };
    mockGetCommands.mockReturnValue([mockFileCommand]);

    await handleSlashCommand(
      '/custom',
      abortController,
      mockConfig,
      mockSettings,
    );

    const executor = vi.mocked(mockConfig.setModelInvocableCommandsExecutor)
      .mock.calls[0]?.[0];
    expect(executor).toBeDefined();

    const content = await executor?.('custom', 'with args');

    expect(content).toEqual({
      error: 'UserPromptExpansion blocked: Blocked by policy',
    });
  });

  it('should return unsupported for other built-in commands like /quit', async () => {
    const mockQuitCommand = {
      name: 'quit',
      description: 'Quit application',
      kind: CommandKind.BUILT_IN,
      action: vi.fn(),
    };
    mockGetCommands.mockReturnValue([mockQuitCommand]);

    const result = await handleSlashCommand(
      '/quit',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(result.type).toBe('unsupported');
    if (result.type === 'unsupported') {
      expect(result.reason).toContain('/quit');
      expect(result.reason).toContain('not supported');
    }
  });

  it('should handle command with no action', async () => {
    const mockCommand = {
      name: 'noaction',
      description: 'Command without action',
      kind: CommandKind.FILE,
      // No action property
    };
    mockGetCommands.mockReturnValue([mockCommand]);

    const result = await handleSlashCommand(
      '/noaction',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(result.type).toBe('no_command');
  });

  it('should return message when command returns void', async () => {
    const mockCommand = {
      name: 'voidcmd',
      description: 'Command that returns void',
      kind: CommandKind.FILE,
      action: vi.fn().mockResolvedValue(undefined),
    };
    mockGetCommands.mockReturnValue([mockCommand]);

    const result = await handleSlashCommand(
      '/voidcmd',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(result.type).toBe('message');
    if (result.type === 'message') {
      expect(result.content).toBe('Command executed successfully.');
      expect(result.messageType).toBe('info');
    }
  });

  describe('disabled slash commands', () => {
    const mockDisabledCommand = {
      name: 'help',
      description: 'Show help',
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
      action: vi.fn().mockResolvedValue({
        type: 'message',
        messageType: 'info',
        content: 'Help content',
      }),
    };

    it('should return unsupported with disabled reason for a disabled command', async () => {
      mockGetCommands.mockReturnValue([mockDisabledCommand]);
      vi.mocked(mockConfig.getDisabledSlashCommands).mockReturnValue(['help']);

      const result = await handleSlashCommand(
        '/help',
        abortController,
        mockConfig,
        mockSettings,
      );

      expect(result.type).toBe('unsupported');
      if (result.type === 'unsupported') {
        expect(result.reason).toContain('disabled');
        expect(result.originalType).toBe('filtered_command');
      }
    });

    it('should match disabled command names case-insensitively', async () => {
      mockGetCommands.mockReturnValue([mockDisabledCommand]);
      vi.mocked(mockConfig.getDisabledSlashCommands).mockReturnValue(['HELP']);

      const result = await handleSlashCommand(
        '/help',
        abortController,
        mockConfig,
        mockSettings,
      );

      expect(result.type).toBe('unsupported');
      if (result.type === 'unsupported') {
        expect(result.reason).toContain('disabled');
      }
    });

    it('should still return no_command for genuinely unknown commands even with a denylist', async () => {
      mockGetCommands.mockReturnValue([mockDisabledCommand]);
      vi.mocked(mockConfig.getDisabledSlashCommands).mockReturnValue(['help']);

      const result = await handleSlashCommand(
        '/unknowncommand',
        abortController,
        mockConfig,
        mockSettings,
      );

      expect(result.type).toBe('no_command');
    });
  });
});

describe('getAvailableCommands', () => {
  let mockConfig: Config;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCommandServiceCreate.mockResolvedValue({
      getCommands: mockGetCommands,
      getCommandsForMode: mockGetCommandsForMode,
      getModelInvocableCommands: mockGetModelInvocableCommands,
    });

    mockConfig = {
      getExperimentalZedIntegration: vi.fn().mockReturnValue(false),
      isInteractive: vi.fn().mockReturnValue(false),
      getSessionId: vi.fn().mockReturnValue('test-session'),
      getFolderTrustFeature: vi.fn().mockReturnValue(false),
      getFolderTrust: vi.fn().mockReturnValue(false),
      getProjectRoot: vi.fn().mockReturnValue('/test/project'),
      getDisabledSlashCommands: vi.fn().mockReturnValue([]),
      storage: {},
    } as unknown as Config;
  });

  it('includes /export in the default non-interactive command list', async () => {
    const exportCommand = {
      name: 'export',
      description: 'Export current session',
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
      action: vi.fn(),
    };
    mockGetCommands.mockReturnValue([exportCommand]);

    const commands = await getAvailableCommands(
      mockConfig,
      new AbortController().signal,
    );

    expect(commands.map((command) => command.name)).toContain('export');
  });
});
