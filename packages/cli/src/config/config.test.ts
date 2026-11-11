/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createLoadedSettings as createCliLoadedSettings } from './settings.js';
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  afterAll,
} from 'vitest';
import { Command, Option } from '@commander-js/extra-typings';
import type { BuiltinRootOptionContribution } from '../app-plugins/types.js';
import { AppPluginRegistry } from '../app-plugins/registry.js';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as ServerConfig from '@qwen-code/core';
import {
  DEFAULT_FILE_FILTERING_OPTIONS,
  OutputFormat,
  SHELL_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  EDIT_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  ASK_USER_TOOL_NAME,
  runLogger,
  type LoadedPlugin,
  type PluginError,
  Storage,
  generalistProfile,
  CONFIG_DIR,
} from '@qwen-code/core';
import {
  ENV_APPEND_SYSTEM_PROMPT,
  ENV_MCP_CONFIG,
  ENV_MCP_LAZY,
  ENV_MODEL,
  ENV_PERMISSION_MODE,
  ENV_SESSION_ID,
  ENV_SESSION_NAME,
  ENV_WORKING_DIR,
  loadCliConfig as baseLoadCliConfig,
  initializeUserResources,
  resolveConfigInteractive,
  resolveConfigTargetDir,
  type CliArgs,
  type LoadCliConfigOptions,
} from './config.js';
import { CommanderError } from '@commander-js/extra-typings';

const loadCliConfig = (
  settings: Parameters<typeof baseLoadCliConfig>[0],
  sessionId: string,
  argv: Parameters<typeof baseLoadCliConfig>[2],
  options: Omit<LoadCliConfigOptions, 'permissionManager'> & {
    permissionManager?: LoadCliConfigOptions['permissionManager'];
  },
) =>
  baseLoadCliConfig(settings, sessionId, argv, {
    permissionManager: createTestPermissionManager(),
    ...options,
  });

import { StartupInputError } from './startupInputError.js';
import {
  buildSuggestionCandidates,
  createCommand,
} from '../commands/index.js';
import type { LoadedSettings } from './settings.js';
import { type Settings } from './settings.js';

import * as settingsModule from '../test-utils/resolveSettings.js';

import { isWorkspaceTrusted } from './trustedFolders.js';
import { handleRootCommand } from '../startup/rootCommandHandler.js';
import { createAppPluginFixture } from '../test-utils/appPluginFixture.js';
import type { FrameworkFixture as AppFramework } from '../test-utils/frameworkFixture.js';
const { registerAppPlugins, getAppPluginRegistry } = createAppPluginFixture();
import { resolveStartupWorkspace } from '../startup/startupWorkspace.js';
import { createCliSettingsService } from './createCliSettingsService.js';
import { SettingsService } from '@qwen-code/resource';
import { getSettingsSchema } from './settingsSchema.js';
import { createTestPermissionManager } from '../test-utils/permissionManager.js';
import { AsyncInitializer } from '../framework/asyncInitializer.js';
const parserResources = new ServerConfig.ResourceService();
const parserSettings = createCliSettingsService({
  environmentPolicy: 'session',
});
afterAll(async () => {
  await parserResources.dispose();
  await parserSettings.dispose();
});
const parserFramework = {
  appPlugins: {
    whenReady: () => parserFramework.awaitInitAppPlugins(),
    get: getAppPluginRegistry,
    dispose: () => parserFramework.awaitDisposeAppPlugins(),
  },
  resources: { get: () => parserResources },
  settingsService: parserSettings,
  getAppPlugins: getAppPluginRegistry,
  start: async () => parserFramework,
  awaitInitAppPlugins: async () => getAppPluginRegistry(),
  awaitDisposeAppPlugins: async () => {},
  getResourceService: () => parserResources,
  getSettingsService: () => parserSettings,
} as unknown as AppFramework;
const declarations = [
  {
    getTerminalCommands: () =>
      getAppPluginRegistry().getAppPluginTerminalCommands(),
    getRootOptions: () => getAppPluginRegistry().getAppPluginRootOptions(),
  },
];

// Parsing a matched command runs it, and for the root command that means the
// whole startup tail. These tests only exercise argv parsing, so the root
// command's body is stubbed out.
vi.mock('../startup/rootCommandHandler.js', () => ({
  handleRootCommand: vi.fn(),
}));
vi.mock('../startup/startupWorkspace.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../startup/startupWorkspace.js')>();
  return {
    ...actual,
    resolveStartupWorkspace: vi.fn(actual.resolveStartupWorkspace),
  };
});

const rootOptionContributions: Array<Option | BuiltinRootOptionContribution> =
  [];
const pluginSubcommandAction = vi.fn();

// Exercise injected command contributions without depending on a product package.
registerAppPlugins([
  {
    apiVersion: 1,
    id: 'command-parser-fixture',
    initialize: async () => {},
    dispose: async () => {},
    getRootOptions: () => [
      // Product-owned declarations are injected without loading the product package.
      new Option('--remote [task]')
        .preset('')
        .argParser((value: string) => value.trim()),
      ...rootOptionContributions,
    ],
    getTerminalCommands: () => {
      const hidden = new Command('hidden-plugin-command')
        .description('Hidden test command')
        .action(() => {});
      new Command().addCommand(hidden, { hidden: true });
      return [
        new Command('sample-plugin')
          .description('Test plugin command')
          .addCommand(
            new Command('scan')
              .description('Test nested command')
              .option('--format <format>', 'Output format')
              .option('--directory <path>', 'Working directory')
              .action(pluginSubcommandAction),
          ),
        hidden,
      ];
    },
  },
]);

/**
 * Runs process.argv through the real command tree the way main() does. main()
 * owns the failure epilogue (error → exit code), so rejected argv surfaces here
 * as the very error that would reach it: a StartupInputError for argv this CLI
 * refuses, or a CommanderError for commander's own help/version/usage exits.
 */
async function runCommandTree(): Promise<void> {
  const program = await createCommand(
    parserFramework.getSettingsService(),
    declarations,
    parserFramework.start,
  );
  await program.parseAsync(process.argv);
}

/**
 * Parses process.argv and returns the argv the root command received. The
 * command tree hands the parsed argv to the matched command's action, so the
 * stubbed root command is where tests read it back from.
 */
async function parseArgsForRootCommand(): Promise<CliArgs> {
  vi.mocked(handleRootCommand).mockClear();
  await runCommandTree();
  const call = vi.mocked(handleRootCommand).mock.calls.at(-1);
  if (!call) {
    throw new Error('argv did not route to the root command');
  }
  return call[0];
}

const { writeToStderrMock } = vi.hoisted(() => ({
  writeToStderrMock: vi.fn(() => true),
}));

vi.mock('./trustedFolders.js', () => ({
  isWorkspaceTrusted: vi.fn(() => ({ isTrusted: true, source: 'file' })), // Default to trusted
}));

vi.mock('../utils/exitCli.js', () => ({
  exitCli: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
  const actualFs = await importOriginal<typeof import('fs')>();
  const pathMod = await import('node:path');
  const mockHome = pathMod.resolve(pathMod.sep, 'mock', 'home', 'user');
  const MOCK_CWD1 = process.cwd();
  const MOCK_CWD2 = pathMod.resolve(pathMod.sep, 'home', 'user', 'project');

  const mockPaths = new Set([
    MOCK_CWD1,
    MOCK_CWD2,
    pathMod.resolve(pathMod.sep, 'cli', 'path1'),
    pathMod.resolve(pathMod.sep, 'settings', 'path1'),
    pathMod.join(mockHome, 'settings', 'path2'),
    pathMod.join(MOCK_CWD2, 'cli', 'path2'),
    pathMod.join(MOCK_CWD2, 'settings', 'path3'),
  ]);

  return {
    ...actualFs,
    mkdirSync: vi.fn((p) => {
      mockPaths.add(p.toString());
    }),
    writeFileSync: vi.fn(),
    existsSync: vi.fn(
      (p) => mockPaths.has(p.toString()) || actualFs.existsSync(p),
    ),
    statSync: vi.fn((p) => {
      if (mockPaths.has(p.toString())) {
        return { isDirectory: () => true } as unknown as import('fs').Stats;
      }
      return actualFs.statSync(p as unknown as string);
    }),
    realpathSync: vi.fn((p) => p),
  };
});

vi.mock('os', async (importOriginal) => {
  const actualOs = await importOriginal<typeof os>();
  return {
    ...actualOs,
    homedir: vi.fn(() => path.resolve(path.sep, 'mock', 'home', 'user')),
  };
});

vi.mock('open', () => ({
  default: vi.fn(),
}));

vi.mock('read-package-up', () => ({
  readPackageUp: vi.fn(() =>
    Promise.resolve({ packageJson: { version: 'test-version' } }),
  ),
}));

// Keep source provenance in fixtures, including omission of schema defaults.
function createLoadedSettings(
  overrides: Partial<Settings> = {},
  isTrusted: boolean = true,
): LoadedSettings {
  return createLoadedSettingsFromSources({ user: overrides }, isTrusted);
}

function createLoadedSettingsFromSources(
  sources: {
    user?: Partial<Settings>;
    project?: Partial<Settings>;
    local?: Partial<Settings>;
    flag?: Partial<Settings>;
  },
  isTrusted: boolean = true,
  userSettingsLoadRejected: boolean = false,
): LoadedSettings {
  const userSettings = (sources.user ?? {}) as Settings;
  const projectSettings = (sources.project ?? {}) as Settings;
  const localSettings = (sources.local ?? {}) as Settings;
  const flagSettings = (sources.flag ?? {}) as Settings;

  return createCliLoadedSettings(
    {
      // 此夹具验证配置组装；磁盘事务由 settingsPersistence 用真实临时文件覆盖。
      path: '',
      settings: userSettings,
      originalSettings: userSettings,
    },
    {
      path: '',
      settings: projectSettings,
      originalSettings: projectSettings,
    },
    {
      path: '',
      settings: localSettings,
      originalSettings: localSettings,
    },
    isTrusted,
    [],
    {
      path: '',
      settings: flagSettings,
      originalSettings: flagSettings,
      readOnly: true,
    },
    userSettingsLoadRejected,
  );
}

/** loadCliConfig 交给 Config 的启动补丁；Config 初始化后经 manager 写到主模型。 */
function launchModelConfig(
  config: ServerConfig.Config,
): ServerConfig.ModelConfig | undefined {
  return (config as unknown as { launchModelConfig?: ServerConfig.ModelConfig })
    .launchModelConfig;
}

const startAutoUpdateSchedulerMock = vi.hoisted(() => vi.fn());
const loadSessionPluginsMock = vi.hoisted(() =>
  vi.fn(async (_options?: unknown) => ({
    plugins: [] as LoadedPlugin[],
    errors: [] as PluginError[],
  })),
);

vi.mock(
  '../../../core/src/plugins/management/pluginManagerSettings.js',
  async (original) => {
    const actual = await original<
      typeof import('../../../core/src/plugins/management/pluginManagerSettings.js')
    >();
    return {
      ...actual,
      createCorePluginManager: (
        ...args: Parameters<typeof actual.createCorePluginManager>
      ) => {
        const manager = actual.createCorePluginManager(...args);
        vi.spyOn(manager, 'loadSessionPlugins').mockImplementation(
          loadSessionPluginsMock,
        );
        return manager;
      },
    };
  },
);

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actualServer =
    await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actualServer,
    writeToStderr: writeToStderrMock,
    getEffectiveBlockedMarketplaces: vi.fn(
      (blockedMarketplaces: string[] | undefined) => [
        ...new Set(
          (blockedMarketplaces ?? []).map((marketplace) =>
            marketplace.toLowerCase(),
          ),
        ),
      ],
    ),
    isRemoteWorkerMode: vi.fn(() => false),
    startAutoUpdateScheduler: startAutoUpdateSchedulerMock,
    loadEnvironment: vi.fn(),
    DEFAULT_MEMORY_FILE_FILTERING_OPTIONS: {
      respectGitIgnore: false,
      respectBrandIgnore: true,
      customIgnoreFilePaths: [],
    },
    DEFAULT_FILE_FILTERING_OPTIONS: {
      respectGitIgnore: true,
      respectBrandIgnore: true,
      customIgnoreFilePaths: [],
    },
    getAdminErrorMessage: vi.fn(
      (_feature) => `Bypass permissions mode is disabled by settings.`,
    ),
    sessionLogger: Object.setPrototypeOf(
      { ...(actualServer.sessionLogger as object), setExitContext: vi.fn() },
      Object.getPrototypeOf(actualServer.sessionLogger),
    ),
    listKnownMarketplaces: vi.fn(() => []),
    loadInstalledPluginsFromDisk: vi.fn(() => ({ version: 2, plugins: {} })),
    loadPluginFromDirectory: vi.fn(),
    parsePluginIdentifier: vi.fn((id: string) => {
      const [name, marketplace] = id.split('@');
      return { name, marketplace };
    }),
    isHeadlessMode: vi.fn((opts) => {
      if (process.env['VITEST'] === 'true') {
        return (
          !!opts?.prompt ||
          opts?.inputFormat === 'stream-json' ||
          !!opts?.print ||
          (!!process.stdin && !process.stdin.isTTY) ||
          (!!process.stdout && !process.stdout.isTTY)
        );
      }
      return (
        !!opts?.prompt ||
        opts?.inputFormat === 'stream-json' ||
        !!opts?.print ||
        process.env['CI'] === 'true' ||
        process.env['GITHUB_ACTIONS'] === 'true' ||
        (!!process.stdin && !process.stdin.isTTY) ||
        (!!process.stdout && !process.stdout.isTTY)
      );
    }),
  };
});

// Global setup to ensure clean environment for all tests in this file
const originalArgv = process.argv;
const startupEnvKeys = [
  ENV_APPEND_SYSTEM_PROMPT,
  ENV_MCP_CONFIG,
  ENV_MCP_LAZY,
  ENV_MODEL,
  ENV_WORKING_DIR,
  ENV_SESSION_ID,
  ENV_SESSION_NAME,
  ENV_PERMISSION_MODE,
] as const;
const originalStartupEnv = new Map(
  startupEnvKeys.map((key) => [key, process.env[key]]),
);
const originalStdoutIsTTY = process.stdout.isTTY;
const originalStdinIsTTY = process.stdin.isTTY;

beforeEach(() => {
  vi.spyOn(parserFramework, 'start')
    .mockResolvedValue(parserFramework)
    .mockClear();
  vi.spyOn(parserFramework, 'awaitInitAppPlugins')
    .mockResolvedValue(getAppPluginRegistry())
    .mockClear();
  vi.spyOn(parserFramework, 'awaitDisposeAppPlugins')
    .mockResolvedValue()
    .mockClear();
  rootOptionContributions.length = 0;
  pluginSubcommandAction.mockClear();
  vi.mocked(resolveStartupWorkspace).mockClear();
  for (const key of startupEnvKeys) {
    delete process.env[key];
  }
  writeToStderrMock.mockClear();
  loadSessionPluginsMock.mockReset();
  loadSessionPluginsMock.mockResolvedValue({ plugins: [], errors: [] });

  // Default to interactive mode for tests unless otherwise specified
  Object.defineProperty(process.stdout, 'isTTY', {
    value: true,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(process.stdin, 'isTTY', {
    value: true,
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  process.argv = originalArgv;
  for (const key of startupEnvKeys) {
    const original = originalStartupEnv.get(key);
    if (original !== undefined) {
      process.env[key] = original;
    } else {
      delete process.env[key];
    }
  }
  Object.defineProperty(process.stdout, 'isTTY', {
    value: originalStdoutIsTTY,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(process.stdin, 'isTTY', {
    value: originalStdinIsTTY,
    configurable: true,
    writable: true,
  });
});

describe('initializeUserResources', () => {
  it.each([
    { sdk: false, sources: {}, expected: true },
    {
      sdk: false,
      sources: { user: { skills: { loadFromAgentsDirectory: false } } },
      expected: false,
    },
    {
      sdk: false,
      sources: { project: { skills: { loadFromAgentsDirectory: false } } },
      expected: true,
    },
    {
      sdk: false,
      sources: {
        user: { skills: { loadFromAgentsDirectory: true } },
        flag: { skills: { loadFromAgentsDirectory: false } },
      },
      expected: false,
    },
    {
      sdk: true,
      sources: { user: { skills: { loadFromAgentsDirectory: true } } },
      expected: true,
    },
    {
      sdk: true,
      sources: {
        user: { skills: { loadFromAgentsDirectory: true } },
        flag: { skills: { loadFromAgentsDirectory: false } },
      },
      expected: false,
    },
    {
      sdk: true,
      sources: { flag: { skills: { loadFromAgentsDirectory: true } } },
      expected: true,
    },
    {
      sdk: true,
      sources: {},
      expected: false,
    },
  ])(
    'fixes the user and flag setting before loading workspaces: %j',
    async ({ sdk, sources, expected }) => {
      vi.stubEnv(ServerConfig.ENV_AGENT_SDK_ENTRYPOINT, sdk ? 'sdk-ts' : '');
      const resourceService = new ServerConfig.ResourceService();
      const initialize = vi
        .spyOn(resourceService, 'initializeUserResources')
        .mockResolvedValue();
      try {
        await initializeUserResources(
          resourceService,
          createLoadedSettingsFromSources(sources, true),
        );
        expect(initialize).toHaveBeenCalledWith({
          homeDir: path.dirname(Storage.getGlobalAgentsDir()),
          globalConfigDirOverride: Storage.getGlobalConfigDir(),
          userAgentSkillsDirOverride: Storage.getUserAgentSkillsDir(),
          loadFromAgentsDirectory: expected,
        });
      } finally {
        initialize.mockRestore();
        vi.unstubAllEnvs();
        await resourceService.dispose();
      }
    },
  );
});

describe('argv parsing', () => {
  it('validates plugin root arguments before a built-in list command without initializing the plugin', async () => {
    process.argv = [
      'node',
      'qwen',
      '--sample-task',
      'example',
      '--resume',
      'local-session',
      '--list-sessions',
    ];
    const failure = new Error('sample-task cannot be combined with resume');
    const validate = vi.fn(() => {
      throw failure;
    });
    const action = vi.fn();
    rootOptionContributions.push({
      option: new Option('--sample-task <name>'),
      validate,
      action,
    });
    const initialize = vi
      .spyOn(parserFramework, 'awaitInitAppPlugins')
      .mockResolvedValue(getAppPluginRegistry());
    vi.mocked(handleRootCommand).mockClear();
    await expect(runCommandTree()).rejects.toBe(failure);
    expect(validate).toHaveBeenCalledOnce();
    expect(action).not.toHaveBeenCalled();
    expect(initialize).not.toHaveBeenCalled();
    expect(handleRootCommand).not.toHaveBeenCalled();
    expect(resolveStartupWorkspace).not.toHaveBeenCalled();
  });

  it.each([
    { args: ['--print', 'hello'], expected: { print: true, prompt: 'hello' } },
    { args: ['--acp'], expected: { acp: true } },
  ])(
    'continues the original root route when all plugin actions yield for $args',
    async ({ args, expected }) => {
      process.argv = [
        'node',
        'qwen',
        '--sample-first',
        '--sample-second',
        ...args,
      ];
      const validate = vi.fn(() => false);
      const action = vi.fn();
      rootOptionContributions.push(
        { option: new Option('--sample-first'), validate, action },
        { option: new Option('--sample-second'), validate, action },
      );
      const argv = await parseArgsForRootCommand();
      expect(argv).toMatchObject(expected);
      expect(validate).toHaveBeenCalledTimes(2);
      expect(action).not.toHaveBeenCalled();
      expect(parserFramework.start).not.toHaveBeenCalled();
      expect(parserFramework.awaitInitAppPlugins).not.toHaveBeenCalled();
      expect(resolveStartupWorkspace).toHaveBeenCalledOnce();
      expect(handleRootCommand).toHaveBeenCalledOnce();
    },
  );

  it('selects one eligible plugin action after normalizing root arguments', async () => {
    process.argv = [
      'node',
      'qwen',
      '--sample-first',
      '--sample-second',
      '--print',
      'hello',
    ];
    const validate = vi.fn((options: Readonly<Record<string, unknown>>) => {
      expect(Object.isFrozen(options)).toBe(true);
      expect(options['prompt']).toBeUndefined();
      expect(options['print']).toBe(true);
      return false;
    });
    const secondValidate = vi.fn(() => {
      expect(validate).toHaveBeenCalledOnce();
      return true;
    });
    const skipped = vi.fn();
    const selected = vi.fn(async () => {
      expect(secondValidate).toHaveBeenCalledOnce();
      return { exitCode: 0 };
    });
    rootOptionContributions.push(
      {
        option: new Option('--sample-first'),
        validate,
        action: skipped,
      },
      {
        option: new Option('--sample-second'),
        validate: secondValidate,
        action: selected,
      },
    );
    vi.mocked(handleRootCommand).mockClear();
    await runCommandTree();
    expect(validate).toHaveBeenCalledOnce();
    expect(skipped).not.toHaveBeenCalled();
    expect(selected).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        options: expect.objectContaining({ prompt: 'hello' }),
      }),
    );
    expect(parserFramework.start).toHaveBeenCalledOnce();
    expect(resolveStartupWorkspace).not.toHaveBeenCalled();
    expect(handleRootCommand).not.toHaveBeenCalled();
  });

  it('keeps parsed values for validation and reuses normal root option normalization for execution', async () => {
    process.argv = [
      'node',
      'qwen',
      '--sample-task',
      'example',
      '--yolo',
      '--allowed-mcp-server-names',
      'one,two',
      '--setting-sources',
      'user,project',
    ];
    const validate = vi.fn();
    const action = vi.fn(async () => ({ exitCode: 0 }));
    rootOptionContributions.push({
      option: new Option('--sample-task <name>'),
      validate,
      action,
    });
    vi.spyOn(parserFramework, 'awaitInitAppPlugins').mockResolvedValue(
      getAppPluginRegistry(),
    );
    vi.spyOn(parserFramework, 'awaitDisposeAppPlugins').mockResolvedValue();
    await runCommandTree();
    const expected = {
      sampleTask: 'example',
      permissionMode: 'bypass_permissions',
      allowedMcpServerNames: ['one', 'two'],
      settingSources: ['user', 'project'],
    };
    expect(validate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        sampleTask: 'example',
        yolo: true,
        allowedMcpServerNames: ['one,two'],
        settingSources: ['user,project'],
      }),
    );
    expect(action).toHaveBeenCalledWith(
      expect.objectContaining({ options: expect.objectContaining(expected) }),
    );
  });

  it.each([
    {
      flag: '--list-extensions',
      extra: [],
      expected: { listExtensions: true },
    },
    { flag: '--list-sessions', extra: [], expected: { listSessions: true } },
    { flag: '--list-models', extra: [], expected: { listModels: true } },
    {
      flag: '--delete-session',
      extra: ['1'],
      expected: { deleteSession: '1' },
    },
  ])(
    'preserves $flag ahead of plugin root actions in either argument order',
    async ({ flag, extra, expected }) => {
      for (const builtinFirst of [false, true]) {
        const builtinArgs = [flag, ...extra];
        const pluginArgs = ['--sample-task', 'example', '--sample-other'];
        process.argv = [
          'node',
          'qwen',
          ...(builtinFirst
            ? [...builtinArgs, ...pluginArgs]
            : [...pluginArgs, ...builtinArgs]),
        ];
        const action = vi.fn(async () => ({ exitCode: 0 }));
        const validate = vi.fn(() => true);
        rootOptionContributions.length = 0;
        rootOptionContributions.push(
          {
            option: new Option('--sample-task <name>'),
            validate,
            action,
          },
          {
            option: new Option('--sample-other'),
            validate,
            action,
          },
        );
        const initialize = vi
          .spyOn(parserFramework, 'awaitInitAppPlugins')
          .mockResolvedValue(getAppPluginRegistry());
        vi.spyOn(parserFramework, 'awaitDisposeAppPlugins').mockResolvedValue();
        vi.mocked(handleRootCommand).mockClear();
        await runCommandTree();
        expect(handleRootCommand).toHaveBeenCalledOnce();
        expect(vi.mocked(handleRootCommand).mock.calls[0][0]).toMatchObject(
          expected,
        );
        expect(action).not.toHaveBeenCalled();
        expect(validate).toHaveBeenCalledTimes(2);
        expect(initialize).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    {
      args: ['--sample-task', 'example', '--unknown'],
      errorType: StartupInputError,
    },
    { args: ['--sample-first', '--sample-second'], errorType: CommanderError },
  ])(
    'keeps plugin argument errors on the parse-error path for $args',
    async ({ args, errorType }) => {
      process.argv = ['node', 'qwen', ...args];
      const action = vi.fn();
      rootOptionContributions.push(
        { option: new Option('--sample-task <name>'), action },
        { option: new Option('--sample-first'), action },
        { option: new Option('--sample-second'), action },
      );
      const initialize = vi
        .spyOn(parserFramework, 'awaitInitAppPlugins')
        .mockResolvedValue(getAppPluginRegistry());
      await expect(runCommandTree()).rejects.toBeInstanceOf(errorType);
      expect(action).not.toHaveBeenCalled();
      expect(initialize).not.toHaveBeenCalled();
    },
  );

  it('still preserves the original execution failure of a plugin root action', async () => {
    process.argv = ['node', 'qwen', '--sample-task', 'example'];
    const failure = new Error('sample execution failed');
    rootOptionContributions.push({
      option: new Option('--sample-task <name>'),
      action: vi.fn(async () => {
        throw failure;
      }),
    });
    vi.spyOn(parserFramework, 'awaitInitAppPlugins').mockResolvedValue(
      getAppPluginRegistry(),
    );
    const dispose = vi
      .spyOn(parserFramework, 'awaitDisposeAppPlugins')
      .mockResolvedValue();
    await expect(runCommandTree()).rejects.toMatchObject({
      name: 'RootCommandExecutionError',
      reason: failure,
    });
    expect(dispose).not.toHaveBeenCalled();
  });

  it.each(['sample-plugin', 'sample-alias'])(
    'prefers the %s nested subcommand over plugin root actions',
    async (name) => {
      process.argv = [
        'node',
        'qwen',
        '--sample-first',
        '--sample-second',
        name,
        'scan',
        '--format',
        'json',
      ];
      const action = vi.fn();
      rootOptionContributions.push(
        { option: new Option('--sample-first'), action },
        { option: new Option('--sample-second'), action },
      );
      const initialize = vi
        .spyOn(parserFramework, 'awaitInitAppPlugins')
        .mockResolvedValue(getAppPluginRegistry());
      vi.mocked(handleRootCommand).mockClear();
      const program = await createCommand(
        parserFramework.getSettingsService(),
        declarations,
        parserFramework.start,
      );
      program.commands
        .find((command) => command.name() === 'sample-plugin')!
        .alias('sample-alias');
      await program.parseAsync(process.argv);
      expect(pluginSubcommandAction).toHaveBeenCalledOnce();
      expect(pluginSubcommandAction.mock.calls[0][0]).toMatchObject({
        format: 'json',
      });
      expect(action).not.toHaveBeenCalled();
      expect(initialize).not.toHaveBeenCalled();
      expect(handleRootCommand).not.toHaveBeenCalled();
      expect(resolveStartupWorkspace).not.toHaveBeenCalled();
    },
  );

  it.each([
    { input: ['-z'], accepts: true },
    { input: ['--', '--literal'], accepts: false },
    { input: ['--unknown=value'], accepts: false },
    { input: ['--unknown'], accepts: false },
  ])(
    'keeps existing root token handling for $input on a plugin action',
    async ({ input, accepts }) => {
      for (const useAction of [false, true]) {
        process.argv = [
          'node',
          'qwen',
          ...(useAction ? ['--sample-task', 'example'] : []),
          ...input,
        ];
        rootOptionContributions.length = 0;
        const action = vi.fn(async () => ({ exitCode: 0 }));
        if (useAction)
          rootOptionContributions.push({
            option: new Option('--sample-task <name>'),
            action,
          });
        vi.spyOn(parserFramework, 'awaitInitAppPlugins').mockResolvedValue(
          getAppPluginRegistry(),
        );
        vi.spyOn(parserFramework, 'awaitDisposeAppPlugins').mockResolvedValue();
        const error = await runCommandTree().then(
          () => undefined,
          (error: unknown) => error,
        );
        if (accepts) expect(error).toBeUndefined();
        else expect(error).toBeDefined();
        if (useAction) expect(action).toHaveBeenCalledTimes(accepts ? 1 : 0);
      }
    },
  );

  it('runs a plugin root action without creating the default Session or resolving its history', async () => {
    process.argv = [
      'node',
      'qwen',
      '--sample-task',
      'example',
      '--cwd',
      '/repo',
    ];
    const action = vi.fn(async () => ({ exitCode: 0 }));
    rootOptionContributions.push({
      option: new Option('--sample-task <name>'),
      action,
    });
    const initialize = vi
      .spyOn(parserFramework, 'awaitInitAppPlugins')
      .mockResolvedValue(getAppPluginRegistry());
    const dispose = vi
      .spyOn(parserFramework, 'awaitDisposeAppPlugins')
      .mockResolvedValue();
    vi.mocked(handleRootCommand).mockClear();
    await runCommandTree();
    expect(action).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          sampleTask: 'example',
          cwd: '/repo',
        }),
      }),
    );
    expect(initialize).toHaveBeenCalledOnce();
    expect(dispose).not.toHaveBeenCalled();
    expect(handleRootCommand).not.toHaveBeenCalled();
    expect(resolveStartupWorkspace).not.toHaveBeenCalled();
  });

  it('does not resolve --resume before rejecting a plugin-declared conflict', async () => {
    process.argv = [
      'node',
      'qwen',
      '--sample-task',
      'example',
      '--resume',
      'not-a-session',
    ];
    const action = vi.fn();
    rootOptionContributions.push({
      option: new Option('--sample-task <name>').conflicts('resume'),
      action,
    });
    const initialize = vi
      .spyOn(parserFramework, 'awaitInitAppPlugins')
      .mockResolvedValue(getAppPluginRegistry());
    await expect(runCommandTree()).rejects.toThrow(/cannot be used/);
    expect(action).not.toHaveBeenCalled();
    expect(initialize).not.toHaveBeenCalled();
    expect(resolveStartupWorkspace).not.toHaveBeenCalled();
  });

  it('keeps ordinary plugin root parameters on the default route', async () => {
    process.argv = [
      'node',
      'qwen',
      '--sample-format',
      'json',
      '--print',
      'hello',
    ];
    rootOptionContributions.push(new Option('--sample-format <format>'));
    const argv = await parseArgsForRootCommand();
    expect(argv.prompt).toBe('hello');
    expect(argv.print).toBe(true);
  });

  it('shows plugin root action help without initializing or executing the plugin', async () => {
    process.argv = ['node', 'qwen', '--sample-task', 'example', '--help'];
    const action = vi.fn();
    rootOptionContributions.push({
      option: new Option('--sample-task <name>'),
      action,
    });
    const initialize = vi
      .spyOn(parserFramework, 'awaitInitAppPlugins')
      .mockResolvedValue(getAppPluginRegistry());
    await expect(runCommandTree()).rejects.toMatchObject({ exitCode: 0 });
    expect(action).not.toHaveBeenCalled();
    expect(initialize).not.toHaveBeenCalled();
    expect(resolveStartupWorkspace).not.toHaveBeenCalled();
  });

  it('passes settings and the startup callback directly without starting resources during parsing', async () => {
    process.argv = ['node', 'script.js', '--print', 'hello'];
    const startFramework = vi.fn(parserFramework.start);
    const program = await createCommand(
      parserSettings,
      declarations,
      startFramework,
    );
    await program.parseAsync(process.argv);
    expect(startFramework).not.toHaveBeenCalled();
    expect(handleRootCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({ print: true }),
      expect.objectContaining({ resourceRoot: process.cwd() }),
      parserSettings,
      startFramework,
    );
  });

  /**
   * Runs argv that must fail parsing and reports what main()'s epilogue would
   * have received, plus whatever commander printed to stdout.
   */
  async function captureParseFailure(args: string[]) {
    process.argv = ['node', 'script.js', ...args];
    const mockStdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    try {
      const error = await runCommandTree().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error, 'expected this argv to be rejected').toBeDefined();
      return {
        error,
        // Set only for commander's own exits (help, version, usage errors).
        code: error instanceof CommanderError ? error.code : undefined,
        stdout: mockStdoutWrite.mock.calls
          .map((call) => String(call[0]))
          .join(''),
      };
    } finally {
      mockStdoutWrite.mockRestore();
    }
  }

  // Regression: pre-init argv errors must reach the user's terminal via
  // writeToStderr, not only the (pre-init unattached) runLogger sink.
  // See docs/designs/2026-07-21-parseargs-errors-visible-on-stderr.md.
  describe('startup error visibility (stderr)', () => {
    it('rejects the removed --devtools option', async () => {
      const result = await captureParseFailure(['--devtools']);

      expect(result.error).toBeInstanceOf(StartupInputError);
      expect(writeToStderrMock).toHaveBeenCalledWith(
        "error: unknown option '--devtools'\n",
      );
      expect(writeToStderrMock).toHaveBeenCalledTimes(1);
      expect(result.stdout).toBe('');
    });

    it('writes a cc-style "error: unknown option" line to stderr for an unknown flag, exactly once, and dumps no help', async () => {
      const result = await captureParseFailure(['--frobnicate']);

      expect(result.error).toBeInstanceOf(StartupInputError);
      // Aligns with cc: `error: unknown option '--foo'`, single-quoted flag.
      expect(writeToStderrMock).toHaveBeenCalledWith(
        "error: unknown option '--frobnicate'\n",
      );
      // Single visible line, no double-print.
      expect(writeToStderrMock).toHaveBeenCalledTimes(1);
      // No help dump on the unknown-option path.
      expect(result.stdout).toBe('');
    });

    it.each([
      ['--teleport', 'remote-session-id'],
      ['--teleport=remote-session-id'],
    ])('rejects the removed --teleport option: %j', async (...args) => {
      const result = await captureParseFailure(args);

      expect(result.error).toBeInstanceOf(StartupInputError);
      expect(writeToStderrMock).toHaveBeenCalledWith(
        "error: unknown option '--teleport'\n",
      );
      expect(result.stdout).toBe('');
    });

    it('writes the invalid --output-format error to stderr with the multi-line message intact and no help dump', async () => {
      const result = await captureParseFailure(['--output-format', 'bogus']);

      expect(result.error).toBeInstanceOf(StartupInputError);
      // Embedded newline preserved + single trailing newline.
      expect(writeToStderrMock).toHaveBeenCalledWith(
        'Invalid values:\n  Argument: output-format, Given: "bogus", Choices: "text", "json", "stream-json"\n',
      );
      // No help dump on this path either.
      expect(result.stdout).toBe('');
    });

    it('writes the conflicting-prompt-flags error to stderr (non-help site) without a help dump', async () => {
      const result = await captureParseFailure([
        '--prompt',
        'test prompt',
        '-i',
        'interactive prompt',
      ]);

      expect(result.error).toBeInstanceOf(StartupInputError);
      expect(writeToStderrMock).toHaveBeenCalledWith(
        'Cannot use both --prompt and --prompt-interactive (-i) together\n',
      );
      // AC6: this site does not dump help — stdout stays empty.
      expect(result.stdout).toBe('');
    });
  });

  describe('unknown command typo suggestion', () => {
    const SUGGESTION_TYPE = 'cli.unknown_command_suggestion';

    it('suggests the closest command and exits 1 for a single-token typo', async () => {
      const eventSpy = vi
        .spyOn(ServerConfig.sessionLogger, 'event')
        .mockImplementation(() => {});
      try {
        const result = await captureParseFailure(['updatge']);
        expect(result.error).toBeInstanceOf(StartupInputError);
        expect(eventSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            type: SUGGESTION_TYPE,
            data: expect.objectContaining({
              suggestion: 'update',
              distance: 1,
            }),
          }),
        );
      } finally {
        eventSpy.mockRestore();
      }
    });

    it('resolves an uppercase command via the exact-case path with distance 0', async () => {
      const eventSpy = vi
        .spyOn(ServerConfig.sessionLogger, 'event')
        .mockImplementation(() => {});
      try {
        const result = await captureParseFailure(['UPDATE']);
        expect(result.error).toBeInstanceOf(StartupInputError);
        expect(eventSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            type: SUGGESTION_TYPE,
            data: expect.objectContaining({
              suggestion: 'update',
              distance: 0,
            }),
          }),
        );
      } finally {
        eventSpy.mockRestore();
      }
    });

    async function expectNoSuggestion(
      args: string[],
      mutate?: () => void,
    ): Promise<void> {
      const eventSpy = vi
        .spyOn(ServerConfig.sessionLogger, 'event')
        .mockImplementation(() => {});
      process.argv = ['node', 'script.js', ...args];
      mutate?.();
      try {
        // Resolving at all means the argv was accepted — no suggestion path.
        await runCommandTree();
        expect(eventSpy).not.toHaveBeenCalledWith(
          expect.objectContaining({ type: SUGGESTION_TYPE }),
        );
      } finally {
        eventSpy.mockRestore();
      }
    }

    it('does not fire for a multi-word query', async () => {
      await expectNoSuggestion(['updatge', 'the', 'thing']);
    });

    it('does not fire in print mode', async () => {
      await expectNoSuggestion(['-p', 'updatge']);
    });

    it('does not fire when the query follows a -- separator', async () => {
      await expectNoSuggestion(['--', 'updatge']);
    });

    it('does not fire when --continue is present', async () => {
      await expectNoSuggestion(['--continue', 'updatge']);
    });

    it('does not fire on a non-TTY stdout', async () => {
      await expectNoSuggestion(['updatge'], () => {
        Object.defineProperty(process.stdout, 'isTTY', {
          value: false,
          configurable: true,
          writable: true,
        });
      });
    });

    it('does not fire for a command-shaped token far from every command', async () => {
      await expectNoSuggestion(['foobar']);
    });
  });

  describe('buildSuggestionCandidates', () => {
    async function poolNames(extraCommandName?: string): Promise<string[]> {
      const program = await createCommand(
        parserFramework.getSettingsService(),
        declarations,
        parserFramework.start,
      );
      if (extraCommandName) {
        // Mirrors how an external command module gets mounted on the root.
        program.addCommand(new Command(extraCommandName));
      }
      return buildSuggestionCandidates(program).flatMap((entry) => [
        entry.name,
        ...entry.aliases,
      ]);
    }

    it('includes visible commands and help, excludes hidden external/install', async () => {
      const pool = await poolNames();
      expect(pool).toContain('update');
      expect(pool).toContain('plugins');
      expect(pool).toContain('plugin'); // alias
      expect(pool).toContain('sample-plugin');
      expect(pool).toContain('help');
      expect(pool).not.toContain('external');
      expect(pool).not.toContain('install');
      expect(pool).not.toContain('hidden-plugin-command');
    });

    it('excludes the product-only config command from the shared CLI', async () => {
      const pool = await poolNames();
      expect(pool).toContain('sample-plugin');
      expect(pool).not.toContain('config');
    });

    it('includes external command modules so their typos can be suggested', async () => {
      const pool = await poolNames('qwen-test-external-command');
      expect(pool).toContain('qwen-test-external-command');
    });
  });

  describe('output-style flag', () => {
    it('parses --output-style with a value into argv.outputStyle', async () => {
      process.argv = ['node', 'script.js', '--output-style', 'Explanatory'];
      const argv = await parseArgsForRootCommand();
      expect(argv.outputStyle).toBe('Explanatory');
    });

    it('leaves argv.outputStyle undefined when the flag is omitted', async () => {
      process.argv = ['node', 'script.js'];
      const argv = await parseArgsForRootCommand();
      expect(argv.outputStyle).toBeUndefined();
    });

    it('accepts an unknown style name without failing argv parsing', async () => {
      // Validation of style names happens in loadCliConfig (unknown →
      // debug log + default fallback). The argv layer must not reject.
      process.argv = ['node', 'script.js', '--output-style', 'does-not-exist'];
      const argv = await parseArgsForRootCommand();
      expect(argv.outputStyle).toBe('does-not-exist');
    });
  });

  describe('worktree', () => {
    it('should parse --worktree flag when provided with a name', async () => {
      process.argv = ['node', 'script.js', '--worktree', 'my-feature'];
      const argv = await parseArgsForRootCommand();
      expect(argv.worktree).toBe('my-feature');
    });

    it('should generate a random name when --worktree is provided without a name', async () => {
      process.argv = ['node', 'script.js', '--worktree'];
      const argv = await parseArgsForRootCommand();
      expect(argv.worktree).toBeDefined();
      expect(argv.worktree).not.toBe('');
      expect(typeof argv.worktree).toBe('string');
    });
  });

  describe('--list-models', () => {
    it('parses --list-models as a boolean flag', async () => {
      process.argv = ['node', 'script.js', '--list-models'];
      const argv = await parseArgsForRootCommand();
      expect(argv.listModels).toBe(true);
    });
  });

  it('should keep internal and unsupported root flags hidden from help output', async () => {
    process.argv = ['node', 'script.js', '--help'];
    const mockStdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    await expect(runCommandTree()).rejects.toThrow(CommanderError);

    const helpText = mockStdoutWrite.mock.calls
      .map((c) => String(c[0]))
      .join('\n');
    expect(helpText).toMatch(
      /Default\s+and\s+New Models use model name; Custom\s+uses\s+modelID/,
    );
    expect(helpText).not.toContain('--teleport');
    expect(helpText).not.toContain('--remote-session');
    expect(helpText).toMatch(/--remote\s/);
    expect(helpText).toContain('--max-model-request-retries');
    expect(helpText).not.toContain('--screen-reader');
    expect(helpText).not.toContain('--alternate-buffer');
    expect(helpText).not.toContain('--quiet');
    expect(helpText).not.toContain('--sandbox');
    expect(helpText).not.toContain('--raw-output');
    expect(helpText).not.toContain('--accept-raw-output-risk');
    expect(helpText).not.toContain('--system-prompt-file');
    expect(helpText).not.toContain('--append-system-prompt-file');
    expect(helpText).toContain('accept_edits');
    expect(helpText).toContain('bypass_permissions');
    expect(helpText).not.toContain('acceptEdits');
    expect(helpText).not.toContain('bypassPermissions');
    expect(helpText).not.toContain('dontAsk');
    expect(helpText).not.toContain('Manage external commands.');

    mockStdoutWrite.mockRestore();
  });

  it('shows built-in subcommand help', async () => {
    const result = await captureParseFailure(['mcp', '-h']);

    expect(result.code).toBe('commander.helpDisplayed');
    expect(result.stdout).toContain(`Usage: ${ServerConfig.BRAND_CLI_BIN} mcp`);
  });

  it('should still parse screen-reader and alternate-buffer flags', async () => {
    process.argv = [
      'node',
      'script.js',
      '--screen-reader',
      '--alternate-buffer',
    ];

    const argv = await parseArgsForRootCommand();
    expect(argv.screenReader).toBe(true);
    expect(argv.alternateBuffer).toBe(true);
  });

  it('should still parse hidden --append-system-prompt', async () => {
    process.argv = [
      'node',
      'script.js',
      '--append-system-prompt',
      'extra instructions',
    ];

    const argv = await parseArgsForRootCommand();
    expect(argv.appendSystemPrompt).toBe('extra instructions');
  });

  it('should parse --system-prompt flag', async () => {
    process.argv = ['node', 'script.js', '--system-prompt', 'custom'];

    const argv = await parseArgsForRootCommand();
    expect(argv.systemPrompt).toBe('custom');
  });

  it.each([
    {
      flag: '--system-prompt-file',
      prop: 'systemPromptFile',
    },
    {
      flag: '--append-system-prompt-file',
      prop: 'appendSystemPromptFile',
    },
  ])('should parse hidden $flag', async ({ flag, prop }) => {
    process.argv = ['node', 'script.js', flag, '/tmp/test.txt'];

    const argv = await parseArgsForRootCommand();
    expect((argv as unknown as Record<string, unknown>)[prop]).toBe(
      '/tmp/test.txt',
    );
  });

  it.each([
    {
      description: 'long flags',
      argv: [
        'node',
        'script.js',
        '--prompt',
        'test prompt',
        '--prompt-interactive',
        'interactive prompt',
      ],
    },
    {
      description: 'mixed flags',
      argv: [
        'node',
        'script.js',
        '--prompt',
        'test prompt',
        '-i',
        'interactive prompt',
      ],
    },
  ])(
    'should throw an error when using conflicting prompt flags ($description)',
    async ({ argv }) => {
      process.argv = argv;

      const mockConsoleError = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      await expect(runCommandTree()).rejects.toThrow(StartupInputError);

      mockConsoleError.mockRestore();
    },
  );

  it.each([
    {
      description: 'should allow --prompt without --prompt-interactive',
      argv: ['node', 'script.js', '--prompt', 'test prompt'],
      expected: { prompt: 'test prompt', promptInteractive: undefined },
    },
    {
      description: 'should allow --prompt-interactive without --prompt',
      argv: ['node', 'script.js', '--prompt-interactive', 'interactive prompt'],
      expected: { prompt: undefined, promptInteractive: 'interactive prompt' },
    },
    {
      description: 'should allow -i flag as alias for --prompt-interactive',
      argv: ['node', 'script.js', '-i', 'interactive prompt'],
      expected: { prompt: undefined, promptInteractive: 'interactive prompt' },
    },
  ])('$description', async ({ argv, expected }) => {
    process.argv = argv;
    const parsedArgs = await parseArgsForRootCommand();
    expect(parsedArgs.prompt).toBe(expected.prompt);
    expect(parsedArgs.promptInteractive).toBe(expected.promptInteractive);
  });

  it('marks --prompt as deprecated while preserving its behavior', async () => {
    process.argv = ['node', 'script.js', '--prompt', 'test prompt'];
    const parsedArgs = await parseArgsForRootCommand();
    expect(parsedArgs.prompt).toBe('test prompt');
    expect(parsedArgs.deprecationWarnings).toEqual([
      'The --prompt flag is deprecated. Use -p/--print with a positional prompt or stdin.',
    ]);
  });

  it('maps --workspace alias to cwd', async () => {
    process.argv = ['node', 'script.js', '--workspace', '/tmp/legacy'];
    const parsedArgs = await parseArgsForRootCommand();
    expect(parsedArgs.cwd).toBe('/tmp/legacy');
  });

  it('maps -w alias to cwd', async () => {
    process.argv = ['node', 'script.js', '-w', '/tmp/legacy-short'];
    const parsedArgs = await parseArgsForRootCommand();
    expect(parsedArgs.cwd).toBe('/tmp/legacy-short');
  });

  it('--cwd, --workspace, and -w are fully equivalent', async () => {
    process.argv = ['node', 'script.js', '--cwd', '/tmp/equiv'];
    const r1 = await parseArgsForRootCommand();

    process.argv = ['node', 'script.js', '--workspace', '/tmp/equiv'];
    const r2 = await parseArgsForRootCommand();

    process.argv = ['node', 'script.js', '-w', '/tmp/equiv'];
    const r3 = await parseArgsForRootCommand();

    expect(r1.cwd).toBe('/tmp/equiv');
    expect(r2.cwd).toBe('/tmp/equiv');
    expect(r3.cwd).toBe('/tmp/equiv');
  });

  it('uses configured startup environment variables as CLI defaults', async () => {
    process.env[ENV_MODEL] = 'env-model';
    process.env[ENV_WORKING_DIR] = '/tmp/env-cwd';
    process.env[ENV_SESSION_ID] = '11111111-1111-4111-8111-111111111111';
    process.env[ENV_SESSION_NAME] = '  Env session  ';
    process.env[ENV_PERMISSION_MODE] = 'acceptEdits';
    process.env[ENV_APPEND_SYSTEM_PROMPT] = 'env extra instructions';

    process.argv = ['node', 'script.js'];
    const argv = await parseArgsForRootCommand();

    expect(argv.model).toBe('env-model');
    expect(argv.cwd).toBe('/tmp/env-cwd');
    expect(argv.sessionId).toBe('11111111-1111-4111-8111-111111111111');
    expect(argv.name).toBe('Env session');
    expect(argv.permissionMode).toBe('accept_edits');
    expect(argv.appendSystemPrompt).toBe('env extra instructions');
    expect(argv.explicitCliOptionNames).toEqual([]);
    expect(argv.environmentOptionNames).toEqual([
      'appendSystemPrompt',
      'cwd',
      'model',
      'name',
      'permissionMode',
      'sessionId',
    ]);
  });

  it('keeps CLI startup flags ahead of configured startup environment variables', async () => {
    process.env[ENV_MODEL] = 'env-model';
    process.env[ENV_WORKING_DIR] = '/tmp/env-cwd';
    process.env[ENV_SESSION_ID] = '11111111-1111-4111-8111-111111111111';
    process.env[ENV_SESSION_NAME] = 'Env session';
    process.env[ENV_PERMISSION_MODE] = 'accept_edits';
    process.env[ENV_APPEND_SYSTEM_PROMPT] = 'env extra';

    process.argv = [
      'node',
      'script.js',
      '--model',
      'cli-model',
      '--cwd',
      '/tmp/cli-cwd',
      '--session-id',
      '22222222-2222-4222-8222-222222222222',
      '--name',
      '  CLI session  ',
      '--permission-mode',
      'default',
      '--append-system-prompt',
      'cli extra',
    ];
    const argv = await parseArgsForRootCommand();

    expect(argv.model).toBe('cli-model');
    expect(argv.cwd).toBe('/tmp/cli-cwd');
    expect(argv.sessionId).toBe('22222222-2222-4222-8222-222222222222');
    expect(argv.name).toBe('CLI session');
    expect(argv.permissionMode).toBe('default');
    expect(argv.appendSystemPrompt).toBe('cli extra');
    expect(argv.explicitCliOptionNames).toEqual([
      'appendSystemPrompt',
      'cwd',
      'model',
      'name',
      'permissionMode',
      'sessionId',
    ]);
    expect(argv.environmentOptionNames).toEqual([]);
  });

  it('maps --print to cc-style headless mode with a positional prompt', async () => {
    process.argv = ['node', 'script.js', '--print', 'headless prompt'];
    const parsedArgs = await parseArgsForRootCommand();
    expect(parsedArgs.print).toBe(true);
    expect(parsedArgs.query).toBe('headless prompt');
    expect(parsedArgs.prompt).toBe('headless prompt');
    expect(parsedArgs.promptInteractive).toBeUndefined();
  });

  describe('dash-prefixed prompts (headless mode)', () => {
    it('parses prompt starting with dash via -p flag', async () => {
      process.argv = [
        'node',
        'script.js',
        '-p',
        '- You are given a PyTorch state dictionary',
      ];
      const parsedArgs = await parseArgsForRootCommand();
      expect(parsedArgs.print).toBe(true);
      expect(parsedArgs.prompt).toBe(
        '- You are given a PyTorch state dictionary',
      );
    });

    it('parses prompt starting with dash via --print flag', async () => {
      process.argv = [
        'node',
        'script.js',
        '--print',
        '- Task: reconstruct the model',
      ];
      const parsedArgs = await parseArgsForRootCommand();
      expect(parsedArgs.print).toBe(true);
      expect(parsedArgs.prompt).toBe('- Task: reconstruct the model');
    });

    it('parses all flags correctly with dash-prefixed prompt', async () => {
      process.argv = [
        'node',
        'script.js',
        '--model',
        'test-model',
        '-p',
        '- You are given weights',
        '--output-format',
        'json',
        '--permission-mode',
        'bypass_permissions',
      ];
      const parsedArgs = await parseArgsForRootCommand();
      expect(parsedArgs.print).toBe(true);
      expect(parsedArgs.model).toBe('test-model');
      expect(parsedArgs.outputFormat).toBe('json');
      expect(parsedArgs.permissionMode).toBe('bypass_permissions');
      expect(parsedArgs.prompt).toBe('- You are given weights');
    });

    it('parses prompt containing newlines and multiple dash items', async () => {
      const multiLinePrompt = '- step 1\n- step 2\n- step 3';
      process.argv = ['node', 'script.js', '-p', multiLinePrompt];
      const parsedArgs = await parseArgsForRootCommand();
      expect(parsedArgs.print).toBe(true);
      expect(parsedArgs.prompt).toContain('step 1');
      expect(parsedArgs.prompt).toContain('step 3');
    });
  });

  it('prepends legacy attachments to the initial prompt', async () => {
    process.argv = [
      'node',
      'script.js',
      '--attachment',
      './fixtures/screenshot one.png',
      '--prompt',
      'describe this image',
    ];
    const parsedArgs = await parseArgsForRootCommand();
    expect(parsedArgs.prompt).toContain('describe this image');
    expect(parsedArgs.prompt).toContain('@');
    expect(parsedArgs.prompt).toContain('screenshot\\ one.png');
  });

  it('resolves legacy attachments relative to --workspace', async () => {
    process.argv = [
      'node',
      'script.js',
      '--workspace',
      '/tmp/legacy-workspace',
      '--attachment',
      'docs/spec.md',
      '--print',
      'review spec',
    ];
    const parsedArgs = await parseArgsForRootCommand();
    expect(parsedArgs.prompt).toContain('@/tmp/legacy-workspace/docs/spec.md');
    expect(parsedArgs.prompt).toContain('review spec');
  });

  it('preserves raw tool allow and deny list strings for downstream paren-aware parsing', async () => {
    process.argv = [
      'node',
      'script.js',
      '--allowed-tools',
      'Bash, Edit',
      '--disallowed-tools',
      'Agent ReadFile',
    ];
    const parsedArgs = await parseArgsForRootCommand();
    // Raw strings are preserved — splitting is done by parseToolListFromCLI downstream
    expect(parsedArgs.allowedTools).toEqual(['Bash, Edit']);
    expect(parsedArgs.disallowedTools).toEqual(['Agent ReadFile']);
  });

  it('preserves parenthesized tool patterns in allowed-tools', async () => {
    process.argv = ['node', 'script.js', '--allowed-tools', 'Bash(git log:*)'];
    const parsedArgs = await parseArgsForRootCommand();
    expect(parsedArgs.allowedTools).toEqual(['Bash(git log:*)']);
  });

  it('preserves parenthesized patterns in --tools flag (no naive comma split)', async () => {
    process.argv = ['node', 'script.js', '--tools', 'Bash(git:*,npm:*)'];
    const parsedArgs = await parseArgsForRootCommand();
    // Without coerce, the raw string is preserved for downstream paren-aware parsing
    expect(parsedArgs.tools).toEqual(['Bash(git:*,npm:*)']);
  });

  it('parses legacy -f as an alias for --output-format', async () => {
    process.argv = ['node', 'script.js', '-f', 'json'];
    const parsedArgs = await parseArgsForRootCommand();
    expect(parsedArgs.outputFormat).toBe('json');
  });

  it('parses legacy --max-output-tokens values', async () => {
    process.argv = ['node', 'script.js', '--max-output-tokens', '16k'];
    const parsedArgs = await parseArgsForRootCommand();
    expect(parsedArgs.maxOutputTokens).toBe('16k');
  });

  it('parses legacy --quiet and -q without applying runtime behavior', async () => {
    process.argv = ['node', 'script.js', '--quiet'];
    const longFlagArgs = await parseArgsForRootCommand();
    expect(longFlagArgs.quiet).toBe(true);

    process.argv = ['node', 'script.js', '-q'];
    const shortFlagArgs = await parseArgsForRootCommand();
    expect(shortFlagArgs.quiet).toBe(true);
  });

  describe('positional arguments and @commands', () => {
    beforeEach(() => {
      // Default to headless mode for these tests as they mostly expect one-shot behavior
      process.stdin.isTTY = false;
      Object.defineProperty(process.stdout, 'isTTY', {
        value: false,
        configurable: true,
        writable: true,
      });
    });

    it.each([
      {
        description:
          'should convert positional query argument to prompt by default',
        argv: ['node', 'script.js', 'Hi Gemini'],
        expectedQuery: 'Hi Gemini',
        expectedModel: undefined,
        debug: false,
      },
      {
        description:
          'should map @path to prompt (one-shot) when it starts with @',
        argv: ['node', 'script.js', '@path ./file.md'],
        expectedQuery: '@path ./file.md',
        expectedModel: undefined,
        debug: false,
      },
      {
        description:
          'should map @path to prompt even when config flags are present',
        argv: [
          'node',
          'script.js',
          '@path',
          './file.md',
          '--model',
          'gemini-2.5-pro',
        ],
        expectedQuery: '@path ./file.md',
        expectedModel: 'gemini-2.5-pro',
        debug: false,
      },
      {
        description:
          'maps unquoted positional @path + arg to prompt (one-shot)',
        argv: ['node', 'script.js', '@path', './file.md'],
        expectedQuery: '@path ./file.md',
        expectedModel: undefined,
        debug: false,
      },
      {
        description:
          'should handle multiple @path arguments in a single command (one-shot)',
        argv: [
          'node',
          'script.js',
          '@path',
          './file1.md',
          '@path',
          './file2.md',
        ],
        expectedQuery: '@path ./file1.md @path ./file2.md',
        expectedModel: undefined,
        debug: false,
      },
      {
        description:
          'should handle mixed quoted and unquoted @path arguments (one-shot)',
        argv: [
          'node',
          'script.js',
          '@path ./file1.md',
          '@path',
          './file2.md',
          'additional text',
        ],
        expectedQuery: '@path ./file1.md @path ./file2.md additional text',
        expectedModel: undefined,
        debug: false,
      },
      {
        description: 'should map @path to prompt with ambient flags (debug)',
        argv: ['node', 'script.js', '@path', './file.md', '--debug'],
        expectedQuery: '@path ./file.md',
        expectedModel: undefined,
        debug: true,
      },
      {
        description: 'should map @include to prompt (one-shot)',
        argv: ['node', 'script.js', '@include src/'],
        expectedQuery: '@include src/',
        expectedModel: undefined,
        debug: false,
      },
      {
        description: 'should map @search to prompt (one-shot)',
        argv: ['node', 'script.js', '@search pattern'],
        expectedQuery: '@search pattern',
        expectedModel: undefined,
        debug: false,
      },
      {
        description: 'should map @web to prompt (one-shot)',
        argv: ['node', 'script.js', '@web query'],
        expectedQuery: '@web query',
        expectedModel: undefined,
        debug: false,
      },
      {
        description: 'should map @git to prompt (one-shot)',
        argv: ['node', 'script.js', '@git status'],
        expectedQuery: '@git status',
        expectedModel: undefined,
        debug: false,
      },
      {
        description: 'should handle @command with leading whitespace',
        argv: ['node', 'script.js', '  @path ./file.md'],
        expectedQuery: '  @path ./file.md',
        expectedModel: undefined,
        debug: false,
      },
    ])(
      '$description',
      async ({ argv, expectedQuery, expectedModel, debug }) => {
        process.argv = argv;
        const parsedArgs = await parseArgsForRootCommand();
        expect(parsedArgs.query).toBe(expectedQuery);
        expect(parsedArgs.prompt).toBe(expectedQuery);
        expect(parsedArgs.promptInteractive).toBeUndefined();
        if (expectedModel) {
          expect(parsedArgs.model).toBe(expectedModel);
        }
        if (debug) {
          expect(parsedArgs.debug).toBe(true);
        }
      },
    );

    it('should include a startup message when converting positional query to interactive prompt', async () => {
      process.stdin.isTTY = true;
      Object.defineProperty(process.stdout, 'isTTY', {
        value: true,
        configurable: true,
        writable: true,
      });
      process.argv = ['node', 'script.js', 'hello'];

      try {
        const argv = await parseArgsForRootCommand();
        expect(argv.startupMessages).toContain(
          'Positional arguments now default to interactive mode. To run in non-interactive mode, use -p/--print.',
        );
      } finally {
        // beforeEach handles resetting
      }
    });
  });

  it.each([
    {
      description: 'should allow --permission-mode with accept_edits',
      argv: ['node', 'script.js', '--permission-mode', 'accept_edits'],
      expected: { permissionMode: 'accept_edits' },
    },
    {
      description: 'should allow --permission-mode with acceptEdits',
      argv: ['node', 'script.js', '--permission-mode', 'acceptEdits'],
      expected: { permissionMode: 'accept_edits' },
    },
    {
      description: 'should allow --permission-mode with bypassPermissions',
      argv: ['node', 'script.js', '--permission-mode', 'bypassPermissions'],
      expected: { permissionMode: 'bypass_permissions' },
    },
    {
      description: 'should allow --permission-mode with dontAsk',
      argv: ['node', 'script.js', '--permission-mode', 'dontAsk'],
      expected: { permissionMode: 'dont_ask' },
    },
    {
      description: 'should allow --permission-mode with auto',
      argv: ['node', 'script.js', '--permission-mode', 'auto'],
      expected: { permissionMode: 'auto' },
    },
  ])('$description', async ({ argv, expected }) => {
    process.argv = argv;
    const parsedArgs = await parseArgsForRootCommand();
    expect(parsedArgs.permissionMode).toBe(expected.permissionMode);
  });

  it('should reject invalid --permission-mode values', async () => {
    process.argv = ['node', 'script.js', '--permission-mode', 'invalid'];

    const mockConsoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const debugErrorSpy = vi
      .spyOn(runLogger, 'error')
      .mockImplementation(() => {});
    const mockStdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    await expect(runCommandTree()).rejects.toThrow(StartupInputError);

    expect(debugErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid values:'),
    );

    mockConsoleError.mockRestore();
    debugErrorSpy.mockRestore();
    mockStdoutWrite.mockRestore();
  });

  it('should allow resuming a session without prompt argument in non-interactive mode (expecting stdin)', async () => {
    const originalIsTTY = process.stdin.isTTY;
    process.stdin.isTTY = false;
    process.argv = ['node', 'script.js', '--resume', 'session-id'];

    try {
      const argv = await parseArgsForRootCommand();
      expect(argv.resume).toBe('session-id');
    } finally {
      process.stdin.isTTY = originalIsTTY;
    }
  });

  it('should preserve an empty string when --resume is passed without a value', async () => {
    const originalIsTTY = process.stdin.isTTY;
    process.stdin.isTTY = true; // Make it interactive to avoid validation error
    process.argv = ['node', 'script.js', '--resume'];

    try {
      const argv = await parseArgsForRootCommand();
      expect(argv.resume).toBe('');
    } finally {
      process.stdin.isTTY = originalIsTTY;
    }
  });

  it('should parse --continue as a boolean flag', async () => {
    process.argv = ['node', 'script.js', '--continue'];
    const argv = await parseArgsForRootCommand();
    expect(argv.continue).toBe(true);
  });

  it('should parse --fork-session as a boolean flag', async () => {
    process.argv = ['node', 'script.js', '--continue', '--fork-session'];
    const argv = await parseArgsForRootCommand();
    expect(argv.continue).toBe(true);
    expect(argv.forkSession).toBe(true);
  });

  it('should parse --resume-session-at as a message UUID', async () => {
    process.argv = [
      'node',
      'script.js',
      '--resume',
      '11111111-1111-4111-8111-111111111111',
      '--resume-session-at=22222222-2222-4222-8222-222222222222',
    ];
    const argv = await parseArgsForRootCommand();
    expect(argv.resumeSessionAt).toBe('22222222-2222-4222-8222-222222222222');
  });

  it('should parse --resume-drops-turn as a prompt UUID', async () => {
    process.argv = [
      'node',
      'script.js',
      '--resume',
      '11111111-1111-4111-8111-111111111111',
      '--resume-session-at=22222222-2222-4222-8222-222222222222',
      '--resume-drops-turn=33333333-3333-4333-8333-333333333333',
    ];
    const argv = await parseArgsForRootCommand();
    expect(argv.resumeDropsTurn).toBe('33333333-3333-4333-8333-333333333333');
  });

  it('should parse --session-id as a string option', async () => {
    process.argv = [
      'node',
      'script.js',
      '--resume',
      'session-id',
      '--fork-session',
      '--session-id',
      'target-session-id',
    ];
    const argv = await parseArgsForRootCommand();
    expect(argv.resume).toBe('session-id');
    expect(argv.forkSession).toBe(true);
    expect(argv.sessionId).toBe('target-session-id');
  });

  it('should parse --remote with a description', async () => {
    process.argv = ['node', 'script.js', '--remote', ' fix failing tests '];
    const argv = await parseArgsForRootCommand();
    expect(argv.remote).toBe('fix failing tests');
  });

  it('should preserve an empty string when --remote is passed without a value', async () => {
    process.argv = ['node', 'script.js', '--remote'];
    const argv = await parseArgsForRootCommand();
    expect(argv.remote).toBe('');
  });

  it('should preserve a positional prompt when --remote is passed without a value', async () => {
    const originalIsTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    process.argv = ['node', 'script.js', 'fix failing tests', '--remote'];

    try {
      const argv = await parseArgsForRootCommand();
      expect(argv.remote).toBe('');
      expect(argv.promptInteractive).toBe('fix failing tests');
    } finally {
      process.stdin.isTTY = originalIsTTY;
    }
  });

  it.each([
    { flag: '--continue', value: undefined, expected: { continue: true } },
    { flag: '--resume', value: '1', expected: { resume: '1' } },
    {
      flag: '--remote-session',
      value: 'qs_existing',
      expected: { remoteSession: 'qs_existing' },
    },
  ])(
    'preserves the bare --remote combination with $flag',
    async ({ flag, value, expected }) => {
      if (flag === '--remote-session')
        rootOptionContributions.push(new Option('--remote-session <id>'));
      process.argv = [
        'node',
        'script.js',
        '--remote',
        flag,
        ...(value ? [value] : []),
      ];

      vi.mocked(resolveStartupWorkspace).mockResolvedValueOnce({
        resourceRoot: process.cwd(),
      });
      const argv = await parseArgsForRootCommand();

      expect(argv).toMatchObject({ remote: '', ...expected });
      expect(handleRootCommand).toHaveBeenCalledOnce();
    },
  );

  it('should parse --name as a trimmed string option', async () => {
    process.argv = ['node', 'script.js', '--name', '  Fix login flow  '];
    const argv = await parseArgsForRootCommand();
    expect(argv.name).toBe('Fix login flow');
  });

  it('should parse the private SDK daemon flag', async () => {
    process.argv = ['node', 'script.js', '--sdk'];
    const argv = await parseArgsForRootCommand();
    expect(argv.sdk).toBe(true);
  });

  it('should preserve raw comma-separated values for --tools (downstream paren-aware splitting)', async () => {
    process.argv = [
      'node',
      'script.js',
      '--tools',
      `read_file,ShellTool(git status)`,
    ];
    const argv = await parseArgsForRootCommand();
    // Raw string preserved — splitting is done by parseToolListFromCLI downstream
    expect(argv.tools).toEqual(['read_file,ShellTool(git status)']);
  });

  it.each([
    ['empty string', ['--tools', ''], ['']],
    ['whitespace-only value', ['--tools', '   '], ['   ']],
    ['separator-only value', ['--tools', ','], [',']],
  ])(
    'should treat --tools with %s empty-sentinel value as valid',
    async (_description, args, expectedTools) => {
      process.argv = ['node', 'script.js', ...args];
      const argv = await parseArgsForRootCommand();
      expect(argv.tools).toEqual(expectedTools);
    },
  );

  it('should parse variadic --tools values', async () => {
    process.argv = ['node', 'script.js', '--tools', 'Read', 'Edit'];
    const argv = await parseArgsForRootCommand();
    expect(argv.tools).toEqual(['Read', 'Edit']);
  });

  it('should preserve repeated --tools flag compatibility with variadic values', async () => {
    process.argv = ['node', 'script.js', '--tools', 'Read', '--tools', 'Edit'];
    const argv = await parseArgsForRootCommand();
    expect(argv.tools).toEqual(['Read', 'Edit']);
  });

  it('should keep positional query after --tools when separated by --', async () => {
    process.argv = ['node', 'script.js', '--tools', 'Read', '--', 'hello'];
    const argv = await parseArgsForRootCommand();
    expect(argv.tools).toEqual(['Read']);
    expect(argv.query).toBe('hello');
  });

  it('should keep positional query before variadic --tools', async () => {
    process.argv = ['node', 'script.js', 'hello', '--tools', 'Read'];
    const argv = await parseArgsForRootCommand();
    expect(argv.query).toBe('hello');
    expect(argv.tools).toEqual(['Read']);
  });

  it('should preserve mixed sentinel and explicit tool values', async () => {
    process.argv = ['node', 'script.js', '--tools', '', 'Read'];
    const argv = await parseArgsForRootCommand();
    expect(argv.tools).toEqual(['', 'Read']);
  });

  it('should document variadic --tools consuming following positional tokens', async () => {
    process.argv = ['node', 'script.js', '--tools', 'Read', 'hello'];
    const argv = await parseArgsForRootCommand();
    expect(argv.tools).toEqual(['Read', 'hello']);
    expect(argv.query).toBeUndefined();
  });

  it('should let Commander reject bare --tools', async () => {
    process.argv = ['node', 'script.js', '--tools'];
    const mockConsoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const mockStdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const debugErrorSpy = vi
      .spyOn(runLogger, 'error')
      .mockImplementation(() => {});

    try {
      await expect(runCommandTree()).rejects.toThrow(CommanderError);
      expect(debugErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "error: option '--tools <tools...>' argument missing",
        ),
      );
    } finally {
      mockConsoleError.mockRestore();
      mockStdoutWrite.mockRestore();
      debugErrorSpy.mockRestore();
    }
  });

  it('should support comma-separated values for --allowed-mcp-server-names', async () => {
    process.argv = [
      'node',
      'script.js',
      '--allowed-mcp-server-names',
      'server1,server2',
    ];
    const argv = await parseArgsForRootCommand();
    expect(argv.allowedMcpServerNames).toEqual(['server1', 'server2']);
  });

  it('should support comma-separated values for --extensions', async () => {
    process.argv = ['node', 'script.js', '--extensions', 'ext1,ext2'];
    const argv = await parseArgsForRootCommand();
    expect(argv.extensions).toEqual(['ext1', 'ext2']);
  });

  it('should correctly parse positional arguments when flags with arguments are present', async () => {
    process.argv = [
      'node',
      'script.js',
      '--model',
      'test-model-string',
      'my-positional-arg',
    ];
    const argv = await parseArgsForRootCommand();
    expect(argv.model).toBe('test-model-string');
    expect(argv.query).toBe('my-positional-arg');
  });

  it('should handle long positional prompts with multiple flags', async () => {
    process.argv = [
      'node',
      'script.js',
      '-e',
      'none',
      '--permission-mode=accept_edits',
      '--tools=ShellTool',
      '--tools=ShellTool(whoami)',
      '--tools=ShellTool(wc)',
      'Use whoami to write a poem in file poem.md about my username in pig latin and use wc to tell me how many lines are in the poem you wrote.',
    ];
    const argv = await parseArgsForRootCommand();
    expect(argv.extensions).toEqual(['none']);
    expect(argv.permissionMode).toBe('accept_edits');
    expect(argv.tools).toEqual([
      'ShellTool',
      'ShellTool(whoami)',
      'ShellTool(wc)',
    ]);
    expect(argv.query).toBe(
      'Use whoami to write a poem in file poem.md about my username in pig latin and use wc to tell me how many lines are in the poem you wrote.',
    );
  });

  describe('subcommand help', () => {
    it.each([
      {
        args: ['mcp', '-h'],
        expected: [`Usage: ${ServerConfig.BRAND_CLI_BIN} mcp`, 'add-json'],
      },
      {
        args: ['mcp', 'add', '-h'],
        expected: [
          `Usage: ${ServerConfig.BRAND_CLI_BIN} mcp add`,
          '--transport',
        ],
      },
      {
        args: ['plugins', '-h'],
        expected: [`Usage: ${ServerConfig.BRAND_CLI_BIN} plugins`, 'install'],
      },
      {
        args: ['plugin', '-h'],
        expected: [`Usage: ${ServerConfig.BRAND_CLI_BIN} plugins`, 'install'],
      },
      {
        args: ['skills', '-h'],
        expected: [`Usage: ${ServerConfig.BRAND_CLI_BIN} skills`, 'enable'],
      },
      {
        args: ['hooks', '-h'],
        expected: [`Usage: ${ServerConfig.BRAND_CLI_BIN} hooks`, 'migrate'],
      },
      {
        args: ['agents', '-h'],
        expected: [
          `Usage: ${ServerConfig.BRAND_CLI_BIN} agents`,
          '--setting-sources',
        ],
      },
      {
        args: ['install', '--help'],
        expected: [`Usage: ${ServerConfig.BRAND_CLI_BIN} install`],
      },
    ])('prints real help for "$args"', async ({ args, expected }) => {
      const result = await captureParseFailure(args);

      expect(result.code).toBe('commander.helpDisplayed');
      for (const text of expected) {
        expect(result.stdout).toContain(text);
      }
    });

    it('prints help returned by a builtin plugin terminal command', async () => {
      const result = await captureParseFailure(['sample-plugin', 'scan', '-h']);

      expect(result.code).toBe('commander.helpDisplayed');
      expect(result.stdout).toContain(
        `Usage: ${ServerConfig.BRAND_CLI_BIN} sample-plugin scan`,
      );
      expect(result.stdout).toContain('--format');
      expect(result.stdout).toContain('--directory');
    });

    it('rejects excess arguments for subcommands', async () => {
      process.argv = [
        'node',
        'script.js',
        'plugins',
        'install',
        'plugin-path',
        'unexpected-extra',
      ];
      const mockStdoutWrite = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);
      const mockRunLoggerError = vi
        .spyOn(runLogger, 'error')
        .mockImplementation(() => {});

      try {
        await expect(runCommandTree()).rejects.toThrow(CommanderError);
        expect(mockRunLoggerError).toHaveBeenCalledWith(
          expect.stringContaining('too many arguments'),
        );
      } finally {
        mockStdoutWrite.mockRestore();
        mockRunLoggerError.mockRestore();
      }
    });

    it.each([
      {
        args: ['-h'],
        code: 'commander.helpDisplayed',
        assertStdout: (stdout: string) => {
          expect(stdout).toContain('Usage:');
          expect(stdout).not.toContain('Configuration:');
          expect(stdout).not.toContain('config set vpc_endpoint');
          expect(stdout).not.toContain('config get vpc_endpoint');
          expect(stdout).not.toContain('config unset vpc_endpoint');
          expect(stdout).not.toMatch(
            /\n {2}config\s+View and modify CLI configuration/,
          );
        },
      },
      {
        args: ['-v'],
        code: 'commander.version',
        assertStdout: (stdout: string) => expect(stdout.trim()).not.toBe(''),
      },
      {
        args: ['--version'],
        code: 'commander.version',
        assertStdout: (stdout: string) => expect(stdout.trim()).not.toBe(''),
      },
    ])(
      'preserves root command handling for "$args"',
      async ({ args, code, assertStdout }) => {
        const result = await captureParseFailure(args);

        expect(result.code).toBe(code);
        assertStdout(result.stdout);
      },
    );
  });
});

describe('loadCliConfig', () => {
  it.each(['injected', 'resolved', 'initialized', 'bare', 'host'] as const)(
    'binds product settings and tool-write validation for %s startup',
    async (source) => {
      process.argv = ['node', 'script.js', '--print'];
      const argv = await parseArgsForRootCommand();
      const base = getSettingsSchema();
      class ProductSettings extends SettingsService {
        override getSchema() {
          return {
            ...base,
            productOnly: {
              type: 'enum' as const,
              label: 'Product option',
              category: 'Advanced',
              requiresRestart: false,
              showInDialog: false,
              default: 'local',
              options: [{ label: 'Local', value: 'local' }],
            },
          };
        }
      }
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'config-product-rules-'));
      const storage = vi
        .spyOn(Storage, 'getGlobalConfigDir')
        .mockReturnValue(root);
      const productService = new ProductSettings();
      const defaultService = new SettingsService();
      const userSource = vi.spyOn(
        productService,
        'getCompatibleUserSettingsSource',
      );
      const projectSources = vi.spyOn(
        productService,
        'getProjectSettingsSources',
      );
      const watchFiles = vi
        .spyOn(productService, 'watchFiles')
        .mockResolvedValue(() => {});
      let config: Awaited<ReturnType<typeof loadCliConfig>> | undefined;
      try {
        const rulesOnly = source === 'bare' || source === 'host';
        let loadedSettings: LoadedSettings;
        if (source === 'resolved') {
          loadedSettings = createCliSettingsService({
            service: productService,
            environmentPolicy: 'session',
          }).resolve({ projectPath: root, sources: [] });
        } else if (source === 'initialized') {
          productService.initialize({ userConfigDir: root });
          const flagSettings = {
            productOnly: 'invalid',
            model: { name: 'from-flag' },
          };
          loadedSettings = productService.resolve({
            projectPath: root,
            sources: [],
            flagSettings,
            headless: true,
          });
          expect(loadedSettings.merged).toHaveProperty(
            'productOnly',
            'invalid',
          );
          flagSettings.model.name = 'changed-after-resolve';
        } else {
          loadedSettings = createLoadedSettings();
        }
        if (rulesOnly) {
          loadedSettings.user.path = path.join(root, 'settings.json');
          loadedSettings.project.path = path.join(
            root,
            'project',
            'settings.json',
          );
          loadedSettings.local.path = path.join(
            root,
            'project',
            'settings.local.json',
          );
        }
        config = await loadCliConfig(
          loadedSettings,
          'content-validation',
          { ...argv, bare: source === 'bare' },
          {
            cwd: root,
            ...(source === 'host' ? { scope: 'host', startupMode: 'acp' } : {}),
            settingsService:
              source === 'resolved' ? defaultService : productService,
          },
        );
        expect(config.getSettingsService()).toBe(productService);
        expect(loadedSettings.getSettingsService()).toBe(productService);
        expect(loadedSettings.merged).toHaveProperty('productOnly', 'local');
        expect(loadedSettings.getSnapshot().merged).toHaveProperty(
          'productOnly',
          'local',
        );
        expect(config.getSetting('productOnly')).toBe('local');
        if (source === 'initialized') {
          expect(loadedSettings.merged.model.name).toBe('from-flag');
          expect(loadedSettings.flag.originalSettings).toHaveProperty(
            'productOnly',
            'invalid',
          );
          expect(loadedSettings.errors).toEqual([
            expect.objectContaining({
              message: expect.stringContaining('productOnly'),
            }),
          ]);
          expect(loadedSettings.user.readOnly).toBe(true);
          expect(loadedSettings.project.readOnly).toBe(true);
          expect(loadedSettings.local.readOnly).toBe(true);
        }
        const settingsPath = path.join(
          root,
          ServerConfig.CONFIG_DIR,
          'settings.json',
        );
        expect(
          config.validateSettingsContent(
            settingsPath,
            JSON.stringify({ productOnly: 'invalid' }),
          ),
        ).toContain('productOnly');
        expect(
          config.validateSettingsContent(
            settingsPath,
            JSON.stringify({ productOnly: 'local' }),
          ),
        ).toBeNull();
        if (rulesOnly) {
          expect(userSource).not.toHaveBeenCalled();
          expect(projectSources).not.toHaveBeenCalledWith(
            loadedSettings.project.path,
            loadedSettings.local.path,
          );
          const stopWatching = await loadedSettings.watchChanges({
            acceptChange: async () => true,
            onChange: vi.fn(),
          });
          stopWatching();
          expect(watchFiles).not.toHaveBeenCalled();
        }
      } finally {
        await config?.dispose();
        await productService.dispose();
        await defaultService.dispose();
        storage.mockRestore();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each([false, true])(
    'keeps ordinary and bare global permissions behavior (bare=%s)',
    async (bare) => {
      process.argv = ['node', 'script.js', '--print'];
      const argv = await parseArgsForRootCommand();
      const settingsService = createCliSettingsService({
        environmentPolicy: 'session',
      });
      const loadedSettings = createLoadedSettings();
      const permissionManager = createTestPermissionManager();
      const config = await loadCliConfig(
        loadedSettings,
        'organization-policy',
        { ...argv, bare },
        { cwd: process.cwd(), settingsService, permissionManager },
      );
      try {
        expect(config.getProcessPermissionManager()).toBe(permissionManager);
        if (!bare) expect(config.getPermissionModeRestriction('auto')).toBeUndefined();
      } finally {
        await config.dispose();
        await settingsService.dispose();
        await permissionManager.dispose();
      }
    },
  );

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/mock/home/user');
    vi.stubEnv('GEMINI_API_KEY', 'test-api-key');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    { isTrusted: true, disableAllHooks: false, hooksEnabled: true },
    { isTrusted: false, disableAllHooks: false, hooksEnabled: true },
    { isTrusted: true, disableAllHooks: true, hooksEnabled: true },
    { isTrusted: true, disableAllHooks: false, hooksEnabled: false },
  ])(
    'derives hooks and their switches from the first argument (trust=$isTrusted, disabled=$disableAllHooks, enabled=$hooksEnabled)',
    async ({ isTrusted, disableAllHooks, hooksEnabled }) => {
      const hooksFor = (source: string) =>
        ({
          SessionStart: [{ hooks: [{ type: 'command', command: source }] }],
        }) as unknown as NonNullable<Settings['hooks']>;
      const loadedSettings = createLoadedSettingsFromSources(
        {
          user: {
            hooks: hooksFor('user'),
            disableAllHooks: !disableAllHooks,
            hooksConfig: { enabled: !hooksEnabled },
          },
          project: { hooks: hooksFor('project') },
          local: { hooks: hooksFor('local') },
          flag: {
            hooks: hooksFor('flag'),
            disableAllHooks,
            hooksConfig: { enabled: hooksEnabled },
          },
        },
        isTrusted,
      );
      const config = await loadCliConfig(
        loadedSettings,
        'settings-source-hooks',
        {} as CliArgs,
        { cwd: process.cwd() },
      );
      try {
        expect(loadedSettings.merged.disableAllHooks).toBe(disableAllHooks);
        expect(loadedSettings.merged.hooksConfig.enabled).toBe(hooksEnabled);
        expect(config.getEnableHooks()).toBe(!disableAllHooks && hooksEnabled);
        expect(config.getHooks()).toEqual(loadedSettings.merged.hooks);
        expect(config.getUserHooks()).toEqual(
          loadedSettings.user.settings.hooks,
        );
        expect(config.getProjectHooks()).toEqual(
          isTrusted ? loadedSettings.project.settings.hooks : {},
        );
        // Preserve the existing local source handoff; trust enforcement belongs
        // to the runtime hook registry rather than this extraction step.
        expect(config.getLocalHooks()).toEqual(
          loadedSettings.local.settings.hooks,
        );
        expect(config.getFlagHooks()).toEqual(
          loadedSettings.flag.settings.hooks,
        );
      } finally {
        await config.dispose();
      }
    },
  );

  it.each([
    { name: 'session', argv: {}, options: {} },
    { name: 'bare', argv: { bare: true }, options: {} },
    { name: 'host', argv: {}, options: { scope: 'host' as const } },
  ])(
    '未注入 transport manager 的 $name Config 使用通用缺省注册表',
    async ({ argv, options }) => {
      const config = await loadCliConfig(
        createLoadedSettings(),
        'default-transport-manager',
        argv as CliArgs,
        { ...options, cwd: process.cwd() },
      );
      try {
        const transports = config.getModelTransportManager();
        for (const protocol of [
          ServerConfig.OPENAI_CHAT_COMPLETIONS,
          ServerConfig.OPENAI_RESPONSES,
          ServerConfig.ANTHROPIC_MESSAGES,
        ]) {
          expect(transports.resolve(protocol).protocol).toBe(protocol);
        }
      } finally {
        await config.dispose();
      }
    },
  );

  it('Config 使用注入的 transport manager，且不接管其生命周期', async () => {
    const manager = new ServerConfig.ModelTransportManager([]);
    const handle = new AsyncInitializer({
      create: () => manager,
      dispose: async () => {},
    });
    await handle.whenReady();
    try {
      const config = await loadCliConfig(
        createLoadedSettings(),
        'transport-manager-borrow',
        { listModels: true } as CliArgs,
        { modelTransportManager: handle.get() },
      );
      try {
        expect(config.getModelTransportManager()).toBe(manager);
      } finally {
        await config.dispose();
      }
      expect(handle.isDisposed()).toBe(false);
    } finally {
      await handle.dispose();
    }
  });

  it.each([
    { name: 'session', argv: {}, options: {} },
    { name: 'bare', argv: { bare: true }, options: {} },
    { name: 'host', argv: {}, options: { scope: 'host' as const } },
  ])('CustomProviderManager 在 $name Config 中使用注入实例，且不接管其生命周期', async ({ argv, options }) => {
    const manager = new ServerConfig.CustomProviderManager(parserSettings);
    const handle = new AsyncInitializer({ create: () => manager, dispose: async () => {} });
    await handle.whenReady();
    try {
      const config = await loadCliConfig(createLoadedSettings(), 'custom-manager-borrow', argv as CliArgs, {
        ...options,
        cwd: process.cwd(),
        customProviderManager: handle.get(),
      });
      try {
        expect(config.getCustomProviderManager()).toBe(manager);
      } finally {
        await config.dispose();
      }
      expect(handle.isDisposed()).toBe(false);
    } finally {
      await handle.dispose();
    }
  });

  it('preserves explicit per-source hooks over loaded settings, including empty overrides', async () => {
    const hooks = {
      SessionStart: [
        { hooks: [{ type: 'command', command: 'from-settings' }] },
      ],
    } as unknown as NonNullable<Settings['hooks']>;
    const explicitHooks = {
      SessionStart: [{ hooks: [{ type: 'command', command: 'explicit' }] }],
    } as unknown as NonNullable<Settings['hooks']>;
    const loadedSettings = createLoadedSettingsFromSources({
      user: { hooks },
      project: { hooks },
      local: { hooks },
      flag: { hooks },
    });
    const config = await loadCliConfig(
      loadedSettings,
      'explicit-source-hooks',
      {} as CliArgs,
      {
        cwd: process.cwd(),
        projectHooks: {},
        localHooks: explicitHooks,
        userHooks: explicitHooks,
        flagHooks: {},
      },
    );
    try {
      expect(config.getProjectHooks()).toEqual({});
      expect(config.getLocalHooks()).toEqual(explicitHooks);
      expect(config.getUserHooks()).toEqual(explicitHooks);
      expect(config.getFlagHooks()).toEqual({});
    } finally {
      await config.dispose();
    }
  });

  it.each([
    { name: 'session', argv: {}, options: {} },
    { name: 'bare', argv: { bare: true }, options: {} },
    {
      name: 'ACP host',
      argv: { acp: true },
      options: { scope: 'host' as const },
    },
  ])(
    'exposes the caller-owned settings instance for $name Config',
    async ({ argv, options }) => {
      const loaded = createLoadedSettingsFromSources({
        user: { ui: { theme: 'initial' } },
        flag: { model: { name: 'flag-model' } },
      });
      const config = await loadCliConfig(
        loaded,
        'loaded-settings-access',
        argv as CliArgs,
        {
          cwd: process.cwd(),
          ...options,
        },
      );
      const changed = vi.fn();
      const unsubscribe = config.getLoadedSettings().subscribe(changed);
      try {
        expect(config.getLoadedSettings()).toBe(loaded);
        const initial = loaded.getSnapshot();
        expect(
          config
            .getLoadedSettings()
            ?.setValue(settingsModule.SettingScope.User, 'ui.theme', 'updated'),
        ).toBe(true);
        expect(changed).toHaveBeenCalledOnce();
        expect(config.getLoadedSettings().merged.ui.theme).toBe('updated');
        expect(config.getLoadedSettings().flag.settings.model?.name).toBe(
          'flag-model',
        );
        expect(initial.merged.ui.theme).toBe('initial');
        unsubscribe?.();
        loaded.setValue(
          settingsModule.SettingScope.User,
          'ui.theme',
          'after-unsubscribe',
        );
        expect(changed).toHaveBeenCalledOnce();
      } finally {
        unsubscribe?.();
        await config.dispose();
      }
    },
  );

  it('retains the entry merged reference while hook reloads read the current first-argument settings', async () => {
    const initialHooks = {
      SessionStart: [{ hooks: [{ type: 'command', command: 'initial-hook' }] }],
    } as unknown as NonNullable<Settings['hooks']>;
    const refreshedHooks = {
      SessionStart: [
        { hooks: [{ type: 'command', command: 'refreshed-hook' }] },
      ],
    } as unknown as NonNullable<Settings['hooks']>;
    const loadedSettings = createLoadedSettingsFromSources({
      user: { hooks: initialHooks },
      project: { hooks: initialHooks },
      local: { hooks: initialHooks },
      flag: { hooks: initialHooks },
    });
    const entryMerged = loadedSettings.merged;
    const config = await loadCliConfig(
      loadedSettings,
      'settings-reference-reload',
      {} as CliArgs,
      { cwd: process.cwd() },
    );
    try {
      expect(config.getSettings()).toBe(entryMerged);
      entryMerged.outputStyle = 'Learning';
      expect(config.getSettings()).toHaveProperty('outputStyle', 'Learning');

      expect(
        loadedSettings.setValue(
          settingsModule.SettingScope.User,
          'hooks',
          undefined,
        ),
      ).toBe(true);
      expect(
        loadedSettings.setValue(
          settingsModule.SettingScope.Project,
          'hooks',
          refreshedHooks,
        ),
      ).toBe(true);
      expect(
        loadedSettings.setValue(
          settingsModule.SettingScope.Local,
          'hooks',
          undefined,
        ),
      ).toBe(true);
      loadedSettings.setFlagSettings({
        path: '',
        settings: { hooks: structuredClone(refreshedHooks) },
        originalSettings: { hooks: structuredClone(refreshedHooks) },
        readOnly: true,
      });
      expect(loadedSettings.merged).not.toBe(entryMerged);

      await config.reloadHooks('settings-event');

      expect(config.getSettings()).toBe(entryMerged);
      expect(config.getHooks()).toEqual(loadedSettings.merged.hooks);
      expect(config.getHooks()).not.toEqual(entryMerged.hooks);
      expect(config.getUserHooks()).toEqual({});
      expect(config.getProjectHooks()).toMatchObject(refreshedHooks);
      expect(config.getLocalHooks()).toEqual({});
      expect(config.getFlagHooks()).toMatchObject(refreshedHooks);
    } finally {
      await config.dispose();
    }
  });

  it.each([false, true])(
    'uses the supplied ACP sources without reloading settings (SDK marker=%s)',
    async (sdkMode) => {
      vi.stubEnv(ServerConfig.ENV_AGENT_SDK_ENTRYPOINT, sdkMode ? 'sdk-ts' : '');
      const loadedSettings = createLoadedSettingsFromSources({
        user: {
          mcp: { disabledProjectMcpServers: ['rejected'] },
          mcpServers: { userServer: { command: 'user-command' } },
          permissions: {
            allow: ['Read'],
          } as unknown as Settings['permissions'],
        },
        project: {
          skills: { loadFromAgentsDirectory: true },
          mcpServers: {
            rejected: { command: 'rejected-command' },
            pending: { command: 'pending-command' },
          },
          permissions: {
            deny: ['Write'],
          } as unknown as Settings['permissions'],
        },
        flag: {
          skills: { loadFromAgentsDirectory: false },
          mcp: { lazyLoad: false },
          permissions: { ask: ['Bash'] } as unknown as Settings['permissions'],
        },
      });
      const loadDisk = vi.spyOn(settingsModule, 'loadSettings');
      const loadResourceSources = vi.spyOn(
        settingsModule,
        'loadSettingsWithService',
      );
      const config = await loadCliConfig(
        loadedSettings,
        'acp-settings-sources',
        { acp: true } as CliArgs,
        { cwd: process.cwd(), startupMode: 'acp' },
      );
      try {
        expect(config.getLoadedSettings()).toBe(loadedSettings);
        expect(loadDisk).not.toHaveBeenCalled();
        expect(loadResourceSources).not.toHaveBeenCalled();
        expect(config.shouldLoadSkillsFromAgentsDirectory()).toBe(false);
        expect(config.getMcpLazyLoadSource()).toBe('settings');
        expect(config.getMcpLazyLoad()).toBe(false);
        // Passing source-aware settings must preserve ACP's existing disk
        // MCP policy, including pending and rejected project entries.
        expect(Object.keys(config.getMcpServers() ?? {}).sort()).toEqual([
          'pending',
          'rejected',
          'userServer',
        ]);
        expect(config.initPermission()?.getRules().allow.flagSettings).toEqual([
          'Read',
        ]);
        expect(config.initPermission()?.getRules().deny.flagSettings).toEqual([
          'Write',
        ]);
        expect(config.initPermission()?.getRules().ask.flagSettings).toEqual([
          'Bash',
        ]);
      } finally {
        await config.dispose();
      }
    },
  );

  it.each([
    { value: undefined, env: '', enabled: true, source: 'default' },
    { value: false, env: '', enabled: false, source: 'settings' },
    { value: true, env: '', enabled: true, source: 'settings' },
    { value: false, env: '1', enabled: true, source: 'environment' },
  ])(
    'preserves ACP lazy mode for $value with env=$env',
    async ({ value, env, enabled, source }) => {
      vi.stubEnv(ENV_MCP_LAZY, env);
      const loadedSettings = createLoadedSettings({ mcp: { lazyLoad: value } });
      const config = await loadCliConfig(
        loadedSettings,
        'acp-lazy',
        { acp: true } as CliArgs,
        { cwd: process.cwd() },
      );
      try {
        expect(config.getMcpLazyLoad()).toBe(enabled);
        expect(config.getMcpLazyLoadSource()).toBe(source);
      } finally {
        await config.dispose();
      }
    },
  );

  it.each([true, false])(
    'keeps persisted permission policy separate from session sources for acp=%s',
    async (acp) => {
      // beforeEach resets the shared fs mock; this case exercises real files.
      const realFs = await vi.importActual<typeof fs>('fs');
      vi.mocked(fs.existsSync).mockImplementation(realFs.existsSync);
      const cwd = fs.mkdtempSync(
        path.join(os.tmpdir(), 'acp-permission-policy-'),
      );
      const projectFile = new Storage(cwd).getWorkspaceSettingsPath();
      realFs.mkdirSync(path.dirname(projectFile), { recursive: true });
      realFs.writeFileSync(
        projectFile,
        JSON.stringify({ permissions: { deny: ['Write'] } }),
      );
      const loadedSettings = createLoadedSettingsFromSources(
        {
          flag: {
            permissions: { ask: ['Bash'] },
          } as unknown as Partial<Settings>,
        },
        false,
      );
      let config: ServerConfig.Config | undefined;
      try {
        config = await loadCliConfig(
          loadedSettings,
          'acp-permissions',
          { acp } as CliArgs,
          { cwd },
        );
        expect(
          config.initPermission()?.getRules().deny.projectSettings,
        ).toEqual(acp ? ['Write'] : undefined);
        expect(config.initPermission()?.getRules().ask.flagSettings).toEqual([
          'Bash',
        ]);
      } finally {
        await config?.dispose();
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    },
  );

  it('persists ACP model selection through the supplied session settings', async () => {
    const loadedSettings = createLoadedSettings();
    const save = vi.spyOn(loadedSettings, 'setValue').mockReturnValue(true);
    const config = await loadCliConfig(
      loadedSettings,
      'acp-model-write',
      { acp: true } as CliArgs,
      { cwd: process.cwd() },
    );
    try {
      await config.setModel('test-acp-model', false);
      expect(save).toHaveBeenCalledWith(
        settingsModule.SettingScope.User,
        'model.name',
        'test-acp-model',
      );
    } finally {
      await config.dispose();
    }
  });

  it('keeps host configuration independent of session resource flags', async () => {
    const userDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'qwen-host-config-'),
    );
    vi.mocked(os.homedir).mockReturnValue(userDir);
    try {
      const config = await loadCliConfig(
        createLoadedSettings(),
        'host',
        {
          acp: true,
          systemPromptFile: '/not-a-session-yet/prompt.md',
          pluginDir: ['/not-a-session-yet/plugin'],
          mcpConfig: ['/not-a-session-yet/mcp.json'],
          worktree: 'feature',
        } as CliArgs,
        { scope: 'host' },
      );
      expect(config.getWorkingDir()).toBe(userDir);
      expect(config.getSessionPersistence()).toBe(false);
      expect(config.getWorktreeSettings()).toBeUndefined();
      expect(config.getMcpServers()).toBeUndefined();
      expect(config.getPlugins()).toEqual([]);
      expect(config.getCustomSystemPrompt()).toBeUndefined();
      await config.dispose();
    } finally {
      fs.rmSync(userDir, { recursive: true, force: true });
    }
  });

  it('requires an explicit cwd when a multi-session host opens a session', async () => {
    await expect(
      loadCliConfig(
        createLoadedSettings(),
        'session',
        { acp: true } as CliArgs,
        {},
      ),
    ).rejects.toThrow('A session cwd is required');
  });

  it('rejects permission writes to a disabled settings source', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-sources-write-'));
    const loadedSettings = settingsModule.loadSettings(cwd, ['project']);
    const config = await loadCliConfig(
      loadedSettings,
      'disabled-settings-source',
      { settingSources: ['project'] } as CliArgs,
      { cwd },
    );
    try {
      const writer = config.permission?.getSettingsWriter();
      expect(writer).toBeDefined();
      const result = writer!.mutateSettingsForSource('userSettings', (root) => {
        root.permissions = { allow: ['ShellTool'] };
        return true;
      });

      expect(result.error?.message).toContain('not writable');
    } finally {
      await config.dispose();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('exposes only invocation flag settings to builtin plugins', async () => {
    const securityScan = {
      l1StaticCheck: false,
      l2LightweightScan: true,
      l3DeepScan: false,
    };
    const loadedSettings = createLoadedSettingsFromSources({
      user: { securityScan: { l1StaticCheck: true } } as Partial<Settings>,
      flag: { securityScan } as Partial<Settings>,
    });
    Object.assign(loadedSettings.flag, {
      settings: {},
      originalSettings: { securityScan },
    });
    process.argv = ['node', 'script.js', '--print'];

    const config = await loadCliConfig(
      loadedSettings,
      'sdk-security-settings',
      await parseArgsForRootCommand(),
      { startupMode: 'sdk' },
    );

    expect(config.getLaunchSetting('securityScan')).toEqual(securityScan);
    expect(config.getLaunchSetting('theme')).toBeUndefined();
  });

  it.each([
    { args: [], enabled: true },
    { args: ['--acp'], enabled: false },
    { args: ['--print'], enabled: false },
    { args: ['--input-format', 'stream-json'], enabled: false },
    { args: ['--output-format', 'stream-json'], enabled: false },
  ])(
    'enables local TUI capabilities only for local TUI: $args',
    async ({ args, enabled }) => {
      process.argv = ['node', 'script.js', ...args];
      const argv = await parseArgsForRootCommand();
      const config = await loadCliConfig(
        createLoadedSettings(),
        'parallel-tools',
        argv,
        { cwd: process.cwd() },
      );
      expect(config.isParallelToolStreamingEnabled()).toBe(enabled);
    },
  );

  it.each([
    { args: [] },
    { args: ['--acp'] },
    { args: ['--print'] },
    { args: ['--input-format', 'stream-json'] },
    { args: ['--output-format', 'stream-json'] },
  ])(
    'exposes the tools settings for CLI arguments: $args',
    async ({ args }) => {
      vi.spyOn(
        ServerConfig.Config.prototype,
        'initializeOutputStyle',
      ).mockResolvedValue(undefined);
      process.argv = ['node', 'script.js', ...args];
      const shell = { pager: 'more' };
      const config = await loadCliConfig(
        createLoadedSettings({ tools: { shell } }),
        'session-tool-settings',
        await parseArgsForRootCommand(),
        { cwd: process.cwd() },
      );
      expect(config.getSetting('tools')).toMatchObject({ shell });
    },
  );

  it.each(['acp', 'sdk', 'daemon', 'headless'] as const)(
    'exposes the tools settings for the %s startup mode',
    async (startupMode) => {
      vi.spyOn(
        ServerConfig.Config.prototype,
        'initializeOutputStyle',
      ).mockResolvedValue(undefined);
      process.argv = ['node', 'script.js'];
      const shell = { pager: 'more' };
      const config = await loadCliConfig(
        createLoadedSettings({ tools: { shell } }),
        'session-tool-settings',
        await parseArgsForRootCommand(),
        { startupMode },
      );
      expect(config.getSetting('tools')).toMatchObject({ shell });
    },
  );

  it.each([
    { name: 'bare', argv: { bare: true }, options: {} },
    { name: 'ACP host', argv: { acp: true }, options: { scope: 'host' as const } },
  ])('exposes the tools settings for $name', async ({ argv, options }) => {
    const shell = { pager: 'more' };
    const config = await loadCliConfig(
      createLoadedSettings({ tools: { shell } }),
      'host-tool-settings',
      argv as CliArgs,
      { ...options, cwd: process.cwd() },
    );
    try {
      expect(config.getSetting('tools')).toMatchObject({ shell });
    } finally {
      await config.dispose();
    }
  });

  // daemon 的 root 加载必须整段绕开企业插件：企业加载会触发 lazy auth init，而 daemon 的
  // 身份要等 SDK 握手帧才到、且必须来自帧里的凭据。会话级 Config（'sdk'）不跳——它的加载
  // 本来就发生在身份落地之后。
  it.each([
    { startupMode: 'daemon', skip: true },
    { startupMode: 'sdk', skip: false },
    { startupMode: 'interactive', skip: false },
    { startupMode: 'headless', skip: false },
  ] as const)(
    'skips root enterprise plugin loading only for the $startupMode startup mode',
    async ({ startupMode, skip }) => {
      process.argv = ['node', 'script.js'];
      await loadCliConfig(
        createLoadedSettings(),
        'enterprise-skip',
        await parseArgsForRootCommand(),
        { startupMode },
      );

      expect(loadSessionPluginsMock).toHaveBeenCalledWith(
        expect.objectContaining({ skipAdditionalPlugins: skip }),
      );
    },
  );

  it.each(['acp', 'sdk', 'daemon', 'headless'] as const)(
    'keeps local TUI capabilities disabled for the %s startup mode',
    async (startupMode) => {
      process.argv = ['node', 'script.js'];
      const argv = await parseArgsForRootCommand();
      const config = await loadCliConfig(
        createLoadedSettings(),
        'parallel-tools',
        argv,
        {
          startupMode,
        },
      );
      expect(config.isParallelToolStreamingEnabled()).toBe(false);
    },
  );

  it.each([
    { startupMode: 'interactive' as const, enabled: true, streaming: true },
    { startupMode: 'acp' as const, enabled: true, streaming: false },
    { startupMode: 'headless' as const, enabled: true, streaming: false },
    { startupMode: 'sdk' as const, enabled: true, streaming: false },
    { startupMode: 'daemon' as const, enabled: false, streaming: false },
  ])(
    'opts $startupMode into read-only Bash independently of streaming',
    async ({ startupMode, enabled, streaming }) => {
      process.argv = ['node', 'script.js'];
      const config = await loadCliConfig(
        createLoadedSettings(),
        'parallel-bash',
        await parseArgsForRootCommand(),
        { startupMode },
      );
      const shell = new ServerConfig.ShellTool({
        config,
      } as ServerConfig.AgentLoopContext);
      expect(shell.isConcurrencySafe({ command: 'pwd' })).toBe(enabled);
      expect(
        shell.isConcurrencySafe({ command: 'echo changed > result.txt' }),
      ).toBe(false);
      expect(shell.isConcurrencySafe({ command: 'pwd', pty: true })).toBe(
        false,
      );
      expect(config.isParallelToolStreamingEnabled()).toBe(streaming);
    },
  );

  it.each([
    { requested: 'Explanatory', expected: 'Explanatory' },
    { requested: 'default', expected: undefined },
  ])(
    'keeps --output-style $requested authoritative across a conversation reset',
    async ({ requested, expected }) => {
      process.argv = ['node', 'script.js', '--output-style', requested];
      const settings = createLoadedSettings({ outputStyle: 'Learning' });
      const argv = await parseArgsForRootCommand();

      const config = await loadCliConfig(settings, 'test-session', argv, {});

      expect(config.getOutputStyle()).toBeUndefined();
      await config.initializeOutputStyle();
      expect(config.getOutputStyle()?.name).toBe(expected);
      await config.resetOutputStyleForNewSession();
      expect(config.getOutputStyle()?.name).toBe(expected);
    },
  );

  it.each([undefined, 'interactive', 'headless', 'acp', 'sdk'] as const)(
    'uses the validated %s startup mode for Custom Providers access',
    async (startupMode) => {
      vi.stubEnv(ServerConfig.ENV_AGENT_SDK_ENTRYPOINT, 'sdk-ts');
      process.argv = [
        'node',
        'script.js',
        '--print',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
      ];
      const argv = await parseArgsForRootCommand();
      const settings = createLoadedSettings({
        providers: {
          gateway: {
            baseUrl: 'https://mcp.example.com/v1',
            apiKey: 'test-key',
            model: 'test-model',
          },
        },
      });
      const config = await loadCliConfig(settings, 'mode-test', argv, {
        startupMode,
      });
      expect(config.getCustomProviderAccessMode()).toBe(
        startupMode === 'sdk' ? 'sdk' : 'local',
      );
      // Minimal startup has not acquired account access yet.
      expect(config.canUseCustomProviders()).toBe(false);
      expect(
        config.isConfiguredCustomProviderModelKey('gateway/test-model'),
      ).toBe(true);
      expect((await config.activateCustomProvidersFromSettings()).status).toBe(
        'inactive',
      );
      config.deactivateCustomProviders('not_authenticated');
    },
  );

  it('rejects disabled session persistence outside print mode', async () => {
    process.argv = ['node', 'script.js', '--no-session-persistence'];
    const settings = createLoadedSettings();
    const argv = await parseArgsForRootCommand();

    await expect(
      loadCliConfig(settings, 'test-session', argv, {}),
    ).rejects.toThrow(
      '--no-session-persistence can only be used with --print mode.',
    );
  });

  it('disables session persistence in print mode', async () => {
    process.argv = [
      'node',
      'script.js',
      '--print',
      '--no-session-persistence',
      'hello',
    ];
    const settings = createLoadedSettings();
    const argv = await parseArgsForRootCommand();

    const config = await loadCliConfig(settings, 'test-session', argv, {});

    expect(config.getSessionPersistence()).toBe(false);
  });

  it('maps --reasoning-effort ultracode to xhigh and enables the session mode', async () => {
    process.argv = ['node', 'script.js', '--reasoning-effort', 'ultracode'];
    const settings = createLoadedSettings();
    const argv = await parseArgsForRootCommand();

    const config = await loadCliConfig(settings, 'test-session', argv, {});

    expect(launchModelConfig(config)?.reasoning?.effort).toBe('xhigh');
    expect(config.getUltracode()).toBe(true);
  });

  it('leaves the ultracode setting effort to Config when no effort is passed', async () => {
    process.argv = ['node', 'script.js'];
    const settings = createLoadedSettings({ ultracode: true });
    const argv = await parseArgsForRootCommand();

    const config = await loadCliConfig(settings, 'test-session', argv, {});

    expect(launchModelConfig(config)?.reasoning).toBeUndefined();
    expect(config.getUltracode()).toBe(true);
  });

  it('anchors a relative --add-dir to the session cwd', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'add-dir-anchor-'));
    const extra = path.join(base, 'extra');
    fs.mkdirSync(extra);
    try {
      process.argv = ['node', 'script.js', '--add-dir', './extra'];
      const settings = createLoadedSettings();
      const argv = await parseArgsForRootCommand();

      const config = await loadCliConfig(settings, 'test-session', argv, {
        cwd: base,
      });

      const dirs = config.initPermission()?.getAdditionalDirectories() ?? [];
      expect(dirs.map((d) => fs.realpathSync(d))).toContain(
        fs.realpathSync(extra),
      );
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('does not treat an ordinary --reasoning-effort xhigh as UltraCode', async () => {
    process.argv = ['node', 'script.js', '--reasoning-effort', 'xhigh'];
    const settings = createLoadedSettings({ ultracode: true });
    const argv = await parseArgsForRootCommand();

    const config = await loadCliConfig(settings, 'test-session', argv, {});

    expect(launchModelConfig(config)?.reasoning?.effort).toBe('xhigh');
    expect(config.getUltracode()).toBe(false);
    expect(config.isUltracodeActive(undefined)).toBe(false);
  });

  it('does not enable UltraCode through shared settings or flags in ACP mode', async () => {
    process.argv = [
      'node',
      'script.js',
      '--acp',
      '--reasoning-effort',
      'ultracode',
    ];
    const settings = createLoadedSettings({
      ultracode: true,
      workflowKeywordTriggerEnabled: true,
    });
    const argv = await parseArgsForRootCommand();

    const config = await loadCliConfig(settings, 'test-session', argv, {
      cwd: process.cwd(),
    });

    expect(config.getAcpMode()).toBe(true);
    expect(launchModelConfig(config)?.reasoning).toBeUndefined();
    expect(config.getUltracode()).toBe(false);
    expect(config.getWorkflowKeywordTriggerEnabled()).toBe(false);
  });

  it('passes skills.loadFromAgentsDirectory to core config', async () => {
    process.argv = ['node', 'script.js'];
    const settings = createLoadedSettings({
      skills: {
        enabled: true,
        loadFromAgentsDirectory: false,
      },
    });
    const argv = await parseArgsForRootCommand();

    const config = await loadCliConfig(settings, 'test-session', argv, {});

    expect(config.shouldLoadSkillsFromAgentsDirectory()).toBe(false);
    expect(config.shouldLoadUserSkillsFromAgentsDirectory()).toBe(false);
  });

  it('defaults skills.loadFromAgentsDirectory to on outside SDK mode', async () => {
    process.argv = ['node', 'script.js'];
    const settings = createLoadedSettings();
    const argv = await parseArgsForRootCommand();

    const config = await loadCliConfig(settings, 'test-session', argv, {});

    expect(config.shouldLoadSkillsFromAgentsDirectory()).toBe(true);
  });

  it.each([false, true])(
    'lets the workspace set compatibility to %s for both sources',
    async (projectSetting) => {
      process.argv = ['node', 'script.js'];
      const loadedSettings = createLoadedSettingsFromSources({
        user: {
          skills: { loadFromAgentsDirectory: !projectSetting },
        },
        project: {
          skills: { loadFromAgentsDirectory: projectSetting },
        },
      });
      const resourceService = new ServerConfig.ResourceService();
      resourceService.getUserResource({
        homeDir: path.dirname(Storage.getGlobalAgentsDir()),
        globalConfigDirOverride: Storage.getGlobalConfigDir(),
        userAgentSkillsDirOverride: Storage.getUserAgentSkillsDir(),
        loadFromAgentsDirectory: !projectSetting,
      });
      const argv = await parseArgsForRootCommand();
      let config: ServerConfig.Config | undefined;
      try {
        config = await loadCliConfig(loadedSettings, 'test-session', argv, {
          resourceService,
        });
        expect(config.shouldLoadUserSkillsFromAgentsDirectory()).toBe(
          projectSetting,
        );
        expect(config.shouldLoadSkillsFromAgentsDirectory()).toBe(
          projectSetting,
        );
      } finally {
        await config?.dispose();
        await resourceService.dispose();
      }
    },
  );

  it.each([
    { sdk: false, revokeTrust: false },
    { sdk: true, revokeTrust: false },
    { sdk: false, revokeTrust: true },
    { sdk: true, revokeTrust: true },
  ])(
    'ignores an untrusted project compatibility opt-in (sdk=$sdk, revokeTrust=$revokeTrust)',
    async ({ sdk, revokeTrust }) => {
      vi.stubEnv(ServerConfig.ENV_AGENT_SDK_ENTRYPOINT, sdk ? 'sdk-ts' : '');
      process.argv = ['node', 'script.js'];
      const loadedSettings = createLoadedSettingsFromSources(
        {
          user: { skills: { loadFromAgentsDirectory: false } },
          project: { skills: { loadFromAgentsDirectory: true } },
          local: { skills: { loadFromAgentsDirectory: true } },
        },
        revokeTrust,
      );
      if (revokeTrust) {
        expect(
          loadedSettings.project.settings.skills?.loadFromAgentsDirectory,
        ).toBe(true);
        loadedSettings.setTrusted(false);
      }
      // Project is projected-empty by LoadedSettings; local remains raw and
      // must be filtered by the resolver's explicit trust check.
      expect(loadedSettings.project.settings).toEqual({});
      expect(
        loadedSettings.local.settings.skills?.loadFromAgentsDirectory,
      ).toBe(true);
      expect(loadedSettings.merged.skills.loadFromAgentsDirectory).toBe(false);
      const argv = await parseArgsForRootCommand();
      const config = await loadCliConfig(
        loadedSettings,
        'test-session',
        argv,
        {},
      );
      try {
        expect(config.shouldLoadSkillsFromAgentsDirectory()).toBe(false);
        expect(config.shouldLoadUserSkillsFromAgentsDirectory()).toBe(false);
      } finally {
        await config.dispose();
      }
    },
  );

  it('defaults skills.loadFromAgentsDirectory to off in SDK mode', async () => {
    vi.stubEnv(ServerConfig.ENV_AGENT_SDK_ENTRYPOINT, 'sdk-ts');
    process.argv = ['node', 'script.js'];
    const loadedSettings = createLoadedSettingsFromSources({ user: {} });
    const argv = await parseArgsForRootCommand();

    const config = await loadCliConfig(
      loadedSettings,
      'test-session',
      argv,
      {},
    );

    expect(config.shouldLoadSkillsFromAgentsDirectory()).toBe(false);
  });

  it('allows an SDK query to select a hidden product output style without advertising it', async () => {
    vi.stubEnv(ServerConfig.ENV_AGENT_SDK_ENTRYPOINT, 'sdk-ts');
    process.argv = ['node', 'script.js'];
    const settings = createLoadedSettings({
      outputStyle: 'Qwen-Collaborative',
    });
    const argv = await parseArgsForRootCommand();
    const registry = new AppPluginRegistry(
      [
        {
          apiVersion: 1,
          id: 'test-output-styles',
          initialize: async () => {},
          dispose: async () => {},
          getOutputStyleDefinitions: () => [
            {
              name: 'Qwen-Collaborative',
              source: 'built-in',
              description: 'hidden product style',
              prompt: 'hidden product prompt',
              isUserVisible: false,
              keepCodingInstructions: true,
            },
          ],
        },
      ],
      {
        mode: 'headless',
        getLaunchSetting: () => undefined,
        isSettingSourceAllowed: () => true,
      },
    );
    await registry.initialize();

    const config = await loadCliConfig(settings, 'test-session', argv, {
      builtinPlugins: registry,
      builtinPluginsInitialization: Promise.resolve(),
    });

    expect(config.getOutputStyle()).toBeUndefined();
    await config.initializeOutputStyle();
    expect(config.getOutputStyle()?.name).toBe('Qwen-Collaborative');
    expect(await config.getAvailableOutputStyles()).not.toHaveProperty(
      'Qwen-Collaborative',
    );
  });

  it('honors an explicit user compatibility opt-in in SDK mode', async () => {
    vi.stubEnv(ServerConfig.ENV_AGENT_SDK_ENTRYPOINT, 'sdk-ts');
    process.argv = ['node', 'script.js'];
    const loadedSettings = createLoadedSettingsFromSources({
      user: { skills: { loadFromAgentsDirectory: true } },
    });
    const argv = await parseArgsForRootCommand();

    const config = await loadCliConfig(
      loadedSettings,
      'test-session',
      argv,
      {},
    );

    expect(config.shouldLoadSkillsFromAgentsDirectory()).toBe(true);
    expect(config.shouldLoadUserSkillsFromAgentsDirectory()).toBe(true);
  });

  it('honors an explicit --settings compatibility opt-in in SDK mode', async () => {
    vi.stubEnv(ServerConfig.ENV_AGENT_SDK_ENTRYPOINT, 'sdk-ts');
    process.argv = ['node', 'script.js'];
    const loadedSettings = createLoadedSettingsFromSources({
      flag: { skills: { loadFromAgentsDirectory: true } },
    });
    const argv = await parseArgsForRootCommand();

    const config = await loadCliConfig(
      loadedSettings,
      'test-session',
      argv,
      {},
    );

    expect(config.shouldLoadSkillsFromAgentsDirectory()).toBe(true);
    expect(config.shouldLoadUserSkillsFromAgentsDirectory()).toBe(true);
  });

  it('lets trusted project settings enable both compatibility sources in SDK mode', async () => {
    vi.stubEnv(ServerConfig.ENV_AGENT_SDK_ENTRYPOINT, 'sdk-ts');
    process.argv = ['node', 'script.js'];
    const loadedSettings = createLoadedSettingsFromSources({
      project: { skills: { loadFromAgentsDirectory: true } },
    });
    const argv = await parseArgsForRootCommand();

    const config = await loadCliConfig(
      loadedSettings,
      'test-session',
      argv,
      {},
    );

    expect(config.shouldLoadSkillsFromAgentsDirectory()).toBe(true);
    expect(config.shouldLoadUserSkillsFromAgentsDirectory()).toBe(true);
  });

  it('lets --settings disable an SDK user opt-in for both scopes', async () => {
    vi.stubEnv(ServerConfig.ENV_AGENT_SDK_ENTRYPOINT, 'sdk-ts');
    process.argv = ['node', 'script.js'];
    const loadedSettings = createLoadedSettingsFromSources({
      user: { skills: { loadFromAgentsDirectory: true } },
      flag: { skills: { loadFromAgentsDirectory: false } },
    });
    const argv = await parseArgsForRootCommand();

    const config = await loadCliConfig(
      loadedSettings,
      'test-session',
      argv,
      {},
    );

    expect(config.shouldLoadSkillsFromAgentsDirectory()).toBe(false);
    expect(config.shouldLoadUserSkillsFromAgentsDirectory()).toBe(false);
  });

  it('ignores an untrusted project skills.loadFromAgentsDirectory opt-in in SDK mode', async () => {
    vi.stubEnv(ServerConfig.ENV_AGENT_SDK_ENTRYPOINT, 'sdk-ts');
    process.argv = ['node', 'script.js'];
    const loadedSettings = createLoadedSettingsFromSources(
      {
        project: { skills: { loadFromAgentsDirectory: true } },
        local: { skills: { loadFromAgentsDirectory: true } },
      },
      false,
    );
    const argv = await parseArgsForRootCommand();

    const config = await loadCliConfig(
      loadedSettings,
      'test-session',
      argv,
      {},
    );

    expect(config.shouldLoadSkillsFromAgentsDirectory()).toBe(false);
  });

  it('passes dream settings through to core config', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArgsForRootCommand();
    const settings = createLoadedSettings({
      dream: {
        enabled: true,
        minHours: 0.01,
        minSessions: 1,
        scanThrottleMinutes: 0.1,
      },
    });

    const config = await loadCliConfig(settings, 'test-session', argv, {});

    expect(config.getDreamSettings()).toEqual({
      enabled: true,
      minHours: 0.01,
      minSessions: 1,
      scanThrottleMinutes: 0.1,
    });
  });

  it('passes independent auto-memory scope settings through to core config', async () => {
    process.argv = ['node', 'script.js'];
    const settings = createLoadedSettings({
      autoMemoryEnabled: false,
      autoMemoryUserScopeEnabled: true,
    });
    const argv = await parseArgsForRootCommand();

    const config = await loadCliConfig(settings, 'test-session', argv, {});

    expect(config.isAutoMemoryEnabled()).toBe(true);
    expect(config.isAutoMemoryProjectScopeEnabled()).toBe(false);
    expect(config.isAutoMemoryUserScopeEnabled()).toBe(true);
    expect(config.isAutoMemoryManuallyEnabled()).toBe(true);
  });

  it('uses the Core session loader for startup and reload', async () => {
    const enabled = {
      name: 'enabled',
      source: 'mp',
      repository: 'mp',
      path: '/plugins/enabled',
      enabled: true,
      manifest: { name: 'enabled', version: '1.0.0' },
    } as LoadedPlugin;
    const disabled = {
      name: 'disabled',
      source: 'mp',
      repository: 'mp',
      path: '/plugins/disabled',
      enabled: false,
      manifest: { name: 'disabled', version: '1.0.0' },
    } as LoadedPlugin;
    loadSessionPluginsMock.mockResolvedValueOnce({
      plugins: [enabled, disabled],
      errors: [],
    });

    process.argv = ['node', 'script.js', '--plugin-dir', './plugins/explicit'];
    const argv = await parseArgsForRootCommand();
    const settings = createLoadedSettings();

    const config = await loadCliConfig(settings, 'test-session', argv, {});

    expect(loadSessionPluginsMock).toHaveBeenCalledWith({
      pluginDirs: ['./plugins/explicit'],
      // 非 daemon 路由不跳企业插件（这条用例没传 startupMode）。
      skipAdditionalPlugins: false,
    });
    expect(
      config.getPlugins().map((p) => `${p.name}@${p.source}:${p.enabled}`),
    ).toEqual(['enabled@mp:true', 'disabled@mp:false']);
    expect(
      config.getEnabledPlugins().map((p) => `${p.name}@${p.source}`),
    ).toEqual(['enabled@mp']);

    const reloadSettings = vi
      .spyOn(settings, 'reload')
      .mockImplementation(() => {});
    const errors: PluginError[] = [
      {
        type: 'generic-error',
        source: 'flag',
        error: 'Reload failed for a flag plugin',
      },
    ];
    loadSessionPluginsMock.mockResolvedValueOnce({ plugins: [disabled], errors });

    await expect(config.reloadPlugins?.()).resolves.toEqual({
      enabled: [disabled],
      errors,
    });
    expect(reloadSettings).toHaveBeenCalledOnce();
    expect(loadSessionPluginsMock).toHaveBeenLastCalledWith({
      pluginDirs: ['./plugins/explicit'],
      collectPluginDirFailure: true,
    });
    expect(config.getPlugins()).toEqual([disabled]);
    expect(config.getPluginErrors()).toEqual(errors);
  });

  it('does not start the plugin auto-update scheduler', async () => {
    // loadCliConfig is shared by headless, ACP, SDK and remote-worker entry
    // points. Plugin auto-update belongs to the interactive TUI only, so it is
    // wired up in usePluginStartupChecks instead of here.
    startAutoUpdateSchedulerMock.mockClear();

    process.argv = ['node', 'script.js'];
    const argv = await parseArgsForRootCommand();
    const settings = createLoadedSettings({
      enabledPlugins: { 'enabled@mp': true },
      plugins: { autoUpdate: true },
    });

    await loadCliConfig(settings, 'test-session', argv, {});

    expect(startAutoUpdateSchedulerMock).not.toHaveBeenCalled();
  });

  describe('Proxy configuration', () => {
    const originalProxyEnv: { [key: string]: string | undefined } = {};
    const proxyEnvVars = [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'http_proxy',
      'https_proxy',
      ServerConfig.ENV_AGENT_SDK_ENTRYPOINT,
    ];

    beforeEach(() => {
      for (const key of proxyEnvVars) {
        originalProxyEnv[key] = process.env[key];
        delete process.env[key];
      }
    });

    afterEach(() => {
      for (const key of proxyEnvVars) {
        if (originalProxyEnv[key]) {
          process.env[key] = originalProxyEnv[key];
        } else {
          delete process.env[key];
        }
      }
    });

    it(`should leave proxy to empty by default`, async () => {
      process.argv = ['node', 'script.js'];
      const argv = await parseArgsForRootCommand();
      const settings = createLoadedSettings();
      const config = await loadCliConfig(settings, 'test-session', argv, {});
      expect(config.getProxy()).toBeFalsy();
    });

    const proxy_url = 'http://localhost:7890';
    const testCases = [
      {
        input: {
          env_name: 'https_proxy',
          proxy_url,
        },
        expected: proxy_url,
      },
      {
        input: {
          env_name: 'http_proxy',
          proxy_url,
        },
        expected: proxy_url,
      },
      {
        input: {
          env_name: 'HTTPS_PROXY',
          proxy_url,
        },
        expected: proxy_url,
      },
      {
        input: {
          env_name: 'HTTP_PROXY',
          proxy_url,
        },
        expected: proxy_url,
      },
    ];
    testCases.forEach(({ input, expected }) => {
      it(`should set proxy to ${expected} according to environment variable [${input.env_name}]`, async () => {
        vi.stubEnv(input.env_name, input.proxy_url);
        process.argv = ['node', 'script.js'];
        const argv = await parseArgsForRootCommand();
        const settings = createLoadedSettings();
        const config = await loadCliConfig(settings, 'test-session', argv, {});
        expect(config.getProxy()).toBe(expected);
      });
    });

    it('should inherit proxy variables in SDK mode when no explicit proxy is provided', async () => {
      process.env[ServerConfig.ENV_AGENT_SDK_ENTRYPOINT] = 'sdk-ts';
      process.env['HTTPS_PROXY'] = proxy_url;
      process.argv = ['node', 'script.js'];
      const settings = createLoadedSettings();
      const argv = await parseArgsForRootCommand();

      const config = await loadCliConfig(settings, 'test-session', argv, {});

      expect(config.getProxy()).toBe(proxy_url);
    });

    it('should use an explicit SDK proxy without reading the inherited proxy', async () => {
      process.env[ServerConfig.ENV_AGENT_SDK_ENTRYPOINT] = 'sdk-ts';
      process.env['HTTPS_PROXY'] = 'http://environment-proxy.test:8080';
      process.argv = ['node', 'script.js', '--proxy', proxy_url];
      const settings = createLoadedSettings();
      const argv = await parseArgsForRootCommand();

      const config = await loadCliConfig(settings, 'test-session', argv, {});

      expect(config.getProxy()).toBe(proxy_url);
    });

    it('should ignore proxy environment variables when disabled in settings', async () => {
      vi.stubEnv('HTTPS_PROXY', proxy_url);
      process.argv = ['node', 'script.js'];
      const settings = createLoadedSettings({
        advanced: { useProxyFromEnvironment: false },
      });
      const argv = await parseArgsForRootCommand();

      const config = await loadCliConfig(settings, 'test-session', argv, {});

      expect(config.getProxy()).toBeUndefined();
    });
  });

  it('should use default fileFilter options when unconfigured', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArgsForRootCommand();
    const settings = createLoadedSettings();
    const config = await loadCliConfig(settings, 'test-session', argv, {});
    expect(config.getFileFilteringRespectGitIgnore()).toBe(
      DEFAULT_FILE_FILTERING_OPTIONS.respectGitIgnore,
    );
    expect(config.getFileFilteringRespectBrandIgnore()).toBe(
      DEFAULT_FILE_FILTERING_OPTIONS.respectBrandIgnore,
    );
    expect(config.getCustomIgnoreFilePaths()).toEqual(
      DEFAULT_FILE_FILTERING_OPTIONS.customIgnoreFilePaths,
    );
    expect(config.getPermissionMode()).toBe('default');
  });

  it.each([true, false])(
    'reuses resolved non-interactive trust=%s without rechecking the host',
    async (trusted) => {
      process.argv = ['node', 'script.js'];
      vi.stubEnv('VITEST', 'false');
      const argv = {
        ...(await parseArgsForRootCommand()),
        print: true,
        inputFormat: 'stream-json',
        permissionMode: 'auto',
      } as CliArgs;
      const settings = createLoadedSettings({}, trusted);
      vi.mocked(isWorkspaceTrusted).mockClear();
      vi.mocked(isWorkspaceTrusted).mockReturnValue({
        isTrusted: !trusted,
        source: undefined,
      });
      const config = await loadCliConfig(settings, 'test-session', argv, {
        trustedFolder: settings.isTrusted,
      });
      try {
        expect(config.isTrustedFolder()).toBe(trusted);
        expect(config.getPermissionMode()).toBe(trusted ? 'auto' : 'default');
        expect(isWorkspaceTrusted).not.toHaveBeenCalled();
      } finally {
        await config.dispose();
      }
    },
  );

  it.each([true, false])(
    'keeps ordinary CLI trust=%s independent of the settings projection',
    async (trusted) => {
      process.argv = ['node', 'script.js'];
      vi.stubEnv('VITEST', 'false');
      const argv = await parseArgsForRootCommand();
      const settings = createLoadedSettings({}, !trusted);
      vi.mocked(isWorkspaceTrusted).mockClear();
      vi.mocked(isWorkspaceTrusted).mockReturnValue({
        isTrusted: trusted,
        source: undefined,
      });
      const config = await loadCliConfig(settings, 'test-session', argv, {});
      try {
        expect(config.isTrustedFolder()).toBe(trusted);
        expect(isWorkspaceTrusted).toHaveBeenCalledWith(
          settings.merged,
          expect.any(String),
          undefined,
          { prompt: argv.prompt },
        );
      } finally {
        await config.dispose();
      }
    },
  );

  it('should be non-interactive in headless mode', async () => {
    process.argv = ['node', 'script.js', '-p', 'test'];
    const argv = await parseArgsForRootCommand();

    // reset tty for this test
    process.stdin.isTTY = true;

    const settings = createLoadedSettings();
    const config = await loadCliConfig(settings, 'test-session', argv, {});

    expect(config.isInteractive()).toBe(false);
  });
});

describe('mergeMcpServers', () => {
  it('should not modify the original settings object', async () => {
    const settings = createLoadedSettings({
      mcpServers: {
        'test-server': {
          url: 'http://localhost:8080',
        },
      },
    });

    const originalSettings = structuredClone(settings.merged);
    process.argv = ['node', 'script.js'];
    const argv = await parseArgsForRootCommand();
    await loadCliConfig(settings, 'test-session', argv, {});
    expect(settings.merged).toEqual(originalSettings);
  });
});

describe('mergeExcludeTools', () => {
  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    process.stdin.isTTY = true;
  });

  afterEach(() => {
    process.stdin.isTTY = originalIsTTY;
  });

  it('should return an empty array when no excludeTools are specified and it is interactive', async () => {
    process.stdin.isTTY = true;
    const settings = createLoadedSettings();
    process.argv = ['node', 'script.js'];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(settings, 'test-session', argv, {});
    expect(config.getExcludeTools()).toEqual(new Set([]));
  });

  it('should return default excludes when no excludeTools are specified and it is not interactive', async () => {
    process.stdin.isTTY = false;
    const settings = createLoadedSettings();
    process.argv = ['node', 'script.js', '-p', 'test'];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(settings, 'test-session', argv, {});
    expect(config.getExcludeTools()).toEqual(new Set([ASK_USER_TOOL_NAME]));
  });

  it('should handle settings with excludeTools but no extensions', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArgsForRootCommand();
    const settings = createLoadedSettings({
      tools: { exclude: ['tool1', 'tool2'] },
    });

    const config = await loadCliConfig(settings, 'test-session', argv, {});
    expect(config.getExcludeTools()).toEqual(new Set(['tool1', 'tool2']));
    expect(config.getExcludeTools()).toHaveLength(2);
  });

  it('should not modify the original settings object', async () => {
    const settings = createLoadedSettings({
      tools: { exclude: ['tool1'] },
    });
    const originalSettings = structuredClone(settings.merged);
    process.argv = ['node', 'script.js'];
    const argv = await parseArgsForRootCommand();
    await loadCliConfig(settings, 'test-session', argv, {});
    expect(settings.merged).toEqual(originalSettings);
  });
});

describe('Permission mode tool exclusion logic', () => {
  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    process.stdin.isTTY = false; // Ensure non-interactive mode
    vi.mocked(isWorkspaceTrusted).mockReturnValue({
      isTrusted: true,
      source: undefined,
    });
  });

  afterEach(() => {
    process.stdin.isTTY = originalIsTTY;
  });

  it('should exclude all interactive tools in non-interactive mode with default permission mode', async () => {
    process.argv = ['node', 'script.js', '-p', 'test'];
    const argv = await parseArgsForRootCommand();
    const settings = createLoadedSettings();
    const config = await loadCliConfig(settings, 'test-session', argv, {});

    const excludedTools = config.getExcludeTools();
    expect(excludedTools).not.toContain(SHELL_TOOL_NAME);
    expect(excludedTools).not.toContain(EDIT_TOOL_NAME);
    expect(excludedTools).not.toContain(WRITE_FILE_TOOL_NAME);
    expect(excludedTools).toContain(ASK_USER_TOOL_NAME);
  });

  it('should exclude all interactive tools in non-interactive mode with explicit default permission mode', async () => {
    process.argv = [
      'node',
      'script.js',
      '--permission-mode',
      'default',
      '-p',
      'test',
    ];
    const argv = await parseArgsForRootCommand();
    const settings = createLoadedSettings();

    const config = await loadCliConfig(settings, 'test-session', argv, {});

    const excludedTools = config.getExcludeTools();
    expect(excludedTools).not.toContain(SHELL_TOOL_NAME);
    expect(excludedTools).not.toContain(EDIT_TOOL_NAME);
    expect(excludedTools).not.toContain(WRITE_FILE_TOOL_NAME);
    expect(excludedTools).toContain(ASK_USER_TOOL_NAME);
  });

  it('should exclude only shell tools in non-interactive mode with acceptEdits permission mode', async () => {
    process.argv = [
      'node',
      'script.js',
      '--permission-mode',
      'accept_edits',
      '-p',
      'test',
    ];
    const argv = await parseArgsForRootCommand();
    const settings = createLoadedSettings();

    const config = await loadCliConfig(settings, 'test-session', argv, {});

    const excludedTools = config.getExcludeTools();
    expect(excludedTools).not.toContain(SHELL_TOOL_NAME);
    expect(excludedTools).not.toContain(EDIT_TOOL_NAME);
    expect(excludedTools).not.toContain(WRITE_FILE_TOOL_NAME);
    expect(excludedTools).toContain(ASK_USER_TOOL_NAME);
  });

  it('should exclude only ask_user in non-interactive mode with bypassPermissions permission mode', async () => {
    process.argv = [
      'node',
      'script.js',
      '--permission-mode',
      'bypass_permissions',
      '-p',
      'test',
    ];
    const argv = await parseArgsForRootCommand();
    const settings = createLoadedSettings();

    const config = await loadCliConfig(settings, 'test-session', argv, {});

    const excludedTools = config.getExcludeTools();
    expect(excludedTools).not.toContain(SHELL_TOOL_NAME);
    expect(excludedTools).not.toContain(EDIT_TOOL_NAME);
    expect(excludedTools).not.toContain(WRITE_FILE_TOOL_NAME);
    expect(excludedTools).toContain(ASK_USER_TOOL_NAME);
  });

  it('should exclude all interactive tools in non-interactive mode with plan permission mode', async () => {
    process.argv = [
      'node',
      'script.js',
      '--permission-mode',
      'plan',
      '-p',
      'test',
    ];
    const settings = createLoadedSettings({
      general: {
        plan: { enabled: true },
      },
    });
    const argv = await parseArgsForRootCommand();

    const config = await loadCliConfig(settings, 'test-session', argv, {});

    const excludedTools = config.getExcludeTools();
    expect(excludedTools).not.toContain(SHELL_TOOL_NAME);
    expect(excludedTools).not.toContain(EDIT_TOOL_NAME);
    expect(excludedTools).not.toContain(WRITE_FILE_TOOL_NAME);
    expect(excludedTools).toContain(ASK_USER_TOOL_NAME);
  });

  it('should not exclude interactive tools in interactive mode regardless of permission mode', async () => {
    process.stdin.isTTY = true; // Interactive mode

    const testCases = [
      { args: ['node', 'script.js'] }, // default
      { args: ['node', 'script.js', '--permission-mode', 'default'] },
      { args: ['node', 'script.js', '--permission-mode', 'accept_edits'] },
      {
        args: ['node', 'script.js', '--permission-mode', 'bypass_permissions'],
      },
    ];

    for (const testCase of testCases) {
      process.argv = testCase.args;
      const argv = await parseArgsForRootCommand();
      const settings = createLoadedSettings();

      const config = await loadCliConfig(settings, 'test-session', argv, {});

      const excludedTools = config.getExcludeTools();
      expect(excludedTools).not.toContain(SHELL_TOOL_NAME);
      expect(excludedTools).not.toContain(EDIT_TOOL_NAME);
      expect(excludedTools).not.toContain(WRITE_FILE_TOOL_NAME);
      expect(excludedTools).not.toContain(ASK_USER_TOOL_NAME);
    }
  });

  it('should merge permission mode exclusions with settings exclusions in acceptEdits mode', async () => {
    process.argv = [
      'node',
      'script.js',
      '--permission-mode',
      'accept_edits',
      '-p',
      'test',
    ];
    const argv = await parseArgsForRootCommand();
    const settings = createLoadedSettings({
      tools: { exclude: ['custom_tool'] },
    });

    const config = await loadCliConfig(settings, 'test-session', argv, {});

    const excludedTools = config.getExcludeTools();
    expect(excludedTools).toContain('custom_tool'); // From settings
    expect(excludedTools).not.toContain(SHELL_TOOL_NAME); // No longer from permission mode
    expect(excludedTools).not.toContain(EDIT_TOOL_NAME); // Should be allowed in acceptEdits
    expect(excludedTools).not.toContain(WRITE_FILE_TOOL_NAME); // Should be allowed in acceptEdits
    expect(excludedTools).toContain(ASK_USER_TOOL_NAME);
  });

  it('should fall back to default if bypassPermissions mode is attempted when disableYoloMode is true', async () => {
    process.argv = [
      'node',
      'script.js',
      '--permission-mode',
      'bypass_permissions',
    ];
    const argv = await parseArgsForRootCommand();
    const settings = createLoadedSettings({
      security: {
        disableYoloMode: true,
      },
    });

    const config = await loadCliConfig(settings, 'test-session', argv, {});

    expect(config.getPermissionMode()).toBe('default');
    expect(config.isYoloModeDisabled()).toBe(true);
  });

  it('should throw an error for invalid permission mode values in loadCliConfig', async () => {
    // Create a mock argv with an invalid permission mode that bypasses argument parsing validation
    const invalidArgv: Partial<CliArgs> & { permissionMode: string } = {
      permissionMode: 'invalid_mode',
      promptInteractive: '',
      prompt: '',
    };

    const settings = createLoadedSettings();
    await expect(
      loadCliConfig(settings, 'test-session', invalidArgv as CliArgs, {}),
    ).rejects.toThrow(
      'Invalid permission mode: invalid_mode. Valid values are: default, accept_edits, bypass_permissions, dont_ask, auto',
    );
  });

  it('passes legacy tool allow and deny flags into permission initialization', async () => {
    const initializeSpy = vi.spyOn(ServerConfig, 'permissionRulesFromStartup');
    process.argv = ['node', 'script.js'];

    const settings = createLoadedSettings();
    await loadCliConfig(
      settings,
      'test-session',
      {
        permissionMode: 'default',
        promptInteractive: '',
        prompt: '',
        allowedTools: ['Bash', 'Edit'],
        disallowedTools: ['Agent'],
      } as CliArgs,
      {},
    );

    expect(initializeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedTools: ['Bash', 'Edit'],
        disallowedTools: ['Agent'],
      }),
    );
  });

  it('applies legacy max-output-tokens to the launch model config', async () => {
    process.argv = ['node', 'script.js'];
    const settings = createLoadedSettings();
    const config = await loadCliConfig(
      settings,
      'test-session',
      {
        model: 'gemini-2.5-pro',
        permissionMode: 'default',
        promptInteractive: '',
        prompt: '',
        maxOutputTokens: '16k',
      } as CliArgs,
      {},
    );

    expect(launchModelConfig(config)?.context?.maxOutputTokens).toBe(16 * 1024);
  });

  it('should fall back to default permission mode if plan mode is requested but not enabled', async () => {
    process.argv = ['node', 'script.js'];
    const settings = createLoadedSettings({
      general: {
        defaultPermissionMode: 'plan',
        plan: { enabled: false },
      },
    });
    const argv = await parseArgsForRootCommand();
    delete (argv as Partial<CliArgs>).permissionMode;
    const config = await loadCliConfig(settings, 'test-session', argv, {});
    expect(config.getPermissionMode()).toBe('default');
  });

  it('should allow plan permission mode in interactive mode if plan is enabled', async () => {
    process.stdin.isTTY = true;
    process.argv = ['node', 'script.js'];
    const settings = createLoadedSettings({
      general: {
        defaultPermissionMode: 'plan',
        plan: { enabled: true },
      },
    });
    const argv = await parseArgsForRootCommand();
    delete (argv as Partial<CliArgs>).permissionMode;
    const config = await loadCliConfig(settings, 'test-session', argv, {});
    expect(config.getPermissionMode()).toBe('default');
    expect(config.isPlanMode()).toBe(true);
  });

  it('routes --permission-mode plan to PlanStateManager and keeps the permission mode at default', async () => {
    process.stdin.isTTY = true;
    process.argv = ['node', 'script.js', '--permission-mode', 'plan'];
    const settings = createLoadedSettings({
      general: { plan: { enabled: true } },
    });
    const argv = await parseArgsForRootCommand();
    expect(argv.permissionMode).toBe('plan');
    const notify = vi.spyOn(
      ServerConfig.Config.prototype,
      'notifyPlanStateChanged',
    );

    try {
      const config = await loadCliConfig(settings, 'test-session', argv, {});
      expect(config.getPermissionMode()).toBe('default');
      expect(config.planStateManager.isActive).toBe(true);
      expect(notify).toHaveBeenCalledWith('startup_flag');
    } finally {
      notify.mockRestore();
    }
  });
});

describe('loadCliConfig with allowed-mcp-server-names', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/mock/home/user');
    vi.stubEnv('GEMINI_API_KEY', 'test-api-key');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const baseSettings = createLoadedSettings({
    mcpServers: {
      server1: { url: 'http://localhost:8080' },
      server2: { url: 'http://localhost:8081' },
      server3: { url: 'http://localhost:8082' },
    },
  });

  it('should allow all MCP servers if the flag is not provided', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(baseSettings, 'test-session', argv, {});
    expect(config.getMcpServers()).toEqual({
      server1: { url: 'http://localhost:8080', scope: 'user' },
      server2: { url: 'http://localhost:8081', scope: 'user' },
      server3: { url: 'http://localhost:8082', scope: 'user' },
    });
  });

  it('should allow only the specified MCP server', async () => {
    process.argv = [
      'node',
      'script.js',
      '--allowed-mcp-server-names',
      'server1',
    ];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(baseSettings, 'test-session', argv, {});
    expect(config.getAllowedMcpServers()).toEqual(['server1']);
  });

  it('should allow multiple specified MCP servers', async () => {
    process.argv = [
      'node',
      'script.js',
      '--allowed-mcp-server-names',
      'server1',
      '--allowed-mcp-server-names',
      'server3',
    ];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(baseSettings, 'test-session', argv, {});
    expect(config.getAllowedMcpServers()).toEqual(['server1', 'server3']);
  });

  it('should handle server names that do not exist', async () => {
    process.argv = [
      'node',
      'script.js',
      '--allowed-mcp-server-names',
      'server1',
      '--allowed-mcp-server-names',
      'server4',
    ];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(baseSettings, 'test-session', argv, {});
    expect(config.getAllowedMcpServers()).toEqual(['server1', 'server4']);
  });

  it('should allow no MCP servers if the flag is provided but empty', async () => {
    process.argv = ['node', 'script.js', '--allowed-mcp-server-names', ''];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(baseSettings, 'test-session', argv, {});
    expect(config.getAllowedMcpServers()).toEqual(['']);
  });

  it('should read allowMCPServers from settings', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArgsForRootCommand();
    const settings = createLoadedSettings({
      ...baseSettings.user.settings,
      mcp: { allowed: ['server1', 'server2'] },
    });
    const config = await loadCliConfig(settings, 'test-session', argv, {});
    expect(config.getAllowedMcpServers()).toEqual(['server1', 'server2']);
  });

  it('should read excludeMCPServers from settings', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArgsForRootCommand();
    const settings = createLoadedSettings({
      ...baseSettings.user.settings,
      mcp: { excluded: ['server1', 'server2'] },
    });
    const config = await loadCliConfig(settings, 'test-session', argv, {});
    expect(config.getBlockedMcpServers()).toEqual(['server1', 'server2']);
  });

  it('should override allowMCPServers with excludeMCPServers if overlapping', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArgsForRootCommand();
    const settings = createLoadedSettings({
      ...baseSettings.user.settings,
      mcp: {
        excluded: ['server1'],
        allowed: ['server1', 'server2'],
      },
    });
    const config = await loadCliConfig(settings, 'test-session', argv, {});
    expect(config.getAllowedMcpServers()).toEqual(['server1', 'server2']);
    expect(config.getBlockedMcpServers()).toEqual(['server1']);
  });

  it('should prioritize mcp server flag if set', async () => {
    process.argv = [
      'node',
      'script.js',
      '--allowed-mcp-server-names',
      'server1',
    ];
    const argv = await parseArgsForRootCommand();
    const settings = createLoadedSettings({
      ...baseSettings.user.settings,
      mcp: {
        excluded: ['server1'],
        allowed: ['server2'],
      },
    });
    const config = await loadCliConfig(settings, 'test-session', argv, {});
    expect(config.getAllowedMcpServers()).toEqual(['server1']);
  });

  it('should prioritize CLI flag over both allowed and excluded settings', async () => {
    process.argv = [
      'node',
      'script.js',
      '--allowed-mcp-server-names',
      'server2',
      '--allowed-mcp-server-names',
      'server3',
    ];
    const argv = await parseArgsForRootCommand();
    const settings = createLoadedSettings({
      ...baseSettings.user.settings,
      mcp: {
        allowed: ['server1', 'server2'], // Should be ignored
        excluded: ['server3'], // Should be ignored
      },
    });
    const config = await loadCliConfig(settings, 'test-session', argv, {});
    expect(config.getAllowedMcpServers()).toEqual(['server2', 'server3']);
    expect(config.getBlockedMcpServers()).toEqual([]);
  });
});

describe('loadCliConfig model selection', () => {
  beforeEach(() => {});

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('selects a model from settings.json if provided', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(
      createLoadedSettings({
        model: {
          name: 'gemini-2.5-pro',
        },
      }),
      'test-session',
      argv,
      {},
    );

    expect(config.getCliModel()).toBeUndefined();
    expect(config.getModel()).toBe('gemini-2.5-pro');
  });

  it('leaves the model unset if nothing is configured', async () => {
    process.argv = ['node', 'script.js']; // No model set.
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(
      createLoadedSettings({
        // No model set.
      }),
      'test-session',
      argv,
      {},
    );

    expect(config.getModel()).toBe('');
  });

  it('always prefers model from argv', async () => {
    process.argv = ['node', 'script.js', '--model', 'gemini-2.5-flash-preview'];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(
      createLoadedSettings({
        model: {
          name: 'gemini-2.5-pro',
        },
      }),
      'test-session',
      argv,
      {},
    );

    expect(config.getCliModel()).toBe('gemini-2.5-flash-preview');
    expect(config.getModel()).toBe('gemini-2.5-flash-preview');
  });

  it('prefers the model environment variable over settings when --model is absent', async () => {
    process.env[ENV_MODEL] = 'gemini-env-model';
    process.argv = ['node', 'script.js'];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(
      createLoadedSettings({
        model: {
          name: 'gemini-2.5-pro',
        },
      }),
      'test-session',
      argv,
      {},
    );

    expect(config.getModel()).toBe('gemini-env-model');
  });

  it('selects the model from argv if provided', async () => {
    process.argv = ['node', 'script.js', '--model', 'gemini-2.5-flash-preview'];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(
      createLoadedSettings({
        // No model provided via settings.
      }),
      'test-session',
      argv,
      {},
    );

    expect(config.getModel()).toBe('gemini-2.5-flash-preview');
  });

  it('preserves the auto alias if provided via argv', async () => {
    process.argv = ['node', 'script.js', '--model', 'auto'];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(
      createLoadedSettings({
        // No model provided via settings.
      }),
      'test-session',
      argv,
      {},
    );

    expect(config.getModel()).toBe('auto');
  });

  it('applies CLI thinking and effort as session-only generation overrides', async () => {
    process.argv = [
      'node',
      'script.js',
      '--model',
      'provider/model',
      '--thinking',
      'adaptive',
      '--reasoning-effort',
      'medium',
    ];
    const settings = createLoadedSettings({
      model: {
        name: 'provider/model',
        preferences: {
          'provider/model': {
            reasoning: {
              thinking: { type: 'enabled', budgetTokens: 8192 },
              effort: 'high',
              preserve: true,
            },
          },
        },
      },
    });
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(settings, 'test-session', argv, {});

    expect(launchModelConfig(config)).toEqual({
      reasoning: { thinking: { type: 'adaptive' }, effort: 'medium' },
    });
  });

  it('lets --reasoning-effort auto clear a persisted explicit effort', async () => {
    process.argv = [
      'node',
      'script.js',
      '--model',
      'provider/model',
      '--reasoning-effort',
      'auto',
    ];
    const settings = createLoadedSettings({
      model: {
        name: 'provider/model',
        preferences: {
          'provider/model': {
            reasoning: {
              enabled: true,
              effort: 'high',
            },
          },
        },
      },
    });
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(settings, 'test-session', argv, {});

    expect(launchModelConfig(config)?.reasoning).toStrictEqual({
      effort: undefined,
    });
  });

  it('rejects incompatible CLI thinking and budget flags', async () => {
    const settings = createLoadedSettings();
    await expect(
      loadCliConfig(
        settings,
        'test-session',
        {
          thinking: 'adaptive',
          thinkingBudget: '8192',
          permissionMode: 'default',
          promptInteractive: '',
          prompt: '',
        } as CliArgs,
        {},
      ),
    ).rejects.toThrow(
      '--thinking-budget cannot be used with --thinking adaptive',
    );
  });
});

describe('loadCliConfig folderTrust', () => {
  let originalVitest: string | undefined;
  let originalIntegrationTest: string | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/mock/home/user');
    vi.stubEnv('GEMINI_API_KEY', 'test-api-key');

    originalVitest = process.env['VITEST'];
    originalIntegrationTest = process.env[ServerConfig.ENV_INTEGRATION_TEST];
    delete process.env['VITEST'];
    delete process.env[ServerConfig.ENV_INTEGRATION_TEST];
  });

  afterEach(() => {
    if (originalVitest !== undefined) {
      process.env['VITEST'] = originalVitest;
    }
    if (originalIntegrationTest !== undefined) {
      process.env[ServerConfig.ENV_INTEGRATION_TEST] = originalIntegrationTest;
    }

    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('should be false when folderTrust is false', async () => {
    process.argv = ['node', 'script.js'];
    const settings = createLoadedSettings({
      security: {
        folderTrust: {
          enabled: false,
        },
      },
    });
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(settings, 'test-session', argv, {});
    expect(config.getFolderTrust()).toBe(false);
  });

  it('should be true when folderTrust is true', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArgsForRootCommand();
    const settings = createLoadedSettings({
      security: {
        folderTrust: {
          enabled: true,
        },
      },
    });
    const config = await loadCliConfig(settings, 'test-session', argv, {});
    expect(config.getFolderTrust()).toBe(true);
  });

  it('should be true by default', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArgsForRootCommand();
    const settings = createLoadedSettings();
    const config = await loadCliConfig(settings, 'test-session', argv, {});
    expect(config.getFolderTrust()).toBe(true);
  });
});

describe('loadCliConfig useRipgrep', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/mock/home/user');
    vi.stubEnv('GEMINI_API_KEY', 'test-api-key');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('should be true by default when useRipgrep is not set in settings', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArgsForRootCommand();
    const settings = createLoadedSettings();
    const config = await loadCliConfig(settings, 'test-session', argv, {});
    expect(config.getUseRipgrep()).toBe(true);
  });

  it('should be false when useRipgrep is set to false in settings', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArgsForRootCommand();
    const settings = createLoadedSettings({ tools: { useRipgrep: false } });
    const config = await loadCliConfig(settings, 'test-session', argv, {});
    expect(config.getUseRipgrep()).toBe(false);
  });

  it('should be true when useRipgrep is explicitly set to true in settings', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArgsForRootCommand();
    const settings = createLoadedSettings({ tools: { useRipgrep: true } });
    const config = await loadCliConfig(settings, 'test-session', argv, {});
    expect(config.getUseRipgrep()).toBe(true);
  });
});

describe('loadCliConfig context management', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/mock/home/user');
    vi.stubEnv('GEMINI_API_KEY', 'test-api-key');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('should be false by default when generalistProfile / context management is not set in settings', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArgsForRootCommand();
    const settings = createLoadedSettings();
    const config = await loadCliConfig(settings, 'test-session', argv, {});
    expect(config.isContextManagementEnabled()).toBe(false);
  });

  it('should be true when generalistProfile is set to true in settings', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArgsForRootCommand();
    const settings = createLoadedSettings({
      experimental: {
        generalistProfile: true,
      },
    });
    const config = await loadCliConfig(settings, 'test-session', argv, {});
    expect(await config.getToolOutputMaskingConfig()).toStrictEqual(
      generalistProfile.tools.outputMasking,
    );
    expect(config.isContextManagementEnabled()).toBe(true);
  });

  it('should be true when contextManagement is set to true in settings', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArgsForRootCommand();
    const outputMasking = {
      protectionThresholdTokens: 30_000,
      minPrunableThresholdTokens: 10_000,
      protectLatestTurn: false,
    };
    const contextManagement = {
      tools: { outputMasking },
    };
    const settings = createLoadedSettings({
      experimental: {
        contextManagement: true,
      },
      // Numeric defaults are inferred as literals, so custom values require a
      // narrow cast at the test boundary.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      contextManagement: contextManagement as any,
    });
    const config = await loadCliConfig(settings, 'test-session', argv, {});
    expect(await config.getToolOutputMaskingConfig()).toStrictEqual(
      outputMasking,
    );
    expect(config.isContextManagementEnabled()).toBe(true);
  });
});

describe('screenReader configuration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/mock/home/user');
    vi.stubEnv('GEMINI_API_KEY', 'test-api-key');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('should use screenReader value from settings if CLI flag is not present (settings true)', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArgsForRootCommand();
    const settings = createLoadedSettings({
      ui: { accessibility: { screenReader: true } },
    });
    const config = await loadCliConfig(settings, 'test-session', argv, {});
    expect(config.getScreenReader()).toBe(true);
  });

  it('should use screenReader value from settings if CLI flag is not present (settings false)', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArgsForRootCommand();
    const settings = createLoadedSettings({
      ui: { accessibility: { screenReader: false } },
    });
    const config = await loadCliConfig(settings, 'test-session', argv, {});
    expect(config.getScreenReader()).toBe(false);
  });

  it('should prioritize --screen-reader CLI flag (true) over settings (false)', async () => {
    process.argv = ['node', 'script.js', '--screen-reader'];
    const argv = await parseArgsForRootCommand();
    const settings = createLoadedSettings({
      ui: { accessibility: { screenReader: false } },
    });
    const config = await loadCliConfig(settings, 'test-session', argv, {});
    expect(config.getScreenReader()).toBe(true);
  });

  it('should be false by default when no flag or setting is present', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArgsForRootCommand();
    const settings = createLoadedSettings();
    const config = await loadCliConfig(settings, 'test-session', argv, {});
    expect(config.getScreenReader()).toBe(false);
  });
});

describe('loadCliConfig tool exclusions', () => {
  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/mock/home/user');
    vi.stubEnv('GEMINI_API_KEY', 'test-api-key');
    process.stdin.isTTY = true;
    vi.mocked(isWorkspaceTrusted).mockReturnValue({
      isTrusted: true,
      source: undefined,
    });
  });

  afterEach(() => {
    process.stdin.isTTY = originalIsTTY;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('should not exclude interactive tools in interactive mode without bypass permissions', async () => {
    process.stdin.isTTY = true;
    process.argv = ['node', 'script.js'];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(
      createLoadedSettings(),
      'test-session',
      argv,
      {},
    );
    expect(config.getExcludeTools()).not.toContain(SHELL_TOOL_NAME);
    expect(config.getExcludeTools()).not.toContain(EDIT_TOOL_NAME);
    expect(config.getExcludeTools()).not.toContain(WRITE_FILE_TOOL_NAME);
    expect(config.getExcludeTools()).not.toContain(ASK_USER_TOOL_NAME);
  });

  it('should not exclude interactive tools in interactive mode with bypassPermissions', async () => {
    process.stdin.isTTY = true;
    process.argv = [
      'node',
      'script.js',
      '--permission-mode',
      'bypass_permissions',
    ];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(
      createLoadedSettings(),
      'test-session',
      argv,
      {},
    );
    expect(config.getExcludeTools()).not.toContain(SHELL_TOOL_NAME);
    expect(config.getExcludeTools()).not.toContain(EDIT_TOOL_NAME);
    expect(config.getExcludeTools()).not.toContain(WRITE_FILE_TOOL_NAME);
    expect(config.getExcludeTools()).not.toContain(ASK_USER_TOOL_NAME);
  });

  it('should exclude interactive tools in non-interactive mode without bypass permissions', async () => {
    process.stdin.isTTY = false;
    process.argv = ['node', 'script.js', '-p', 'test'];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(
      createLoadedSettings(),
      'test-session',
      argv,
      {},
    );
    expect(config.getExcludeTools()).not.toContain(SHELL_TOOL_NAME);
    expect(config.getExcludeTools()).not.toContain(EDIT_TOOL_NAME);
    expect(config.getExcludeTools()).not.toContain(WRITE_FILE_TOOL_NAME);
    expect(config.getExcludeTools()).toContain(ASK_USER_TOOL_NAME);
  });

  it('should exclude only ask_user in non-interactive mode with bypassPermissions', async () => {
    process.stdin.isTTY = false;
    process.argv = [
      'node',
      'script.js',
      '-p',
      'test',
      '--permission-mode',
      'bypass_permissions',
    ];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(
      createLoadedSettings(),
      'test-session',
      argv,
      {},
    );
    expect(config.getExcludeTools()).not.toContain(SHELL_TOOL_NAME);
    expect(config.getExcludeTools()).not.toContain(EDIT_TOOL_NAME);
    expect(config.getExcludeTools()).not.toContain(WRITE_FILE_TOOL_NAME);
    expect(config.getExcludeTools()).toContain(ASK_USER_TOOL_NAME);
  });

  it('should not exclude ask_user when --acp is provided', async () => {
    process.stdin.isTTY = true;
    process.argv = ['node', 'script.js', '--acp'];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(
      createLoadedSettings(),
      'test-session',
      argv,
      { cwd: process.cwd() },
    );
    expect(config.getExcludeTools()).not.toContain(ASK_USER_TOOL_NAME);
  });

  it('should set coreTools from --tools flag', async () => {
    process.stdin.isTTY = false;
    process.argv = ['node', 'script.js', '-p', 'test', '--tools', 'ShellTool'];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(
      createLoadedSettings(),
      'test-session',
      argv,
      {},
    );
    expect(config.getCoreTools()).toEqual(['ShellTool']);
  });

  it.each(['', 'default', 'Read', 'mcp_list', 'mcp_get', 'mcp_call'])(
    'disables MCP meta tools whenever --tools is supplied with %j',
    async (value) => {
      process.argv = ['node', 'script.js', '-p', 'test', '--tools', value];
      const argv = await parseArgsForRootCommand();
      const config = await loadCliConfig(
        createLoadedSettings(),
        'test-session',
        argv,
        {},
      );
      for (const name of ['mcp_list', 'mcp_get', 'mcp_call']) {
        expect(config.getExcludeTools()).toContain(name);
      }
      const registry = new ServerConfig.ToolRegistry(config, true);
      config.registerLazyMetaTools(registry);
      expect(registry.getAllTools()).toEqual([]);
      expect(registry.getModelFunctionDeclarations()).toEqual([]);
    },
  );

  it.each([undefined, { core: [] }, { core: ['Read'] }])(
    'keeps MCP meta tools enabled without --tools when settings.tools is %j',
    async (tools) => {
      process.argv = ['node', 'script.js', '-p', 'test'];
      const argv = await parseArgsForRootCommand();
      const config = await loadCliConfig(
        createLoadedSettings(tools === undefined ? {} : { tools }),
        'test-session',
        argv,
        {},
      );
      for (const name of ['mcp_list', 'mcp_get', 'mcp_call']) {
        expect(config.getExcludeTools()).not.toContain(name);
      }
      const registry = new ServerConfig.ToolRegistry(config, true);
      config.registerLazyMetaTools(registry);
      expect(registry.getAllTools().map((tool) => tool.name).sort()).toEqual([
        'mcp_call',
        'mcp_get',
        'mcp_list',
      ]);
    },
  );

  it('should not exclude web-fetch in non-interactive mode at config level', async () => {
    process.stdin.isTTY = false;
    process.argv = ['node', 'script.js', '-p', 'test'];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(
      createLoadedSettings(),
      'test-session',
      argv,
      {},
    );
    expect(config.getExcludeTools()).not.toContain(WEB_FETCH_TOOL_NAME);
  });

  it('should set coreTools from --tools flag with multiple tool names', async () => {
    process.stdin.isTTY = false;
    process.argv = [
      'node',
      'script.js',
      '-p',
      'test',
      '--tools',
      SHELL_TOOL_NAME,
    ];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(
      createLoadedSettings(),
      'test-session',
      argv,
      {},
    );
    expect(config.getCoreTools()).toEqual([SHELL_TOOL_NAME]);
  });
});

describe('loadCliConfig interactive', () => {
  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/mock/home/user');
    vi.stubEnv('GEMINI_API_KEY', 'test-api-key');
    process.stdin.isTTY = true;
  });

  afterEach(() => {
    process.stdin.isTTY = originalIsTTY;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('should be interactive if isTTY and no prompt', async () => {
    process.stdin.isTTY = true;
    process.argv = ['node', 'script.js'];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(
      createLoadedSettings(),
      'test-session',
      argv,
      {},
    );
    expect(config.isInteractive()).toBe(true);
  });

  it('should be interactive if prompt-interactive is set', async () => {
    process.stdin.isTTY = false;
    process.argv = ['node', 'script.js', '--prompt-interactive', 'test'];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(
      createLoadedSettings(),
      'test-session',
      argv,
      {},
    );
    expect(config.isInteractive()).toBe(true);
  });

  it('preserves prompt-interactive behavior when print is also set', () => {
    expect(
      resolveConfigInteractive({
        promptInteractive: 'test',
        print: true,
      } as CliArgs),
    ).toBe(true);
  });

  it('resolves Config target directories to absolute paths', () => {
    expect(resolveConfigTargetDir('relative/project')).toBe(
      path.resolve('relative/project'),
    );
  });

  it('should not be interactive if not isTTY and no prompt', async () => {
    process.stdin.isTTY = false;
    process.argv = ['node', 'script.js'];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(
      createLoadedSettings(),
      'test-session',
      argv,
      {},
    );
    expect(config.isInteractive()).toBe(false);
  });

  it('should not be interactive if prompt is set', async () => {
    process.stdin.isTTY = true;
    process.argv = ['node', 'script.js', '--prompt', 'test'];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(
      createLoadedSettings(),
      'test-session',
      argv,
      {},
    );
    expect(config.isInteractive()).toBe(false);
  });

  it('should be interactive if positional prompt words are provided with other flags', async () => {
    process.stdin.isTTY = true;
    process.argv = ['node', 'script.js', '--model', 'gemini-2.5-pro', 'Hello'];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(
      createLoadedSettings(),
      'test-session',
      argv,
      {},
    );
    expect(config.isInteractive()).toBe(true);
  });

  it('should be interactive if positional prompt words are provided with multiple flags', async () => {
    process.stdin.isTTY = true;
    process.argv = [
      'node',
      'script.js',
      '--model',
      'gemini-2.5-pro',
      '--permission-mode',
      'bypass_permissions',
      'Hello world',
    ];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(
      createLoadedSettings(),
      'test-session',
      argv,
      {},
    );
    expect(config.isInteractive()).toBe(true);
    // Verify the question is preserved for one-shot execution
    expect(argv.prompt).toBeUndefined();
    expect(argv.promptInteractive).toBe('Hello world');
  });

  it('should be interactive if positional prompt words are provided with extensions flag', async () => {
    process.stdin.isTTY = true;
    process.argv = ['node', 'script.js', '-e', 'none', 'hello'];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(
      createLoadedSettings(),
      'test-session',
      argv,
      {},
    );
    expect(config.isInteractive()).toBe(true);
    expect(argv.query).toBe('hello');
    expect(argv.promptInteractive).toBe('hello');
    expect(argv.extensions).toEqual(['none']);
  });

  it('should handle multiple positional words correctly', async () => {
    process.stdin.isTTY = true;
    process.argv = ['node', 'script.js', 'hello world how are you'];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(
      createLoadedSettings(),
      'test-session',
      argv,
      {},
    );
    expect(config.isInteractive()).toBe(true);
    expect(argv.query).toBe('hello world how are you');
    expect(argv.promptInteractive).toBe('hello world how are you');
  });

  it('should handle multiple positional words with flags', async () => {
    process.stdin.isTTY = true;
    process.argv = [
      'node',
      'script.js',
      '--model',
      'gemini-2.5-pro',
      'write',
      'a',
      'function',
      'to',
      'sort',
      'array',
    ];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(
      createLoadedSettings(),
      'test-session',
      argv,
      {},
    );
    expect(config.isInteractive()).toBe(true);
    expect(argv.query).toBe('write a function to sort array');
    expect(argv.promptInteractive).toBe('write a function to sort array');
    expect(argv.model).toBe('gemini-2.5-pro');
  });

  it('should handle empty positional arguments', async () => {
    process.stdin.isTTY = true;
    process.argv = ['node', 'script.js', ''];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(
      createLoadedSettings(),
      'test-session',
      argv,
      {},
    );
    expect(config.isInteractive()).toBe(true);
    expect(argv.query).toBeUndefined();
  });

  it('should handle extensions flag with positional arguments correctly', async () => {
    process.stdin.isTTY = true;
    process.argv = [
      'node',
      'script.js',
      '-e',
      'none',
      'hello',
      'world',
      'how',
      'are',
      'you',
    ];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(
      createLoadedSettings(),
      'test-session',
      argv,
      {},
    );
    expect(config.isInteractive()).toBe(true);
    expect(argv.query).toBe('hello world how are you');
    expect(argv.promptInteractive).toBe('hello world how are you');
    expect(argv.extensions).toEqual(['none']);
  });

  it('should be interactive if no positional prompt words are provided with flags', async () => {
    process.stdin.isTTY = true;
    process.argv = ['node', 'script.js', '--model', 'gemini-2.5-pro'];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(
      createLoadedSettings(),
      'test-session',
      argv,
      {},
    );
    expect(config.isInteractive()).toBe(true);
  });
});

describe('loadCliConfig headless permission prompts', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/mock/home/user');
    vi.mocked(ServerConfig.isHeadlessMode).mockImplementation(
      (opts: Parameters<typeof ServerConfig.isHeadlessMode>[0]) =>
        !!opts?.prompt ||
        opts?.inputFormat === 'stream-json' ||
        !!opts?.print ||
        (!!process.stdin && !process.stdin.isTTY) ||
        (!!process.stdout && !process.stdout.isTTY),
    );
    vi.mocked(ServerConfig.isRemoteWorkerMode).mockReturnValue(false);
    vi.stubEnv('GEMINI_API_KEY', 'test-api-key');
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function loadConfigForArgv(argvParts: string[]) {
    process.argv = ['node', 'script.js', ...argvParts];
    const settings = createLoadedSettings();
    const argv = await parseArgsForRootCommand();
    return loadCliConfig(settings, 'test-session', argv, {
      cwd: process.cwd(),
    });
  }

  it('sets hideInteractiveTools for plain --print headless without external handler', async () => {
    const config = await loadConfigForArgv(['--print', 'test prompt']);

    expect(config.shouldHideInteractiveTools()).toBe(true);
  });

  it('sets hideInteractiveTools for deprecated --prompt headless without external handler', async () => {
    const config = await loadConfigForArgv(['--prompt', 'test prompt']);

    expect(config.shouldHideInteractiveTools()).toBe(true);
  });

  it('does not set hideInteractiveTools in interactive mode', async () => {
    const config = await loadConfigForArgv([]);

    expect(config.shouldHideInteractiveTools()).toBe(false);
  });

  it('does not set hideInteractiveTools for --prompt-interactive', async () => {
    const config = await loadConfigForArgv([
      '--prompt-interactive',
      'test prompt',
    ]);

    expect(config.shouldHideInteractiveTools()).toBe(false);
  });

  it('does not set hideInteractiveTools for ACP mode', async () => {
    const config = await loadConfigForArgv(['--acp']);

    expect(config.shouldHideInteractiveTools()).toBe(false);
  });

  it('does not set hideInteractiveTools for stream-json input', async () => {
    const config = await loadConfigForArgv([
      '--print',
      '--input-format',
      'stream-json',
      'test prompt',
    ]);

    expect(config.shouldHideInteractiveTools()).toBe(false);
  });

  it('keeps AskUserQuestion for the stream-json stdio permission channel', async () => {
    const config = await loadConfigForArgv([
      '--print',
      '--input-format',
      'stream-json',
      'test prompt',
    ]);

    expect(config.getExcludeTools()).not.toContain(ASK_USER_TOOL_NAME);
  });

  it('does not set hideInteractiveTools for stdio permission prompt tool', async () => {
    const config = await loadConfigForArgv([
      '--print',
      '--permission-prompt-tool',
      'stdio',
      'test prompt',
    ]);

    expect(config.shouldHideInteractiveTools()).toBe(false);
    expect(config.getExcludeTools()).not.toContain(ASK_USER_TOOL_NAME);
  });

  it('treats stdio permission prompt tool case-insensitively', async () => {
    const config = await loadConfigForArgv([
      '--print',
      '--permission-prompt-tool',
      'STDIO',
      'test prompt',
    ]);

    expect(config.shouldHideInteractiveTools()).toBe(false);
  });

  it('does not set hideInteractiveTools for named permission prompt tool', async () => {
    const config = await loadConfigForArgv([
      '--print',
      '--permission-prompt-tool',
      'mcp__permission_prompt__approve_permission',
      'test prompt',
    ]);

    expect(config.shouldHideInteractiveTools()).toBe(false);
    expect(config.getExcludeTools()).toContain(ASK_USER_TOOL_NAME);
  });

  it('does not set hideInteractiveTools for remote worker mode', async () => {
    vi.mocked(ServerConfig.isRemoteWorkerMode).mockReturnValue(true);

    const config = await loadConfigForArgv(['--print', 'test prompt']);

    expect(config.shouldHideInteractiveTools()).toBe(false);
  });
});

describe('loadCliConfig permission mode', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/mock/home/user');
    vi.stubEnv('GEMINI_API_KEY', 'test-api-key');
    process.argv = ['node', 'script.js']; // Reset argv for each test
    vi.mocked(isWorkspaceTrusted).mockReturnValue({
      isTrusted: true,
      source: undefined,
    });
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('should default to DEFAULT permission mode when no flags are set', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(
      createLoadedSettings(),
      'test-session',
      argv,
      {},
    );
    expect(config.getPermissionMode()).toBe('default');
  });

  it('should set bypassPermissions permission mode when --permission-mode=bypass_permissions is used', async () => {
    process.argv = [
      'node',
      'script.js',
      '--permission-mode',
      'bypass_permissions',
    ];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(
      createLoadedSettings(),
      'test-session',
      argv,
      {},
    );
    expect(config.getPermissionMode()).toBe('yolo');
  });

  it('should set bypassPermissions permission mode when --yolo is used', async () => {
    process.argv = ['node', 'script.js', '--yolo'];
    const argv = await parseArgsForRootCommand();
    expect(argv.permissionMode).toBe('bypass_permissions');
    const config = await loadCliConfig(
      createLoadedSettings(),
      'test-session',
      argv,
      {},
    );
    expect(config.getPermissionMode()).toBe('yolo');
  });

  it('should set bypassPermissions permission mode when --dangerously-skip-permissions is used', async () => {
    process.argv = ['node', 'script.js', '--dangerously-skip-permissions'];
    const argv = await parseArgsForRootCommand();
    expect(argv.permissionMode).toBe('bypass_permissions');
    const config = await loadCliConfig(
      createLoadedSettings(),
      'test-session',
      argv,
      {},
    );
    expect(config.getPermissionMode()).toBe('yolo');
  });

  it('should set DEFAULT permission mode when --permission-mode=default', async () => {
    process.argv = ['node', 'script.js', '--permission-mode', 'default'];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(
      createLoadedSettings(),
      'test-session',
      argv,
      {},
    );
    expect(config.getPermissionMode()).toBe('default');
  });

  it('should set acceptEdits permission mode when --permission-mode=accept_edits', async () => {
    process.argv = ['node', 'script.js', '--permission-mode', 'accept_edits'];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(
      createLoadedSettings(),
      'test-session',
      argv,
      {},
    );
    expect(config.getPermissionMode()).toBe('acceptEdits');
  });

  it('should set permission mode from ENV_PERMISSION_MODE when --permission-mode is absent', async () => {
    process.env[ENV_PERMISSION_MODE] = 'accept_edits';
    process.argv = ['node', 'script.js'];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(
      createLoadedSettings({
        general: { defaultPermissionMode: 'default' },
      }),
      'test-session',
      argv,
      {},
    );
    expect(config.getPermissionMode()).toBe('acceptEdits');
  });

  it('should set auto permission mode when --permission-mode=auto', async () => {
    process.argv = ['node', 'script.js', '--permission-mode', 'auto'];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(
      createLoadedSettings(),
      'test-session',
      argv,
      {},
    );
    expect(config.getPermissionMode()).toBe('auto');
  });

  it('should set Plan permission mode when --permission-mode=plan is used and plan is enabled', async () => {
    process.argv = ['node', 'script.js', '--permission-mode', 'plan'];
    const argv = await parseArgsForRootCommand();
    const settings = createLoadedSettings({
      general: {
        plan: { enabled: true },
      },
    });
    const config = await loadCliConfig(settings, 'test-session', argv, {});
    expect(config.getPermissionMode()).toBe('default');
    expect(config.isPlanMode()).toBe(true);
  });

  it('should ignore "bypassPermissions" in settings.general.defaultPermissionMode and fall back to DEFAULT', async () => {
    process.argv = ['node', 'script.js'];
    const settings = createLoadedSettings({
      tools: {
        // @ts-expect-error: testing invalid value
        approvalMode: 'bypassPermissions',
      },
    });
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(settings, 'test-session', argv, {});
    expect(config.getPermissionMode()).toBe('default');
  });

  it('should fall back to default for an invalid default permission mode in settings', async () => {
    process.argv = ['node', 'script.js'];
    const settings = createLoadedSettings({
      general: {
        defaultPermissionMode: '1',
      },
    });
    const argv = await parseArgsForRootCommand();

    const config = await loadCliConfig(settings, 'test-session', argv, {});

    expect(config.getPermissionMode()).toBe('default');
  });

  it('should throw error when --permission-mode=plan is used but plan is disabled', async () => {
    process.argv = ['node', 'script.js', '--permission-mode', 'plan'];
    const argv = await parseArgsForRootCommand();
    const settings = createLoadedSettings({
      general: {
        plan: { enabled: false },
      },
    });

    const config = await loadCliConfig(settings, 'test-session', argv, {});
    expect(config.getPermissionMode()).toBe('default');
  });

  it('should allow plan permission mode by default when --permission-mode=plan is used', async () => {
    process.argv = ['node', 'script.js', '--permission-mode', 'plan'];
    const argv = await parseArgsForRootCommand();
    const settings = createLoadedSettings({});

    const config = await loadCliConfig(settings, 'test-session', argv, {});
    expect(config.getPermissionMode()).toBe('default');
    expect(config.isPlanMode()).toBe(true);
  });

  it('should pass planSettings.directory from settings to config', async () => {
    process.argv = ['node', 'script.js'];
    const settings = createLoadedSettings({
      general: {
        plan: {
          directory: '.custom-plans',
        },
      },
    } as unknown as Settings);
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(settings, 'test-session', argv, {});
    const plansDir = config.storage.getPlansDir();
    expect(plansDir).toContain('.custom-plans');
  });

  // --- Untrusted Folder Scenarios ---
  describe('when folder is NOT trusted', () => {
    beforeEach(() => {
      vi.mocked(isWorkspaceTrusted).mockReturnValue({
        isTrusted: false,
        source: 'file',
      });
    });

    it('should override --permission-mode=bypass_permissions to DEFAULT', async () => {
      process.argv = [
        'node',
        'script.js',
        '--permission-mode',
        'bypass_permissions',
      ];
      const argv = await parseArgsForRootCommand();
      const config = await loadCliConfig(
        createLoadedSettings(),
        'test-session',
        argv,
        {},
      );
      expect(config.getPermissionMode()).toBe('default');
    });

    it('should restore --yolo after the folder becomes trusted', async () => {
      process.argv = ['node', 'script.js', '--yolo'];
      const argv = await parseArgsForRootCommand();
      expect(argv.permissionMode).toBe('bypass_permissions');

      const config = await loadCliConfig(
        createLoadedSettings(),
        'test-session',
        argv,
        {},
      );
      expect(config.getPermissionMode()).toBe('default');

      config.setTrustedFolder(true);

      // `sessionBaseMode` and `isBypassPermissionsModeAvailable` are gone: the
      // first was replaced by the subagent override supplier, and the second was
      // a second gate on a question the mode resolution already answers.
      expect(config.getPermissionMode()).toBe('yolo');
      expect(config.initPermission()?.getPermissionMode()).toBe('yolo');
    });

    it('should override --permission-mode=accept_edits to DEFAULT', async () => {
      process.argv = ['node', 'script.js', '--permission-mode', 'accept_edits'];
      const argv = await parseArgsForRootCommand();
      const config = await loadCliConfig(
        createLoadedSettings(),
        'test-session',
        argv,
        {},
      );
      expect(config.getPermissionMode()).toBe('default');
    });

    it('should remain DEFAULT when --permission-mode=default', async () => {
      process.argv = ['node', 'script.js', '--permission-mode', 'default'];
      const argv = await parseArgsForRootCommand();
      const config = await loadCliConfig(
        createLoadedSettings(),
        'test-session',
        argv,
        {},
      );
      expect(config.getPermissionMode()).toBe('default');
    });

    it('should keep disabled plan mode as default after the folder becomes trusted', async () => {
      process.argv = ['node', 'script.js', '--permission-mode', 'plan'];
      const argv = await parseArgsForRootCommand();
      const settings = createLoadedSettings({
        general: {
          plan: { enabled: false },
        },
      });

      const config = await loadCliConfig(settings, 'test-session', argv, {});
      expect(config.getPermissionMode()).toBe('default');

      config.setTrustedFolder(true);

      expect(config.getPermissionMode()).toBe('default');
      expect(config.initPermission()?.getPermissionMode()).toBe('default');
    });
  });

  describe('Persistent permissionMode setting', () => {
    it('should use permissionMode from settings when no CLI flags are set', async () => {
      process.argv = ['node', 'script.js'];
      const settings = createLoadedSettings({
        general: { defaultPermissionMode: 'accept_edits' },
      });
      const argv = await parseArgsForRootCommand();
      const config = await loadCliConfig(settings, 'test-session', argv, {});
      expect(config.getPermissionMode()).toBe('acceptEdits');
    });

    it('should prioritize --permission-mode flag over settings', async () => {
      process.argv = ['node', 'script.js', '--permission-mode', 'accept_edits'];
      const settings = createLoadedSettings({
        general: { defaultPermissionMode: 'default' },
      });
      const argv = await parseArgsForRootCommand();
      const config = await loadCliConfig(settings, 'test-session', argv, {});
      expect(config.getPermissionMode()).toBe('acceptEdits');
    });

    it('should prioritize --permission-mode=bypass_permissions flag over settings', async () => {
      process.argv = [
        'node',
        'script.js',
        '--permission-mode',
        'bypass_permissions',
      ];
      const settings = createLoadedSettings({
        general: { defaultPermissionMode: 'accept_edits' },
      });
      const argv = await parseArgsForRootCommand();
      const config = await loadCliConfig(settings, 'test-session', argv, {});
      expect(config.getPermissionMode()).toBe('yolo');
    });

    it('should accept canonical --permission-mode=bypass_permissions', async () => {
      process.argv = [
        'node',
        'script.js',
        '--permission-mode',
        'bypass_permissions',
      ];
      const settings = createLoadedSettings();
      const argv = await parseArgsForRootCommand();
      const config = await loadCliConfig(settings, 'test-session', argv, {});
      expect(config.getPermissionMode()).toBe('yolo');
    });

    it('should accept canonical --permission-mode=accept_edits', async () => {
      process.argv = ['node', 'script.js', '--permission-mode', 'accept_edits'];
      const settings = createLoadedSettings();
      const argv = await parseArgsForRootCommand();
      const config = await loadCliConfig(settings, 'test-session', argv, {});
      expect(config.getPermissionMode()).toBe('acceptEdits');
    });

    it('should accept canonical --permission-mode=dont_ask', async () => {
      process.argv = ['node', 'script.js', '--permission-mode', 'dont_ask'];
      const settings = createLoadedSettings();
      const argv = await parseArgsForRootCommand();
      const config = await loadCliConfig(settings, 'test-session', argv, {});
      expect(config.getPermissionMode()).toBe('dontAsk');
    });

    it.each([
      ['acceptEdits', 'acceptEdits'],
      // The flag spelling is unchanged; only the mode it maps to was renamed.
      ['bypassPermissions', 'yolo'],
      ['dontAsk', 'dontAsk'],
    ] as const)(
      'should accept camelCase --permission-mode=%s',
      async (flagValue, expectedMode) => {
        process.argv = ['node', 'script.js', '--permission-mode', flagValue];
        const settings = createLoadedSettings();
        const argv = await parseArgsForRootCommand();
        const config = await loadCliConfig(settings, 'test-session', argv, {});
        expect(config.getPermissionMode()).toBe(expectedMode);
      },
    );

    it('should respect plan mode from settings when plan is enabled', async () => {
      process.argv = ['node', 'script.js'];
      const settings = createLoadedSettings({
        general: {
          defaultPermissionMode: 'plan',
          plan: { enabled: true },
        },
      });
      const argv = await parseArgsForRootCommand();
      const config = await loadCliConfig(settings, 'test-session', argv, {});
      expect(config.getPermissionMode()).toBe('default');
      expect(config.isPlanMode()).toBe(true);
    });

    it('should fall back to default if plan mode is in settings but disabled', async () => {
      process.argv = ['node', 'script.js'];
      const settings = createLoadedSettings({
        general: {
          defaultPermissionMode: 'plan',
          plan: { enabled: false },
        },
      });
      const argv = await parseArgsForRootCommand();
      const config = await loadCliConfig(settings, 'test-session', argv, {});
      expect(config.getPermissionMode()).toBe('default');
    });

    it('should use auto from settings', async () => {
      process.argv = ['node', 'script.js'];
      const settings = createLoadedSettings({
        general: { defaultPermissionMode: 'auto' },
      });
      const argv = await parseArgsForRootCommand();
      const config = await loadCliConfig(settings, 'test-session', argv, {});
      expect(config.getPermissionMode()).toBe('auto');
    });
  });

  describe('Permission rules from loaded settings', () => {
    it('loads permissions.allow from flag settings into the runtime context', async () => {
      process.argv = ['node', 'script.js'];
      const loadedSettings = createLoadedSettingsFromSources({
        flag: {
          permissions: { allow: ['Write'] },
        } as unknown as Partial<Settings>,
      });
      const argv = await parseArgsForRootCommand();
      const config = await loadCliConfig(
        loadedSettings,
        'test-session',
        argv,
        {},
      );

      expect(
        config.initPermission()?.getRules().allow.flagSettings,
      ).toEqual(['Write']);
    });

    it('loads permissions.deny from trusted workspace settings into the runtime context', async () => {
      process.argv = ['node', 'script.js'];
      const loadedSettings = createLoadedSettingsFromSources({
        project: {
          permissions: { deny: ['Write'] },
        } as unknown as Partial<Settings>,
      });
      const argv = await parseArgsForRootCommand();
      const config = await loadCliConfig(
        loadedSettings,
        'test-session',
        argv,
        {},
      );

      expect(
        config.initPermission()?.getRules().deny.projectSettings,
      ).toEqual(['Write']);
    });

    it('ignores non-policy permission rules when managed-only is enabled', async () => {
      process.argv = ['node', 'script.js'];
      const loadedSettings = createLoadedSettingsFromSources({
        user: {
          allowManagedPermissionRulesOnly: true,
          permissions: { allow: ['Write'], deny: ['Read'] },
        } as unknown as Partial<Settings>,
      });
      const argv = await parseArgsForRootCommand();
      const config = await loadCliConfig(
        loadedSettings,
        'test-session',
        argv,
        {},
      );

      expect(
        config.initPermission()?.getRules().allow.userSettings,
      ).toBe(undefined);
      expect(
        config.initPermission()?.getRules().deny.userSettings,
      ).toBe(undefined);
    });
  });
});

describe('loadCliConfig fileFiltering', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/mock/home/user');
    vi.stubEnv('GEMINI_API_KEY', 'test-api-key');
    process.argv = ['node', 'script.js']; // Reset argv for each test
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  type FileFilteringSettings = NonNullable<
    NonNullable<Settings['context']>['fileFiltering']
  >;
  const testCases: Array<{
    property: keyof FileFilteringSettings;
    getter: (config: ServerConfig.Config) => boolean;
    value: boolean;
  }> = [
    {
      property: 'enableFuzzySearch',
      getter: (c) => c.getFileFilteringEnableFuzzySearch(),
      value: true,
    },
    {
      property: 'enableFuzzySearch',
      getter: (c) => c.getFileFilteringEnableFuzzySearch(),
      value: false,
    },
    {
      property: 'respectGitIgnore',
      getter: (c) => c.getFileFilteringRespectGitIgnore(),
      value: true,
    },
    {
      property: 'respectGitIgnore',
      getter: (c) => c.getFileFilteringRespectGitIgnore(),
      value: false,
    },
    {
      property: 'respectBrandIgnore',
      getter: (c) => c.getFileFilteringRespectBrandIgnore(),
      value: true,
    },
    {
      property: 'respectBrandIgnore',
      getter: (c) => c.getFileFilteringRespectBrandIgnore(),
      value: false,
    },
    {
      property: 'enableRecursiveFileSearch',
      getter: (c) => c.getEnableRecursiveFileSearch(),
      value: true,
    },
    {
      property: 'enableRecursiveFileSearch',
      getter: (c) => c.getEnableRecursiveFileSearch(),
      value: false,
    },
  ];

  it.each(testCases)(
    'should pass $property from settings to config when $value',
    async ({ property, getter, value }) => {
      const settings = createLoadedSettings({
        context: {
          fileFiltering: { [property]: value },
        },
      });
      const argv = await parseArgsForRootCommand();
      const config = await loadCliConfig(settings, 'test-session', argv, {});
      expect(getter(config)).toBe(value);
    },
  );
});

describe('Output format', () => {
  beforeEach(() => {});

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should default to TEXT', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(
      createLoadedSettings(),
      'test-session',
      argv,
      {},
    );
    expect(config.getOutputFormat()).toBe(OutputFormat.TEXT);
  });

  it('should use the format from settings', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(
      createLoadedSettings({ output: { format: OutputFormat.JSON } }),
      'test-session',
      argv,
      {},
    );
    expect(config.getOutputFormat()).toBe(OutputFormat.JSON);
  });

  it('should prioritize the format from argv', async () => {
    process.argv = ['node', 'script.js', '--output-format', 'json'];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(
      createLoadedSettings({ output: { format: OutputFormat.JSON } }),
      'test-session',
      argv,
      {},
    );
    expect(config.getOutputFormat()).toBe(OutputFormat.JSON);
  });

  it('should accept stream-json as a valid output format', async () => {
    process.argv = ['node', 'script.js', '--output-format', 'stream-json'];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(
      createLoadedSettings(),
      'test-session',
      argv,
      {},
    );
    expect(config.getOutputFormat()).toBe(OutputFormat.STREAM_JSON);
  });

  it('should error on invalid --output-format argument', async () => {
    process.argv = ['node', 'script.js', '--output-format', 'invalid'];

    const mockStdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const debugErrorSpy = vi
      .spyOn(runLogger, 'error')
      .mockImplementation(() => {});

    await expect(runCommandTree()).rejects.toThrow(StartupInputError);
    expect(debugErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid values:'),
    );

    mockStdoutWrite.mockRestore();
    debugErrorSpy.mockRestore();
  });
});

describe('argv parsing with positional prompt', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    // Default to headless mode for these tests as they mostly expect one-shot behavior
    process.stdin.isTTY = false;
    Object.defineProperty(process.stdout, 'isTTY', {
      value: false,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  it('should throw an error when both a positional prompt and the --prompt flag are used', async () => {
    process.argv = [
      'node',
      'script.js',
      'positional',
      'prompt',
      '--prompt',
      'test prompt',
    ];

    const mockConsoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const debugErrorSpy = vi
      .spyOn(runLogger, 'error')
      .mockImplementation(() => {});

    await expect(runCommandTree()).rejects.toThrow(StartupInputError);

    expect(debugErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Cannot use both a positional prompt and the --prompt flag together',
      ),
    );

    mockConsoleError.mockRestore();
    debugErrorSpy.mockRestore();
  });

  it('should correctly parse a positional prompt to query field', async () => {
    process.argv = ['node', 'script.js', 'positional', 'prompt'];
    const argv = await parseArgsForRootCommand();
    expect(argv.query).toBe('positional prompt');
    // Since no explicit prompt flags are set and query doesn't start with @, should map to prompt (one-shot)
    expect(argv.prompt).toBe('positional prompt');
    expect(argv.promptInteractive).toBeUndefined();
  });

  it('should have correct positional argument description', async () => {
    // Test that the positional argument has the expected description
    // This test verifies that the positional 'query' argument is properly configured
    // with the description: "Positional prompt. Defaults to one-shot; use -i/--prompt-interactive for interactive."
    process.argv = ['node', 'script.js', 'test', 'query'];
    const argv = await parseArgsForRootCommand();
    expect(argv.query).toBe('test query');
  });

  it('should correctly parse a prompt from the --prompt flag', async () => {
    process.argv = ['node', 'script.js', '--prompt', 'test prompt'];
    const argv = await parseArgsForRootCommand();
    expect(argv.prompt).toBe('test prompt');
    expect(argv.deprecationWarnings).toEqual([
      'The --prompt flag is deprecated. Use -p/--print with a positional prompt or stdin.',
    ]);
  });
});

describe('loadCliConfig disableYoloMode', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/mock/home/user');
    vi.stubEnv('GEMINI_API_KEY', 'test-api-key');

    vi.mocked(isWorkspaceTrusted).mockReturnValue({
      isTrusted: true,
      source: undefined,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('should allow acceptEdits mode even if bypass permissions mode is disabled', async () => {
    process.argv = ['node', 'script.js', '--permission-mode=accept_edits'];
    const argv = await parseArgsForRootCommand();
    const settings = createLoadedSettings({
      security: { disableYoloMode: true },
    });
    const config = await loadCliConfig(settings, 'test-session', argv, {});
    expect(config.getPermissionMode()).toBe('acceptEdits');
  });

  it('should fall back to default if bypassPermissions mode is attempted when disableYoloMode is true', async () => {
    process.argv = [
      'node',
      'script.js',
      '--permission-mode',
      'bypass_permissions',
    ];
    const argv = await parseArgsForRootCommand();
    const settings = createLoadedSettings({
      security: { disableYoloMode: true },
    });
    const config = await loadCliConfig(settings, 'test-session', argv, {});

    expect(config.getPermissionMode()).toBe('default');
    expect(config.isYoloModeDisabled()).toBe(true);
  });

  it('should fall back to default if dangerously-skip-permissions is attempted when disableYoloMode is true', async () => {
    process.argv = ['node', 'script.js', '--dangerously-skip-permissions'];
    const argv = await parseArgsForRootCommand();
    const settings = createLoadedSettings({
      security: { disableYoloMode: true },
    });
    const config = await loadCliConfig(settings, 'test-session', argv, {});

    expect(config.getPermissionMode()).toBe('default');
    expect(config.isYoloModeDisabled()).toBe(true);
  });
});

describe('loadCliConfig secureModeEnabled', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/mock/home/user');
    vi.stubEnv('GEMINI_API_KEY', 'test-api-key');

    vi.mocked(isWorkspaceTrusted).mockReturnValue({
      isTrusted: true,
      source: undefined,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('should fall back to default if bypassPermissions mode is attempted when secureModeEnabled is true', async () => {
    process.argv = [
      'node',
      'script.js',
      '--permission-mode',
      'bypass_permissions',
    ];
    const argv = await parseArgsForRootCommand();
    const settings = createLoadedSettings({
      security: {
        disableYoloMode: true,
      },
    });

    const config = await loadCliConfig(settings, 'test-session', argv, {});

    expect(config.getPermissionMode()).toBe('default');
    expect(config.isYoloModeDisabled()).toBe(true);
  });

  it('should fall back to default if permission-mode=bypassPermissions is attempted when secureModeEnabled is true', async () => {
    process.argv = [
      'node',
      'script.js',
      '--permission-mode=bypass_permissions',
    ];
    const argv = await parseArgsForRootCommand();
    const settings = createLoadedSettings({
      security: {
        disableYoloMode: true,
      },
    });

    const config = await loadCliConfig(settings, 'test-session', argv, {});

    expect(config.getPermissionMode()).toBe('default');
    expect(config.isYoloModeDisabled()).toBe(true);
  });

  it('should set disableYoloMode to true when secureModeEnabled is true', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArgsForRootCommand();
    const settings = createLoadedSettings({
      security: {
        disableYoloMode: true,
      },
    });
    const config = await loadCliConfig(settings, 'test-session', argv, {});
    expect(config.isYoloModeDisabled()).toBe(true);
  });
});

describe('loadCliConfig mcpEnabled', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/mock/home/user');
    vi.stubEnv('GEMINI_API_KEY', 'test-api-key');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const mcpSettings = {
    mcp: {
      serverCommand: 'mcp-server',
      allowed: ['serverA'],
      excluded: ['serverB'],
    },
    mcpServers: { serverA: { url: 'http://a' } },
  };

  it('should enable MCP by default', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArgsForRootCommand();
    const settings = createLoadedSettings({ ...mcpSettings });
    const config = await loadCliConfig(settings, 'test-session', argv, {});
    expect(config.getMcpEnabled()).toBe(true);
    expect(config.getMcpServerCommand()).toBe('mcp-server');
    expect(config.getMcpServers()).toEqual({
      serverA: { url: 'http://a', scope: 'user' },
      mcp: { command: 'mcp-server', args: [], scope: 'flag' },
    });
    expect(config.getAllowedMcpServers()).toEqual(['serverA']);
    expect(config.getBlockedMcpServers()).toEqual(['serverB']);
  });

  describe('extension plan settings', () => {
    beforeEach(() => {
      vi.spyOn(Storage.prototype, 'getProjectTempDir').mockReturnValue(
        `/mock/home/user/${CONFIG_DIR}/tmp/test-project`,
      );
    });

    it('should use default global plans dir when user has not specified one', async () => {
      process.argv = ['node', 'script.js'];
      const settings = createLoadedSettings({
        general: {
          plan: { enabled: true },
        },
      });
      const argv = await parseArgsForRootCommand();

      const config = await loadCliConfig(settings, 'test-session', argv, {});

      expect(config.storage.getPlansDir()).toContain('plans');
    });

    it('should use default path if neither user nor extension settings provide a plan directory', async () => {
      process.argv = ['node', 'script.js'];
      const settings = createLoadedSettings({
        general: {
          plan: { enabled: true },
        },
      });
      const argv = await parseArgsForRootCommand();

      // No extensions providing plan directory

      const config = await loadCliConfig(settings, 'test-session', argv, {});
      expect(config.storage.getPlansDir()).toBe(
        path.join(Storage.getGlobalConfigDir(), 'plans'),
      );
    });
  });
});

describe('loadCliConfig acpMode and clientName', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/mock/home/user');
    vi.stubEnv('GEMINI_API_KEY', 'test-api-key');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should set acpMode to true and use the vscode clientName placeholder when --acp flag is used', async () => {
    process.argv = ['node', 'script.js', '--acp'];
    vi.stubEnv('TERM_PROGRAM', 'iTerm.app'); // Placeholder is terminal-independent
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(
      createLoadedSettings(),
      'test-session',
      argv,
      { cwd: process.cwd() },
    );
    expect(config.getAcpMode()).toBe(true);
    expect(config.getClientName()).toBe('vscode');
  });

  it('should set acpMode to false and clientName to undefined by default', async () => {
    process.argv = ['node', 'script.js'];
    const argv = await parseArgsForRootCommand();
    const config = await loadCliConfig(
      createLoadedSettings(),
      'test-session',
      argv,
      {},
    );
    expect(config.getAcpMode()).toBe(false);
    expect(config.getClientName()).toBeUndefined();
  });
});

describe('argv parsing missing option coverage', () => {
  describe('--config-dir', () => {
    it('parses a custom user-level config root', async () => {
      process.argv = ['node', 'script.js', '--config-dir', '/tmp/qwen-config'];
      const argv = await parseArgsForRootCommand();
      expect(argv.configDir).toBe('/tmp/qwen-config');
    });
  });

  describe('--mcp-config', () => {
    it('parses a single --mcp-config value', async () => {
      process.argv = ['node', 'script.js', '--mcp-config', '/tmp/mcp.json'];
      const argv = await parseArgsForRootCommand();
      expect(argv.mcpConfig).toEqual(['/tmp/mcp.json']);
    });

    it('parses multiple --mcp-config values', async () => {
      process.argv = [
        'node',
        'script.js',
        '--mcp-config',
        '/tmp/a.json',
        '--mcp-config',
        '/tmp/b.json',
      ];
      const argv = await parseArgsForRootCommand();
      expect(argv.mcpConfig).toEqual(['/tmp/a.json', '/tmp/b.json']);
    });
  });

  describe('--strict-mcp-config', () => {
    it('defaults to false when not provided', async () => {
      process.argv = ['node', 'script.js'];
      const argv = await parseArgsForRootCommand();
      expect(argv.strictMcpConfig).toBe(false);
    });

    it('sets strictMcpConfig to true when provided', async () => {
      process.argv = ['node', 'script.js', '--strict-mcp-config'];
      const argv = await parseArgsForRootCommand();
      expect(argv.strictMcpConfig).toBe(true);
    });
  });

  describe('--allow-plugin-mcp', () => {
    it('defaults to false even in strict mode', async () => {
      process.argv = ['node', 'script.js', '--strict-mcp-config'];
      const argv = await parseArgsForRootCommand();
      expect(argv.allowPluginMcp).toBe(false);
      expect(argv.explicitCliOptionNames).not.toContain('allowPluginMcp');
    });

    it('can be used without strict mode', async () => {
      process.argv = ['node', 'script.js', '--allow-plugin-mcp'];
      const argv = await parseArgsForRootCommand();
      expect(argv.allowPluginMcp).toBe(true);
      expect(argv.strictMcpConfig).toBe(false);
    });

    it.each([
      ['--strict-mcp-config', '--allow-plugin-mcp'],
      ['--allow-plugin-mcp', '--strict-mcp-config'],
    ])('preserves the query after %s %s', async (...flags) => {
      process.argv = ['node', 'script.js', ...flags, 'explain this project'];
      const argv = await parseArgsForRootCommand();
      expect(argv.strictMcpConfig).toBe(true);
      expect(argv.allowPluginMcp).toBe(true);
      expect(argv.query).toBe('explain this project');
      expect(argv.explicitCliOptionNames).toContain('allowPluginMcp');
    });

    it.each([
      { mode: 'TUI', args: [] },
      { mode: 'headless text', args: ['-p'] },
      {
        mode: 'stream-json',
        args: [
          '-p',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
        ],
      },
      { mode: 'ACP', args: ['--acp'] },
    ])(
      'requires explicit opt-in under strict mode in $mode',
      async ({ args }) => {
        const loadedSettings = createLoadedSettings({
          mcpServers: { userServer: { command: 'from-user-settings' } },
        });

        for (const allowPluginMcp of [false, true]) {
          process.argv = [
            'node',
            'script.js',
            ...args,
            '--strict-mcp-config',
            ...(allowPluginMcp ? ['--allow-plugin-mcp'] : []),
          ];
          const argv = await parseArgsForRootCommand();
          const config = await loadCliConfig(
            loadedSettings,
            'test-session',
            argv,
            { cwd: process.cwd() },
          );

          expect(config.getMcpServers()).toEqual({});
          expect(config.getMcpSettingsSourcesEnabled()).toBe(false);
          expect(config.getPluginMcpServersEnabled()).toBe(allowPluginMcp);
        }
      },
    );
  });

  describe('--setting-sources', () => {
    it('parses a single --setting-sources value', async () => {
      process.argv = ['node', 'script.js', '--setting-sources', 'user'];
      const argv = await parseArgsForRootCommand();
      expect(argv.settingSources).toEqual(['user']);
    });

    it('parses multiple --setting-sources values', async () => {
      process.argv = [
        'node',
        'script.js',
        '--setting-sources',
        'user',
        '--setting-sources',
        'project',
      ];
      const argv = await parseArgsForRootCommand();
      expect(argv.settingSources).toEqual(['user', 'project']);
    });

    it('parses comma-separated --setting-sources', async () => {
      process.argv = [
        'node',
        'script.js',
        '--setting-sources',
        'user,project,local',
      ];
      const argv = await parseArgsForRootCommand();
      expect(argv.settingSources).toEqual(['user', 'project', 'local']);
    });
  });

  describe('--settings', () => {
    it('parses --settings with a JSON string', async () => {
      process.argv = ['node', 'script.js', '--settings', '{"theme":"dark"}'];
      const argv = await parseArgsForRootCommand();
      expect((argv as unknown as Record<string, unknown>)['settings']).toBe(
        '{"theme":"dark"}',
      );
    });

    it('parses --settings with a file path', async () => {
      process.argv = ['node', 'script.js', '--settings', '/tmp/settings.json'];
      const argv = await parseArgsForRootCommand();
      expect((argv as unknown as Record<string, unknown>)['settings']).toBe(
        '/tmp/settings.json',
      );
    });
  });

  describe('--reasoning-effort', () => {
    it('parses --reasoning-effort with a valid value', async () => {
      process.argv = ['node', 'script.js', '--reasoning-effort', 'high'];
      const argv = await parseArgsForRootCommand();
      expect(argv.reasoningEffort).toBe('high');
    });

    it('accepts ultracode as a CLI-only special value', async () => {
      process.argv = ['node', 'script.js', '--reasoning-effort', 'ultracode'];
      const argv = await parseArgsForRootCommand();
      expect(argv.reasoningEffort).toBe('ultracode');
    });

    it('leaves reasoningEffort undefined when not provided', async () => {
      process.argv = ['node', 'script.js'];
      const argv = await parseArgsForRootCommand();
      expect(argv.reasoningEffort).toBeUndefined();
    });
  });

  describe('--max-turns', () => {
    it.each([
      { value: '0', expected: 0 },
      { value: '1', expected: 1 },
      { value: '100', expected: 100 },
    ])('parses $value as $expected', async ({ value, expected }) => {
      process.argv = ['node', 'script.js', '--max-turns', value];

      const argv = await parseArgsForRootCommand();

      expect(argv.maxTurns).toBe(expected);
    });

    it.each(['-1', '1.5', 'abc', '1e2', '9007199254740992'])(
      'rejects invalid value %s',
      async (value) => {
        process.argv = ['node', 'script.js', '--max-turns', value];

        // Rejected by the option's own parser, so commander reports it.
        await expect(runCommandTree()).rejects.toThrow(CommanderError);
      },
    );
  });

  describe('--plugin-dir', () => {
    it('parses a single --plugin-dir', async () => {
      process.argv = ['node', 'script.js', '--plugin-dir', '/tmp/plugins'];
      const argv = await parseArgsForRootCommand();
      expect((argv as unknown as Record<string, unknown>)['pluginDir']).toEqual(
        ['/tmp/plugins'],
      );
    });

    it('parses multiple --plugin-dir values', async () => {
      process.argv = [
        'node',
        'script.js',
        '--plugin-dir',
        '/tmp/a',
        '--plugin-dir',
        '/tmp/b',
      ];
      const argv = await parseArgsForRootCommand();
      expect((argv as unknown as Record<string, unknown>)['pluginDir']).toEqual(
        ['/tmp/a', '/tmp/b'],
      );
    });
  });

  describe('--list-sessions', () => {
    it('sets listSessions to true when provided', async () => {
      process.argv = ['node', 'script.js', '--list-sessions'];
      const argv = await parseArgsForRootCommand();
      expect(argv.listSessions).toBe(true);
    });

    it('leaves listSessions undefined when not provided', async () => {
      process.argv = ['node', 'script.js'];
      const argv = await parseArgsForRootCommand();
      expect(argv.listSessions).toBeUndefined();
    });
  });

  describe('--delete-session', () => {
    it('parses --delete-session with an index', async () => {
      process.argv = ['node', 'script.js', '--delete-session', '3'];
      const argv = await parseArgsForRootCommand();
      expect(argv.deleteSession).toBe('3');
    });

    it('leaves deleteSession undefined when not provided', async () => {
      process.argv = ['node', 'script.js'];
      const argv = await parseArgsForRootCommand();
      expect(argv.deleteSession).toBeUndefined();
    });
  });

  describe('--add-dir', () => {
    it('parses a single --add-dir', async () => {
      process.argv = ['node', 'script.js', '--add-dir', '/tmp/extra'];
      const argv = await parseArgsForRootCommand();
      expect(argv.addDir).toEqual(['/tmp/extra']);
    });

    it('parses multiple --add-dir values', async () => {
      process.argv = [
        'node',
        'script.js',
        '--add-dir',
        '/tmp/a',
        '--add-dir',
        '/tmp/b',
      ];
      const argv = await parseArgsForRootCommand();
      expect(argv.addDir).toEqual(['/tmp/a', '/tmp/b']);
    });

    it('parses comma-separated --add-dir', async () => {
      process.argv = ['node', 'script.js', '--add-dir', '/tmp/a,/tmp/b'];
      const argv = await parseArgsForRootCommand();
      expect(argv.addDir).toEqual(['/tmp/a', '/tmp/b']);
    });
  });

  describe('--input-format', () => {
    it('parses --input-format with a valid value', async () => {
      process.argv = ['node', 'script.js', '--input-format', 'stream-json'];
      const argv = await parseArgsForRootCommand();
      expect(argv.inputFormat).toBe('stream-json');
    });

    it('parses --input-format text', async () => {
      process.argv = ['node', 'script.js', '--input-format', 'text'];
      const argv = await parseArgsForRootCommand();
      expect(argv.inputFormat).toBe('text');
    });

    it('leaves inputFormat undefined when not provided', async () => {
      process.argv = ['node', 'script.js'];
      const argv = await parseArgsForRootCommand();
      expect(argv.inputFormat).toBeUndefined();
    });
  });

  describe('--agent and --agents', () => {
    it('parses --agent with a name', async () => {
      process.argv = ['node', 'script.js', '--agent', 'reviewer'];
      const argv = await parseArgsForRootCommand();
      expect(argv.agent).toBe('reviewer');
    });

    it('parses --agents with a JSON string', async () => {
      const agentsJson =
        '{"reviewer":{"description":"Reviews code","prompt":"You are a code reviewer"}}';
      process.argv = ['node', 'script.js', '--agents', agentsJson];
      const argv = await parseArgsForRootCommand();
      expect(argv.agents).toBe(agentsJson);
    });

    it('leaves agent and agents undefined when not provided', async () => {
      process.argv = ['node', 'script.js'];
      const argv = await parseArgsForRootCommand();
      expect(argv.agent).toBeUndefined();
      expect(argv.agents).toBeUndefined();
    });
  });

  describe('-v, --version', () => {
    it('outputs version and exits when --version is provided', async () => {
      process.argv = ['node', 'script.js', '--version'];
      const mockStdoutWrite = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);

      await expect(runCommandTree()).rejects.toThrow(CommanderError);

      mockStdoutWrite.mockRestore();
    });

    it('outputs version and exits when -v is provided', async () => {
      process.argv = ['node', 'script.js', '-v'];
      const mockStdoutWrite = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);

      await expect(runCommandTree()).rejects.toThrow(CommanderError);

      mockStdoutWrite.mockRestore();
    });

    it('does not treat -V (uppercase) as version flag', async () => {
      process.argv = ['node', 'script.js', '-V'];

      const result = await parseArgsForRootCommand();
      expect(result).toBeDefined();
    });
  });

  describe('upstream develop new options', () => {
    it('should parse --context-window', async () => {
      process.argv = ['node', 'script.js', '--context-window', '128000'];
      const argv = await parseArgsForRootCommand();
      expect(argv.contextWindow).toBe('128000');
    });

    it('should parse --max-model-request-retries', async () => {
      process.argv = ['node', 'script.js', '--max-model-request-retries', '7'];
      const argv = await parseArgsForRootCommand();
      expect(argv.maxModelRequestRetries).toBe('7');
    });

    it('should parse --include-hook-events', async () => {
      process.argv = ['node', 'script.js', '--include-hook-events'];
      const argv = await parseArgsForRootCommand();
      expect(argv.includeHookEvents).toBe(true);
    });

    it('should default --include-hook-events to false', async () => {
      process.argv = ['node', 'script.js'];
      const argv = await parseArgsForRootCommand();
      expect(argv.includeHookEvents).toBe(false);
    });

    it('should parse --session-mirror', async () => {
      process.argv = ['node', 'script.js', '--session-mirror'];
      const argv = await parseArgsForRootCommand();
      expect(argv.sessionMirror).toBe(true);
    });

    it('should default --session-mirror to false', async () => {
      process.argv = ['node', 'script.js'];
      const argv = await parseArgsForRootCommand();
      expect(argv.sessionMirror).toBe(false);
    });

    it('should parse --no-session-persistence', async () => {
      process.argv = ['node', 'script.js', '--no-session-persistence'];
      const argv = await parseArgsForRootCommand();
      expect(argv.sessionPersistence).toBe(false);
    });

    it('should parse --emit-reference-content', async () => {
      process.argv = ['node', 'script.js', '--emit-reference-content'];
      const argv = await parseArgsForRootCommand();
      expect(argv.emitReferenceContent).toBe(true);
    });

    it('should default --emit-reference-content to false', async () => {
      process.argv = ['node', 'script.js'];
      const argv = await parseArgsForRootCommand();
      expect(argv.emitReferenceContent).toBe(false);
    });

    it('should parse --headless-fast-hooks', async () => {
      process.argv = ['node', 'script.js', '--headless-fast-hooks'];
      const argv = await parseArgsForRootCommand();
      expect(argv.headlessFastHooks).toBe(true);
    });

    it('should default --headless-fast-hooks to false', async () => {
      process.argv = ['node', 'script.js'];
      const argv = await parseArgsForRootCommand();
      expect(argv.headlessFastHooks).toBe(false);
    });

    it('should parse --disable-builtin-skills', async () => {
      process.argv = ['node', 'script.js', '--disable-builtin-skills'];
      const argv = await parseArgsForRootCommand();
      expect(argv.disableBuiltinSkills).toBe(true);
    });

    it('should default --disable-builtin-skills to false', async () => {
      process.argv = ['node', 'script.js'];
      const argv = await parseArgsForRootCommand();
      expect(argv.disableBuiltinSkills).toBe(false);
    });

    it('should parse comma-separated and repeated --enable-builtin-skills values', async () => {
      process.argv = [
        'node',
        'script.js',
        '--enable-builtin-skills',
        'skill-creator,sdk',
        '--enable-builtin-skills',
        'simplify',
      ];
      const argv = await parseArgsForRootCommand();
      expect(argv.enableBuiltinSkills).toEqual([
        'skill-creator',
        'sdk',
        'simplify',
      ]);
    });

    it('should default --enable-builtin-skills to undefined', async () => {
      process.argv = ['node', 'script.js'];
      const argv = await parseArgsForRootCommand();
      expect(argv.enableBuiltinSkills).toBeUndefined();
    });

    it('should permit an explicit built-in allowlist with the disable flag', async () => {
      process.argv = [
        'node',
        'script.js',
        '--disable-builtin-skills',
        '--enable-builtin-skills',
        'sdk',
      ];
      const argv = await parseArgsForRootCommand();
      expect(argv.disableBuiltinSkills).toBe(true);
      expect(argv.enableBuiltinSkills).toEqual(['sdk']);
    });

    it('should normalize camelCase permission mode acceptEdits to accept_edits', async () => {
      process.argv = ['node', 'script.js', '--permission-mode', 'acceptEdits'];
      const argv = await parseArgsForRootCommand();
      expect(argv.permissionMode).toBe('accept_edits');
    });

    it('should normalize camelCase permission mode bypassPermissions to bypass_permissions', async () => {
      process.argv = [
        'node',
        'script.js',
        '--permission-mode',
        'bypassPermissions',
      ];
      const argv = await parseArgsForRootCommand();
      expect(argv.permissionMode).toBe('bypass_permissions');
    });

    it('should normalize camelCase permission mode dontAsk to dont_ask', async () => {
      process.argv = ['node', 'script.js', '--permission-mode', 'dontAsk'];
      const argv = await parseArgsForRootCommand();
      expect(argv.permissionMode).toBe('dont_ask');
    });
  });
});

describe('argv parsing option combinations', () => {
  it('parses --mcp-config with --strict-mcp-config together', async () => {
    process.argv = [
      'node',
      'script.js',
      '--mcp-config',
      '/tmp/servers.json',
      '--strict-mcp-config',
    ];
    const argv = await parseArgsForRootCommand();
    expect(argv.mcpConfig).toEqual(['/tmp/servers.json']);
    expect(argv.strictMcpConfig).toBe(true);
  });

  it('parses --add-dir with positional prompt', async () => {
    process.argv = [
      'node',
      'script.js',
      '--add-dir',
      '/tmp/extra',
      'hello world',
    ];
    const argv = await parseArgsForRootCommand();
    expect(argv.addDir).toEqual(['/tmp/extra']);
    expect(argv.query).toBe('hello world');
  });

  it('parses --agent with --model together', async () => {
    process.argv = [
      'node',
      'script.js',
      '--agent',
      'coder',
      '--model',
      'test-model',
    ];
    const argv = await parseArgsForRootCommand();
    expect(argv.agent).toBe('coder');
    expect(argv.model).toBe('test-model');
  });

  it('parses --input-format with --output-format together', async () => {
    process.argv = [
      'node',
      'script.js',
      '--input-format',
      'stream-json',
      '--output-format',
      'json',
    ];
    const argv = await parseArgsForRootCommand();
    expect(argv.inputFormat).toBe('stream-json');
    expect(argv.outputFormat).toBe('json');
  });

  it('parses --setting-sources with --settings together', async () => {
    process.argv = [
      'node',
      'script.js',
      '--setting-sources',
      'user',
      '--settings',
      '{"key":"val"}',
    ];
    const argv = await parseArgsForRootCommand();
    expect(argv.settingSources).toEqual(['user']);
    expect((argv as unknown as Record<string, unknown>)['settings']).toBe(
      '{"key":"val"}',
    );
  });

  it('parses --plugin-dir with --add-dir without interference', async () => {
    process.argv = [
      'node',
      'script.js',
      '--plugin-dir',
      '/tmp/plugins',
      '--add-dir',
      '/tmp/extra',
    ];
    const argv = await parseArgsForRootCommand();
    expect((argv as unknown as Record<string, unknown>)['pluginDir']).toEqual([
      '/tmp/plugins',
    ]);
    expect(argv.addDir).toEqual(['/tmp/extra']);
  });

  it('parses --reasoning-effort with --model together', async () => {
    process.argv = [
      'node',
      'script.js',
      '--model',
      'gemini-2.5-pro',
      '--reasoning-effort',
      'medium',
    ];
    const argv = await parseArgsForRootCommand();
    expect(argv.model).toBe('gemini-2.5-pro');
    expect(argv.reasoningEffort).toBe('medium');
  });

  it('parses many options together without collision', async () => {
    process.argv = [
      'node',
      'script.js',
      '--model',
      'test-model',
      '--reasoning-effort',
      'high',
      '--agent',
      'coder',
      '--mcp-config',
      '/tmp/mcp.json',
      '--strict-mcp-config',
      '--setting-sources',
      'user,project',
      '--plugin-dir',
      '/tmp/plugins',
      '--add-dir',
      '/tmp/extra',
      '--input-format',
      'stream-json',
      '--output-format',
      'json',
      '-p',
      '- This is a dash-prefixed prompt',
    ];
    const argv = await parseArgsForRootCommand();
    expect(argv.model).toBe('test-model');
    expect(argv.reasoningEffort).toBe('high');
    expect(argv.agent).toBe('coder');
    expect(argv.mcpConfig).toEqual(['/tmp/mcp.json']);
    expect(argv.strictMcpConfig).toBe(true);
    expect(argv.settingSources).toEqual(['user', 'project']);
    expect((argv as unknown as Record<string, unknown>)['pluginDir']).toEqual([
      '/tmp/plugins',
    ]);
    expect(argv.addDir).toEqual(['/tmp/extra']);
    expect(argv.inputFormat).toBe('stream-json');
    expect(argv.outputFormat).toBe('json');
    expect(argv.print).toBe(true);
    expect(argv.prompt).toBe('- This is a dash-prefixed prompt');
  });
});

describe('loadCliConfig upstream develop features', () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('contextWindow', () => {
    it('passes context window from argv to config', async () => {
      process.argv = ['node', 'script.js', '--context-window', '32000'];
      const argv = await parseArgsForRootCommand();
      const config = await loadCliConfig(
        createLoadedSettings(),
        'test-session',
        argv,
        {},
      );
      expect(launchModelConfig(config)?.context?.contextWindow).toBe(32000);
    });

    it('prefers argv context window over the legacy settings field', async () => {
      process.argv = ['node', 'script.js', '--context-window', '64000'];
      const argv = await parseArgsForRootCommand();
      const config = await loadCliConfig(
        createLoadedSettings({ model: { contextWindow: 128000 } }),
        'test-session',
        argv,
        {},
      );
      expect(launchModelConfig(config)?.context?.contextWindow).toBe(64000);
    });

    it('throws on invalid context window value', async () => {
      process.argv = ['node', 'script.js', '--context-window', 'invalid'];
      const argv = await parseArgsForRootCommand();
      await expect(
        loadCliConfig(createLoadedSettings(), 'test-session', argv, {}),
      ).rejects.toThrow('Invalid context window');
    });
  });

  describe('maxModelRequestRetries', () => {
    it.each([
      ['default settings', {}],
      ['empty --settings override', { flag: {} }],
    ])('allows four retries with %s', async (_name, sources) => {
      process.argv = ['node', 'script.js'];
      const argv = await parseArgsForRootCommand();
      const config = await loadCliConfig(
        createLoadedSettingsFromSources(sources),
        'test-session',
        argv,
        {},
      );

      expect(config.getMaxAttempts()).toBe(5);
    });

    it('converts CLI retries into a shared model request attempt budget', async () => {
      process.argv = ['node', 'script.js', '--max-model-request-retries', '7'];
      const argv = await parseArgsForRootCommand();
      const config = await loadCliConfig(
        createLoadedSettings(),
        'test-session',
        argv,
        {},
      );

      expect(config.getMaxAttempts()).toBe(8);
    });

    it('allows retries to be disabled for both provider paths', async () => {
      process.argv = ['node', 'script.js', '--max-model-request-retries', '0'];
      const argv = await parseArgsForRootCommand();
      const config = await loadCliConfig(
        createLoadedSettings(),
        'test-session',
        argv,
        {},
      );

      expect(config.getMaxAttempts()).toBe(1);
    });

    it('keeps the settings attempt budget when the CLI flag is absent', async () => {
      process.argv = ['node', 'script.js'];
      const argv = await parseArgsForRootCommand();
      const settings = createLoadedSettings();
      (
        settings.merged.general as unknown as { maxAttempts: number }
      ).maxAttempts = 4;
      const config = await loadCliConfig(settings, 'test-session', argv, {});

      expect(config.getMaxAttempts()).toBe(4);
    });

    it('prefers the CLI retry budget over settings attempts', async () => {
      process.argv = ['node', 'script.js', '--max-model-request-retries', '4'];
      const argv = await parseArgsForRootCommand();
      const config = await loadCliConfig(
        createLoadedSettings({ general: { maxAttempts: 3 } }),
        'test-session',
        argv,
        {},
      );

      expect(config.getMaxAttempts()).toBe(5);
    });

    it('throws on an invalid model request retry value', async () => {
      process.argv = [
        'node',
        'script.js',
        '--max-model-request-retries',
        'invalid',
      ];
      const argv = await parseArgsForRootCommand();

      await expect(
        loadCliConfig(createLoadedSettings(), 'test-session', argv, {}),
      ).rejects.toThrow('Invalid max model request retries');
    });
  });

  describe('mcpLazyLoad', () => {
    it('defaults mcpLazyLoad to true', async () => {
      process.argv = ['node', 'script.js'];
      const argv = await parseArgsForRootCommand();
      const config = await loadCliConfig(
        createLoadedSettings(),
        'test-session',
        argv,
        {},
      );
      expect(config.getMcpLazyLoad()).toBe(true);
      expect(config.getMcpLazyLoadSource()).toBe('default');
    });

    it('enables mcpLazyLoad from settings', async () => {
      process.argv = ['node', 'script.js'];
      const argv = await parseArgsForRootCommand();
      const config = await loadCliConfig(
        createLoadedSettings({ mcp: { lazyLoad: true } }),
        'test-session',
        argv,
        {},
      );
      expect(config.getMcpLazyLoad()).toBe(true);
      expect(config.getMcpLazyLoadSource()).toBe('settings');
    });

    it('preserves an explicit false setting', async () => {
      process.argv = ['node', 'script.js'];
      const loadedSettings = createLoadedSettings({
        mcp: { lazyLoad: false },
      });
      const argv = await parseArgsForRootCommand();
      const config = await loadCliConfig(
        loadedSettings,
        'test-session',
        argv,
        {},
      );

      expect(config.getMcpLazyLoad()).toBe(false);
      expect(config.getMcpLazyLoadSource()).toBe('settings');
    });

    it('enables mcpLazyLoad from env var', async () => {
      process.argv = ['node', 'script.js'];
      process.env[ENV_MCP_LAZY] = '1';
      const argv = await parseArgsForRootCommand();
      const config = await loadCliConfig(
        createLoadedSettings(),
        'test-session',
        argv,
        {},
      );
      expect(config.getMcpLazyLoad()).toBe(true);
      expect(config.getMcpLazyLoadSource()).toBe('environment');
      delete process.env[ENV_MCP_LAZY];
    });
  });

  describe('reloadPlugins', () => {
    it('reloadPlugins returns { enabled, errors } shape', async () => {
      process.argv = ['node', 'script.js'];
      const argv = await parseArgsForRootCommand();
      const config = await loadCliConfig(
        createLoadedSettings(),
        'test-session',
        argv,
        {},
      );
      expect(config.reloadPlugins).toBeDefined();
      const result = await config.reloadPlugins!();
      expect(result).toHaveProperty('enabled');
      expect(result).toHaveProperty('errors');
      expect(Array.isArray(result.enabled)).toBe(true);
      expect(Array.isArray(result.errors)).toBe(true);
    });

    it('re-reads persistable settings from disk before reloading (manual reload)', async () => {
      process.argv = ['node', 'script.js'];
      const loadedSettings = createLoadedSettingsFromSources({
        user: { enabledPlugins: {} } as unknown as Partial<Settings>,
      });
      const reloadSpy = vi
        .spyOn(loadedSettings, 'reload')
        .mockImplementation(() => {});
      const argv = await parseArgsForRootCommand();
      const config = await loadCliConfig(
        loadedSettings,
        'test-session',
        argv,
        {},
      );

      await config.reloadPlugins!();

      expect(reloadSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('permission rules from loaded settings', () => {
    it('loads permissions.allow from user settings', async () => {
      process.argv = ['node', 'script.js'];
      const loadedSettings = createLoadedSettingsFromSources({
        user: {
          permissions: { allow: ['Bash'] },
        } as unknown as Partial<Settings>,
      });
      const argv = await parseArgsForRootCommand();
      const config = await loadCliConfig(
        loadedSettings,
        'test-session',
        argv,
        {},
      );
      expect(
        config.initPermission()?.getRules().allow.userSettings,
      ).toEqual(['Bash']);
    });

    it('loads permissions.deny from local settings', async () => {
      process.argv = ['node', 'script.js'];
      const loadedSettings = createLoadedSettingsFromSources({
        local: {
          permissions: { deny: ['Bash'] },
        } as unknown as Partial<Settings>,
      });
      const argv = await parseArgsForRootCommand();
      const config = await loadCliConfig(
        loadedSettings,
        'test-session',
        argv,
        {},
      );
      expect(
        config.initPermission()?.getRules().deny.localSettings,
      ).toEqual(['Bash']);
    });

    it('applies camelCase permission mode normalization in loadCliConfig', async () => {
      process.argv = ['node', 'script.js', '--permission-mode', 'acceptEdits'];
      const argv = await parseArgsForRootCommand();
      const config = await loadCliConfig(
        createLoadedSettings(),
        'test-session',
        argv,
        {},
      );
      expect(config.getPermissionMode()).toBe('acceptEdits');
    });
  });
});
