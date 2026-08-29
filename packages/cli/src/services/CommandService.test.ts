/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CommandService } from './CommandService.js';
import { type ICommandLoader } from './types.js';
import { CommandKind, type SlashCommand } from '../ui/commands/types.js';

const createMockCommand = (name: string, kind: CommandKind): SlashCommand => ({
  name,
  description: `Description for ${name}`,
  kind,
  action: vi.fn(),
});

const mockCommandA = createMockCommand('command-a', CommandKind.BUILT_IN);
const mockCommandB = createMockCommand('command-b', CommandKind.BUILT_IN);
const mockCommandC = createMockCommand('command-c', CommandKind.FILE);
const mockCommandB_Override = createMockCommand('command-b', CommandKind.FILE);

class MockCommandLoader implements ICommandLoader {
  private commandsToLoad: SlashCommand[];

  constructor(
    commandsToLoad: SlashCommand[],
    private readonly reserved: ReadonlySet<string> = new Set(),
  ) {
    this.commandsToLoad = commandsToLoad;
  }

  loadCommands = vi.fn(
    async (): Promise<SlashCommand[]> => Promise.resolve(this.commandsToLoad),
  );

  reservedNames = vi.fn((): ReadonlySet<string> => this.reserved);
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

  it('keeps namespaced extension-skill keys and numeric-suffixes collisions', async () => {
    const userCommand = createMockCommand('demo:chat', CommandKind.FILE);
    const collidingSkill = {
      ...createMockCommand('demo:chat', CommandKind.SKILL),
      extensionName: 'demo',
      modelInvocable: true,
    };
    const cleanSkill = {
      ...createMockCommand('other:tool', CommandKind.SKILL),
      extensionName: 'other',
      modelInvocable: true,
    };

    const service = await CommandService.create(
      [new MockCommandLoader([userCommand, collidingSkill, cleanSkill])],
      new AbortController().signal,
    );

    const commands = service.getCommands();
    expect(commands).toHaveLength(3);

    // The user command keeps the contested name.
    const userOwner = commands.find((cmd) => cmd.name === 'demo:chat');
    expect(userOwner?.kind).toBe(CommandKind.FILE);
    expect(userOwner?.extensionName).toBeUndefined();

    // The colliding skill is suffixed, not re-prefixed (`demo.demo:chat`
    // would be wrong).
    const renamedSkill = commands.find((cmd) => cmd.extensionName === 'demo');
    expect(renamedSkill?.name).toBe('demo:chat1');
    expect(renamedSkill?.kind).toBe(CommandKind.SKILL);

    // A non-colliding namespaced key passes through untouched.
    const cleanResult = commands.find((cmd) => cmd.name === 'other:tool');
    expect(cleanResult?.kind).toBe(CommandKind.SKILL);
    expect(cleanResult?.extensionName).toBe('other');
  });

  it('numeric-suffixes a colliding skill under the production loader order', async () => {
    // Production call sites hand file commands to CommandService before
    // skills: SkillCommandLoader runs after FileCommandLoader, so the
    // colliding skill arrives last and must take the numeric suffix.
    const userCommand = createMockCommand('demo:chat', CommandKind.FILE);
    const collidingSkill = {
      ...createMockCommand('demo:chat', CommandKind.SKILL),
      extensionName: 'demo',
      modelInvocable: true,
    };

    const service = await CommandService.create(
      [
        new MockCommandLoader([userCommand]),
        new MockCommandLoader([collidingSkill]),
      ],
      new AbortController().signal,
    );

    const commands = service.getCommands();
    expect(commands).toHaveLength(2);

    // The earlier file command keeps the contested name.
    const userOwner = commands.find((cmd) => cmd.name === 'demo:chat');
    expect(userOwner?.kind).toBe(CommandKind.FILE);
    expect(userOwner?.extensionName).toBeUndefined();

    // The skill survives on the suffixed key instead of being dropped.
    const renamedSkill = commands.find((cmd) => cmd.extensionName === 'demo');
    expect(renamedSkill?.name).toBe('demo:chat1');
    expect(renamedSkill?.kind).toBe(CommandKind.SKILL);
    expect(service.getModelInvocableCommands().map((c) => c.name)).toEqual([
      'demo:chat1',
    ]);
  });

  it('skips an occupied suffix and takes the next free number', async () => {
    // demo/chat.toml claims demo:chat and demo/chat1.toml claims
    // demo:chat1; the colliding skill probes upward past both entries.
    const chatCommand = createMockCommand('demo:chat', CommandKind.FILE);
    const chatOneCommand = createMockCommand('demo:chat1', CommandKind.FILE);
    const collidingSkill = {
      ...createMockCommand('demo:chat', CommandKind.SKILL),
      extensionName: 'demo',
      modelInvocable: true,
    };

    const service = await CommandService.create(
      [
        new MockCommandLoader([chatCommand, chatOneCommand]),
        new MockCommandLoader([collidingSkill]),
      ],
      new AbortController().signal,
    );

    const commands = service.getCommands();
    expect(commands).toHaveLength(3);

    expect(commands.find((cmd) => cmd.name === 'demo:chat')?.kind).toBe(
      CommandKind.FILE,
    );
    expect(commands.find((cmd) => cmd.name === 'demo:chat1')?.kind).toBe(
      CommandKind.FILE,
    );

    // The while loop walks past the taken suffix; always-1 would land on
    // demo:chat1 and overwrite the second file command.
    const renamedSkill = commands.find((cmd) => cmd.extensionName === 'demo');
    expect(renamedSkill?.name).toBe('demo:chat2');
    expect(service.getModelInvocableCommands().map((c) => c.name)).toEqual([
      'demo:chat2',
    ]);
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

      const commands = service.getCommands();
      expect(commands).toHaveLength(0);
    });

    it('keeps a legacy bare disablement matching a collision-qualified skill', async () => {
      const fileCommand = createMockCommand('demo:pdf', CommandKind.FILE);
      const qualifiedSkill = {
        ...createMockCommand('docs:pdf', CommandKind.SKILL),
        extensionName: 'docs',
        modelInvocable: true,
      };
      const service = await CommandService.create(
        [new MockCommandLoader([fileCommand, qualifiedSkill])],
        new AbortController().signal,
        new Set(['pdf']),
      );

      const commands = service.getCommands();
      expect(commands).toHaveLength(1);
      expect(commands[0]?.name).toBe('demo:pdf');
      expect(service.getModelInvocableCommands()).toHaveLength(0);
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
  });

  // ── Truth matrix: claimFreeName collision handling ──
  // Every name source × collision state × entry spelling × operation.
  describe('claimFreeName truth matrix', () => {
    type MatrixCommand = {
      name: string;
      kind:
        | typeof CommandKind.FILE
        | typeof CommandKind.SKILL
        | typeof CommandKind.BUILT_IN;
      extensionName?: string;
    };
    it.each<{
      commands: MatrixCommand[];
      expectedName: string;
      expectedKind: MatrixCommand['kind'];
      expectedExtension: string;
      label: string;
    }>([
      // ── Skill collision: keeps qualified name, takes numeric suffix ──
      {
        commands: [
          { name: 'demo:chat', kind: CommandKind.FILE },
          { name: 'demo:chat', kind: CommandKind.SKILL, extensionName: 'demo' },
        ],
        expectedName: 'demo:chat1',
        expectedKind: CommandKind.SKILL,
        expectedExtension: 'demo',
        label:
          'skill keeps qualified key, takes suffix on collision with file command',
      },
      {
        commands: [
          { name: 'demo:chat', kind: CommandKind.FILE },
          { name: 'demo:chat1', kind: CommandKind.FILE },
          { name: 'demo:chat', kind: CommandKind.SKILL, extensionName: 'demo' },
        ],
        expectedName: 'demo:chat2',
        expectedKind: CommandKind.SKILL,
        expectedExtension: 'demo',
        label: 'skill skips occupied suffix, takes next free number',
      },
      {
        commands: [
          { name: 'other:tool', kind: CommandKind.FILE },
          {
            name: 'other:tool',
            kind: CommandKind.SKILL,
            extensionName: 'other',
          },
        ],
        expectedName: 'other:tool1',
        expectedKind: CommandKind.SKILL,
        expectedExtension: 'other',
        label:
          'non-colliding namespaced key passes through; colliding takes suffix',
      },

      // ── Non-skill extension command: gets dot notation ──
      {
        commands: [
          { name: 'deploy', kind: CommandKind.BUILT_IN },
          { name: 'deploy', kind: CommandKind.FILE, extensionName: 'firebase' },
        ],
        expectedName: 'firebase.deploy',
        expectedKind: CommandKind.FILE,
        expectedExtension: 'firebase',
        label: 'extension command gets dot notation on collision with built-in',
      },
      {
        commands: [
          { name: 'deploy', kind: CommandKind.FILE },
          { name: 'deploy', kind: CommandKind.FILE, extensionName: 'gcp' },
        ],
        expectedName: 'gcp.deploy',
        expectedKind: CommandKind.FILE,
        expectedExtension: 'gcp',
        label:
          'extension command gets dot notation on collision with user command',
      },
      {
        commands: [
          { name: 'deploy', kind: CommandKind.FILE },
          { name: 'gcp.deploy', kind: CommandKind.FILE },
          { name: 'deploy', kind: CommandKind.FILE, extensionName: 'gcp' },
        ],
        expectedName: 'gcp.deploy1',
        expectedKind: CommandKind.FILE,
        expectedExtension: 'gcp',
        label:
          'extension command gets dot notation with suffix on secondary conflict',
      },

      // ── Multiple collisions with incrementing suffixes ──
      {
        commands: [
          { name: 'deploy', kind: CommandKind.FILE },
          { name: 'gcp.deploy', kind: CommandKind.FILE },
          { name: 'gcp.deploy1', kind: CommandKind.FILE },
          { name: 'deploy', kind: CommandKind.FILE, extensionName: 'gcp' },
        ],
        expectedName: 'gcp.deploy2',
        expectedKind: CommandKind.FILE,
        expectedExtension: 'gcp',
        label:
          'extension command takes suffix 2 past multiple occupied dot-notation names',
      },

      // ── No collision: name passes through unchanged ──
      {
        commands: [
          {
            name: 'other:tool',
            kind: CommandKind.SKILL,
            extensionName: 'other',
          },
        ],
        expectedName: 'other:tool',
        expectedKind: CommandKind.SKILL,
        expectedExtension: 'other',
        label: 'non-colliding skill name passes through untouched',
      },
    ])(
      'produces $expectedName for $label',
      async ({ commands, expectedName, expectedKind, expectedExtension }) => {
        const mockCommands = commands.map((c) =>
          createMockCommand(c.name, c.kind),
        );
        const cmdsWithExt = commands.map((c, i) => ({
          ...mockCommands[i],
          extensionName: c.extensionName,
        }));

        const service = await CommandService.create(
          [new MockCommandLoader(cmdsWithExt)],
          new AbortController().signal,
        );

        const matching = service
          .getCommands()
          .find(
            (cmd) =>
              cmd.extensionName === expectedExtension &&
              cmd.kind === expectedKind,
          );
        expect(matching?.name).toBe(expectedName);
        expect(matching?.kind).toBe(expectedKind);
      },
    );

    it.each<{
      commands: MatrixCommand[];
      disabledNames: ReadonlySet<string>;
      expectedCommandName: string;
      expectedCount: number;
      label: string;
    }>([
      // ── disabledNames filtering with dual-spelling ──
      {
        commands: [
          { name: 'demo:pdf', kind: CommandKind.FILE },
          { name: 'docs:pdf', kind: CommandKind.SKILL, extensionName: 'docs' },
        ],
        disabledNames: new Set(['pdf']),
        expectedCommandName: 'demo:pdf',
        expectedCount: 1,
        label: 'legacy bare disablement matches collision-qualified skill',
      },
      {
        commands: [
          { name: 'demo:pdf', kind: CommandKind.FILE },
          { name: 'docs:pdf', kind: CommandKind.SKILL, extensionName: 'docs' },
        ],
        disabledNames: new Set(['docs:pdf']),
        expectedCommandName: 'demo:pdf',
        expectedCount: 1,
        label: 'qualified disablement matches collision-qualified skill',
      },
      {
        commands: [
          { name: 'demo:pdf', kind: CommandKind.FILE },
          { name: 'docs:pdf', kind: CommandKind.SKILL, extensionName: 'docs' },
        ],
        disabledNames: new Set(['pdf', 'docs:pdf']),
        expectedCommandName: 'demo:pdf',
        expectedCount: 1,
        label:
          'both spellings remove the qualified skill; the unrelated file command survives',
      },
    ])(
      'disabledNames $label',
      async ({
        commands,
        disabledNames,
        expectedCommandName,
        expectedCount,
      }) => {
        const mockCommands = commands.map((c) =>
          createMockCommand(c.name, c.kind),
        );
        const cmdsWithExt = commands.map((c, i) => ({
          ...mockCommands[i],
          extensionName: c.extensionName,
        }));

        const service = await CommandService.create(
          [new MockCommandLoader(cmdsWithExt)],
          new AbortController().signal,
          disabledNames,
        );

        if (expectedCount === 0) {
          expect(service.getCommands()).toHaveLength(0);
        } else {
          expect(service.getCommands()).toHaveLength(expectedCount);
          expect(service.getCommands()[0]?.name).toBe(expectedCommandName);
        }
      },
    );
  });

  // ── Extensionless collision: neither command can be renamed ──
  describe('extensionless name precedence', () => {
    it('keeps the file command when a same-named local skill is aggregated first (#9408 R1-7)', async () => {
      // This is the order buildCommandLoaders hands production: local skills,
      // then saved workflows, then file commands. Neither `deploy` carries an
      // extensionName, so the collision rename cannot fire for either one and
      // the later writer keeps the name. The user's own command must win, the
      // way it did before #9408 moved skills to the end of the list.
      const localSkill = createMockCommand('deploy', CommandKind.SKILL);
      const fileCommand = createMockCommand('deploy', CommandKind.FILE);

      const service = await CommandService.create(
        [
          new MockCommandLoader([localSkill]),
          new MockCommandLoader([fileCommand]),
        ],
        new AbortController().signal,
      );

      const winners = service
        .getCommands()
        .filter((cmd) => cmd.name === 'deploy');
      expect(winners).toHaveLength(1);
      expect(winners[0]?.kind).toBe(CommandKind.FILE);
    });

    it('suffixes an extension skill that collides with an earlier file command (#9408 R1-7)', async () => {
      // The counterpart, and the reason extension skills still load last: they
      // can be renamed, so neither side is silently lost.
      const fileCommand = createMockCommand('demo:chat', CommandKind.FILE);
      const extensionSkill = {
        ...createMockCommand('demo:chat', CommandKind.SKILL),
        extensionName: 'demo',
      };

      const service = await CommandService.create(
        [
          new MockCommandLoader([fileCommand]),
          new MockCommandLoader([extensionSkill]),
        ],
        new AbortController().signal,
      );

      const names = service
        .getCommands()
        .filter((cmd) => cmd.name.startsWith('demo:chat'))
        .map((cmd) => cmd.name);
      expect(names).toContain('demo:chat');
      expect(names).toContain('demo:chat1');
    });
  });

  describe('denylist against a suffix-renamed skill', () => {
    it('removes the suffixed skill when the entry is the pre-rename bare name (#9408 R3-2)', async () => {
      // A file command claims `demo:chat` through the existing `:`-joined path
      // naming, so the colliding extension skill is suffixed to `demo:chat1`
      // before the denylist runs. The operator's entry is the bare spelling
      // this matcher exists to keep working, and it must still reach the skill.
      const fileCommand = createMockCommand('demo:chat', CommandKind.FILE);
      const extensionSkill = {
        ...createMockCommand('demo:chat', CommandKind.SKILL),
        extensionName: 'demo',
        skillDetail: {
          name: 'demo:chat',
          level: 'extension',
          extensionName: 'demo',
        },
      };

      const service = await CommandService.create(
        [
          new MockCommandLoader([fileCommand]),
          new MockCommandLoader([extensionSkill]),
        ],
        new AbortController().signal,
        new Set(['chat']),
      );

      expect(
        service.getCommands().filter((cmd) => cmd.kind === CommandKind.SKILL),
      ).toHaveLength(0);
    });
  });

  describe('collision rename against a disabled name (#9408 R3-19)', () => {
    it('walks past a name the skill loader hid behind skills.disabled', async () => {
      // `demo/chat.toml` claims `demo:chat`. The extension ships `chat` and
      // `chat1`, and `skills.disabled` hides `demo:chat1`, so the loader hands
      // over only `demo:chat`: the disabled name is absent from the aggregate,
      // and `skills.disabled` is never re-checked after the rename. The probe
      // must still treat it as taken by the skill that was withheld.
      const fileCommand = createMockCommand('demo:chat', CommandKind.FILE);
      const visibleSkill = {
        ...createMockCommand('demo:chat', CommandKind.SKILL),
        extensionName: 'demo',
        modelInvocable: true,
        skillDetail: {
          name: 'demo:chat',
          level: 'extension',
          extensionName: 'demo',
        },
      };

      const service = await CommandService.create(
        [
          new MockCommandLoader([fileCommand]),
          new MockCommandLoader(
            [visibleSkill],
            new Set(['demo:chat1', 'chat1']),
          ),
        ],
        new AbortController().signal,
      );

      const commands = service.getCommands();

      // The user's disabled name is not registered at all...
      expect(commands.map((cmd) => cmd.name)).not.toContain('demo:chat1');
      // ...and the skill they never disabled survives one step further along
      // the suffix list instead of being dropped for it.
      expect(commands.find((cmd) => cmd.extensionName === 'demo')?.name).toBe(
        'demo:chat2',
      );
      expect(
        service.getModelInvocableCommands().map((cmd) => cmd.name),
      ).toEqual(['demo:chat2']);
    });

    it('walks past an entry in the global denylist that no command holds', async () => {
      // `slashCommands.disabled: ['demo:chat1']` with no command of that name
      // loaded. Unreserved, the probe lands on it and the post-rename filter
      // then deletes the skill for a name it never held.
      const fileCommand = createMockCommand('demo:chat', CommandKind.FILE);
      const visibleSkill = {
        ...createMockCommand('demo:chat', CommandKind.SKILL),
        extensionName: 'demo',
        modelInvocable: true,
        skillDetail: {
          name: 'demo:chat',
          level: 'extension',
          extensionName: 'demo',
        },
      };

      const service = await CommandService.create(
        [new MockCommandLoader([fileCommand, visibleSkill])],
        new AbortController().signal,
        new Set(['demo:chat1']),
      );

      expect(service.getCommands().map((cmd) => cmd.name)).toEqual([
        'demo:chat',
        'demo:chat2',
      ]);
    });
  });
});
