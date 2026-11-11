/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import type { FrameworkFixture as AppFramework } from '../test-utils/frameworkFixture.js';
import {
  Command,
  Option,
  type CommandUnknownOpts,
} from '@commander-js/extra-typings';
import type {
  BuiltinRootOptionActionContext,
  BuiltinRootOptionContribution,
  AppTerminalCommandResolutionContext,
} from './types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  definitions: vi.fn(),
  rootDefinitions: vi.fn(),
  parent: vi.fn(),
  child: vi.fn(),
  exit: vi.fn(),
  initialize: vi.fn(),
  initCommand: vi.fn(),
  hostReady: vi.fn(),
  dispose: vi.fn(),
  loadSettings: vi.fn(),
}));
vi.mock('./registry.js', () => ({
  getAppPluginTerminalCommands: mocks.definitions,
  getAppPluginRootOptions: mocks.rootDefinitions,
}));
vi.mock('@qwen-code/core', () => ({
  initializeBuiltinPlugins: mocks.initialize,
  disposeBuiltinPlugins: mocks.dispose,
}));
vi.mock('../config/settings.js', () => ({
  getSettingsResolveOptions: (projectPath: string) => ({ projectPath }),
}));
vi.mock('../utils/outputListeners.js', () => ({
  initializeOutputListenersAndFlush: vi.fn(),
}));
vi.mock('../utils/exitCli.js', () => ({ exitCli: mocks.exit }));
import {
  registerAppPluginRootOptions,
  registerAppPluginTerminalCommands,
  resolveAppPluginTerminalCommands,
  isAppPluginTerminalCommand,
  runTerminalCommand,
} from './commands.js';
const framework = {
  appPlugins: {
    whenReady: mocks.initialize,
    get: () => ({ markHostReady: mocks.hostReady }),
  },
  getResourceService: () => ({}),
  getSettingsService: () => ({ resolve: mocks.loadSettings }),
  initForCommand: mocks.initCommand,
  start: async (_mode: unknown, input: unknown) => {
    mocks.initCommand(input);
    return framework;
  },
  awaitInitAppPlugins: mocks.initialize,
  getAppPlugins: () => ({
    markHostReady: mocks.hostReady,
    getAppPluginTerminalCommands: mocks.definitions,
    getAppPluginRootOptions: mocks.rootDefinitions,
  }),
} as unknown as AppFramework;
const declarations = [
  {
    getTerminalCommands: mocks.definitions,
    getRootOptions: mocks.rootDefinitions,
  },
];
function attachedCommand(name: string): Command {
  const command = new Command(name);
  mocks.definitions.mockReturnValueOnce([command]);
  registerAppPluginTerminalCommands(
    new Command(),
    declarations,
    framework.getSettingsService(),
    framework.start,
  );
  return command;
}

it('resolves dynamic commands with reserved names and aliases from preceding declarations', async () => {
  const program = new Command().addCommand(new Command('builtin').alias('b'));
  const rawArgv = Object.freeze(['dynamic', '--flag']);
  const second = vi.fn(
    async (_context: AppTerminalCommandResolutionContext) => [],
  );
  await resolveAppPluginTerminalCommands(
    program,
    [
      {
        resolveTerminalCommands: async (context) => {
          expect(context.rawArgv).toBe(rawArgv);
          expect([...context.reservedCommandNames]).toEqual(['builtin', 'b']);
          return [new Command('dynamic').alias('d')];
        },
      },
      { resolveTerminalCommands: second },
    ],
    { rawArgv, explicitHeadless: false, valueOptionFlags: ['--model'] },
  );
  expect([...second.mock.calls[0][0].reservedCommandNames]).toEqual([
    'builtin',
    'b',
    'dynamic',
    'd',
  ]);
  expect(program.commands.map((command) => command.name())).toEqual([
    'builtin',
    'dynamic',
  ]);
});

it.each(['builtin', 'b'])(
  'rejects a dynamic command that shadows the existing name %s',
  async (name) => {
    const program = new Command().addCommand(new Command('builtin').alias('b'));
    await expect(
      resolveAppPluginTerminalCommands(
        program,
        [
          {
            resolveTerminalCommands: async () => [new Command(name)],
          },
        ],
        { rawArgv: [], explicitHeadless: false, valueOptionFlags: [] },
      ),
    ).rejects.toThrow('Invalid or duplicate app plugin command');
    expect(program.commands.map((command) => command.name())).toEqual([
      'builtin',
    ]);
  },
);

it('preserves hidden static commands and ordinary local startup for their children', () => {
  const child = new Command('list');
  const command = new Command('management')
    .description('Hidden management')
    .addCommand(child);
  const program = new Command();
  registerAppPluginTerminalCommands(
    program,
    [
      {
        getTerminalCommands: () => [
          { command, hidden: true, startup: 'local' },
        ],
      },
    ],
    framework.getSettingsService(),
    framework.start,
  );
  expect(program.helpInformation()).not.toContain('Hidden management');
  expect(isAppPluginTerminalCommand(command)).toBe(false);
  expect(isAppPluginTerminalCommand(child)).toBe(false);
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.initialize.mockResolvedValue(undefined);
  mocks.dispose.mockResolvedValue(undefined);
  mocks.exit.mockResolvedValue(undefined);
  mocks.loadSettings.mockReturnValue({ merged: {} });
  mocks.parent.mockResolvedValue({ exitCode: 0 });
  mocks.child.mockResolvedValue({ exitCode: 0 });
  mocks.rootDefinitions.mockReturnValue([]);
  const feedback = new Command('feedback')
    .description('feedback')
    .option('--json', 'json');
  const action = new Command('action').description('action');
  const send = new Command('send').description('send').option('--json', 'json');
  feedback.action(() =>
    runTerminalCommand(feedback, (signal) =>
      mocks.parent([], signal, feedback.opts()),
    ),
  );
  send.action(() =>
    runTerminalCommand(send, (signal) =>
      mocks.child([], signal, { ...feedback.opts(), ...send.opts() }),
    ),
  );
  mocks.definitions.mockReturnValue([
    feedback.addCommand(action.addCommand(send)),
  ]);
});
describe('builtin root options', () => {
  it('registers plugin options and replaces a host option with the same flag', () => {
    mocks.rootDefinitions.mockReturnValue([new Option('--plugin-mode <id>')]);
    const program = new Command();
    registerAppPluginRootOptions(
      program,
      declarations,
      framework.getSettingsService(),
      framework.start,
    );
    expect(program.options.map((option) => option.long)).toContain(
      '--plugin-mode',
    );

    const host = new Command().option('--plugin-mode <host-flag>');
    const registration = registerAppPluginRootOptions(
      host,
      declarations,
      framework.getSettingsService(),
      framework.start,
    );
    expect(
      host.options.filter((option) => option.long === '--plugin-mode'),
    ).toHaveLength(1);
    expect(registration.replacedRootOptions.has('pluginMode')).toBe(true);
  });
});

function rootActionHarness(
  definitions: ReadonlyArray<Option | BuiltinRootOptionContribution>,
  configure?: (program: CommandUnknownOpts) => void,
) {
  mocks.rootDefinitions.mockReturnValue(definitions);
  const program = new Command('sample')
    .argument('[args...]')
    .enablePositionalOptions()
    .exitOverride()
    .configureOutput({ writeErr: () => {}, writeOut: () => {} });
  configure?.(program);
  const rootOptions = registerAppPluginRootOptions(
    program,
    declarations,
    framework.getSettingsService(),
    framework.start,
  );
  const normalRoot = vi.fn();
  program.action(async (args: string[]) => {
    const candidates = rootOptions.validate(program.opts());
    const action = rootOptions.selectAction(candidates, program.opts());
    if (action) await action(args);
    else normalRoot();
  });
  return {
    program,
    normalRoot,
    parse: (args: string[]) => program.parseAsync(args, { from: 'user' }),
  };
}

describe('builtin root option actions', () => {
  it('validates an explicitly selected root action before initializing plugins', async () => {
    const validate = vi.fn((options: Readonly<Record<string, unknown>>) => {
      expect(options['sampleTask']).toBe('example');
      expect(Object.isFrozen(options)).toBe(true);
      expect(mocks.initialize).not.toHaveBeenCalled();
    });
    const action = vi.fn(async () => {
      expect(validate).toHaveBeenCalledOnce();
      return { exitCode: 0 };
    });
    const h = rootActionHarness([
      { option: new Option('--sample-task <name>'), validate, action },
    ]);
    await h.parse(['--sample-task', 'example']);
    expect(validate).toHaveBeenCalledOnce();
    expect(action).toHaveBeenCalledOnce();
  });

  it('does not run a root validator when a subcommand is selected', async () => {
    const validate = vi.fn(() => {
      throw new Error('invalid root arguments');
    });
    const action = vi.fn();
    const child = vi.fn();
    const h = rootActionHarness([
      { option: new Option('--sample-task <name>'), validate, action },
    ]);
    h.program.addCommand(new Command('child').action(child));
    await h.parse(['--sample-task', 'example', 'child']);
    expect(child).toHaveBeenCalledOnce();
    expect(validate).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  });

  it('does not validate a defaulted action that was not explicitly selected', async () => {
    const validate = vi.fn();
    const action = vi.fn();
    const h = rootActionHarness([
      {
        option: new Option('--sample-task <name>').default('example'),
        validate,
        action,
      },
    ]);
    await h.parse([]);
    expect(validate).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  });

  it.each(['host', 'plugin'])(
    'rejects an action contribution colliding with a %s short flag',
    (source) => {
      const action = vi.fn();
      const program = new Command();
      const definitions: BuiltinRootOptionContribution[] = [
        { option: new Option('-t, --sample-task <name>'), action },
      ];
      if (source === 'host') {
        program.option('-t, --host-task <name>');
      } else {
        definitions.push({ option: new Option('-t, --other-task'), action });
      }
      mocks.rootDefinitions.mockReturnValue(definitions);
      expect(() =>
        registerAppPluginRootOptions(
          program,
          declarations,
          framework.getSettingsService(),
          framework.start,
        ),
      ).toThrow('Duplicate app plugin root option: -t');
      expect(action).not.toHaveBeenCalled();
      expect(mocks.initialize).not.toHaveBeenCalled();
    },
  );

  it('runs one explicit action with a parsed read-only snapshot', async () => {
    const action = vi.fn(async (_context: BuiltinRootOptionActionContext) => ({
      exitCode: 3,
    }));
    const parseValue = vi.fn((value: string) => Number(value));
    const h = rootActionHarness(
      [
        new Option('--sample-format <value>'),
        {
          option: new Option('-t, --sample-task <value>').argParser(parseValue),
          action,
        },
      ],
      (program) => program.option('--host-json'),
    );
    await h.parse([
      '--host-json',
      '--sample-format',
      'json',
      '-t',
      '12',
      'input',
    ]);
    expect(action).toHaveBeenCalledExactlyOnceWith({
      options: { hostJson: true, sampleFormat: 'json', sampleTask: 12 },
      positionalArgs: ['input'],
      signal: expect.any(AbortSignal),
    });
    expect(parseValue).toHaveBeenCalledOnce();
    expect(Object.isFrozen(action.mock.calls[0][0].options)).toBe(true);
    expect(mocks.initialize).toHaveBeenCalledOnce();
    expect(mocks.dispose).not.toHaveBeenCalled();
    expect(mocks.exit).toHaveBeenCalledWith(3);
    expect(h.normalRoot).not.toHaveBeenCalled();
  });

  it('keeps plain Options and contributions without actions on the normal route', async () => {
    const h = rootActionHarness([
      new Option('--sample-format <value>'),
      { option: new Option('--sample-json') },
    ]);
    await h.parse(['--sample-format=json', '--sample-json']);
    expect(h.normalRoot).toHaveBeenCalledOnce();
    expect(h.program.opts()).toEqual({
      sampleFormat: 'json',
      sampleJson: true,
    });
    expect(mocks.initialize).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'default',
      configure: (option: Option) => option.default('default'),
    },
    {
      label: 'environment',
      configure: (option: Option) => option.env('CLI_TEST_SAMPLE_TASK'),
    },
  ])('does not start an action from its $label', async ({ configure }) => {
    vi.stubEnv('CLI_TEST_SAMPLE_TASK', 'environment');
    const action = vi.fn();
    const h = rootActionHarness([
      { option: configure(new Option('--sample-task <name>')), action },
    ]);
    await h.parse([]);
    expect(h.normalRoot).toHaveBeenCalledOnce();
    expect(action).not.toHaveBeenCalled();
    expect(mocks.initialize).not.toHaveBeenCalled();
  });

  it('does not start an action from an implied value', async () => {
    const action = vi.fn();
    const h = rootActionHarness([
      new Option('--sample-trigger').implies({ sampleTask: 'implied' }),
      { option: new Option('--sample-task <name>'), action },
    ]);
    await h.parse(['--sample-trigger']);
    expect(action).not.toHaveBeenCalled();
    expect(h.normalRoot).toHaveBeenCalledOnce();
  });

  it.each([false, 0, ''])(
    'does not use truthiness to select an explicit value %j',
    async (value) => {
      const action = vi.fn(
        async (_context: BuiltinRootOptionActionContext) => ({ exitCode: 0 }),
      );
      const h = rootActionHarness([
        {
          option: new Option('--sample-task <value>').argParser(() => value),
          action,
        },
      ]);
      await h.parse(['--sample-task', 'input']);
      expect(action).toHaveBeenCalledWith(
        expect.objectContaining({ options: { sampleTask: value } }),
      );
      expect(h.normalRoot).not.toHaveBeenCalled();
    },
  );

  it('runs repeated short/long aliases only once with the final parsed value', async () => {
    const action = vi.fn(async () => ({ exitCode: 0 }));
    const h = rootActionHarness([
      { option: new Option('-t, --sample-task <name>'), action },
    ]);
    await h.parse(['-t', 'first', '--sample-task=second']);
    expect(action).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ options: { sampleTask: 'second' } }),
    );
  });

  it('does not mistake the negated Option for its positive action', async () => {
    const action = vi.fn();
    const h = rootActionHarness([
      { option: new Option('--sample-enabled'), action },
      new Option('--no-sample-enabled'),
    ]);
    await h.parse(['--no-sample-enabled']);
    expect(action).not.toHaveBeenCalled();
    expect(h.normalRoot).toHaveBeenCalledOnce();
  });

  it('can explicitly select an action on a negated Option', async () => {
    const action = vi.fn(async () => ({ exitCode: 0 }));
    const h = rootActionHarness([
      new Option('--sample-enabled'),
      { option: new Option('--no-sample-enabled'), action },
    ]);
    await h.parse(['--no-sample-enabled']);
    expect(action).toHaveBeenCalledWith(
      expect.objectContaining({ options: { sampleEnabled: false } }),
    );
  });

  it('validates a yielded action and continues the normal route without initializing plugins', async () => {
    const validate = vi.fn((options: Readonly<Record<string, unknown>>) => {
      expect(Object.isFrozen(options)).toBe(true);
      expect(options['sampleTask']).toBe('example');
      expect(mocks.initialize).not.toHaveBeenCalled();
      return false;
    });
    const action = vi.fn(async () => ({ exitCode: 0 }));
    const h = rootActionHarness([
      { option: new Option('--sample-task <name>'), validate, action },
    ]);
    await h.parse(['--sample-task', 'example']);
    expect(validate).toHaveBeenCalledOnce();
    expect(action).not.toHaveBeenCalled();
    expect(h.normalRoot).toHaveBeenCalledOnce();
    expect(mocks.initCommand).not.toHaveBeenCalled();
    expect(mocks.initialize).not.toHaveBeenCalled();
    expect(mocks.exit).not.toHaveBeenCalled();
  });

  it('checks every validator before selecting one of several explicit actions', async () => {
    const firstValidate = vi.fn(() => false);
    const secondValidate = vi.fn(() => {
      expect(firstValidate).toHaveBeenCalledOnce();
      expect(mocks.initialize).not.toHaveBeenCalled();
      return true;
    });
    const first = vi.fn(async () => ({ exitCode: 0 }));
    const second = vi.fn(async () => {
      expect(secondValidate).toHaveBeenCalledOnce();
      return { exitCode: 0 };
    });
    const h = rootActionHarness([
      {
        option: new Option('--sample-first'),
        validate: firstValidate,
        action: first,
      },
      {
        option: new Option('--sample-second'),
        validate: secondValidate,
        action: second,
      },
    ]);
    await h.parse(['--sample-first', '--sample-second']);
    expect(firstValidate).toHaveBeenCalledOnce();
    expect(secondValidate).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    expect(h.normalRoot).not.toHaveBeenCalled();
  });

  it('continues the normal route when every explicit action yields', async () => {
    const validate = vi.fn(() => false);
    const action = vi.fn();
    const h = rootActionHarness([
      { option: new Option('--sample-first'), validate, action },
      { option: new Option('--sample-second'), validate, action },
    ]);
    await h.parse(['--sample-first', '--sample-second']);
    expect(validate).toHaveBeenCalledTimes(2);
    expect(action).not.toHaveBeenCalled();
    expect(h.normalRoot).toHaveBeenCalledOnce();
    expect(mocks.initCommand).not.toHaveBeenCalled();
    expect(mocks.exit).not.toHaveBeenCalled();
  });

  it('rejects later invalid arguments after an earlier action yields', async () => {
    const failure = new Error('invalid root arguments');
    const firstValidate = vi.fn(() => false);
    const secondValidate = vi.fn(() => {
      throw failure;
    });
    const action = vi.fn();
    const h = rootActionHarness([
      { option: new Option('--sample-first'), validate: firstValidate, action },
      {
        option: new Option('--sample-second'),
        validate: secondValidate,
        action,
      },
    ]);
    await expect(h.parse(['--sample-first', '--sample-second'])).rejects.toBe(
      failure,
    );
    expect(firstValidate).toHaveBeenCalledOnce();
    expect(secondValidate).toHaveBeenCalledOnce();
    expect(action).not.toHaveBeenCalled();
    expect(h.normalRoot).not.toHaveBeenCalled();
    expect(mocks.initCommand).not.toHaveBeenCalled();
  });

  it('does not retain a yielded validation result across repeated parses', async () => {
    const validate = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const action = vi.fn(async () => ({ exitCode: 0 }));
    const h = rootActionHarness([
      { option: new Option('--sample-task <name>'), validate, action },
    ]);
    await h.parse(['--sample-task', 'example']);
    expect(h.normalRoot).toHaveBeenCalledOnce();
    expect(action).not.toHaveBeenCalled();
    h.normalRoot.mockClear();

    await h.parse(['--sample-task', 'example']);
    expect(validate).toHaveBeenCalledTimes(2);
    expect(action).toHaveBeenCalledOnce();
    expect(h.normalRoot).not.toHaveBeenCalled();
  });

  it('still rejects multiple eligible actions after excluding a yielded action', async () => {
    const validate = vi.fn(() => true);
    const yieldAction = vi.fn(() => false);
    const action = vi.fn();
    const h = rootActionHarness([
      { option: new Option('--sample-first'), validate, action },
      { option: new Option('--sample-second'), action },
      { option: new Option('--sample-third'), validate: yieldAction, action },
    ]);
    await expect(
      h.parse(['--sample-first', '--sample-second', '--sample-third']),
    ).rejects.toThrow(/conflict/i);
    expect(validate).toHaveBeenCalledOnce();
    expect(yieldAction).toHaveBeenCalledOnce();
    expect(action).not.toHaveBeenCalled();
    expect(mocks.initCommand).not.toHaveBeenCalled();
  });

  it.each(['default', 'subcommand', 'help'])(
    'does not run an action validator for %s routing',
    async (route) => {
      const validate = vi.fn(() => false);
      const action = vi.fn();
      const h = rootActionHarness([
        {
          option: new Option('--sample-task <name>').default('example'),
          validate,
          action,
        },
      ]);
      h.program.addCommand(new Command('child').action(() => {}));
      if (route === 'help') {
        await expect(
          h.parse(['--sample-task', 'example', '--help']),
        ).rejects.toMatchObject({ exitCode: 0 });
      } else {
        await h.parse(
          route === 'subcommand' ? ['--sample-task', 'example', 'child'] : [],
        );
      }
      expect(validate).not.toHaveBeenCalled();
      expect(action).not.toHaveBeenCalled();
      expect(mocks.initCommand).not.toHaveBeenCalled();
    },
  );

  it('rejects multiple explicit actions before plugin initialization', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const h = rootActionHarness([
      { option: new Option('--sample-first'), action: first },
      { option: new Option('--sample-second'), action: second },
    ]);
    await expect(
      h.parse(['--sample-first', '--sample-second']),
    ).rejects.toThrow(/conflict/i);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(mocks.initialize).not.toHaveBeenCalled();
  });

  it.each(['sample-child', 'child'])(
    'prefers the %s subcommand over a root action',
    async (name) => {
      const action = vi.fn();
      const child = vi.fn();
      const h = rootActionHarness([
        { option: new Option('--sample-task <name>'), action },
      ]);
      h.program.addCommand(
        new Command('sample-child').alias('child').action(child),
      );
      await h.parse(['--sample-task', 'input', name]);
      expect(child).toHaveBeenCalledOnce();
      expect(action).not.toHaveBeenCalled();
      expect(mocks.initialize).not.toHaveBeenCalled();
    },
  );

  it('prefers a nested subcommand even when multiple root actions were provided', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const child = vi.fn();
    const h = rootActionHarness([
      { option: new Option('--sample-first'), action: first },
      { option: new Option('--sample-second'), action: second },
    ]);
    h.program.addCommand(
      new Command('group').addCommand(
        new Command('child').option('--json').action(child),
      ),
    );
    await h.parse([
      '--sample-first',
      '--sample-second',
      'group',
      'child',
      '--json',
    ]);
    expect(child).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(mocks.initialize).not.toHaveBeenCalled();
  });

  it.each(['--help', '--version'])(
    'does not initialize plugins for %s',
    async (flag) => {
      const action = vi.fn();
      const h = rootActionHarness([
        { option: new Option('--sample-task <name>'), action },
      ]);
      h.program.version('1.0.0');
      await expect(
        h.parse(['--sample-task', 'input', flag]),
      ).rejects.toMatchObject({ exitCode: 0 });
      expect(action).not.toHaveBeenCalled();
      expect(mocks.initialize).not.toHaveBeenCalled();
    },
  );

  it('does not trigger options from text after the delimiter', async () => {
    const action = vi.fn();
    const h = rootActionHarness([
      { option: new Option('--sample-task <name>'), action },
    ]);
    await h.parse(['--', '--sample-task', 'literal']);
    expect(action).not.toHaveBeenCalled();
    expect(h.normalRoot).toHaveBeenCalledOnce();
  });

  it('keeps an unknown short token as positional input like the existing root command', async () => {
    const action = vi.fn(async () => ({ exitCode: 0 }));
    const h = rootActionHarness(
      [{ option: new Option('--sample-task <name>'), action }],
      (program) => program.allowUnknownOption(),
    );
    await h.parse(['--sample-task', 'input', '-z']);
    expect(action).toHaveBeenCalledWith(
      expect.objectContaining({ positionalArgs: ['-z'] }),
    );
  });

  it('lets Commander reject missing values and plugin-declared conflicts', async () => {
    const action = vi.fn();
    const h = rootActionHarness(
      [
        {
          option: new Option('--sample-task <name>').conflicts('sampleOther'),
          action,
        },
      ],
      (program) => program.option('--sample-other'),
    );
    await expect(h.parse(['--sample-task'])).rejects.toThrow(
      /argument missing/,
    );
    await expect(
      h.parse(['--sample-task', 'input', '--sample-other']),
    ).rejects.toThrow(/cannot be used/);
    expect(action).not.toHaveBeenCalled();
    expect(mocks.initialize).not.toHaveBeenCalled();
  });

  it('does not retain an action selection from an earlier parse or help exit', async () => {
    const action = vi.fn(async () => ({ exitCode: 0 }));
    const h = rootActionHarness([
      { option: new Option('--sample-enabled'), action },
      new Option('--no-sample-enabled'),
    ]);
    await expect(h.parse(['--sample-enabled', '--help'])).rejects.toMatchObject(
      { exitCode: 0 },
    );
    await h.parse([]);
    await h.parse(['--no-sample-enabled']);
    expect(action).not.toHaveBeenCalled();
    expect(h.normalRoot).toHaveBeenCalledTimes(2);
  });

  it('rejects an invalid choice before action initialization', async () => {
    const action = vi.fn();
    const h = rootActionHarness([
      { option: new Option('--sample-task <name>').choices(['valid']), action },
    ]);
    await expect(h.parse(['--sample-task', 'invalid'])).rejects.toThrow(
      /Allowed choices are valid/,
    );
    expect(action).not.toHaveBeenCalled();
    expect(mocks.initialize).not.toHaveBeenCalled();
  });

  it('leaves application-owned disposal to the common exit path after a root action throws', async () => {
    const error = new Error('sample action failed');
    const action = vi.fn(async () => {
      throw error;
    });
    const h = rootActionHarness([
      { option: new Option('--sample-task'), action },
    ]);
    await expect(h.parse(['--sample-task'])).rejects.toBe(error);
    expect(mocks.dispose).not.toHaveBeenCalled();
    expect(mocks.exit).not.toHaveBeenCalled();
    expect(h.normalRoot).not.toHaveBeenCalled();
  });

  it('leaves application-owned disposal to the common exit path when root action initialization fails', async () => {
    const error = new Error('sample initialization failed');
    mocks.initialize.mockRejectedValue(error);
    const action = vi.fn();
    const h = rootActionHarness([
      { option: new Option('--sample-task'), action },
    ]);
    await expect(h.parse(['--sample-task'])).rejects.toBe(error);
    expect(action).not.toHaveBeenCalled();
    expect(mocks.dispose).not.toHaveBeenCalled();
    expect(h.normalRoot).not.toHaveBeenCalled();
  });

  it('cancels a root action and removes the terminal signal listener', async () => {
    const original = process.listeners('SIGINT');
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const action = vi.fn(
      (context: BuiltinRootOptionActionContext) =>
        new Promise<{ exitCode: number }>((resolve) => {
          context.signal.addEventListener(
            'abort',
            () => resolve({ exitCode: 130 }),
            { once: true },
          );
          started();
        }),
    );
    const h = rootActionHarness([
      { option: new Option('--sample-task'), action },
    ]);
    const parse = h.parse(['--sample-task']);
    await running;
    const handler = process
      .listeners('SIGINT')
      .find((listener) => !original.includes(listener))!;
    handler('SIGINT');
    await parse;
    expect(mocks.exit).toHaveBeenCalledWith(130);
    expect(mocks.dispose).not.toHaveBeenCalled();
    expect(process.listeners('SIGINT')).toEqual(original);
  });
});
describe('builtin terminal commands with a default action', () => {
  it('replaces a complete host tree and dispatches through the product alias', async () => {
    const oldAction = vi.fn();
    const replacementAction = vi.fn();
    const host = new Command('plugins').alias('plugin');
    host.addCommand(new Command('obsolete').action(oldAction));
    const replacement = new Command('plugins').alias('plugin');
    replacement.addCommand(new Command('list').action(replacementAction));
    const program = new Command().addCommand(host);
    mocks.definitions.mockReturnValue([replacement]);
    registerAppPluginTerminalCommands(program, declarations);

    expect(program.commands).toEqual([replacement]);
    expect(replacement.commands.map((command) => command.name())).toEqual(['list']);
    await program.parseAsync(['plugin', 'list'], { from: 'user' });
    expect(replacementAction).toHaveBeenCalledOnce();
    expect(oldAction).not.toHaveBeenCalled();
  });

  it('rejects two product plugins claiming the same host command', () => {
    const program = new Command().addCommand(new Command('plugins'));
    mocks.definitions.mockReturnValue([
      new Command('plugins'),
      new Command('plugins'),
    ]);
    expect(() => registerAppPluginTerminalCommands(program, declarations))
      .toThrow('Invalid or duplicate app plugin command: plugins');
  });

  it('does not treat an earlier product declaration as a replaceable host command', () => {
    const program = new Command().addCommand(new Command('plugins'));
    mocks.definitions.mockReturnValue([new Command('plugins')]);
    registerAppPluginTerminalCommands(program, declarations);
    mocks.definitions.mockReturnValue([new Command('plugins')]);
    expect(() => registerAppPluginTerminalCommands(program, declarations))
      .toThrow('Invalid or duplicate app plugin command: plugins');
  });

  it('keeps the host tree when a replacement has an alias owned by another command', () => {
    const host = new Command('plugins').alias('plugin');
    const program = new Command()
      .addCommand(host)
      .addCommand(new Command('other').alias('reserved'));
    mocks.definitions.mockReturnValue([new Command('plugins').alias('reserved')]);
    expect(() => registerAppPluginTerminalCommands(program, declarations))
      .toThrow('Invalid or duplicate app plugin command: reserved');
    expect(program.commands).toContain(host);
  });

  it('keeps the parent action invocable', async () => {
    const program = new Command();
    registerAppPluginTerminalCommands(
      program,
      declarations,
      framework.getSettingsService(),
      framework.start,
    );
    await program.parseAsync(['feedback', '--json'], { from: 'user' });
    expect(mocks.parent).toHaveBeenCalledWith([], expect.any(AbortSignal), {
      json: true,
    });
    expect(mocks.child).not.toHaveBeenCalled();
  });
  it('dispatches a nested action with inherited JSON options', async () => {
    const program = new Command();
    registerAppPluginTerminalCommands(
      program,
      declarations,
      framework.getSettingsService(),
      framework.start,
    );
    await program.parseAsync(['feedback', 'action', 'send', '--json'], {
      from: 'user',
    });
    expect(mocks.child).toHaveBeenCalledWith([], expect.any(AbortSignal), {
      json: true,
    });
    expect(mocks.parent).not.toHaveBeenCalled();
  });
  it('replaces a host command group and its aliases without initializing plugins', async () => {
    const host = vi.fn();
    const product = vi.fn();
    const program = new Command().addCommand(
      new Command('agents').alias('agent').action(host),
    );
    const replacement = new Command('agents').alias('agent').action(product);
    replacement.addCommand(new Command('list').action(product));
    mocks.definitions.mockReturnValue([replacement]);
    registerAppPluginTerminalCommands(
      program,
      declarations,
      framework.getSettingsService(),
      framework.start,
    );
    expect(program.commands).toEqual([replacement]);
    expect(mocks.initialize).not.toHaveBeenCalled();
    await program.parseAsync(['agent'], { from: 'user' });
    await program.parseAsync(['agents', 'list'], { from: 'user' });
    expect(product).toHaveBeenCalledTimes(2);
    expect(host).not.toHaveBeenCalled();
  });
  it('does not replace a command contributed by another plugin', () => {
    mocks.definitions.mockReturnValue([
      new Command('agents'),
      new Command('agents'),
    ]);
    expect(() =>
      registerAppPluginTerminalCommands(
        new Command().addCommand(new Command('agents')),
        declarations,
      ),
    ).toThrow('Invalid or duplicate app plugin command: agents');
  });
  it('validates replacement aliases before removing the host group', () => {
    const host = new Command('agents');
    const other = new Command('skills').alias('skill');
    const program = new Command().addCommand(host).addCommand(other);
    mocks.definitions.mockReturnValue([new Command('agents').alias('skill')]);
    expect(() =>
      registerAppPluginTerminalCommands(program, declarations),
    ).toThrow('Invalid or duplicate app plugin command: skill');
    expect(program.commands).toEqual([host, other]);
  });
  it('keeps host commands when there is no product override', () => {
    const host = new Command('agents').alias('agent');
    const program = new Command().addCommand(host);
    mocks.definitions.mockReturnValue([]);
    registerAppPluginTerminalCommands(program, declarations);
    expect(program.commands).toEqual([host]);
  });
  it('does not initialize plugin contributions for local actions', async () => {
    await runTerminalCommand(
      attachedCommand('local'),
      async () => ({ exitCode: 0 }),
      { components: 'local' },
    );
    expect(mocks.initialize).not.toHaveBeenCalled();
  });
  it('rejects collisions with an existing command alias', () => {
    mocks.definitions.mockReturnValue([new Command('other').alias('existing')]);
    expect(() =>
      registerAppPluginTerminalCommands(
        new Command().addCommand(new Command('existing')),
        declarations,
        framework.getSettingsService(),
        framework.start,
      ),
    ).toThrow('Invalid or duplicate app plugin command: existing');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
it('cancels on SIGINT and removes its listener after action failure', async () => {
  const original = process.listeners('SIGINT');
  const error = new Error('cancelled');
  await expect(
    runTerminalCommand(attachedCommand('test'), async (signal) => {
      const handler = process
        .listeners('SIGINT')
        .find((fn) => !original.includes(fn))!;
      handler('SIGINT');
      expect(signal.aborted).toBe(true);
      throw error;
    }),
  ).rejects.toBe(error);
  expect(mocks.dispose).not.toHaveBeenCalled();
  expect(process.listeners('SIGINT')).toEqual(original);
  expect(mocks.exit).not.toHaveBeenCalled();
});
it('starts only the sign-in state for an action that asks for it', async () => {
  const action = vi.fn(async () => ({ exitCode: 3 }));
  await runTerminalCommand(attachedCommand('test'), action, {
    components: 'auth',
  });
  expect(mocks.initCommand).toHaveBeenCalledWith(
    expect.objectContaining({ command: 'auth' }),
  );
  expect(mocks.initialize).not.toHaveBeenCalled();
  expect(mocks.hostReady).not.toHaveBeenCalled();
  expect(action).toHaveBeenCalledOnce();
  expect(mocks.exit).toHaveBeenCalledWith(3);
});
it('prepares a local command without initializing app plugins', async () => {
  const action = vi.fn(async () => ({ exitCode: 0 }));
  await runTerminalCommand(attachedCommand('test'), action, {
    components: 'local',
  });
  expect(mocks.initCommand).toHaveBeenCalledWith(
    expect.objectContaining({ command: 'local' }),
  );
  expect(mocks.initialize).not.toHaveBeenCalled();
  expect(mocks.hostReady).not.toHaveBeenCalled();
  expect(action).toHaveBeenCalledOnce();
});
it('leaves application-owned disposal to the common exit path when initialization fails', async () => {
  const error = new Error('initialize failed');
  mocks.initialize.mockRejectedValue(error);
  const action = vi.fn();
  await expect(
    runTerminalCommand(attachedCommand('test'), action),
  ).rejects.toBe(error);
  expect(action).not.toHaveBeenCalled();
  expect(mocks.dispose).not.toHaveBeenCalled();
});

it.each(['SIGHUP', 'SIGTERM'] as const)(
  'turns %s into a terminal-command cancellation signal',
  async (signalName) => {
    let actionStarted!: () => void;
    let finishAction!: () => void;
    let actionSignal: AbortSignal | undefined;
    const started = new Promise<void>((resolve) => (actionStarted = resolve));
    const finish = new Promise<void>((resolve) => (finishAction = resolve));
    const listenersBefore = process.listenerCount(signalName);

    const running = runTerminalCommand(
      attachedCommand('test'),
      async (signal) => {
        actionSignal = signal;
        actionStarted();
        await finish;
        return { exitCode: 0 };
      },
    );
    await started;

    expect(process.listenerCount(signalName)).toBe(listenersBefore + 1);
    process.emit(signalName, signalName);
    expect(actionSignal?.aborted).toBe(true);
    finishAction();
    await running;
    expect(process.listenerCount(signalName)).toBe(listenersBefore);
  },
);

it('starts the selected command DAG and waits before running its action', async () => {
  let finish!: () => void;
  mocks.initialize.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const action = vi.fn(async () => ({ exitCode: 0 }));
  const pending = runTerminalCommand(attachedCommand('test'), action);
  await vi.waitFor(() => expect(mocks.initCommand).toHaveBeenCalledOnce());
  expect(action).not.toHaveBeenCalled();
  finish();
  await pending;
  expect(mocks.hostReady).toHaveBeenCalledOnce();
  expect(action).toHaveBeenCalledOnce();
});

it('validates explicitly selected passive root options without turning them into actions', async () => {
  const validate = vi.fn();
  const declarations = [{ getRootOptions: () => [{ option: new Option('--session-test <id>'), validate }] }];
  const program = new Command().exitOverride();
  const options = registerAppPluginRootOptions(
    program as CommandUnknownOpts,
    declarations,
  );
  program.action(() => {});
  program.parse(['node', 'test', '--session-test', 'one']);
  options.validate(program.opts());
  expect(validate).toHaveBeenCalledExactlyOnceWith({ sessionTest: 'one' });
  expect(options.hasAction()).toBe(false);
  program.parse(['node', 'test']);
  options.validate(program.opts());
  expect(validate).toHaveBeenCalledOnce();
});
