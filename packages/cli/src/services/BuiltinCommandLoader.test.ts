/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

vi.mock('../ui/commands/profileCommand.js', async () => {
  const { CommandKind } = await import('../ui/commands/types.js');
  return {
    profileCommand: {
      name: 'profile',
      description: 'Profile command',
      kind: CommandKind.BUILT_IN,
    },
  };
});

vi.mock('../ui/commands/aboutCommand.js', async () => {
  const { CommandKind } = await import('../ui/commands/types.js');
  return {
    aboutCommand: {
      name: 'about',
      description: 'About the CLI',
      kind: CommandKind.BUILT_IN,
    },
  };
});

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest';
import { BuiltinCommandLoader } from './BuiltinCommandLoader.js';
import { releaseNotesCommand } from '../ui/commands/releaseNotesCommand.js';
import * as appPluginRegistry from '../app-plugins/registry.js';
import { isNightly, type Config } from '@qwen-code/core';
import { CommandKind } from '../ui/commands/types.js';

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    isNightly: vi.fn().mockResolvedValue(false),
  };
});

vi.mock('../ui/commands/agentsCommand.js', () => ({
  agentsCommand: { name: 'agents' },
}));
vi.mock('../ui/commands/clearCommand.js', () => ({ clearCommand: {} }));
vi.mock('../ui/commands/newCommand.js', () => ({
  newCommand: { name: 'new' },
}));
vi.mock('../ui/commands/compressCommand.js', () => ({ compactCommand: {} }));
vi.mock('../ui/commands/corgiCommand.js', () => ({ corgiCommand: {} }));
vi.mock('../ui/commands/editorCommand.js', () => ({ editorCommand: {} }));
vi.mock('../ui/commands/effortCommand.js', () => ({
  effortCommand: { name: 'effort' },
}));
vi.mock('../ui/commands/exportCommand.js', () => ({
  exportCommand: { name: 'export' },
}));
vi.mock('../ui/commands/extensionsCommand.js', () => ({
  extensionsCommand: () => ({}),
}));
vi.mock('../ui/commands/helpCommand.js', () => ({ helpCommand: {} }));
vi.mock('../ui/commands/shortcutsCommand.js', () => ({
  shortcutsCommand: {},
}));
vi.mock('../ui/commands/memoryCommand.js', () => ({ memoryCommand: {} }));
vi.mock('../ui/commands/modelCommand.js', () => ({
  modelCommand: { name: 'model' },
}));
vi.mock('../ui/commands/contextWindowCommand.js', () => ({
  contextWindowCommand: { name: 'context-window' },
}));
vi.mock('../ui/commands/quitCommand.js', () => ({ quitCommand: {} }));
vi.mock('../ui/commands/continueCommand.js', () => ({
  continueCommand: {
    name: 'continue',
  },
}));
vi.mock('../ui/commands/resumeCommand.js', () => ({
  resumeCommand: {
    name: 'resume',
  },
}));
vi.mock('../ui/commands/renameCommand.js', () => ({
  renameCommand: {
    name: 'rename',
  },
}));
vi.mock('../ui/commands/rewindCommand.js', () => ({
  rewindCommand: {
    name: 'rewind',
    altNames: ['checkpoint'],
  },
}));
vi.mock('../ui/commands/statsCommand.js', () => ({ statsCommand: {} }));
vi.mock('../ui/commands/themeCommand.js', () => ({ themeCommand: {} }));
vi.mock('../ui/commands/toolsCommand.js', () => ({ toolsCommand: {} }));
vi.mock('../ui/commands/skillsCommand.js', () => ({
  skillsCommand: { name: 'skills' },
}));
vi.mock('../ui/commands/outputStyleCommand.js', () => ({
  outputStyleCommand: { name: 'output-style' },
}));
vi.mock('../ui/commands/tasksCommand.js', () => ({
  tasksCommand: { name: 'tasks' },
  workflowsCommand: { name: 'workflows' },
}));
vi.mock('../ui/commands/planCommand.js', async () => {
  const { CommandKind } = await import('../ui/commands/types.js');
  return {
    planCommand: {
      name: 'plan',
      description: 'Plan command',
      kind: CommandKind.BUILT_IN,
    },
  };
});

vi.mock('../ui/commands/goalCommand.js', async () => {
  const { CommandKind } = await import('../ui/commands/types.js');
  return {
    goalCommand: {
      name: 'goal',
      description: 'Goal command',
      kind: CommandKind.BUILT_IN,
    },
  };
});

vi.mock('../ui/commands/mcpCommand.js', () => ({
  mcpCommand: {
    name: 'mcp',
    description: 'MCP command',
    kind: 'BUILT_IN',
  },
}));

describe('BuiltinCommandLoader', () => {
  it('registers release-notes without a product plugin in every mode', async () => {
    for (const interactive of [true, false]) {
      const config = { ...mockConfig, isInteractive: () => interactive } as Config;
      const commands = await new BuiltinCommandLoader(config).loadCommands(
        new AbortController().signal,
      );
      expect(commands.filter((command) => command.name === 'release-notes')).toEqual([
        expect.objectContaining({
          kind: CommandKind.BUILT_IN,
          autoExecute: true,
          isSafeConcurrent: true,
          hideInput: true,
        }),
      ]);
      expect(commands.find((command) => command.name === 'release-notes')).toBe(
        releaseNotesCommand,
      );
    }
  });
  let mockConfig: Config;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig = {
      getFolderTrust: vi.fn().mockReturnValue(true),
      isPlanEnabled: vi.fn().mockReturnValue(true),
      getEnableExtensionReloading: () => false,
      getEnableHooks: () => false,
      isSkillsSupportEnabled: vi.fn().mockReturnValue(true),
      isAgentsEnabled: vi.fn().mockReturnValue(false),
      isWorkflowsEnabled: vi.fn().mockReturnValue(true),
      isInteractive: vi.fn().mockReturnValue(true),
      getAcpMode: vi.fn().mockReturnValue(false),
      getMcpEnabled: vi.fn().mockReturnValue(true),
      getDebugMode: vi.fn().mockReturnValue(false),
      getSkillManager: vi.fn().mockReturnValue({
        getAllSkills: vi.fn().mockReturnValue([]),
        isAdminEnabled: vi.fn().mockReturnValue(true),
      }),
      getContentGeneratorConfig: vi.fn().mockReturnValue({
        authType: 'other',
      }),
    } as unknown as Config;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns only host declarations without reading plugin commands', async () => {
    const readPlugins = vi.spyOn(appPluginRegistry, 'getAppPlugins')
      .mockReturnValue(undefined);
    try {
      const commands = await new BuiltinCommandLoader(mockConfig).loadCommands(new AbortController().signal);
      expect(commands.some((command) => command.name === 'plugin-only')).toBe(false);
      expect(readPlugins).not.toHaveBeenCalled();
    } finally {
      readPlugins.mockRestore();
    }
  });

  it('should include workflows command by default', async () => {
    const loader = new BuiltinCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);

    expect(commands.find((c) => c.name === 'workflows')).toBeDefined();
  });

  it('should filter out null command definitions returned by factories', async () => {
    const loader = new BuiltinCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);

    const renameCmd = commands.find((c) => c.name === 'rename');
    expect(renameCmd).toBeDefined();

    // Other commands should still be present.
    const aboutCmd = commands.find((c) => c.name === 'about');
    expect(aboutCmd).toBeDefined();
  });

  it('should handle a null config gracefully when loading commands', async () => {
    const loader = new BuiltinCommandLoader(null);
    const commands = await loader.loadCommands(new AbortController().signal);
    expect(commands.find((c) => c.name === 'terminal-setup')).toBeUndefined();
  });

  it('should expose terminal setup only in the local interactive catalog', async () => {
    const commands = await new BuiltinCommandLoader(mockConfig).loadCommands(
      new AbortController().signal,
    );
    expect(commands.find((c) => c.name === 'terminal-setup')).toBeDefined();

    (mockConfig.isInteractive as Mock).mockReturnValue(false);
    const headlessCommands = await new BuiltinCommandLoader(
      mockConfig,
    ).loadCommands(new AbortController().signal);
    expect(
      headlessCommands.find((c) => c.name === 'terminal-setup'),
    ).toBeUndefined();

    (mockConfig.isInteractive as Mock).mockReturnValue(true);
    (mockConfig.getAcpMode as Mock).mockReturnValue(true);
    const acpCommands = await new BuiltinCommandLoader(mockConfig).loadCommands(
      new AbortController().signal,
    );
    expect(acpCommands.find((c) => c.name === 'terminal-setup')).toBeUndefined();
  });

  it('should return a list of all loaded commands', async () => {
    const loader = new BuiltinCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);

    const aboutCmd = commands.find((c) => c.name === 'about');
    expect(aboutCmd).toBeDefined();
    expect(aboutCmd?.kind).toBe(CommandKind.BUILT_IN);

    expect(commands.find((c) => c.name === 'output-style')).toBeDefined();

    const mcpCmd = commands.find((c) => c.name === 'mcp');
    expect(mcpCmd).toBeDefined();

    const renameCmd = commands.find((c) => c.name === 'rename');
    expect(renameCmd).toBeDefined();

  });

  it('leaves login and logout to the product', async () => {
    const loader = new BuiltinCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);

    expect(commands.find((c) => c.name === 'login')).toBeUndefined();
    expect(commands.find((c) => c.name === 'logout')).toBeUndefined();
  });

  it('should include export command', async () => {
    const loader = new BuiltinCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);

    const exportCmd = commands.find((c) => c.name === 'export');
    expect(exportCmd).toBeDefined();
  });

  it('should include rename command', async () => {
    const loader = new BuiltinCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);

    const renameCmd = commands.find((c) => c.name === 'rename');
    expect(renameCmd).toBeDefined();
  });

  it('should include new command', async () => {
    const loader = new BuiltinCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);

    const newCmd = commands.find((c) => c.name === 'new');
    expect(newCmd).toBeDefined();
  });

  it('should include review command', async () => {
    const loader = new BuiltinCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);

    const reviewCmd = commands.find((c) => c.name === 'review');
    expect(reviewCmd).toBeDefined();
  });

  it('should include permissions command (formerly policies)', async () => {
    const loader = new BuiltinCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);
    const permissionsCmd = commands.find((c) => c.name === 'permissions');
    expect(permissionsCmd).toBeDefined();
  });

  it('should include agents command when agents are enabled', async () => {
    mockConfig.isAgentsEnabled = vi.fn().mockReturnValue(true);
    const loader = new BuiltinCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);
    const agentsCmd = commands.find((c) => c.name === 'agents');
    expect(agentsCmd).toBeDefined();
  });

  it('should include plan command when plan mode is enabled', async () => {
    (mockConfig.isPlanEnabled as Mock).mockReturnValue(true);
    const loader = new BuiltinCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);
    const planCmd = commands.find((c) => c.name === 'plan');
    expect(planCmd).toBeDefined();
  });

  it('should include goal command unconditionally', async () => {
    const loader = new BuiltinCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);
    const goalCmd = commands.find((c) => c.name === 'goal');
    expect(goalCmd).toBeDefined();
  });

  it('should exclude plan command when plan mode is disabled', async () => {
    (mockConfig.isPlanEnabled as Mock).mockReturnValue(false);
    const loader = new BuiltinCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);
    const planCmd = commands.find((c) => c.name === 'plan');
    expect(planCmd).toBeUndefined();
  });

  it('should exclude agents command when agents are disabled', async () => {
    mockConfig.isAgentsEnabled = vi.fn().mockReturnValue(false);
    const loader = new BuiltinCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);
    const agentsCmd = commands.find((c) => c.name === 'agents');
    expect(agentsCmd).toBeUndefined();
  });

  it('leaves remote-env registration to product plugins', async () => {
    const loader = new BuiltinCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);
    const remoteEnvCmd = commands.find((c) => c.name === 'remote-env');
    expect(remoteEnvCmd).toBeUndefined();
  });

  it('should include context-window command', async () => {
    const loader = new BuiltinCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);
    const contextWindowCmd = commands.find((c) => c.name === 'context-window');
    expect(contextWindowCmd).toBeDefined();
  });

  describe('resume command', () => {
    it('should not expose legacy resume subcommands and should register rewind', async () => {
      vi.mocked(isNightly).mockResolvedValue(false);
      const loader = new BuiltinCommandLoader(mockConfig);
      const commands = await loader.loadCommands(new AbortController().signal);

      const chatCmd = commands.find((c) => c.name === 'chat');
      expect(chatCmd).toBeUndefined();

      const resumeCmd = commands.find((c) => c.name === 'resume');
      expect(resumeCmd?.subCommands).toBeUndefined();

      const rewindCmd = commands.find((c) => c.name === 'rewind');
      expect(rewindCmd).toBeDefined();
    });
  });
});

describe('BuiltinCommandLoader command set', () => {
  let mockConfig: Config;

  beforeEach(() => {
    vi.resetModules();
    mockConfig = {
      getFolderTrust: vi.fn().mockReturnValue(false),
      isPlanEnabled: vi.fn().mockReturnValue(true),
      getFileCheckpointingEnabled: () => true,
      getEnableExtensionReloading: () => false,
      getEnableHooks: () => false,
      isSkillsSupportEnabled: vi.fn().mockReturnValue(true),
      isAgentsEnabled: vi.fn().mockReturnValue(false),
      isWorkflowsEnabled: vi.fn().mockReturnValue(true),
      getMcpEnabled: vi.fn().mockReturnValue(true),
      getDebugMode: vi.fn().mockReturnValue(false),
      getSkillManager: vi.fn().mockReturnValue({
        getAllSkills: vi.fn().mockReturnValue([]),
        isAdminEnabled: vi.fn().mockReturnValue(true),
      }),
      getContentGeneratorConfig: vi.fn().mockReturnValue({
        authType: 'other',
      }),
    } as unknown as Config;
  });

  it('should include profile command when isDevelopment is false', async () => {
    process.env['NODE_ENV'] = 'production';
    const { BuiltinCommandLoader } = await import('./BuiltinCommandLoader.js');
    const loader = new BuiltinCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);
    const profileCmd = commands.find((c) => c.name === 'profile');
    expect(profileCmd).toBeDefined();
  });

  it('should include profile command when isDevelopment is true', async () => {
    process.env['NODE_ENV'] = 'development';
    const { BuiltinCommandLoader } = await import('./BuiltinCommandLoader.js');
    const loader = new BuiltinCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);
    const profileCmd = commands.find((c) => c.name === 'profile');
    expect(profileCmd).toBeDefined();
  });

  it('should include continue and keep resume free of checkpoint subcommands', async () => {
    const { BuiltinCommandLoader } = await import('./BuiltinCommandLoader.js');
    const loader = new BuiltinCommandLoader(mockConfig);
    const commands = await loader.loadCommands(new AbortController().signal);
    const resumeCmd = commands.find((c) => c.name === 'resume');
    expect(resumeCmd?.subCommands).toBeUndefined();
    const continueCmd = commands.find((c) => c.name === 'continue');
    expect(continueCmd).toBeDefined();
  });
});
