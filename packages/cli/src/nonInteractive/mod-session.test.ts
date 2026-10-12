/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { convertClaudePluginPackage } from '@qwen-code/qwen-code-core/extension/claude-converter.js';
import { OutputFormat } from '@qwen-code/qwen-code-core/output/types.js';
import type { ModLog } from '@qwen-code/qwen-code-core/mods/types.js';
import type { LoadedSettings } from '../config/settings.js';
import type { JsonOutputAdapterInterface } from './io/BaseJsonOutputAdapter.js';
import { ModSession } from './mod-session.js';
import { CommandService } from '../services/CommandService.js';
import { CommandKind, type CommandContext } from '../ui/commands/types.js';
import { registerCleanup, runExitCleanup } from '../utils/cleanup.js';

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  dependencies: vi.fn(),
  create: vi.fn(),
}));
vi.mock('@qwen-code/qwen-code-core/mods/discovery.js', () => ({
  loadModSource: mocks.load,
  loadModDependencies: mocks.dependencies,
}));
vi.mock('@qwen-code/qwen-code-core/mods/runtime.js', () => ({
  ModRuntime: { createGroup: mocks.create },
}));

describe('headless Mod session ownership', () => {
  const sessions: ModSession[] = [];
  const tempDirs: string[] = [];
  const setup = (overrides: Record<string, unknown> = {}) => {
    const extension = {
      id: 'id',
      name: 'hello-mod',
      version: '1.0.0',
      path: '/mod',
      isActive: true,
    };
    const config = {
      getSessionId: vi.fn(() => 'session-1'),
      getTargetDir: () => '/workspace',
      getOutputFormat: () => OutputFormat.JSON,
      getExtensions: () => [extension],
      isInteractive: () => false,
      getExperimentalZedIntegration: () => false,
      isTrustedFolder: () => true,
      getDisableAllHooks: () => false,
      getBareMode: () => false,
      isSafeMode: () => false,
      getExecutionEnvironment: () => undefined,
      getExecutionEnvironmentFactory: () => undefined,
      getHookSystem: () => undefined,
      getSandbox: () => undefined,
      isSessionAgentSession: () => false,
      ...overrides,
    };
    const adapter = { emitSystemMessage: vi.fn() };
    const runtime = {
      getCommands: vi.fn(() => [{ name: 'hello', description: 'Hello' }]),
      runCommand: vi.fn().mockResolvedValue('answer'),
      end: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    mocks.load.mockResolvedValue({
      root: '/mod',
      entry: '/mod/entry.js',
      source: 'export function register() {}',
      dependencies: [],
    });
    mocks.dependencies.mockResolvedValue([]);
    mocks.create.mockImplementation(
      async (_plugins, _cwd, log: (entry: ModLog, plugin: string) => void) => {
        log({ to: 'transcript', text: 'startup log' }, 'hello-mod');
        return runtime;
      },
    );
    const session = new ModSession(
      config as unknown as Config,
      adapter as unknown as JsonOutputAdapterInterface,
    );
    sessions.push(session);
    return { config, adapter, runtime, session, extension };
  };
  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.close()));
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
    vi.resetAllMocks();
  });

  it('is opt-in without reading or executing extensions by default', () => {
    expect(
      ModSession.create(
        {} as Config,
        { merged: {} } as LoadedSettings,
        {} as JsonOutputAdapterInterface,
      ),
    ).toBeUndefined();
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it.each([
    ['isInteractive', true],
    ['getExperimentalZedIntegration', true],
    ['isTrustedFolder', false],
    ['getDisableAllHooks', true],
    ['getBareMode', true],
    ['isSafeMode', true],
    ['getExecutionEnvironment', {}],
    ['getExecutionEnvironmentFactory', () => {}],
    ['getHookSystem', { isManaged: () => true }],
    ['getSandbox', {}],
    ['isSessionAgentSession', true],
  ])('does not read modules behind %s admission', async (name, value) => {
    const { session } = setup({ [name]: () => value });
    await session.initialize(new AbortController().signal);
    expect(await session.loadCommands(new AbortController().signal)).toEqual(
      [],
    );
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('initializes once, buffers logs behind init, and uses the command signal', async () => {
    const { session, adapter, runtime } = setup();
    const signal = new AbortController().signal;
    await session.initialize(signal);
    expect(adapter.emitSystemMessage).not.toHaveBeenCalled();
    session.flushLogs();
    expect(adapter.emitSystemMessage).toHaveBeenCalledWith('ui_log', {
      plugin: 'hello-mod',
      text: 'startup log',
    });
    const commands = await session.loadCommands(signal);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(await commands[0].action!({} as CommandContext, 'hello')).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'answer',
    });
    expect(runtime.getCommands).toHaveBeenCalledWith('id');
    expect(runtime.runCommand).toHaveBeenCalledWith('hello', 'hello', signal);
    expect(commands[0].modelInvocable).toBe(false);
  });

  it('uses operator scopes and validates options before starting any runtime', async () => {
    const { config, adapter } = setup();
    mocks.load.mockResolvedValue({
      root: '/mod',
      entry: '/mod/entry.ts',
      source: 'export function register() {}',
      dependencies: [],
      userConfig: {
        value: {
          type: 'string',
          title: 'Value',
          description: 'Value',
          required: true,
        },
      },
    });
    const settings = {
      merged: {
        experimental: { mods: true },
        pluginConfigs: { 'hello-mod': { options: { value: 'workspace' } } },
      },
      systemDefaults: { settings: {} },
      user: {
        settings: {
          pluginConfigs: { 'hello-mod@inline': { options: { value: 'user' } } },
        },
      },
      system: {
        settings: {
          pluginConfigs: { 'hello-mod': { options: { value: 'system' } } },
        },
      },
    } as unknown as LoadedSettings;
    const session = ModSession.create(
      config as unknown as Config,
      settings,
      adapter as unknown as JsonOutputAdapterInterface,
    )!;
    sessions.push(session);
    await session.initialize(new AbortController().signal);
    expect(mocks.create.mock.calls[0][0][0].options).toEqual({
      value: 'system',
    });
  });

  it.each(['missing', 'cycle', 'options'])(
    'starts no workers when a later plugin has invalid %s',
    async (kind) => {
      const extensions = [
        { id: 'a', name: 'a', path: '/a', version: '1.0.0', isActive: true },
        { id: 'b', name: 'b', path: '/b', version: '1.0.0', isActive: true },
      ];
      const { session } = setup({ getExtensions: () => extensions });
      mocks.load.mockImplementation(async (path: string) => ({
        root: path,
        entry: path + '/entry.js',
        source: '',
        dependencies:
          kind === 'cycle'
            ? [{ name: path === '/a' ? 'b' : 'a' }]
            : kind === 'missing' && path === '/b'
              ? [{ name: 'absent' }]
              : [],
        userConfig:
          kind === 'options' && path === '/b'
            ? {
                needed: {
                  type: 'string',
                  title: '',
                  description: '',
                  required: true,
                },
              }
            : undefined,
      }));
      await expect(
        session.initialize(new AbortController().signal),
      ).rejects.toThrow(
        kind === 'cycle'
          ? /cycle/
          : kind === 'missing'
            ? /installed, enabled/
            : /required/,
      );
      expect(mocks.create).not.toHaveBeenCalled();
    },
  );

  it('orders Mod consumers before providers and accepts an ordinary extension dependency', async () => {
    const extensions = ['base', 'ordinary', 'consumer'].map((name) => ({
      id: name + '-id',
      name,
      path: '/' + name,
      version: '1.0.0',
      isActive: true,
    }));
    const { session } = setup({ getExtensions: () => extensions });
    mocks.load.mockImplementation(async (path: string) =>
      path === '/ordinary'
        ? undefined
        : {
            root: path,
            entry: path + '/entry.js',
            source: '',
            dependencies:
              path === '/consumer'
                ? [{ name: 'base' }, { name: 'ordinary' }]
                : [],
          },
    );
    await session.initialize(new AbortController().signal);
    expect(
      mocks.create.mock.calls[0][0].map(
        (plugin: { source: { root: string } }) => plugin.source.root,
      ),
    ).toEqual(['/consumer', '/base']);
  });

  it('checks transitive ordinary dependencies but ignores unrelated declarations', async () => {
    const extensions = ['consumer', 'ordinary', 'unrelated'].map((name) => ({
      id: name,
      name,
      path: '/' + name,
      version: '1.0.0',
      isActive: true,
    }));
    const { session } = setup({ getExtensions: () => extensions });
    mocks.load.mockImplementation(async (path: string) =>
      path !== '/consumer'
        ? undefined
        : {
            root: path,
            entry: path + '/entry.js',
            source: '',
            dependencies: [{ name: 'ordinary' }],
          },
    );
    mocks.dependencies.mockResolvedValue([{ name: 'missing' }]);
    await expect(
      session.initialize(new AbortController().signal),
    ).rejects.toThrow(/ordinary.*missing.*installed/);
    expect(mocks.dependencies).toHaveBeenCalledExactlyOnceWith('/ordinary');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('does not turn an ordinary provider into a Mod ordering node', async () => {
    const extensions = ['base', 'ordinary', 'consumer'].map((name) => ({
      id: name,
      name,
      path: '/' + name,
      version: '1.0.0',
      isActive: true,
    }));
    const { session } = setup({ getExtensions: () => extensions });
    mocks.load.mockImplementation(async (path: string) =>
      path === '/ordinary'
        ? undefined
        : {
            root: path,
            entry: path + '/entry.js',
            source: '',
            dependencies: path === '/consumer' ? [{ name: 'ordinary' }] : [],
          },
    );
    mocks.dependencies.mockResolvedValue([{ name: 'base' }]);
    await session.initialize(new AbortController().signal);
    expect(
      mocks.create.mock.calls[0][0].map(
        (plugin: { source: { root: string } }) => plugin.source.root,
      ),
    ).toEqual(['/base', '/consumer']);
  });

  describe.each(['direct', 'ordinary'] as const)(
    'converted marketplace %s dependencies',
    (via) => {
      it.each(['missing', 'incompatible', 'satisfied', 'invalid'])(
        'validates %s dependencies before starting a worker',
        async (state) => {
          const root = await fs.mkdtemp(
            path.join(os.tmpdir(), 'mod-marketplace-'),
          );
          tempDirs.push(root);
          const names = [
            'consumer',
            ...(via === 'ordinary' ? ['ordinary'] : []),
          ];
          if (state !== 'missing') names.push('base');
          const entries = [];
          for (const name of names) {
            const version =
              name === 'base' && state === 'incompatible' ? '1.0.0' : '2.0.0';
            const declaresDependency =
              name === (via === 'direct' ? 'consumer' : 'ordinary');
            entries.push({
              name,
              version,
              source: `./${name}`,
              ...(declaresDependency
                ? {
                    dependencies:
                      state === 'invalid'
                        ? false
                        : [{ name: 'base', version: '^2.0.0' }],
                  }
                : {}),
            });
            await fs.mkdir(path.join(root, name, '.claude-plugin'), {
              recursive: true,
            });
            await fs.writeFile(
              path.join(root, name, '.claude-plugin/plugin.json'),
              JSON.stringify({
                name,
                version,
                ...(name === 'consumer' && via === 'ordinary'
                  ? { dependencies: ['ordinary'] }
                  : {}),
              }),
            );
          }
          await fs.mkdir(path.join(root, '.claude-plugin'));
          await fs.writeFile(
            path.join(root, '.claude-plugin/marketplace.json'),
            JSON.stringify({
              name: 'fixture',
              owner: { name: 'Fixture' },
              plugins: entries,
            }),
          );
          await fs.mkdir(path.join(root, 'consumer/hooks'));
          await fs.writeFile(
            path.join(root, 'consumer/hooks/hooks.json'),
            JSON.stringify({ modules: ['./entry.js'] }),
          );
          await fs.writeFile(
            path.join(root, 'consumer/hooks/entry.js'),
            'export function register() {}',
          );
          const extensions = await Promise.all(
            names.map(async (name) => {
              const { convertedDir, config } = await convertClaudePluginPackage(
                root,
                name,
              );
              tempDirs.push(convertedDir);
              return {
                ...config,
                id: name,
                path: convertedDir,
                isActive: true,
                installMetadata: { marketplaceConfig: { name: 'fixture' } },
              };
            }),
          );
          const { session } = setup({ getExtensions: () => extensions });
          const discovery = await vi.importActual<
            typeof import('@qwen-code/qwen-code-core/mods/discovery.js')
          >('@qwen-code/qwen-code-core/mods/discovery.js');
          mocks.load.mockImplementation(discovery.loadModSource);
          mocks.dependencies.mockImplementation(discovery.loadModDependencies);

          const initialization = session.initialize(
            new AbortController().signal,
          );
          if (state === 'satisfied') {
            await initialization;
            expect(mocks.create).toHaveBeenCalledTimes(1);
            expect(
              (await session.loadCommands(new AbortController().signal)).map(
                ({ name }) => name,
              ),
            ).toEqual(['hello']);
          } else {
            await expect(initialization).rejects.toThrow(
              state === 'missing'
                ? /dependency base.*installed, enabled/
                : state === 'incompatible'
                  ? /dependency base.*incompatible installed version/
                  : /Invalid Mod dependencies declaration/,
            );
            expect(mocks.create).not.toHaveBeenCalled();
          }
        },
      );
    },
  );

  it('keeps Agent Plugins v1 hooks ignored', async () => {
    const { session } = setup({
      getExtensions: () => [{ isActive: true, format: 'agent-plugins-v1' }],
    });
    await session.initialize(new AbortController().signal);
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('does not skip the next registered exit cleanup', async () => {
    const { session, runtime } = setup();
    await session.initialize(new AbortController().signal);
    const following = vi.fn();
    const last = vi.fn();
    registerCleanup(following);
    registerCleanup(last);
    await runExitCleanup();
    expect(runtime.dispose).toHaveBeenCalledOnce();
    expect(following).toHaveBeenCalledOnce();
    expect(last).toHaveBeenCalledOnce();
  });

  it('retains the same runtime across session changes and closes once', async () => {
    const { session, runtime, config } = setup();
    await session.initialize(new AbortController().signal);
    config.getSessionId.mockReturnValue('session-2');
    await session.syncSession('clear');
    await session.initialize(new AbortController().signal);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(runtime.end).toHaveBeenNthCalledWith(
      1,
      'session-1',
      'clear',
      expect.any(AbortSignal),
    );
    await Promise.all([session.close(), session.close()]);
    expect(runtime.end).toHaveBeenNthCalledWith(
      2,
      'session-2',
      'other',
      expect.any(AbortSignal),
    );
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
  });

  it('checks activation again at the actual command invocation', async () => {
    const { session, runtime, extension } = setup();
    const [command] = await session.loadCommands(new AbortController().signal);
    extension.isActive = false;
    await expect(command.action!({} as CommandContext, '')).rejects.toThrow(
      /disabled/,
    );
    expect(runtime.runCommand).not.toHaveBeenCalled();
    expect(runtime.dispose).toHaveBeenCalled();
  });

  it('invalidates the whole chain when another participating plugin is disabled', async () => {
    const extensions = ['wrapper', 'provider'].map((name) => ({
      id: name,
      name,
      path: '/' + name,
      version: '1.0.0',
      isActive: true,
    }));
    const { session, runtime } = setup({ getExtensions: () => extensions });
    const commands = await session.loadCommands(new AbortController().signal);
    extensions[0].isActive = false;
    await expect(commands[1].action!({} as CommandContext, '')).rejects.toThrow(
      /chain changed/,
    );
    expect(runtime.runCommand).not.toHaveBeenCalled();
    await session.close();
    expect(runtime.end).not.toHaveBeenCalled();
  });

  it('keeps real CommandService namespacing and denylist behavior', async () => {
    const { session } = setup();
    const builtin = {
      loadCommands: async () => [
        { name: 'hello', description: 'builtin', kind: CommandKind.BUILT_IN },
      ],
    };
    const service = await CommandService.create(
      [builtin, session],
      new AbortController().signal,
    );
    expect(service.getCommands().map((command) => command.name)).toEqual([
      'hello',
      'hello-mod.hello',
    ]);
    const filtered = await CommandService.create(
      [builtin, session],
      new AbortController().signal,
      new Set(['hello-mod.hello']),
    );
    expect(filtered.getCommands().map((command) => command.name)).toEqual([
      'hello',
    ]);
  });
});
