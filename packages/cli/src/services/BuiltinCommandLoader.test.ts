/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

vi.mock('../ui/commands/aboutCommand.js', async () => {
  const { CommandKind } = await import('../ui/commands/types.js');
  return {
    aboutCommand: {
      name: 'status',
      altNames: ['about'],
      description: 'About the CLI',
      kind: CommandKind.BUILT_IN,
    },
  };
});

vi.mock('../ui/commands/approvalModeCommand.js', () => ({
  approvalModeCommand: {
    name: 'approval-mode',
    description: 'Approval mode command',
    kind: 'built-in',
  },
}));

vi.mock('../ui/commands/ideCommand.js', async () => {
  const { CommandKind } = await import('../ui/commands/types.js');
  return {
    ideCommand: vi.fn().mockResolvedValue({
      name: 'ide',
      description: 'IDE command',
      kind: CommandKind.BUILT_IN,
    }),
  };
});
vi.mock('../ui/commands/restoreCommand.js', () => ({
  restoreCommand: vi.fn(),
}));
vi.mock('../ui/commands/trustCommand.js', async () => {
  const { CommandKind } = await import('../ui/commands/types.js');
  return {
    trustCommand: {
      name: 'trust',
      description: 'Trust command',
      kind: CommandKind.BUILT_IN,
    },
  };
});
vi.mock('../ui/commands/permissionsCommand.js', async () => {
  const { CommandKind } = await import('../ui/commands/types.js');
  return {
    permissionsCommand: {
      name: 'permissions',
      description: 'Manage permission rules',
      kind: CommandKind.BUILT_IN,
    },
  };
});

vi.mock('../ui/commands/hooksCommand.js', async () => {
  const { CommandKind } = await import('../ui/commands/types.js');
  return {
    hooksCommand: {
      name: 'hooks',
      description: 'Hooks command',
      kind: CommandKind.BUILT_IN,
    },
  };
});

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { BuiltinCommandLoader } from './BuiltinCommandLoader.js';
import type { Config } from '@qwen-code/qwen-code-core';
import { CommandKind } from '../ui/commands/types.js';

import { restoreCommand } from '../ui/commands/restoreCommand.js';

vi.mock('../ui/commands/authCommand.js', () => ({ authCommand: {} }));
vi.mock('../ui/commands/bugCommand.js', () => ({ bugCommand: {} }));
vi.mock('../ui/commands/clearCommand.js', () => ({ clearCommand: {} }));
vi.mock('../ui/commands/compressCommand.js', () => ({ compressCommand: {} }));
vi.mock('../ui/commands/docsCommand.js', () => ({ docsCommand: {} }));
vi.mock('../ui/commands/exportCommand.js', () => ({ exportCommand: {} }));
vi.mock('../ui/commands/editorCommand.js', () => ({ editorCommand: {} }));
vi.mock('../ui/commands/extensionsCommand.js', () => ({
  extensionsCommand: {},
}));
vi.mock('../ui/commands/helpCommand.js', () => ({ helpCommand: {} }));
vi.mock('../ui/commands/memoryCommand.js', () => ({ memoryCommand: {} }));
vi.mock('../ui/commands/insightCommand.js', async () => {
  const { CommandKind } = await import('../ui/commands/types.js');
  return {
    insightCommand: {
      name: 'insight',
      description: 'Insight command',
      kind: CommandKind.BUILT_IN,
    },
  };
});
vi.mock('../ui/commands/modelCommand.js', () => ({
  modelCommand: { name: 'model' },
}));
vi.mock('../ui/commands/quitCommand.js', () => ({
  quitCommand: {},
}));
vi.mock('../ui/commands/statsCommand.js', () => ({ statsCommand: {} }));
vi.mock('../ui/commands/themeCommand.js', () => ({ themeCommand: {} }));
vi.mock('../ui/commands/toolsCommand.js', () => ({ toolsCommand: {} }));
vi.mock('../ui/commands/mcpCommand.js', () => ({
  mcpCommand: {
    name: 'mcp',
    description: 'MCP command',
    kind: 'BUILT_IN',
  },
}));
vi.mock('../ui/commands/modelCommand.js', () => ({
  modelCommand: {
    name: 'model',
    description: 'Model command',
    kind: 'BUILT_IN',
  },
}));

describe('BuiltinCommandLoader', () => {
  let mockConfig: Config;

  const restoreCommandMock = restoreCommand as Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig = {
      getFolderTrust: vi.fn().mockReturnValue(true),
      getUseModelRouter: () => false,
      getDisableAllHooks: vi.fn().mockReturnValue(false),
      getManagedAutoMemoryEnabled: vi.fn().mockReturnValue(true),
    } as unknown as Config;

    restoreCommandMock.mockReturnValue({
      name: 'restore',
      description: 'Restore command',
      kind: CommandKind.BUILT_IN,
    });
  });

  it('should correctly pass the config object to restore command factory', async () => {
    const loader = new BuiltinCommandLoader(mockConfig);
    await loader.loadCommands(new AbortController().signal);

    // ideCommand is now a constant, no longer needs config
    expect(restoreCommandMock).toHaveBeenCalledTimes(1);
    expect(restoreCommandMock).toHaveBeenCalledWith(mockConfig);
  });

  it('should filter out null command definitions returned by factories', async () => {
    // ideCommand is now a constant SlashCommand
    const loader = new BuiltinCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);

    // The 'ide' command should be present.
    const ideCmd = commands.find((c) => c.name === 'ide');
    expect(ideCmd).toBeDefined();

    // Other commands should still be present.
    const statusCmd = commands.find((c) => c.name === 'status');
    expect(statusCmd).toBeDefined();
  });

  it('should handle a null config gracefully when calling factories', async () => {
    const loader = new BuiltinCommandLoader(null);
    await loader.loadCommands(new AbortController().signal);
    // ideCommand is now a constant, no longer needs config
    expect(restoreCommandMock).toHaveBeenCalledTimes(1);
    expect(restoreCommandMock).toHaveBeenCalledWith(null);
  });

  it('should return a list of all loaded commands', async () => {
    const loader = new BuiltinCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);

    const statusCmd = commands.find((c) => c.name === 'status');
    expect(statusCmd).toBeDefined();
    expect(statusCmd?.kind).toBe(CommandKind.BUILT_IN);

    const approvalModeCmd = commands.find((c) => c.name === 'approval-mode');
    expect(approvalModeCmd).toBeDefined();
    expect(approvalModeCmd?.kind).toBe(CommandKind.BUILT_IN);

    const ideCmd = commands.find((c) => c.name === 'ide');
    expect(ideCmd).toBeDefined();

    const mcpCmd = commands.find((c) => c.name === 'mcp');
    expect(mcpCmd).toBeDefined();

    const modelCmd = commands.find((c) => c.name === 'model');
    expect(modelCmd).toBeDefined();
  });

  it('should include trust command when folder trust is enabled', async () => {
    const loader = new BuiltinCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);
    const trustCmd = commands.find((c) => c.name === 'trust');
    expect(trustCmd).toBeDefined();
  });

  it('should exclude trust command when folder trust is disabled', async () => {
    (mockConfig.getFolderTrust as Mock).mockReturnValue(false);
    const loader = new BuiltinCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);
    const trustCmd = commands.find((c) => c.name === 'trust');
    expect(trustCmd).toBeUndefined();
  });

  it('should always include modelCommand', async () => {
    const loader = new BuiltinCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);
    const modelCmd = commands.find((c) => c.name === 'model');
    expect(modelCmd).toBeDefined();
    expect(modelCmd?.name).toBe('model');
  });

  it('should still load all other commands when ideCommand() throws', async () => {
    // Simulate ideCommand() failure (e.g., platform-specific process detection fails)
    const { ideCommand: ideCommandMock } = await import(
      '../ui/commands/ideCommand.js'
    );
    (ideCommandMock as Mock).mockRejectedValueOnce(
      new Error('PowerShell not available'),
    );

    const loader = new BuiltinCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);

    // IDE command should NOT be present
    const ideCmd = commands.find((c) => c.name === 'ide');
    expect(ideCmd).toBeUndefined();

    // But all other built-in commands should still be loaded
    const modelCmd = commands.find((c) => c.name === 'model');
    expect(modelCmd).toBeDefined();

    const statusCmd = commands.find((c) => c.name === 'status');
    expect(statusCmd).toBeDefined();

    const mcpCmd = commands.find((c) => c.name === 'mcp');
    expect(mcpCmd).toBeDefined();
  });

  it('should include insight command in the built-in command list', async () => {
    const loader = new BuiltinCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);
    const insightCmd = commands.find((c) => c.name === 'insight');
    expect(insightCmd).toBeDefined();
    expect(insightCmd?.kind).toBe(CommandKind.BUILT_IN);
  });

  it('should always include hooks command regardless of disableAllHooks', async () => {
    // When disableAllHooks is false
    const loader1 = new BuiltinCommandLoader(mockConfig);
    const commands1 = await loader1.loadCommands(new AbortController().signal);
    const hooksCmd1 = commands1.find((c) => c.name === 'hooks');
    expect(hooksCmd1).toBeDefined();

    // When disableAllHooks is true - hooks command should still be available
    // (it will show a disabled state page in the UI instead of hiding the command)
    (mockConfig.getDisableAllHooks as Mock).mockReturnValue(true);
    const loader2 = new BuiltinCommandLoader(mockConfig);
    const commands2 = await loader2.loadCommands(new AbortController().signal);
    const hooksCmd2 = commands2.find((c) => c.name === 'hooks');
    expect(hooksCmd2).toBeDefined();
  });
});
