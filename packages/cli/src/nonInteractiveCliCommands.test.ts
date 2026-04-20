/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleSlashCommand } from './nonInteractiveCliCommands.js';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from './config/settings.js';
import { CommandKind } from './ui/commands/types.js';

// Mock the CommandService
const mockGetCommands = vi.hoisted(() => vi.fn());
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

  beforeEach(() => {
    mockCommandServiceCreate.mockResolvedValue({
      getCommands: mockGetCommands,
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

    mockSettings = {
      system: { path: '', settings: {} },
      systemDefaults: { path: '', settings: {} },
      user: { path: '', settings: {} },
      workspace: { path: '', settings: {} },
    } as LoadedSettings;

    abortController = new AbortController();
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

  it('should return unsupported for known built-in commands not in allowed list', async () => {
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
      [], // Empty allowed list
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
        'The command "/help" is not supported in non-interactive mode.',
      );
    }
  });

  it('should return unsupported (not no_command) for a disabled command so it is not forwarded to the model', async () => {
    const mockInitCommand = {
      name: 'init',
      description: 'Initialize project',
      kind: CommandKind.BUILT_IN,
      action: vi.fn(),
    };
    mockGetCommands.mockReturnValue([mockInitCommand]);
    vi.mocked(mockConfig.getDisabledSlashCommands).mockReturnValue(['init']);

    const result = await handleSlashCommand(
      '/init',
      abortController,
      mockConfig,
      mockSettings,
      ['init'], // Would normally be allowed; denylist must still block it.
    );

    expect(result.type).toBe('unsupported');
    if (result.type === 'unsupported') {
      expect(result.reason).toContain('/init');
      expect(result.reason).toContain('disabled');
    }
    expect(mockInitCommand.action).not.toHaveBeenCalled();
  });

  it('should match disabled names case-insensitively', async () => {
    const mockInitCommand = {
      name: 'init',
      description: 'Initialize project',
      kind: CommandKind.BUILT_IN,
      action: vi.fn(),
    };
    mockGetCommands.mockReturnValue([mockInitCommand]);
    vi.mocked(mockConfig.getDisabledSlashCommands).mockReturnValue(['INIT']);

    const result = await handleSlashCommand(
      '/init',
      abortController,
      mockConfig,
      mockSettings,
      ['init'],
    );

    expect(result.type).toBe('unsupported');
    expect(mockInitCommand.action).not.toHaveBeenCalled();
  });

  it('should still return no_command for truly unknown slash commands even when a denylist is set', async () => {
    mockGetCommands.mockReturnValue([]);
    vi.mocked(mockConfig.getDisabledSlashCommands).mockReturnValue(['help']);

    const result = await handleSlashCommand(
      '/does-not-exist',
      abortController,
      mockConfig,
      mockSettings,
    );

    expect(result.type).toBe('no_command');
  });

  it('should execute allowed built-in commands', async () => {
    const mockInitCommand = {
      name: 'init',
      description: 'Initialize project',
      kind: CommandKind.BUILT_IN,
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
      ['init'], // init is in the allowed list
    );

    expect(result.type).toBe('message');
    if (result.type === 'message') {
      expect(result.content).toBe('Project initialized');
    }
  });

  it('should execute /btw when using the default allowed list', async () => {
    const mockBtwCommand = {
      name: 'btw',
      description: 'Ask a side question',
      kind: CommandKind.BUILT_IN,
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

  it('should execute file commands regardless of allowed list', async () => {
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
      [], // Empty allowed list, but FILE commands should still work
    );

    expect(result.type).toBe('submit_prompt');
    if (result.type === 'submit_prompt') {
      expect(result.content).toEqual([{ text: 'Custom prompt' }]);
    }
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
});
