/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppPlugin } from '../app-plugins/types.js';
import { type FrameworkInitInput } from './appFramework.js';
import { TuiAppFramework } from './tuiAppFramework.js';
import { AcpAppFramework } from './acpAppFramework.js';
import { DaemonAppFramework } from './daemonAppFramework.js';
import { HeadlessAppFramework } from './headlessAppFramework.js';
import { SdkAppFramework } from './sdkAppFramework.js';
import { RemoteWorkerAppFramework } from './remoteWorkerAppFramework.js';
import { CommandAppFramework } from './commandAppFramework.js';
import { createCliSettingsService } from '../config/createCliSettingsService.js';
import type { EntryFramework } from './entryFramework.js';
import { ResourceService } from '@qwen-code/resource';
import * as core from '@qwen-code/core';
import {
  ModelTransportManager,
  CustomProviderManager,
  PermissionManager,
  type ModelTransport,
  type BuiltinPluginContext,
} from '@qwen-code/core';
import { AsyncInitializer } from './asyncInitializer.js';
import type { HeadlessSession } from '../headless/headlessSession.js';
import { createMockSettings } from '../test-utils/mockConfig.js';

const mocks = vi.hoisted(() => ({
  userResources: vi.fn(async () => {}),
  settings: vi.fn(() => ({})),
}));
vi.mock('../config/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  initializeUserResources: mocks.userResources,
}));
vi.mock('../config/settings.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  loadSettingsWithService: mocks.settings,
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function input(
  argv: Partial<FrameworkInitInput['argv']> = {},
  command?: FrameworkInitInput['command'],
): FrameworkInitInput {
  return {
    argv: argv as FrameworkInitInput['argv'],
    settings: createMockSettings(),
    command,
  };
}
const applications: Array<{
  app: EntryFramework;
  abort: AbortController;
  settings: ReturnType<typeof createCliSettingsService>;
}> = [];
type EntryConstructor =
  | typeof TuiAppFramework
  | typeof AcpAppFramework
  | typeof DaemonAppFramework
  | typeof HeadlessAppFramework
  | typeof SdkAppFramework
  | typeof RemoteWorkerAppFramework
  | typeof CommandAppFramework;
function createApp<T extends EntryConstructor = typeof TuiAppFramework>(
  Base: T = TuiAppFramework as T,
  options = input(),
  plugins: readonly AppPlugin[] = [],
) {
  let ready: Promise<void> | undefined;
  const start = vi.fn(async () => {});
  const source = {
    start: () => (ready ??= start()),
    stop: vi.fn(async () => {}),
    getValue: () => undefined,
    onValueChange: () => () => {},
    onError: () => () => {},
  };
  const createDefinitions = vi.fn(() => plugins);
  const abort = new AbortController();
  const settings = createCliSettingsService({ environmentPolicy: 'session' });
  const app = new Base(abort.signal, settings, options) as InstanceType<T>;
  const factories = app as unknown as {
    createAppPlugins(): readonly AppPlugin[];
    createConfigService(): typeof source;
  };
  vi.spyOn(factories, 'createAppPlugins').mockImplementation(createDefinitions);
  vi.spyOn(factories, 'createConfigService').mockReturnValue(source);
  applications.push({ app, abort, settings });
  return { app, abort, settings, source, start, createDefinitions };
}
beforeEach(() => {
  mocks.userResources.mockReset().mockResolvedValue(undefined);
  mocks.settings.mockClear();
});
afterEach(async () => {
  for (const { app, abort, settings } of applications.splice(0)) {
    abort.abort();
    try {
      await app.dispose();
    } finally {
      await settings.dispose();
    }
  }
});

describe('entry frameworks', () => {
  it.each([false, true])(
    'owns the product hook runner registration and restoration (bare=%s)',
    async (bare) => {
      class ProductHookRunner extends core.HookRunner {}
      const restore = vi.fn();
      const register = vi
        .spyOn(core.HookSystem, 'setRunnerFactory')
        .mockReturnValue(restore);
      const { app } = createApp(SdkAppFramework, {
        ...input({ bare }),
        createHookRunner: (config) => new ProductHookRunner(config),
      });
      try {
        expect(register).not.toHaveBeenCalled();
        await app.init();
        await app.init();
        expect(register).toHaveBeenCalledOnce();
        const factory = register.mock.calls[0][0];
        expect(factory({} as core.Config)).toBeInstanceOf(ProductHookRunner);
        expect(restore).not.toHaveBeenCalled();
        await app.dispose();
        await app.dispose();
        expect(restore).toHaveBeenCalledOnce();
      } finally {
        register.mockRestore();
      }
    },
  );

  it.each([false, true])(
    'schedules Windows preparation before shell discovery and owns cleanup (bare=%s)',
    async (bare) => {
      const events: string[] = [];
      const stop = vi.fn(async () => {});
      const prepare = vi.fn(async () => {
        events.push('prepare');
        return stop;
      });
      const probe = vi
        .spyOn(core, 'setShellIfWindows')
        .mockImplementation(async () => {
          events.push('probe');
        });
      class TestSdkFramework extends SdkAppFramework {
        protected override readonly prepareEnvironment = prepare;
      }
      const { app } = createApp(TestSdkFramework, input({ bare }));
      const platform = vi
        .spyOn(process, 'platform', 'get')
        .mockReturnValue('win32');
      try {
        await app.init();
        await app.dispose();
        expect(events).toEqual(bare ? [] : ['prepare', 'probe']);
        expect(stop).toHaveBeenCalledTimes(bare ? 0 : 1);
      } finally {
        platform.mockRestore();
        probe.mockRestore();
      }
    },
  );

  describe.each([
    TuiAppFramework,
    AcpAppFramework,
    DaemonAppFramework,
    HeadlessAppFramework,
    SdkAppFramework,
    RemoteWorkerAppFramework,
    CommandAppFramework,
  ])('%s default Windows preparation', (Base) => {
    it.each([
      ['win32', false, true],
      ['win32', true, false],
      ['darwin', false, false],
      ['linux', false, false],
    ] as const)('platform=%s bare=%s', async (platformName, bare, expected) => {
      const events: string[] = [];
      const stop = vi.fn(async () => {});
      const prepare = vi
        .spyOn(core, 'prepareWindowsEnvironment')
        .mockImplementation(async () => {
          events.push('prepare');
          return stop;
        });
      const probe = vi
        .spyOn(core, 'setShellIfWindows')
        .mockImplementation(async () => {
          events.push('probe');
        });
      const { app, abort } = createApp(Base, input({ bare }));
      const platform = vi
        .spyOn(process, 'platform', 'get')
        .mockReturnValue(platformName);
      try {
        await app.init();
        await app.init();
        await app.dispose();
        expect(events).toEqual(expected ? ['prepare', 'probe'] : []);
        expect(prepare).toHaveBeenCalledTimes(expected ? 1 : 0);
        if (expected) expect(prepare).toHaveBeenCalledWith(abort.signal);
        expect(stop).toHaveBeenCalledTimes(expected ? 1 : 0);
      } finally {
        platform.mockRestore();
        probe.mockRestore();
        prepare.mockRestore();
      }
    });
  });

  it('construction and early shutdown create no runtime resource', async () => {
    const { app, createDefinitions, start } = createApp();
    expect(app.resources).toBeUndefined();
    expect(app.modelTransportManager).toBeUndefined();
    expect(app.customProviderManager).toBeUndefined();
    expect(app.appPlugins).toBeUndefined();
    await app.dispose();
    expect(createDefinitions).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(mocks.userResources).not.toHaveBeenCalled();
  });
  it('borrows settings from main without disposing them', async () => {
    const { app, settings } = createApp();
    const dispose = vi.spyOn(settings, 'dispose');
    await app.init();
    await app.dispose();
    expect(dispose).not.toHaveBeenCalled();
  });
  it.each([
    [TuiAppFramework, {}, true],
    [TuiAppFramework, { remoteSession: 'remote' }, true],
    [HeadlessAppFramework, {}, false],
    [SdkAppFramework, {}, false],
    [AcpAppFramework, {}, false],
    [DaemonAppFramework, {}, false],
    [RemoteWorkerAppFramework, {}, false],
  ])(
    '%s publishes public mode without interpreting commercial flags',
    async (Base, argv, local) => {
      let context: BuiltinPluginContext | undefined;
      const initialize = vi.fn(async (value: BuiltinPluginContext) => {
        context = value;
      });
      const { app } = createApp(Base, input(argv), [
        { apiVersion: 1, id: 'probe', initialize, dispose: async () => {} },
      ]);
      await app.init();
      const registry = await app.appPlugins!.whenReady();
      await registry.initialize();
      expect(initialize).toHaveBeenCalledOnce();
      expect(context?.localSession).toBe(local);
      expect(context?.mode).toBe(local ? 'interactive' : 'headless');
    },
  );
  it('TUI starts once and every resource has a single initializer', async () => {
    const initialize = vi.fn(async () => {});
    const { app, start } = createApp(TuiAppFramework, input(), [
      { apiVersion: 1, id: 'probe', initialize, dispose: async () => {} },
    ]);
    await app.init();
    const resources = app.resources;
    await app.init();
    await Promise.all([
      app.appPlugins!.whenReady(),
      app.whenConfigReady(),
      app.mcpManager!.whenReady(),
    ]);
    expect(app.resources).toBe(resources);
    expect(app.resources!.get()).toBe(await resources!.whenReady());
    expect(mocks.userResources).toHaveBeenCalledOnce();
    expect(initialize).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
  });
  it.each([
    TuiAppFramework,
    AcpAppFramework,
    DaemonAppFramework,
    HeadlessAppFramework,
    SdkAppFramework,
    RemoteWorkerAppFramework,
    CommandAppFramework,
  ])('%s 的 transport manager 共用单一句柄并随框架销毁', async (Base) => {
    const { app } = createApp(Base);
    const createTransports = vi.spyOn(
      app as unknown as { createModelTransports(): readonly ModelTransport[] },
      'createModelTransports',
    );
    await app.init();
    const handle = app.modelTransportManager!;
    expect(handle).toBeInstanceOf(AsyncInitializer);
    const manager = handle.get();
    expect(manager).toBeInstanceOf(ModelTransportManager);
    await app.init();
    expect(app.modelTransportManager).toBe(handle);
    expect(await handle.whenReady()).toBe(manager);
    expect(createTransports).toHaveBeenCalledOnce();
    expect(
      app.getModelProviderFactory()({
        listModels: async () => [],
        setSelectionPreparation: vi.fn(),
        setModelAccessCheck: vi.fn(),
      }),
    ).toEqual([expect.any(core.CustomModelProvider)]);
    if (app.permissionManager) {
      const permission = app.permissionManager
        .get()
        .createSessionPermissionManager({
        getSessionId: () => 'test',
        getWorkingDir: () => '/',
        flagSettings: {
          initialMode: 'default',
          rules: { allow: {}, deny: {}, ask: {} },
          additionalDirectories: [],
        },
      });
      expect(permission.isAutoModeJevEnabled()).toBe(true);
    }
    await app.dispose();
    expect(handle.isDisposed()).toBe(true);
    expect(() => handle.get()).toThrow('disposed');
    createTransports.mockRestore();
  });
  it.each([
    TuiAppFramework,
    AcpAppFramework,
    DaemonAppFramework,
    HeadlessAppFramework,
    SdkAppFramework,
    RemoteWorkerAppFramework,
    CommandAppFramework,
  ])(
    '%s 的配置管理器只借用 SettingsService，重复初始化与销毁均幂等',
    async (Base) => {
      const { app, settings } = createApp(Base);
      const disposeSettings = vi.spyOn(settings, 'dispose');
      expect(app.customProviderManager).toBeUndefined();
      await Promise.all([app.init(), app.init()]);
      const handle = app.customProviderManager!;
      const manager = handle.get();
      expect(manager).toBeInstanceOf(CustomProviderManager);
      expect(Reflect.get(manager, 'settingsService')).toBe(settings);
      expect(Reflect.has(manager, 'config')).toBe(false);
      expect(Reflect.has(app, 'config')).toBe(false);
      await app.init();
      expect(app.customProviderManager).toBe(handle);
      expect(await handle.whenReady()).toBe(manager);
      if ('threadManager' in app) {
        const params = Reflect.get(
          await app.threadManager!.whenCreated(),
          'params',
        );
        expect(params.customProviderManager).toBe(manager);
        expect(params.permissionManager).toBeInstanceOf(PermissionManager);
        expect(params.permissionManager.getModes()).toBeDefined();
      }
      const disposeHandle = vi.spyOn(handle, 'dispose');
      const closing = app.dispose();
      expect(app.dispose()).toBe(closing);
      await closing;
      expect(disposeHandle).toHaveBeenCalledOnce();
      expect(handle.isDisposed()).toBe(true);
      expect(() => handle.get()).toThrow('disposed');
      expect(disposeSettings).not.toHaveBeenCalled();
      disposeHandle.mockRestore();
      disposeSettings.mockRestore();
    },
  );

  it('Headless 会话共用单一句柄，取用不运行会话，退出销毁句柄', async () => {
    const { app } = createApp(HeadlessAppFramework);
    const createSession = vi.spyOn(
      app as unknown as {
        createSession(manager: unknown): Promise<HeadlessSession>;
      },
      'createSession',
    );
    expect(app.headlessSession).toBeUndefined();
    await app.init();
    const handle = app.headlessSession!;
    expect(handle).toBeInstanceOf(AsyncInitializer);
    const session = handle.get();
    const run = vi.spyOn(session, 'run');
    await app.init();
    expect(app.headlessSession).toBe(handle);
    expect(await app.getHeadlessSession()).toBe(session);
    expect(await app.getHeadlessSession()).toBe(session);
    expect(createSession).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
    await app.dispose();
    expect(handle.isDisposed()).toBe(true);
    expect(() => handle.get()).toThrow('disposed');
    createSession.mockRestore();
    run.mockRestore();
  });
  it('resource getters reject unfinished initialization', async () => {
    const gate = deferred();
    mocks.userResources.mockReturnValueOnce(gate.promise);
    const { app } = createApp();
    const initializing = app.init();
    expect(() => app.resources!.get()).toThrow('not yet initialized');
    gate.resolve();
    await initializing;
    expect(app.resources!.get()).toBeInstanceOf(ResourceService);
  });
  it.each([AcpAppFramework, DaemonAppFramework])(
    '%s exposes the manager before waiting for host',
    async (Base) => {
      const { app } = createApp(Base);
      await app.init();
      const manager = await app.threadManager!.whenCreated();
      expect(() => app.threadManager!.get()).toThrow('not yet initialized');
      await app.init();
      expect(await app.threadManager!.whenCreated()).toBe(manager);
      let ready = false;
      const pending = app.threadManager!.whenReady().then((value) => {
        ready = true;
        return value;
      });
      await Promise.resolve();
      expect(ready).toBe(false);
      manager.provideHost({ createHost: vi.fn() });
      expect(await pending).toBe(manager);
      expect(app.threadManager!.get()).toBe(manager);
    },
  );
  it('abort rejects the missing-host wait and shutdown finishes', async () => {
    const { app, abort } = createApp(DaemonAppFramework);
    await app.init();
    const rejected = app.threadManager!.whenReady().catch((error) => error);
    abort.abort(new Error('exiting'));
    expect(await rejected).toMatchObject({ message: 'exiting' });
    await app.dispose();
    expect(() => app.threadManager!.get()).toThrow('disposed');
  });
  it.each([AcpAppFramework, DaemonAppFramework])(
    '%s disposal cancels the missing-host wait and shuts down the created manager',
    async (Base) => {
      const { app } = createApp(Base);
      await app.init();
      const manager = await app.threadManager!.whenCreated();
      const shutdown = vi.spyOn(manager, 'shutdown');
      const ready = app.threadManager!.whenReady();
      await app.dispose();
      await expect(ready).rejects.toMatchObject({ name: 'AbortError' });
      expect(shutdown).toHaveBeenCalledOnce();
    },
  );
  it('Headless ignores --bare and starts the regular runtime', async () => {
    const { app } = createApp(HeadlessAppFramework, input({ bare: true }));
    await app.init();
    expect(app.appPlugins).toBeDefined();
    expect(mocks.userResources).toHaveBeenCalledOnce();
  });
  it('SdkAppFramework bare skips plugin and user snapshot startup', async () => {
    const { app, start } = createApp(SdkAppFramework, input({ bare: true }));
    await app.init();
    expect(app.appPlugins).toBeUndefined();
    expect(mocks.userResources).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
  it('local command skips plugins and user snapshots', async () => {
    const { app, start } = createApp(CommandAppFramework, input({}, 'local'));
    await app.init();
    expect(app.appPlugins).toBeUndefined();
    expect('threadManager' in app).toBe(false);
    expect(mocks.userResources).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
  it('plugin command does not create a second thread manager', async () => {
    const { app } = createApp(CommandAppFramework, input({}, 'plugins'));
    await app.init();
    await app.appPlugins!.whenReady();
    expect('threadManager' in app).toBe(false);
  });
  it('partial snapshot failure disposes the created service', async () => {
    mocks.userResources.mockRejectedValueOnce(new Error('snapshot failed'));
    const { app } = createApp();
    const dispose = vi.spyOn(ResourceService.prototype, 'dispose');
    try {
      await expect(app.init()).rejects.toThrow('snapshot failed');
      await app.dispose();
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      dispose.mockRestore();
    }
  });
  it('plugin creation failure still releases previously prepared resources', async () => {
    const { app, createDefinitions, source } = createApp();
    createDefinitions.mockImplementation(() => {
      throw new Error('plugin failed');
    });
    await app.init();
    await expect(app.appPlugins!.whenReady()).rejects.toThrow('plugin failed');
    const dispose = vi.spyOn(app.resources!.get(), 'dispose');
    await app.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    expect(source.stop).toHaveBeenCalledOnce();
    expect(app.customProviderManager!.isDisposed()).toBe(true);
  });
  it('cleanup failure is retained, remaining resources close and repeated disposal shares the result', async () => {
    const disposePlugin = vi.fn(async () => {
      throw new Error('cleanup failed');
    });
    const { app, abort, settings, source } = createApp(
      HeadlessAppFramework,
      input(),
      [
        {
          apiVersion: 1,
          id: 'probe',
          initialize: async () => {},
          dispose: disposePlugin,
        },
      ],
    );
    await app.init();
    await app.appPlugins!.whenReady();
    const dispose = vi.spyOn(app.resources!.get(), 'dispose');
    abort.abort();
    const closing = app.dispose();
    expect(app.dispose()).toBe(closing);
    await expect(closing).rejects.toThrow('Framework disposal failed');
    expect(disposePlugin).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(source.stop).toHaveBeenCalledOnce();
    expect(app.customProviderManager!.isDisposed()).toBe(true);
    applications.length = 0;
    await settings.dispose();
  });
  it('does not expose unrelated entry resources or legacy forwarding methods', () => {
    const { app: tui } = createApp(TuiAppFramework);
    const { app: acp } = createApp(AcpAppFramework);
    const { app: sdk } = createApp(SdkAppFramework);
    expect('threadManager' in tui).toBe(false);
    expect('createAcpServer' in tui).toBe(false);
    expect('createSdkServer' in tui).toBe(false);
    expect('createSdkServer' in acp).toBe(false);
    expect('threadManager' in sdk).toBe(false);
    for (const app of [tui, acp, sdk]) {
      expect('awaitInitResourceService' in app).toBe(false);
      expect('ownsSettingsService' in app).toBe(false);
    }
  });
  it('shutdown during preparation waits and does not create later resources', async () => {
    const gate = deferred();
    mocks.userResources.mockReturnValueOnce(gate.promise);
    const { app, start } = createApp();
    const initialized = app.init().catch((error: unknown) => error);
    const closing = app.dispose();
    gate.resolve();
    expect(await initialized).toMatchObject({
      message: 'Framework is disposed',
    });
    await closing;
    expect(app.resources?.isDisposed()).toBe(true);
    expect(app.modelTransportManager).toBeUndefined();
    expect(app.customProviderManager).toBeUndefined();
    expect(app.configService).toBeUndefined();
    expect(app.appPlugins).toBeUndefined();
    expect(start).not.toHaveBeenCalled();
  });
  it('MCP remains lazy for commands and repeated requests share initialization', async () => {
    const { app } = createApp(CommandAppFramework, input({}, 'plugins'));
    await app.init();
    expect(app.mcpManager).toBeUndefined();
    const first = app.startMcp();
    expect(app.startMcp()).toBe(first);
    expect(await first.whenReady()).toBe(first.get());
  });
});

it('keeps ordinary TUI on its existing session path', async () => {
  const { app } = createApp();
  expect(
    await app.prepareSession({ model: 'model', permissionMode: 'default' }),
  ).toBeUndefined();
});

describe('Framework I18nService ownership', () => {
  it('prepares I18nService with the legacy Framework resources', async () => {
    const { FrameworkFixture } = await import('../test-utils/frameworkFixture.js');
    const app = new FrameworkFixture(new AbortController().signal);
    try {
      await app.initForMain();
      expect(app.i18nService?.isInitialized()).toBe(true);
      expect(app.i18nService!.get().getModelDescription('auto')).not.toBe('');
    } finally {
      await app.dispose();
    }
  });

  it.each([
    [TuiAppFramework, undefined],
    [HeadlessAppFramework, undefined],
    [SdkAppFramework, undefined],
    [AcpAppFramework, undefined],
    [DaemonAppFramework, undefined],
    [RemoteWorkerAppFramework, undefined],
    [CommandAppFramework, 'local'],
    [CommandAppFramework, 'client'],
    [CommandAppFramework, 'plugins'],
  ] as const)(
    'installs and releases its instance for %s (%s)',
    async (Base, command) => {
      const { app } = createApp(Base, input({}, command));
      await app.init();
      expect(core.getI18nService()).toBe(app.i18nService!.get());
      expect(core.getI18nService().getModelDescription('auto')).not.toBe('');
      const dispose = vi.spyOn(app.i18nService!.get(), 'dispose');
      await app.dispose();
      expect(dispose).toHaveBeenCalledOnce();
      expect(core.getI18nService()).toBeUndefined();
    },
  );
});
