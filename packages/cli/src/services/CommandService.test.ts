/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CommandService } from './CommandService.js';
import { type ICommandLoader } from './types.js';
import { CommandKind, type SlashCommand } from '../ui/commands/types.js';

const mocks = vi.hoisted(() => ({
  logger: {
    isEnabled: () => true,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    createDebugLogger: () => mocks.logger,
  };
});

const createMockCommand = (name: string, kind: CommandKind): SlashCommand => ({
  name,
  description: `Description for ${name}`,
  kind,
  action: vi.fn(),
});

const skillCommand = (name: string, authoredName?: string): SlashCommand => ({
  name,
  description: `Description for ${name}`,
  kind: CommandKind.SKILL,
  skillDetail: {
    name,
    ...(authoredName ? { authoredName } : {}),
    level: 'extension',
    extensionName: 'rust',
  },
  action: async () => {},
});

const serviceFor = (
  commands: SlashCommand[],
  disabledNames?: string[],
): Promise<CommandService> =>
  CommandService.create(
    [new MockCommandLoader(commands)],
    new AbortController().signal,
    disabledNames ? new Set(disabledNames) : undefined,
  );

const commandNamed = (
  service: CommandService,
  name: string,
): SlashCommand | undefined =>
  service.getCommands().find((cmd) => cmd.name === name);

const mockCommandA = createMockCommand('command-a', CommandKind.BUILT_IN);
const mockCommandB = createMockCommand('command-b', CommandKind.BUILT_IN);
const mockCommandC = createMockCommand('command-c', CommandKind.FILE);
const mockCommandB_Override = createMockCommand('command-b', CommandKind.FILE);

class MockCommandLoader implements ICommandLoader {
  private commandsToLoad: SlashCommand[];

  constructor(commandsToLoad: SlashCommand[]) {
    this.commandsToLoad = commandsToLoad;
  }

  loadCommands = vi.fn(
    async (): Promise<SlashCommand[]> => Promise.resolve(this.commandsToLoad),
  );
}

describe('CommandService', () => {
  beforeEach(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should load commands from a single loader', async () => {
    const mockLoader = new MockCommandLoader([mockCommandA, mockCommandB]);
    const service = await CommandService.create(
      [mockLoader],
      new AbortController().signal,
    );

    const commands = service.getCommands();

    expect(mockLoader.loadCommands).toHaveBeenCalledTimes(1);
    expect(commands).toHaveLength(2);
    expect(commands).toEqual(
      expect.arrayContaining([mockCommandA, mockCommandB]),
    );
  });

  it('should aggregate commands from multiple loaders', async () => {
    const loader1 = new MockCommandLoader([mockCommandA]);
    const loader2 = new MockCommandLoader([mockCommandC]);
    const service = await CommandService.create(
      [loader1, loader2],
      new AbortController().signal,
    );

    const commands = service.getCommands();

    expect(loader1.loadCommands).toHaveBeenCalledTimes(1);
    expect(loader2.loadCommands).toHaveBeenCalledTimes(1);
    expect(commands).toHaveLength(2);
    expect(commands).toEqual(
      expect.arrayContaining([mockCommandA, mockCommandC]),
    );
  });

  it('should override commands from earlier loaders with those from later loaders', async () => {
    const loader1 = new MockCommandLoader([mockCommandA, mockCommandB]);
    const loader2 = new MockCommandLoader([
      mockCommandB_Override,
      mockCommandC,
    ]);
    const service = await CommandService.create(
      [loader1, loader2],
      new AbortController().signal,
    );

    const commands = service.getCommands();

    expect(commands).toHaveLength(3); // Should be A, C, and the overridden B.

    // The final list should contain the override from the *last* loader.
    const commandB = commands.find((cmd) => cmd.name === 'command-b');
    expect(commandB).toBeDefined();
    expect(commandB?.kind).toBe(CommandKind.FILE); // Verify it's the overridden version.
    expect(commandB).toEqual(mockCommandB_Override);

    // Ensure the other commands are still present.
    expect(commands).toEqual(
      expect.arrayContaining([
        mockCommandA,
        mockCommandC,
        mockCommandB_Override,
      ]),
    );
  });

  it('should handle loaders that return an empty array of commands gracefully', async () => {
    const loader1 = new MockCommandLoader([mockCommandA]);
    const emptyLoader = new MockCommandLoader([]);
    const loader3 = new MockCommandLoader([mockCommandB]);
    const service = await CommandService.create(
      [loader1, emptyLoader, loader3],
      new AbortController().signal,
    );

    const commands = service.getCommands();

    expect(emptyLoader.loadCommands).toHaveBeenCalledTimes(1);
    expect(commands).toHaveLength(2);
    expect(commands).toEqual(
      expect.arrayContaining([mockCommandA, mockCommandB]),
    );
  });

  it('should load commands from successful loaders even if one fails', async () => {
    const successfulLoader = new MockCommandLoader([mockCommandA]);
    const failingLoader = new MockCommandLoader([]);
    const error = new Error('Loader failed');
    vi.spyOn(failingLoader, 'loadCommands').mockRejectedValue(error);

    const service = await CommandService.create(
      [successfulLoader, failingLoader],
      new AbortController().signal,
    );

    const commands = service.getCommands();
    expect(commands).toHaveLength(1);
    expect(commands).toEqual([mockCommandA]);
  });

  it('getCommands should return a readonly array that cannot be mutated', async () => {
    const service = await CommandService.create(
      [new MockCommandLoader([mockCommandA])],
      new AbortController().signal,
    );

    const commands = service.getCommands();

    // Expect it to throw a TypeError at runtime because the array is frozen.
    expect(() => {
      // @ts-expect-error - Testing immutability is intentional here.
      commands.push(mockCommandB);
    }).toThrow();

    // Verify the original array was not mutated.
    expect(service.getCommands()).toHaveLength(1);
  });

  it('should pass the abort signal to all loaders', async () => {
    const controller = new AbortController();
    const signal = controller.signal;

    const loader1 = new MockCommandLoader([mockCommandA]);
    const loader2 = new MockCommandLoader([mockCommandB]);

    await CommandService.create([loader1, loader2], signal);

    expect(loader1.loadCommands).toHaveBeenCalledTimes(1);
    expect(loader1.loadCommands).toHaveBeenCalledWith(signal);
    expect(loader2.loadCommands).toHaveBeenCalledTimes(1);
    expect(loader2.loadCommands).toHaveBeenCalledWith(signal);
  });

  it('should exclude non-user-invocable commands from user command modes', async () => {
    const userCommand = {
      ...createMockCommand('user-command', CommandKind.FILE),
      userInvocable: true,
      modelInvocable: true,
    };
    const modelOnlyCommand = {
      ...createMockCommand('model-only-command', CommandKind.FILE),
      userInvocable: false,
      modelInvocable: true,
    };
    const service = await CommandService.create(
      [new MockCommandLoader([userCommand, modelOnlyCommand])],
      new AbortController().signal,
    );

    expect(service.getCommands().map((cmd) => cmd.name)).toEqual([
      'user-command',
      'model-only-command',
    ]);
    expect(
      service.getCommandsForMode('interactive').map((cmd) => cmd.name),
    ).toEqual(['user-command']);
    expect(service.getModelInvocableCommands().map((cmd) => cmd.name)).toEqual([
      'user-command',
      'model-only-command',
    ]);
  });

  it('should exclude commands that are neither user nor model invocable', async () => {
    const hiddenCommand = {
      ...createMockCommand('hidden-command', CommandKind.FILE),
      userInvocable: false,
      modelInvocable: false,
    };
    const service = await CommandService.create(
      [new MockCommandLoader([hiddenCommand])],
      new AbortController().signal,
    );

    expect(service.getCommands().map((cmd) => cmd.name)).toEqual([
      'hidden-command',
    ]);
    expect(service.getCommandsForMode('interactive')).toEqual([]);
    expect(service.getModelInvocableCommands()).toEqual([]);
  });

  it('should rename extension commands when they conflict', async () => {
    const builtinCommand = createMockCommand('deploy', CommandKind.BUILT_IN);
    const userCommand = createMockCommand('sync', CommandKind.FILE);
    const extensionCommand1 = {
      ...createMockCommand('deploy', CommandKind.FILE),
      extensionName: 'firebase',
      description: '[firebase] Deploy to Firebase',
    };
    const extensionCommand2 = {
      ...createMockCommand('sync', CommandKind.FILE),
      extensionName: 'git-helper',
      description: '[git-helper] Sync with remote',
    };

    const mockLoader1 = new MockCommandLoader([builtinCommand]);
    const mockLoader2 = new MockCommandLoader([
      userCommand,
      extensionCommand1,
      extensionCommand2,
    ]);

    const service = await CommandService.create(
      [mockLoader1, mockLoader2],
      new AbortController().signal,
    );

    const commands = service.getCommands();
    expect(commands).toHaveLength(4);

    // Built-in command keeps original name
    const deployBuiltin = commands.find(
      (cmd) => cmd.name === 'deploy' && !cmd.extensionName,
    );
    expect(deployBuiltin).toBeDefined();
    expect(deployBuiltin?.kind).toBe(CommandKind.BUILT_IN);

    // Extension command conflicting with built-in gets renamed
    const deployExtension = commands.find(
      (cmd) => cmd.name === 'firebase.deploy',
    );
    expect(deployExtension).toBeDefined();
    expect(deployExtension?.extensionName).toBe('firebase');

    // User command keeps original name
    const syncUser = commands.find(
      (cmd) => cmd.name === 'sync' && !cmd.extensionName,
    );
    expect(syncUser).toBeDefined();
    expect(syncUser?.kind).toBe(CommandKind.FILE);

    // Extension command conflicting with user command gets renamed
    const syncExtension = commands.find(
      (cmd) => cmd.name === 'git-helper.sync',
    );
    expect(syncExtension).toBeDefined();
    expect(syncExtension?.extensionName).toBe('git-helper');
  });

  it('should handle user/project command override correctly', async () => {
    const builtinCommand = createMockCommand('help', CommandKind.BUILT_IN);
    const userCommand = createMockCommand('help', CommandKind.FILE);
    const projectCommand = createMockCommand('deploy', CommandKind.FILE);
    const userDeployCommand = createMockCommand('deploy', CommandKind.FILE);

    const mockLoader1 = new MockCommandLoader([builtinCommand]);
    const mockLoader2 = new MockCommandLoader([
      userCommand,
      userDeployCommand,
      projectCommand,
    ]);

    const service = await CommandService.create(
      [mockLoader1, mockLoader2],
      new AbortController().signal,
    );

    const commands = service.getCommands();
    expect(commands).toHaveLength(2);

    // User command overrides built-in
    const helpCommand = commands.find((cmd) => cmd.name === 'help');
    expect(helpCommand).toBeDefined();
    expect(helpCommand?.kind).toBe(CommandKind.FILE);

    // Project command overrides user command (last wins)
    const deployCommand = commands.find((cmd) => cmd.name === 'deploy');
    expect(deployCommand).toBeDefined();
    expect(deployCommand?.kind).toBe(CommandKind.FILE);
  });

  it('should handle secondary conflicts when renaming extension commands', async () => {
    // User has both /deploy and /gcp.deploy commands
    const userCommand1 = createMockCommand('deploy', CommandKind.FILE);
    const userCommand2 = createMockCommand('gcp.deploy', CommandKind.FILE);

    // Extension also has a deploy command that will conflict with user's /deploy
    const extensionCommand = {
      ...createMockCommand('deploy', CommandKind.FILE),
      extensionName: 'gcp',
      description: '[gcp] Deploy to Google Cloud',
    };

    const mockLoader = new MockCommandLoader([
      userCommand1,
      userCommand2,
      extensionCommand,
    ]);

    const service = await CommandService.create(
      [mockLoader],
      new AbortController().signal,
    );

    const commands = service.getCommands();
    expect(commands).toHaveLength(3);

    // Original user command keeps its name
    const deployUser = commands.find(
      (cmd) => cmd.name === 'deploy' && !cmd.extensionName,
    );
    expect(deployUser).toBeDefined();

    // User's dot notation command keeps its name
    const gcpDeployUser = commands.find(
      (cmd) => cmd.name === 'gcp.deploy' && !cmd.extensionName,
    );
    expect(gcpDeployUser).toBeDefined();

    // Extension command gets renamed with suffix due to secondary conflict
    const deployExtension = commands.find(
      (cmd) => cmd.name === 'gcp.deploy1' && cmd.extensionName === 'gcp',
    );
    expect(deployExtension).toBeDefined();
    expect(deployExtension?.description).toBe('[gcp] Deploy to Google Cloud');
  });

  it('should handle multiple secondary conflicts with incrementing suffixes', async () => {
    // User has /deploy, /gcp.deploy, and /gcp.deploy1
    const userCommand1 = createMockCommand('deploy', CommandKind.FILE);
    const userCommand2 = createMockCommand('gcp.deploy', CommandKind.FILE);
    const userCommand3 = createMockCommand('gcp.deploy1', CommandKind.FILE);

    // Extension has a deploy command
    const extensionCommand = {
      ...createMockCommand('deploy', CommandKind.FILE),
      extensionName: 'gcp',
      description: '[gcp] Deploy to Google Cloud',
    };

    const mockLoader = new MockCommandLoader([
      userCommand1,
      userCommand2,
      userCommand3,
      extensionCommand,
    ]);

    const service = await CommandService.create(
      [mockLoader],
      new AbortController().signal,
    );

    const commands = service.getCommands();
    expect(commands).toHaveLength(4);

    // Extension command gets renamed with suffix 2 due to multiple conflicts
    const deployExtension = commands.find(
      (cmd) => cmd.name === 'gcp.deploy2' && cmd.extensionName === 'gcp',
    );
    expect(deployExtension).toBeDefined();
    expect(deployExtension?.description).toBe('[gcp] Deploy to Google Cloud');
  });

  describe('disabled commands (disabledNames parameter)', () => {
    it('should exclude commands whose names are in the disabledNames set', async () => {
      const mockLoader = new MockCommandLoader([
        mockCommandA,
        mockCommandB,
        mockCommandC,
      ]);
      const service = await CommandService.create(
        [mockLoader],
        new AbortController().signal,
        new Set(['command-a']),
      );

      const commands = service.getCommands();
      expect(commands).toHaveLength(2);
      expect(commands.find((c) => c.name === 'command-a')).toBeUndefined();
      expect(commands.find((c) => c.name === 'command-b')).toBeDefined();
      expect(commands.find((c) => c.name === 'command-c')).toBeDefined();
    });

    it('should match disabled names case-insensitively', async () => {
      const mockLoader = new MockCommandLoader([mockCommandA, mockCommandB]);
      const service = await CommandService.create(
        [mockLoader],
        new AbortController().signal,
        new Set(['COMMAND-A', 'Command-B']),
      );

      expect(service.getCommands()).toHaveLength(0);
    });

    it('should match disabled names case-insensitively against a capitalized command name', async () => {
      // The denylist side is normalized, so the command side has to be too: a
      // user file command `/Report.md` is disabled by the entry `report`.
      const service = await serviceFor(
        [createMockCommand('Report', CommandKind.FILE)],
        ['report'],
      );

      expect(service.getCommands()).toHaveLength(0);
    });

    it('should not filter any commands when disabledNames is empty', async () => {
      const mockLoader = new MockCommandLoader([mockCommandA, mockCommandB]);
      const service = await CommandService.create(
        [mockLoader],
        new AbortController().signal,
        new Set(),
      );

      expect(service.getCommands()).toHaveLength(2);
    });

    it('should not filter any commands when disabledNames is undefined', async () => {
      const mockLoader = new MockCommandLoader([mockCommandA, mockCommandB]);
      const service = await CommandService.create(
        [mockLoader],
        new AbortController().signal,
        undefined,
      );

      expect(service.getCommands()).toHaveLength(2);
    });

    it.each([
      { label: 'the legacy bare entry', disabled: ['pdf'] },
      { label: 'the registry entry', disabled: ['rust:pdf'] },
    ])(
      'hides a qualified skill command named by $label',
      async ({ disabled }) => {
        const service = await serviceFor(
          [
            skillCommand('rust:pdf', 'pdf'),
            createMockCommand('help', CommandKind.BUILT_IN),
          ],
          disabled,
        );

        expect(commandNamed(service, 'rust:pdf')).toBeUndefined();
        expect(commandNamed(service, 'help')).toBeDefined();
      },
    );

    it('hides a command that only an alias in the denylist names', async () => {
      // The gate matches through `commandRestrictionNames`, which appends every
      // normalized `altNames` entry. `/compress` really does carry `summarize`
      // (compressCommand.ts:27), so `slashCommands.disabled: ['summarize']` has
      // to remove the command — a gate that read only `name`, or only the first
      // alias, or skipped the trim/lowercase, would leave the alias live at
      // dispatch while the settings entry claims the command is off.
      const service = await serviceFor(
        [
          {
            ...createMockCommand('compress', CommandKind.BUILT_IN),
            altNames: ['COMP', ' summarize'],
          },
          createMockCommand('help', CommandKind.BUILT_IN),
        ],
        ['summarize'],
      );

      expect(commandNamed(service, 'compress')).toBeUndefined();
      expect(commandNamed(service, 'help')).toBeDefined();
    });

    it('still hides every other command a bare entry names', async () => {
      // `slashCommands.disabled` is a global denylist on main: an entry already
      // hides a built-in of that name (`getDisabledSlashCommands`, config.ts:6121).
      // This change adds the authored-spelling match for skill commands and must
      // not narrow the global one, so the bare entry bites both.
      const service = await serviceFor(
        [
          createMockCommand('pdf', CommandKind.BUILT_IN),
          skillCommand('rust:pdf', 'pdf'),
        ],
        ['pdf'],
      );

      expect(commandNamed(service, 'pdf')).toBeUndefined();
      expect(commandNamed(service, 'rust:pdf')).toBeUndefined();
    });
  });

  describe('shadowing diagnostic', () => {
    beforeEach(() => {
      mocks.logger.warn.mockClear();
    });

    it('names the replacement when a later command shadows an earlier one', async () => {
      // The outcome is unchanged — FileCommandLoader loads last and still wins.
      // The log only names what happened to a command the user can no longer run.
      const service = await serviceFor([
        skillCommand('pdf', 'pdf'),
        createMockCommand('pdf', CommandKind.FILE),
      ]);

      expect(commandNamed(service, 'pdf')?.kind).toBe(CommandKind.FILE);
      expect(mocks.logger.warn).toHaveBeenCalledWith(
        'Slash command "/pdf" from skill command "pdf" is replaced by ' +
          'file command "pdf"',
      );
    });

    it('does not warn when nothing is replaced', async () => {
      await serviceFor([
        createMockCommand('alpha', CommandKind.BUILT_IN),
        createMockCommand('beta', CommandKind.FILE),
      ]);

      expect(mocks.logger.warn).not.toHaveBeenCalled();
    });
  });
});
