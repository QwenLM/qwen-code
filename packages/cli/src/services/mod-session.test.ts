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
import type { ModToolCall } from '@qwen-code/qwen-code-core/mods/tool-events.js';
import { convertClaudePluginPackage } from '@qwen-code/qwen-code-core/extension/claude-converter.js';
import { OutputFormat } from '@qwen-code/qwen-code-core/output/types.js';
import type {
  ModCommand,
  ModLog,
} from '@qwen-code/qwen-code-core/mods/types.js';
import type { LoadedSettings } from '../config/settings.js';
import type { JsonOutputAdapterInterface } from '../nonInteractive/io/BaseJsonOutputAdapter.js';
import { ModSession, type ModTerminalHost } from './mod-session.js';
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

describe('Mod session ownership', () => {
  const sessions: ModSession[] = [];
  const tempDirs: string[] = [];
  const setup = (
    overrides: Record<string, unknown> = {},
    terminal?: ModTerminalHost,
  ) => {
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
      hasToolHooks: false,
      runTool: vi.fn<ModToolCall>(async (input, next, signal) =>
        next(input, signal, async (_input, verdict) => verdict),
      ),
      getCommands: vi.fn<() => ModCommand[]>(() => [
        { name: 'hello', description: 'Hello' },
      ]),
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
      terminal ?? adapter,
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

  it('exposes tool middleware only for a loaded tool hook and charges every repeated next', async () => {
    const { session, runtime } = setup();
    const signal = new AbortController().signal;
    const repeat = vi.fn();
    expect(session.toolCall(repeat)).toBeUndefined();
    await session.initialize(signal);
    expect(session.toolCall(repeat)).toBeUndefined();
    runtime.hasToolHooks = true;
    runtime.runTool.mockImplementation(async (e, next, active) => {
      await next(e, active, async (_e, v) => v);
      return next(e, active, async (_e, v) => v);
    });
    const next = vi.fn().mockResolvedValue({ result: {} });
    await session.toolCall(repeat)!({ tool: 'write_file' }, next, signal);
    expect(next).toHaveBeenCalledTimes(2);
    expect(repeat).toHaveBeenCalledTimes(1);
  });

  it('serializes roots and refuses a queued call after group invalidation', async () => {
    const { session, runtime, extension } = setup();
    const signal = new AbortController().signal;
    await session.initialize(signal);
    runtime.hasToolHooks = true;
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = vi.fn(async () => {
      await pending;
      return { result: {} };
    });
    const middleware = session.toolCall(() => {})!;
    const first = middleware({ tool: 'write_file' }, next, signal);
    const second = middleware({ tool: 'write_file' }, next, signal);
    const rejected = second.catch((error: unknown) => error);
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1));
    extension.isActive = false;
    release();
    await first;
    expect(await rejected).toEqual(
      expect.objectContaining({
        message: expect.stringMatching(/chain changed/),
      }),
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('cancels and settles tool work before ending a session', async () => {
    const { session, runtime } = setup();
    const signal = new AbortController().signal;
    await session.initialize(signal);
    runtime.hasToolHooks = true;
    let settled = false;
    const next = vi.fn(async (_e, active: AbortSignal) => {
      await new Promise<void>((resolve) =>
        active.addEventListener('abort', () => resolve(), { once: true }),
      );
      settled = true;
      return { result: {} };
    });
    const running = session.toolCall(() => {})!(
      { tool: 'write_file' },
      next,
      signal,
    );
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1));
    runtime.end.mockImplementation(async () => {
      expect(settled).toBe(true);
    });
    await session.close();
    await running;
    expect(settled).toBe(true);
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
    expect(runtime.runCommand).toHaveBeenCalledWith(
      'hello',
      'hello',
      expect.any(AbortSignal),
      undefined,
    );
    expect(commands[0].modelInvocable).toBe(false);
  });

  it('uses terminal presentation and invocation cancellation without retaining a loader signal', async () => {
    const log = vi.fn();
    const presentation = { isFullscreen: true, columns: 112 };
    const { session, runtime } = setup(
      { isInteractive: () => true },
      {
        surface: 'terminal',
        log,
        presentation: () => presentation,
      },
    );
    const loader = new AbortController();
    const [command] = await session.loadCommands(loader.signal);
    loader.abort();
    const invocation = new AbortController();
    runtime.runCommand.mockImplementation(
      async (_name, _args, signal: AbortSignal) => {
        expect(signal.aborted).toBe(false);
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        signal.throwIfAborted();
      },
    );
    const running = command.action!(
      { abortSignal: invocation.signal } as CommandContext,
      'test',
    );
    const rejected = Promise.resolve(running).catch((error: unknown) => error);
    await vi.waitFor(() => expect(runtime.runCommand).toHaveBeenCalledOnce());
    invocation.abort();
    expect(await rejected).toBeInstanceOf(Error);
    expect(command.supportedModes).toEqual(['interactive']);
    expect(runtime.runCommand).toHaveBeenCalledWith(
      'hello',
      'test',
      expect.any(AbortSignal),
      presentation,
    );
    expect(mocks.create.mock.calls[0][5]).toBe('terminal');
  });

  it.each([false, true])(
    'preserves headless metadata and sanitizes terminal metadata: terminal=%s',
    async (terminal) => {
      const { session, runtime, extension } = setup(
        { isInteractive: () => terminal },
        terminal
          ? {
              surface: 'terminal',
              log: vi.fn(),
              presentation: () => ({ isFullscreen: false, columns: 80 }),
            }
          : undefined,
      );
      const link = '\u001b]8;;https://invalid.example/mod-description\u0007';
      const description = `${link}Description\u001b]8;;\u0007\nline\u202e`;
      const argumentHint = '\u001b[31m<argument>\u001b[0m\u0007\tvalue\u2066';
      extension.name = 'hello\nmod\u202e';
      runtime.getCommands.mockReturnValue([
        { name: 'hello', description, argumentHint },
      ]);
      const [command] = await session.loadCommands(
        new AbortController().signal,
      );
      expect(command.description).toBe(
        terminal ? 'Description line' : description,
      );
      expect(command.argumentHint).toBe(
        terminal ? '<argument> value' : argumentHint,
      );
      expect(command.extensionName).toBe(
        terminal ? 'hello mod' : extension.name,
      );
    },
  );

  it('waits for cancellation to settle before dispatching the next command', async () => {
    const { session, runtime } = setup();
    const [command] = await session.loadCommands(new AbortController().signal);
    let settle!: () => void;
    runtime.runCommand.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        settle = resolve;
      });
      return 'late result';
    });
    const invocation = new AbortController();
    const first = command.action!(
      { abortSignal: invocation.signal } as CommandContext,
      'first',
    );
    const rejected = Promise.resolve(first).catch((error: unknown) => error);
    await vi.waitFor(() => expect(runtime.runCommand).toHaveBeenCalledOnce());
    invocation.abort();
    const second = command.action!({} as CommandContext, 'second');
    await Promise.resolve();
    expect(runtime.runCommand).toHaveBeenCalledOnce();
    settle();
    expect(await rejected).toBeInstanceOf(Error);
    await expect(second).resolves.toMatchObject({ content: 'answer' });
    expect(runtime.runCommand).toHaveBeenCalledTimes(2);
  });

  it('ends the old session after cancelling work, preserves the runtime, and ignores same-id switches', async () => {
    const { session, runtime, config } = setup();
    const [command] = await session.loadCommands(new AbortController().signal);
    const order: string[] = [];
    runtime.runCommand.mockImplementationOnce(
      async (_name, _args, signal: AbortSignal) => {
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        order.push('cancelled');
        return 'late';
      },
    );
    runtime.end.mockImplementation(async () => {
      order.push('end');
    });
    const running = command.action!({} as CommandContext, '');
    const rejected = Promise.resolve(running).catch((error: unknown) => error);
    await vi.waitFor(() => expect(runtime.runCommand).toHaveBeenCalledOnce());
    config.getSessionId.mockReturnValue('session-2');
    await session.syncSession('resume');
    expect(await rejected).toBeInstanceOf(Error);
    await session.syncSession('resume');
    expect(order).toEqual(['cancelled', 'end']);
    expect(runtime.end).toHaveBeenCalledWith(
      'session-1',
      'resume',
      expect.any(AbortSignal),
    );
    await expect(
      command.action!({} as CommandContext, 'new'),
    ).resolves.toMatchObject({ content: 'answer' });
    expect(mocks.create).toHaveBeenCalledOnce();
  });

  it('sanitizes terminal output, keeps debug logs private and discards cancelled output', async () => {
    const log = vi.fn();
    const { session, runtime } = setup(
      { isInteractive: () => true },
      {
        surface: 'terminal',
        log,
        presentation: () => ({ isFullscreen: false, columns: 80 }),
      },
    );
    const [command] = await session.loadCommands(new AbortController().signal);
    session.flushLogs();
    log.mockClear();
    const emit = mocks.create.mock.calls[0][2] as (
      entry: ModLog,
      plugin: string,
    ) => void;
    emit({ to: 'debug', text: 'private' }, 'hello-mod');
    emit(
      { to: 'transcript', text: '\u001b[31m' + 'x'.repeat(2500) },
      'hello-mod',
    );
    expect(log).toHaveBeenCalledExactlyOnceWith(
      {
        to: 'transcript',
        text: 'x'.repeat(2000),
        plugin: 'hello-mod',
        sessionId: 'session-1',
      },
      'hello-mod',
      'session-1',
    );
    log.mockClear();
    emit(
      {
        to: 'transcript',
        text: '\u001b[31mline one\u001b[0m\nline two\tvalue\u0007\u202e\u2066',
      },
      'hello-mod',
    );
    expect(log).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: 'line one\nline two\tvalue' }),
      'hello-mod',
      'session-1',
    );
    runtime.runCommand.mockResolvedValueOnce(
      '\u001b[31msafe\u001b[0m\nline two\tvalue\u0007\u007f\u202e',
    );
    await expect(
      command.action!({} as CommandContext, ''),
    ).resolves.toMatchObject({ content: 'safe\nline two\tvalue' });
    log.mockClear();
    const invocation = new AbortController();
    runtime.runCommand.mockImplementationOnce(async () => {
      invocation.abort();
      emit({ to: 'transcript', text: 'late' }, 'hello-mod');
      return 'late result';
    });
    await expect(
      command.action!({ abortSignal: invocation.signal } as CommandContext, ''),
    ).rejects.toThrow();
    expect(log).not.toHaveBeenCalled();
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

  it.each([
    [undefined, undefined, 'native'],
    ['claude', undefined, 'claude'],
    ['claude', 'native', 'native'],
  ] as const)(
    'selects dialect from operator settings, not workspace or plugin origin (%s, %s)',
    async (user, system, expected) => {
      const { config, adapter, extension } = setup();
      Object.assign(extension, { originSource: 'claude' });
      const settings = {
        merged: {
          experimental: { mods: true },
          pluginConfigs: { 'hello-mod': { toolDialect: 'claude' } },
        },
        systemDefaults: { settings: {} },
        user: {
          settings: {
            pluginConfigs: { 'hello-mod@inline': { toolDialect: user } },
          },
        },
        system: {
          settings: { pluginConfigs: { 'hello-mod': { toolDialect: system } } },
        },
      } as unknown as LoadedSettings;
      const session = ModSession.create(
        config as unknown as Config,
        settings,
        adapter as unknown as JsonOutputAdapterInterface,
      )!;
      sessions.push(session);
      await session.initialize(new AbortController().signal);
      expect(mocks.create.mock.calls[0][0][0]).toMatchObject({
        toolDialect: expected,
        options: {},
      });
    },
  );

  it('rejects an invalid dialect on a later plugin before any worker starts without userConfig', async () => {
    const extensions = [
      { id: 'a', name: 'a', path: '/a', version: '1.0.0', isActive: true },
      { id: 'b', name: 'b', path: '/b', version: '1.0.0', isActive: true },
    ];
    const { config, adapter } = setup({ getExtensions: () => extensions });
    const session = new ModSession(
      config as unknown as Config,
      adapter as unknown as JsonOutputAdapterInterface,
      [{ b: { toolDialect: 'unsupported' } }],
    );
    sessions.push(session);
    await expect(
      session.initialize(new AbortController().signal),
    ).rejects.toThrow('Mod b: Invalid Mod toolDialect');
    expect(mocks.create).not.toHaveBeenCalled();
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
