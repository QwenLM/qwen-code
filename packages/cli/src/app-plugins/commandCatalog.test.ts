/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendAppPluginSlashCommands } from './commands.js';
import { createAppPluginFixture } from '../test-utils/appPluginFixture.js';
const { registerAppPlugins, getAppPluginRegistry } = createAppPluginFixture(true);
import type {
  AppPlugin,
} from './types.js';
import { CommandKind, type SlashCommand } from '../ui/commands/types.js';
import { CommandService } from '../services/CommandService.js';
import { parseSlashCommand } from '../utils/commands.js';

vi.mock('@qwen-code/core', async () => ({
  ...(await import('../../../core/src/builtin-plugins/registry.js')),
  registerBuiltinPlugins: vi.fn(),
  areBuiltinPluginsReady: () => true,
  initializeBuiltinPlugins: vi.fn(),
  disposeBuiltinPlugins: vi.fn(),
  coreEvents: {
    emitDynamicCommandsChanged: vi.fn(),
    emitSlashCommandConflicts: vi.fn(),
  },
  runLogger: { warn: vi.fn(), debug: vi.fn() },
}));

function definition(
  name: string,
  overrides: Partial<SlashCommand> = {},
): SlashCommand {
  return {
    name,
    description: name,
    kind: CommandKind.DYNAMIC,
    loadedFrom: `id:${name}`,
    action: async () => {},
    ...overrides,
  };
}

function plugin(
  id: string,
  definitions: SlashCommand[],
): AppPlugin {
  return {
    apiVersion: 1,
    id,
    initialize: async () => {},
    dispose: async () => {},
    getSlashCommands: () => definitions,
  };
}

function regular(
  name: string,
  kind = CommandKind.BUILT_IN,
  overrides: Partial<SlashCommand> = {},
): SlashCommand {
  return { name, description: name, kind, ...overrides };
}

function catalog(
  regularCommands: SlashCommand[] = [],
  signal = new AbortController().signal,
) {
  return CommandService.create(
    [
      {
        loadCommands: async () =>
          regularCommands,
      },
    ],
    signal,
    getAppPluginRegistry(),
  );
}

afterEach(() => {
  registerAppPlugins([]);
  vi.clearAllMocks();
});

describe('app plugin dynamic command catalog', () => {
  it('reads updated fallback visibility from plugin state on the next catalog refresh', async () => {
    let hasActivity = true;
    const owner: AppPlugin = {
      ...plugin('owner', []),
      getSlashCommands: () => [
        definition('reward'),
        definition('status', {
          kind: CommandKind.BUILT_IN,
          fallback: true,
          hidden: hasActivity,
        }),
      ],
    };
    registerAppPlugins([owner]);
    const original = (await catalog([regular('reward')]))
      .getCommands()
      .find((command) => command.name === 'status')!;
    const copy = { ...original };
    hasActivity = false;
    expect(
      (await catalog([regular('reward')]))
        .getCommands()
        .find((command) => command.name === 'status')?.hidden,
    ).toBe(false);
    expect(original.hidden).toBe(true);
    expect(copy.hidden).toBe(true);
  });

  it.each([
    regular('reward'),
    regular('help', CommandKind.BUILT_IN, { altNames: ['reward'] }),
    regular('help', CommandKind.SKILL, { displayName: 'reward' }),
  ])(
    'does not register a fallback over an occupied route: $name',
    async (existing) => {
      const fallback = definition('reward', {
        kind: CommandKind.BUILT_IN,
        fallback: true,
      });
      const owner = plugin('owner', [fallback]);
      registerAppPlugins([owner]);
      expect((await catalog([existing])).getCommands()).toEqual([existing]);
    },
  );

  it('lets a real dynamic command win even if its fallback is declared first', async () => {
    const fallback = definition('reward', { kind: CommandKind.BUILT_IN, fallback: true });
    const dynamic = definition('reward');
    const owner = plugin('owner', [fallback, dynamic]);
    registerAppPlugins([owner]);
    const commands = (await catalog()).getCommands();
    expect(commands).toHaveLength(1);
    expect(commands[0].kind).toBe(CommandKind.DYNAMIC);
  });

  it('adds, removes and restores a fallback as the real catalog changes', async () => {
    const fallback = definition('reward', { kind: CommandKind.BUILT_IN, fallback: true });
    const owner = plugin('owner', [fallback]);
    registerAppPlugins([owner]);
    expect((await catalog()).getCommands()[0]).toMatchObject({
      name: 'reward',
      fallback: true,
    });
    expect(
      (await catalog([regular('reward')])).getCommands()[0].fallback,
    ).toBeUndefined();
    expect((await catalog()).getCommands()[0]).toMatchObject({
      name: 'reward',
      fallback: true,
    });
  });

  it('keeps only the first of two same-named fallbacks', async () => {
    const first = definition('reward', {
      kind: CommandKind.BUILT_IN,
      fallback: true,
      description: 'first fallback',
    });
    const second = definition('reward', { kind: CommandKind.BUILT_IN, fallback: true });
    const a = plugin('a', [first]);
    const b = plugin('b', [second]);
    registerAppPlugins([a, b]);
    expect(
      (await catalog()).getCommands().map((command) => command.description),
    ).toEqual(['first fallback']);
  });

  it('rejects the whole fallback when one of its aliases is occupied', async () => {
    const fallback = definition('reward', {
      kind: CommandKind.BUILT_IN,
      fallback: true,
      altNames: ['help'],
    });
    const owner = plugin('owner', [fallback]);
    registerAppPlugins([owner]);
    expect(
      (await catalog([regular('help')]))
        .getCommands()
        .map((command) => command.name),
    ).toEqual(['help']);
  });

  it('checks supplemental commands in the recovery catalog too', () => {
    const blocked = definition('help', { kind: CommandKind.BUILT_IN, fallback: true });
    const available = definition('reward', {
      kind: CommandKind.BUILT_IN,
      fallback: true,
    });
    const owner = plugin('owner', [blocked, available]);
    registerAppPlugins([owner]);
    const commands = CommandService.resolveFallbackCommands(
      [regular('help')],
      new AbortController().signal,
      getAppPluginRegistry(),
    );
    expect(commands.map((command) => command.name)).toEqual(['help', 'reward']);
  });

  it('does not admit an invalid dynamic fallback name', async () => {
    const fallback = definition('bad/name', { fallback: true });
    const owner = plugin('owner', [fallback]);
    registerAppPlugins([owner]);
    expect(
      (await catalog([regular('help')]))
        .getCommands()
        .map((command) => command.name),
    ).toEqual(['help']);
  });

  it('excludes dynamic commands from the recovery catalog', async () => {
    const declarations = [
      definition('help'),
      definition('bad/name'),
      definition('reward'),
    ];
    const builtin = definition('feedback', { kind: CommandKind.BUILT_IN });
    const owner = plugin('owner', [...declarations, builtin]);
    registerAppPlugins([owner]);
    const loaded = [regular('help')];
    const fallback = CommandService.resolveFallbackCommands(
      loaded,
      new AbortController().signal,
      getAppPluginRegistry(),
    );
    expect(fallback.map((command) => command.name)).toEqual([
      'help',
      'feedback',
    ]);
    expect(
      (await catalog([regular('help')]))
        .getCommands()
        .map((command) => command.name),
    ).toEqual(['help', 'feedback', 'reward']);
  });

  it('rejects recovery catalog loading after cancellation', () => {
    const owner = plugin('owner', [definition('reward')]);
    registerAppPlugins([owner]);
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      CommandService.resolveFallbackCommands(
        [],
        controller.signal,
      ),
    ).toThrow();
  });

  it.each([
    ['2_reward', true],
    ['a'.repeat(64), true],
    ['a'.repeat(65), false],
    ['Bad', false],
    ['_reward', false],
    ['bad/name', false],
    ['', false],
  ] as const)(
    'validates %s without losing the rest of the catalog',
    async (name, accepted) => {
      const command = definition(name);
      const owner = plugin('owner', [command, definition('valid')]);
      registerAppPlugins([owner]);
      const service = await catalog([regular('help')]);
      expect(service.getCommands().map((item) => item.name)).toEqual(
        accepted ? ['help', name, 'valid'] : ['help', 'valid'],
      );
    },
  );

  it.each([
    { name: 'reward', regulars: [regular('reward')] },
    {
      name: 'reward',
      regulars: [
        regular('help', CommandKind.BUILT_IN, { altNames: ['reward'] }),
      ],
    },
    {
      name: 'reward',
      regulars: [regular('help', CommandKind.SKILL, { displayName: 'reward' })],
    },
    {
      name: 'help1',
      regulars: [regular('help'), regular('help', CommandKind.SKILL)],
    },
  ])(
    'rejects occupied names, including aliases and resolver-generated names: $name',
    async ({ name, regulars }) => {
      const command = definition(name);
      const owner = plugin('owner', [command]);
      registerAppPlugins([owner]);
      const service = await catalog(regulars);
      expect(
        service
          .getCommands()
          .some((item) => item.loadedFrom === command.loadedFrom),
      ).toBe(false);
    },
  );

  it('reserves dynamic aliases across plugins', async () => {
    const first = definition('first', {
      altNames: ['reward'],
      loadedFrom: 'same-id',
    });
    const second = definition('reward', { loadedFrom: 'same-id' });
    const a = plugin('a', [first]);
    const b = plugin('b', [second]);
    registerAppPlugins([a, b]);
    const service = await catalog();
    expect(service.getCommands().map((command) => command.name)).toEqual([
      'first',
    ]);
    expect(service.getCommands()[0].pluginName).toBe('a');
  });

  it('rejects an invalid alias as one whole dynamic command', async () => {
    const command = definition('reward', { altNames: ['Bad'] });
    const owner = plugin('owner', [command]);
    registerAppPlugins([owner]);
    expect((await catalog()).getCommands()).toEqual([]);
  });

  it('keeps builtin ownership even when a colliding dynamic declaration comes first', async () => {
    const dynamic = definition('reward');
    const builtin = definition('reward', { kind: CommandKind.BUILT_IN });
    const owner = plugin('owner', [dynamic, builtin]);
    registerAppPlugins([owner]);
    const service = await catalog();
    expect(service.getCommands()).toHaveLength(1);
    expect(service.getCommands()[0].kind).toBe(CommandKind.BUILT_IN);
  });

  it.each(['2_reward', 'bad/name'])(
    'preserves strict validation for ordinary app plugin commands: %s',
    (name) => {
      registerAppPlugins([
        plugin('owner', [definition(name, { kind: CommandKind.BUILT_IN })]),
      ]);
      expect(() => appendAppPluginSlashCommands([regular('help')], getAppPluginRegistry())).toThrow(
        'Invalid or duplicate app plugin slash command',
      );
    },
  );

  it('accepts a dynamic command after a conflicting command disappears', async () => {
    registerAppPlugins([plugin('owner', [definition('reward')])]);
    expect((await catalog([regular('reward')])).getCommands()[0].kind).toBe(
      CommandKind.BUILT_IN,
    );
    expect((await catalog()).getCommands()[0].kind).toBe(CommandKind.DYNAMIC);
  });

  it('rejects cancelled catalog loads', async () => {
    registerAppPlugins([plugin('owner', [definition('reward')])]);
    const controller = new AbortController();
    controller.abort();
    await expect(catalog([], controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('does not apply the new rejection policy to legacy QCS dynamic commands', async () => {
    const qcs = regular('reward', CommandKind.DYNAMIC, {
      source: 'config-service',
    });
    const service = await catalog([regular('reward'), qcs]);
    expect(service.getCommands().map((command) => command.name)).toEqual([
      'reward',
      'dynamic.reward',
    ]);
  });

  it('applies dynamic registration rules to plugin declarations', async () => {
    const owner = plugin('owner', [definition('help'), definition('2_reward')]);
    registerAppPlugins([owner]);
    expect(
      (await catalog([regular('help')]))
        .getCommands()
        .map((command) => command.name),
    ).toEqual(['help', '2_reward']);
  });

  it('rejects plugin dynamic conflicts without requiring a source', async () => {
    const command = regular('reward', CommandKind.DYNAMIC, {
      pluginName: 'example',
    });
    expect(
      (await catalog([regular('reward'), command]))
        .getCommands()
        .map((item) => item.name),
    ).toEqual(['reward']);
  });

  it('does not treat a source label as plugin ownership', async () => {
    const command = regular('reward', CommandKind.DYNAMIC, {
      source: 'extension-source',
    });
    const service = await catalog([regular('reward'), command]);
    expect(service.getCommands().map((item) => item.name)).toEqual([
      'reward',
      'dynamic.reward',
    ]);
  });
});


describe('live app plugin declarations', () => {
  it('adds, updates and withdraws commands without rerunning host loaders', async () => {
    const declarations: SlashCommand[] = [];
    registerAppPlugins([plugin('live', declarations)]);
    const loadCommands = vi.fn(async () => [regular('help')]);
    const service = await CommandService.create([{ loadCommands }], new AbortController().signal, getAppPluginRegistry());
    expect(service.getCommands().map((c) => c.name)).toEqual(['help']);
    declarations.push(definition('bonus', { description: 'First' }));
    expect(service.getCommands().find((c) => c.name === 'bonus')?.description).toBe('First');
    declarations[0] = definition('gift', { description: 'Updated' });
    expect(service.getCommands().map((c) => c.name)).toEqual(['help', 'gift']);
    declarations.length = 0;
    expect(service.getCommands().map((c) => c.name)).toEqual(['help']);
    expect(loadCommands).toHaveBeenCalledOnce();
  });

  it.each([CommandKind.BUILT_IN] as const)(
    'uses the plugin builtin (%s) and restores the original when absent',
    async (kind) => {
      const original = regular('usage');
      const status = regular('status');
      const declarations: SlashCommand[] = [];
      registerAppPlugins([plugin('product', declarations)]);
      const service = await catalog([original, status]);
      const snapshot = service.getCommands();
      expect(parseSlashCommand('/usage', snapshot).commandToExecute).toEqual(original);
      declarations.push(definition('usage', { kind, description: 'Product usage' }));
      expect(service.getCommands().filter((c) => c.name === 'usage')).toHaveLength(1);
      expect(parseSlashCommand('/usage', snapshot).commandToExecute?.description).toBe('Product usage');
      expect(service.getCommands().find((c) => c.name === 'status')).toEqual(status);
      declarations.length = 0;
      expect(parseSlashCommand('/usage', snapshot).commandToExecute).toEqual(original);
    },
  );

  it('rejects a same-named dynamic command and keeps the host builtin', async () => {
    registerAppPlugins([plugin('dynamic', [definition('help')])]);
    const original = regular('help');
    const service = await catalog([original]);
    expect(service.getCommands()).toEqual([original]);
  });

  it('rejects same-named commands from two app plugins', async () => {
    registerAppPlugins(['first', 'second'].map((id) => plugin(id, [definition('usage', { kind: CommandKind.BUILT_IN })])));
    await expect(catalog([regular('usage')])).rejects.toThrow('Invalid or duplicate app plugin slash command');
  });
});


it('resolves new and removed plugin commands through an existing catalog snapshot', async () => {
  const declarations: SlashCommand[] = [];
  registerAppPlugins([plugin('live-parser', declarations)]);
  const service = await catalog([regular('help')]);
  const snapshot = service.getCommands();
  expect(parseSlashCommand('/bonus', snapshot).commandToExecute).toBeUndefined();
  declarations.push(definition('bonus'));
  expect(parseSlashCommand('/bonus', snapshot).commandToExecute?.name).toBe('bonus');
  declarations.length = 0;
  expect(parseSlashCommand('/bonus', snapshot).commandToExecute).toBeUndefined();
});

it('does not inject plugin commands into plain command arrays or subcommands', async () => {
  registerAppPlugins([plugin('live-parser', [definition('bonus')])]);
  const local = [regular('local')];
  expect(parseSlashCommand('/bonus', local).commandToExecute).toBeUndefined();
  expect(CommandService.readCurrentCommands(local)).toBe(local);
  const service = await catalog([regular('parent', CommandKind.BUILT_IN, { subCommands: local })]);
  const parsed = parseSlashCommand('/parent bonus', service.getCommands());
  expect(parsed.commandToExecute?.name).toBe('parent');
  expect(parsed.args).toBe('bonus');
});

it('keeps host catalogs isolated when resolving live plugin declarations', async () => {
  registerAppPlugins([plugin('live-parser', [definition('bonus')])]);
  const first = (await catalog([regular('first')])).getCommands();
  const second = (await catalog([regular('second')])).getCommands();
  expect(parseSlashCommand('/first', first).commandToExecute?.name).toBe('first');
  expect(parseSlashCommand('/first', second).commandToExecute).toBeUndefined();
});

it('keeps plugin declarations isolated across two application registries', async () => {
  const first = createAppPluginFixture(true);
  const second = createAppPluginFixture(true);
  first.registerAppPlugins([plugin('first', [definition('only-first')])]);
  second.registerAppPlugins([plugin('second', [definition('only-second')])]);
  const signal = new AbortController().signal;
  const a = await CommandService.create([], signal, first.getAppPluginRegistry());
  const b = await CommandService.create([], signal, second.getAppPluginRegistry());
  expect(a.getCommands().map(command => command.name)).toEqual(['only-first']);
  expect(b.getCommands().map(command => command.name)).toEqual(['only-second']);
});

it('preserves builtin priority over same-named user skills', async () => {
  registerAppPlugins([plugin('feedback-provider', [definition('feedback', { kind: CommandKind.BUILT_IN })])]);
  const service = await catalog([regular('help'), regular('feedback', CommandKind.SKILL)]);
  expect(service.getCommands().map((command) => [command.name, command.kind])).toEqual([
    ['help', CommandKind.BUILT_IN],
    ['feedback', CommandKind.BUILT_IN],
    ['feedback1', CommandKind.SKILL],
  ]);
  expect(service.getConflicts()).toHaveLength(1);
});

it('resolves from original names when plugin commands reserve numeric suffixes', async () => {
  const declarations = [
    definition('feedback', { kind: CommandKind.BUILT_IN }),
    definition('feedback1', { kind: CommandKind.BUILT_IN }),
  ];
  registerAppPlugins([plugin('feedback-provider', declarations)]);
  const service = await catalog([regular('feedback'), regular('feedback', CommandKind.SKILL)]);
  const snapshot = service.getCommands();
  expect(parseSlashCommand('/feedback2', snapshot).commandToExecute?.kind).toBe(CommandKind.SKILL);
  declarations.pop();
  expect(parseSlashCommand('/feedback1', snapshot).commandToExecute?.kind).toBe(CommandKind.SKILL);
  expect(parseSlashCommand('/feedback2', snapshot).commandToExecute).toBeUndefined();
});

it('does not reject a user skill merely because a plugin builtin has that alias', async () => {
  registerAppPlugins([plugin('feedback-provider', [definition('feedback', { kind: CommandKind.BUILT_IN, altNames: ['bug'] })])]);
  const service = await catalog([regular('bug', CommandKind.SKILL)]);
  expect(service.getCommands().map((command) => command.name)).toEqual(['feedback', 'bug']);
  expect(parseSlashCommand('/bug', service.getCommands()).commandToExecute?.kind).toBe(CommandKind.SKILL);
});

it('merges plugins with raw loader declarations and restores the original host command', async () => {
  const original = regular('usage');
  const declarations = [definition('usage', { kind: CommandKind.BUILT_IN, description: 'Product usage' })];
  registerAppPlugins([plugin('product', declarations)]);
  const loaded = [original];
  const loadCommands = vi.fn(async () => loaded);
  const service = await CommandService.create([{ loadCommands }], new AbortController().signal, getAppPluginRegistry());
  expect(service.getCommands().filter((command) => command.name === 'usage')).toHaveLength(1);
  expect(service.getCommands().find((command) => command.name === 'usage')?.description).toBe('Product usage');
  declarations.length = 0;
  expect(service.getCommands()).toEqual([original]);
  expect(loaded).toEqual([original]);
  expect(loadCommands).toHaveBeenCalledOnce();
});


it('logs a persistent dynamic conflict once and logs again after it disappears and returns', async () => {
  const { runLogger } = await import('@qwen-code/core');
  const declarations = [definition('help')];
  registerAppPlugins([plugin('extension', declarations)]);
  const service = await catalog([regular('help')]);
  service.getCommands();
  service.getCommands();
  expect(runLogger.warn).toHaveBeenCalledTimes(1);
  declarations.length = 0;
  service.getCommands();
  declarations.push(definition('help'));
  service.getCommands();
  expect(runLogger.warn).toHaveBeenCalledTimes(2);
});


it('does not reread a live catalog when parsing ordinary input', async () => {
  const service = await catalog([regular('help')]);
  const snapshot = service.getCommands();
  const read = vi.spyOn(service, 'getCommands');
  for (const text of ['', 'hello world', 'help', 'use /help']) {
    expect(parseSlashCommand(text, snapshot).commandToExecute).toBeUndefined();
  }
  expect(read).not.toHaveBeenCalled();
  expect(parseSlashCommand('/help', snapshot).commandToExecute?.name).toBe('help');
  expect(read).toHaveBeenCalledOnce();
});
