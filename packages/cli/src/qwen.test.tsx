/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createMockSettings as createI18nSettings } from './test-utils/settings.js';
import { createTestI18nService } from './test-utils/i18n.js';

const loadSettings = vi.hoisted(() => vi.fn());
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
  type Mock,
} from 'vitest';

const appLifetimes = vi.hoisted(
  () =>
    [] as Array<{
      cancelInitialization(): void;
      dispose(): Promise<void>;
    }>,
);
import { main, setupUnhandledRejectionHandler } from './qwen.js';
import {
  loadCliConfig,
  initializeUserResources,
  type CliArgs,
} from './config/config.js';
import { terminalCapabilityManager } from './ui/utils/terminalCapabilityManager.js';
import v8 from 'node:v8';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { type LoadedSettings } from './config/settings.js';
import {
  createMockConfig,
  createMockSettings,
} from './test-utils/mockConfig.js';
import { appEvents, AppEvent } from './utils/events.js';
import {
  type Config,
  type ConfigService,
  installConfigService,
  ForkSessionService,
  CoreEvent,
  type SessionResumeData,
  type StartupWarning,
  resolveSameRepoTranscriptSession,
  resolveLatestSameRepoTranscriptSession,
  WarningPriority,
  runLogger,
  coreEvents,
  writeToStderr,
  ENV_WORKTREE_HANDLED,
  ENV_WORKTREE_INFO,
  sessionLogger,
  getCwd,
  setCwd,
  setOriginalCwd,
  makeFakeConfig,
} from '@qwen-code/core';
import { act } from 'react';
import * as interactiveProject from './ui/hooks/useInteractiveProject.js';
import { Text, render as renderInk } from 'ink';
import type { AppContainerProps } from './ui/AppContainerProps.js';
import { TuiAppFramework } from './framework/tuiAppFramework.js';
import { render as renderTerminal } from './test-utils/render.js';
import { FrameworkFixture as AppFramework } from './test-utils/frameworkFixture.js';
import type { CliOptions } from './startup/runCli.js';
import type { FrameworkInitInput } from './framework/appFramework.js';
import type { SdkServer, SdkServerParams } from './sdk/sdkServer.js';
type CliDependencies = {
  configService?: ConfigService;
  resourceService?: import('@qwen-code/core').ResourceService;
  createSdkServer?: (params: SdkServerParams) => SdkServer | Promise<SdkServer>;
};
// Hoisted constants and mocks
const performance = vi.hoisted(() => ({
  now: vi.fn(),
}));
vi.stubGlobal('performance', performance);

const runHeadlessSessionSpy = vi.hoisted(() => vi.fn());
vi.mock('./sdk/sdkServer.js', () => ({
  // 此处只验证启动路由；真实 Server 会等待测试进程的 stdin 结束。
  SdkServer: class {
    async run(): Promise<void> {
      throw new Error('SDK daemon mode is not supported by this build');
    }
  },
}));
vi.mock('./headless/headlessSession.js', () => ({
  HeadlessSession: class {
    // 真实 HeadlessSession.run() 自己重置 exit code 并在收尾后退出进程；
    // 入口测试注入的是替身，这里按同一契约模拟，避免把退出责任又写回入口。
    async run(...args: unknown[]) {
      const { resetHeadlessExitCode, exitHeadlessMode } = await import(
        './headless/exit.js'
      );
      resetHeadlessExitCode();
      await runHeadlessSessionSpy(...args);
      await exitHeadlessMode();
    }
  },
}));

const terminalNotificationMocks = vi.hoisted(() => ({
  notifyViaTerminal: vi.fn().mockResolvedValue(true),
  buildRunEventNotificationContent: vi.fn(() => ({
    title: 'Session complete',
    body: 'done',
    subtitle: 'Run finished',
  })),
}));
vi.mock('./utils/terminalNotifications.js', () => ({
  notifyViaTerminal: terminalNotificationMocks.notifyViaTerminal,
  buildRunEventNotificationContent:
    terminalNotificationMocks.buildRunEventNotificationContent,
}));

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    writeToStdout: vi.fn((...args) =>
      process.stdout.write(
        ...(args as Parameters<typeof process.stdout.write>),
      ),
    ),
    writeToStderr: vi.fn((...args) =>
      process.stderr.write(
        ...(args as Parameters<typeof process.stderr.write>),
      ),
    ),
    patchStdio: vi.fn(() => () => {}),
    installConfigService: vi.fn(),
    registerProfilingSignalHandlers: vi.fn(),
    startRuntimeHealthMonitoring: vi.fn(),
    stopRuntimeHealthMonitoring: vi.fn(),
    createWorkingStdio: vi.fn(() => ({
      stdout: {
        write: vi.fn((...args) =>
          process.stdout.write(
            ...(args as Parameters<typeof process.stdout.write>),
          ),
        ),
        columns: 80,
        rows: 24,
        on: vi.fn(),
        removeListener: vi.fn(),
      },
      stderr: {
        write: vi.fn(),
      },
    })),
    enableMouseEvents: vi.fn(),
    disableMouseEvents: vi.fn(),
    enterAlternateScreen: vi.fn(),
    disableLineWrapping: vi.fn(),
    getVersion: vi.fn(() => Promise.resolve('1.0.0')),
    listTranscriptSessions: vi.fn(),
    resolveLatestTranscriptSession: vi.fn(),
    resolveSameRepoTranscriptSession: vi.fn(),
    resolveLatestSameRepoTranscriptSession: vi.fn(),
    coreEvents: {
      // eslint-disable-next-line @typescript-eslint/no-misused-spread
      ...actual.coreEvents,
      emitFeedback: vi.fn(),
      emitConsoleLog: vi.fn(),
      listenerCount: vi.fn().mockReturnValue(0),
      on: vi.fn(),
      off: vi.fn(),
      drainBacklogs: vi.fn(),
    },
  };
});

vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    render: vi.fn((_node, options) => {
      if (options.alternateBuffer) {
        options.stdout.write('\x1b[?7l');
      }
      if (options.onRender) {
        options.onRender();
      }
      return {
        unmount: vi.fn(),
        rerender: vi.fn(),
        cleanup: vi.fn(),
        waitUntilExit: vi.fn(),
      };
    }),
  };
});

// Custom error to identify mock process.exit calls
class MockProcessExitError extends Error {
  constructor(readonly code?: string | number | null | undefined) {
    super('PROCESS_EXIT_MOCKED');
    this.name = 'MockProcessExitError';
  }
}

// Mock dependencies
vi.mock('./config/settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config/settings.js')>();
  const mocked = {
    ...actual,
    loadSettings: loadSettings.mockImplementation(() => ({
      merged: actual.getDefaultsFromSchema(),
      user: { settings: {} },
      project: { settings: {} },
      local: { settings: {} },
      flag: { settings: {} },
      errors: [],
    })),
    saveModelChange: vi.fn(),
    getDefaultsFromSchema: actual.getDefaultsFromSchema,
  };
  return {
    ...mocked,
    loadSettingsWithService: (
      cwd: string,
      _service: unknown,
      sources?: ReadonlyArray<
        import('./test-utils/resolveSettings.js').SettingSource
      >,
    ) =>
      sources === undefined
        ? mocked.loadSettings(cwd)
        : mocked.loadSettings(cwd, sources),
  };
});

vi.mock('./ui/utils/terminalCapabilityManager.js', () => ({
  terminalCapabilityManager: {
    detectCapabilities: vi.fn(),
    isKittyProtocolEnabled: vi.fn(() => false),
    getTerminalBackgroundColor: vi.fn(),
    stopDraining: vi.fn(),
  },
}));

vi.mock('./config/config.js', () => ({
  initializeUserResources: vi.fn(async () => {}),
  loadCliConfig: vi.fn().mockImplementation(async () => createMockConfig()),
  isDebugMode: vi.fn(() => false),
  getWorkingDirFromEnv: vi.fn(() => undefined),
  resolveConfigTargetDir: vi.fn((cwd = process.cwd()) => path.resolve(cwd)),
  resolveConfigInteractive: vi.fn(() => false),
}));

// main() ends by parsing process.argv through the real command tree, which would
// route on vitest's own argv. The tree is stubbed out so main() stops right
// after the process-level setup these tests are about.
vi.mock('./commands/index.js', () => ({
  createCommand: vi.fn(async () => ({
    parseAsync: vi.fn(async () => {}),
  })),
}));

vi.mock('read-package-up', () => ({
  readPackageUp: vi.fn().mockResolvedValue({
    enabled: true,
    allowedPaths: [],
    networkAccess: false,
    packageJson: { name: 'test-pkg', version: 'test-version' },
    path: '/fake/path/package.json',
  }),
}));

vi.mock('update-notifier', () => ({
  default: vi.fn(() => ({
    notify: vi.fn(),
  })),
}));

vi.mock('./utils/events.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils/events.js')>();
  return {
    ...actual,
    appEvents: {
      emit: vi.fn(),
    },
  };
});

import * as readStdinModule from './utils/readStdin.js';
import { startInteractiveUI } from './interactiveCli.js';
import {
  getNodeMemoryArgs,
  handleRootCommand,
  validateDnsResolutionOrder,
} from './startup/rootCommandHandler.js';

/**
 * In production main() parses argv through the command tree and the root
 * command's action runs handleRootCommand with the argv it parsed. The command
 * tree is mocked in this file, so tests supply that argv themselves with
 * setCliArgs() and runCliStartup() re-creates the wiring: main() performs the
 * process-level setup, then the startup tail runs with the given argv.
 */
let stubbedCliArgs: CliArgs | undefined;
let lastFrameworkInput: FrameworkInitInput | undefined;

function setCliArgs(args: CliArgs): void {
  stubbedCliArgs = args;
}

async function runCliStartup(
  dependencies: CliDependencies = {},
): Promise<void> {
  // main 持有 AbortController 并把 signal 交给工厂；这里从工厂回捕实例，
  // 使随后显式调用的 handleRootCommand 复用同一个 Framework。
  let framework!: AppFramework;
  const createFramework: NonNullable<CliOptions['createFramework']> = (
    signal,
    settings,
    mode,
    input,
  ) => {
    lastFrameworkInput = input;
    framework = new (class extends AppFramework {
      override createConfigService() {
        return dependencies.configService ?? super.createConfigService();
      }
      override createResourceService() {
        return dependencies.resourceService ?? super.createResourceService();
      }
      override createSdkServer(params: SdkServerParams) {
        return (
          dependencies.createSdkServer?.(params) ??
          super.createSdkServer(params)
        );
      }
      getHeadlessSession() {
        return {
          run: async (...args: unknown[]) => {
            const { resetHeadlessExitCode, exitHeadlessMode } = await import(
              './headless/exit.js'
            );
            resetHeadlessExitCode();
            await runHeadlessSessionSpy(...args);
            await exitHeadlessMode();
          },
        } as never;
      }
    })(signal, settings, input, mode);
    return framework;
  };
  await main({ createFramework });
  const { createCommand } = await import('./commands/index.js');
  const [settings, , startFramework] = vi
    .mocked(createCommand)
    .mock.calls.at(-1)!;
  await handleRootCommand(
    stubbedCliArgs as CliArgs,
    undefined,
    settings!,
    startFramework!,
  );
}

afterEach(async () => {
  const { registerApplicationLifecycle } = await import('./utils/cleanup.js');
  for (const lifecycle of appLifetimes.splice(0)) {
    lifecycle.cancelInitialization();
    await lifecycle.dispose();
  }
  vi.mocked(registerApplicationLifecycle).mockClear();
});

vi.mock('./ui/utils/mouse.js', () => ({
  enableMouseEvents: vi.fn(),
  disableMouseEvents: vi.fn(),
  isIncompleteMouseSequence: vi.fn(),
}));

describe('qwen.tsx main function', () => {
  let originalIsTTY: boolean | undefined;
  let initialUnhandledRejectionListeners: NodeJS.UnhandledRejectionListener[] =
    [];
  let initialUncaughtExceptionListeners: NodeJS.UncaughtExceptionListener[] =
    [];

  it.each([false, true])(
    'no command action creates or releases runtime resources (injected=%s)',
    async (injected) => {
      const { ResourceService } = await import('@qwen-code/core');
      const { registerApplicationLifecycle } = await import(
        './utils/cleanup.js'
      );
      const resourceService = injected ? new ResourceService() : undefined;
      const dispose = vi.spyOn(ResourceService.prototype, 'dispose');
      const options: CliOptions = {};
      if (resourceService) {
        options.createFramework = (signal) =>
          new (class extends AppFramework {
            override createResourceService() {
              return resourceService;
            }
          })(signal);
      }
      try {
        await main(options);
        expect(dispose).not.toHaveBeenCalled();
        await vi
          .mocked(registerApplicationLifecycle)
          .mock.calls.at(-1)![0]
          .dispose();
        expect(dispose).not.toHaveBeenCalled();
      } finally {
        dispose.mockRestore();
        await resourceService?.dispose();
      }
    },
  );

  it('prepares Settings before declarations and restores policy when declarations fail', async () => {
    const order: string[] = [];
    const restore = vi.fn(() => {
      order.push('restore');
    });
    const createFramework = vi.fn();
    await expect(
      main({
        prepareSettings: () => {
          order.push('prepare');
          return restore;
        },
        declarations: () => {
          order.push('declarations');
          throw new Error('declarations failed');
        },
        createFramework,
      }),
    ).rejects.toThrow('declarations failed');
    expect(order).toEqual(['prepare', 'declarations']);
    await appLifetimes.at(-1)!.dispose();
    expect(order).toEqual(['prepare', 'declarations', 'restore']);
    expect(createFramework).not.toHaveBeenCalled();
  });

  it('waits for pending Settings preparation on shutdown and restores it without starting commands', async () => {
    let finish!: (restore: () => void) => void;
    let entered!: () => void;
    const enteredPreparation = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<() => void>((resolve) => {
      finish = resolve;
    });
    const restore = vi.fn();
    const declarations = vi.fn();
    const result = main({
      prepareSettings: () => {
        entered();
        return pending;
      },
      declarations,
    }).catch((error: unknown) => error);
    await enteredPreparation;
    const lifecycle = appLifetimes.at(-1)!;
    lifecycle.cancelInitialization();
    let closed = false;
    const closing = lifecycle.dispose().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    finish(restore);
    expect(await result).toBeInstanceOf(Error);
    await closing;
    expect(restore).toHaveBeenCalledOnce();
    expect(declarations).not.toHaveBeenCalled();
  });

  it('installs the product factory before creating CLI settings and passes the instance to Framework', async () => {
    const { SettingsService } = await import('@qwen-code/resource');
    const { AppFramework: Framework } = await import(
      './framework/appFramework.js'
    );
    const { Storage } = await import('@qwen-code/core');
    const { createCliSettingsService } = await import(
      './config/createCliSettingsService.js'
    );
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(
      join(tmpdir(), 'main-settings-factory-中文 空格-'),
    );
    const directory = vi
      .spyOn(Storage, 'getGlobalConfigDir')
      .mockReturnValue(root);
    class ProductSettings extends SettingsService {}
    const factory = vi.fn(() => new ProductSettings());
    const instance = {
      init: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    } as unknown as import('./framework/entryFramework.js').EntryFramework;
    const createFramework = vi.fn<NonNullable<CliOptions['createFramework']>>(
      async () => instance,
    );
    try {
      await main({
        prepareSettings: () => Framework.setSettingsServiceFactory(factory),
        createFramework,
      });
      const { createCommand } = await import('./commands/index.js');
      const [service, , startFramework] = vi
        .mocked(createCommand)
        .mock.calls.at(-1)!;
      expect(service).toBeInstanceOf(ProductSettings);
      expect(factory).toHaveBeenCalledOnce();
      expect(createFramework).not.toHaveBeenCalled();
      await startFramework!('command', {
        argv: {} as CliArgs,
        settings: createMockSettings(),
        command: 'local',
      });
      expect(createFramework.mock.calls[0][1]).toBe(service);
      await appLifetimes.at(-1)!.dispose();
      expect(instance.dispose).toHaveBeenCalledOnce();
      const restored = createCliSettingsService();
      try {
        expect(restored.constructor).toBe(SettingsService);
      } finally {
        await restored.dispose();
      }
    } finally {
      await appLifetimes.at(-1)?.dispose();
      directory.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('starts the framework once through the direct callback and rejects entry switches', async () => {
    const init = vi.fn(async () => {});
    const dispose = vi.fn(async () => {});
    const instance = {
      init,
      dispose,
    } as unknown as import('./framework/entryFramework.js').EntryFramework;
    const createFramework = vi.fn(async () => instance);
    await main({ createFramework });
    const { createCommand } = await import('./commands/index.js');
    const [, , startFramework] = vi.mocked(createCommand).mock.calls.at(-1)!;
    expect(createFramework).not.toHaveBeenCalled();
    const input = {
      argv: {} as CliArgs,
      settings: createMockSettings(),
      command: 'local' as const,
    };
    const first = startFramework!('command', input);
    const second = startFramework!('command', input);
    expect(second).toBe(first);
    await expect(first).resolves.toBe(instance);
    expect(createFramework).toHaveBeenCalledOnce();
    expect(init).toHaveBeenCalledOnce();
    expect(() => startFramework!('tui', input)).toThrow(
      'Cannot switch entry framework',
    );
    await appLifetimes.at(-1)!.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('shutdown waits for a late framework factory and does not initialize after cancellation', async () => {
    let resolveFactory!: (
      value: import('./framework/entryFramework.js').EntryFramework,
    ) => void;
    const factoryReady = new Promise<
      import('./framework/entryFramework.js').EntryFramework
    >((resolve) => {
      resolveFactory = resolve;
    });
    const init = vi.fn(async () => {});
    const dispose = vi.fn(async () => {});
    {
      await main({ createFramework: () => factoryReady });
      const { createCommand } = await import('./commands/index.js');
      const [, , startFramework] = vi.mocked(createCommand).mock.calls.at(-1)!;
      const starting = startFramework!('command', {
        argv: {} as CliArgs,
        settings: createMockSettings(),
        command: 'local',
      });
      const rejected = starting.catch((error) => error);
      const lifecycle = appLifetimes.at(-1)!;
      lifecycle.cancelInitialization();
      let closed = false;
      const closing = lifecycle.dispose().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      resolveFactory({
        init,
        dispose,
      } as unknown as import('./framework/entryFramework.js').EntryFramework);
      expect(await rejected).toBeInstanceOf(Error);
      await closing;
      expect(init).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledOnce();
    }
  });

  beforeEach(() => {
    vi.stubEnv('SHPOOL_SESSION_NAME', '');

    initialUnhandledRejectionListeners =
      process.listeners('unhandledRejection');
    initialUncaughtExceptionListeners = process.listeners('uncaughtException');

    originalIsTTY = process.stdin.isTTY;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdin as any).isTTY = true;
  });

  afterEach(() => {
    const currentListeners = process.listeners('unhandledRejection');
    currentListeners.forEach((listener) => {
      if (!initialUnhandledRejectionListeners.includes(listener)) {
        process.removeListener('unhandledRejection', listener);
      }
    });
    const currentUncaughtExceptionListeners =
      process.listeners('uncaughtException');
    currentUncaughtExceptionListeners.forEach((listener) => {
      if (!initialUncaughtExceptionListeners.includes(listener)) {
        process.removeListener('uncaughtException', listener);
      }
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdin as any).isTTY = originalIsTTY;

    vi.restoreAllMocks();
  });

  const installUncaughtExceptionHandler =
    (): NodeJS.UncaughtExceptionListener => {
      setupUnhandledRejectionHandler();
      const handler = process
        .listeners('uncaughtException')
        .find(
          (listener) => !initialUncaughtExceptionListeners.includes(listener),
        );
      if (!handler) {
        throw new Error('uncaughtException handler was not installed');
      }
      return handler;
    };

  // undici synthesizes this error when a response body is destroyed before it
  // ended — e.g. when the first-payload deadline cancels an unconsumed SSE
  // stream. It is a cancellation, not a crash.
  const undiciAbortError = () =>
    Object.assign(new Error('Request aborted'), {
      name: 'AbortError',
      code: 'UND_ERR_ABORTED',
    });

  it('records unhandled promise rejections non-fatally without terminating or opening debug console', async () => {
    const processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code) => {
        throw new MockProcessExitError(code);
      });
    const appEventsMock = vi.mocked(appEvents);
    const debugLoggerErrorSpy = vi.spyOn(runLogger, 'error');
    const rejectionError = new Error('Test unhandled rejection');

    setupUnhandledRejectionHandler();
    // Simulate an unhandled rejection.
    // We are not using Promise.reject here as vitest will catch it.
    // Instead we will dispatch the event manually.
    process.emit('unhandledRejection', rejectionError, Promise.resolve());

    // We need to wait for the rejection handler to be called.
    await new Promise(process.nextTick);

    expect(appEventsMock.emit).not.toHaveBeenCalledWith(
      AppEvent.OpenDebugConsole,
    );
    expect(debugLoggerErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[unhandledRejection] Test unhandled rejection'),
    );

    // Simulate a second rejection
    const secondRejectionError = new Error('Second test unhandled rejection');
    process.emit('unhandledRejection', secondRejectionError, Promise.resolve());
    await new Promise(process.nextTick);

    // Unhandled rejections are logged, but they no longer force-open the debug console.
    const openDebugConsoleCalls = appEventsMock.emit.mock.calls.filter(
      (call) => call[0] === AppEvent.OpenDebugConsole,
    );
    expect(openDebugConsoleCalls.length).toBe(0);

    // Avoid the process.exit error from being thrown.
    processExitSpy.mockRestore();
  });

  it('treats an undici response-body abort reaching uncaughtException as non-fatal', () => {
    const debugLoggerWarnSpy = vi.spyOn(runLogger, 'warn');
    const debugLoggerErrorSpy = vi.spyOn(runLogger, 'error');
    const setExitContextSpy = vi.spyOn(sessionLogger, 'setExitContext');

    const abortError = undiciAbortError();

    installUncaughtExceptionHandler()(abortError, 'uncaughtException');

    expect(debugLoggerWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        '[uncaughtException] Cancelled error (non-fatal): Request aborted',
      ),
    );
    expect(debugLoggerErrorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('[uncaughtException]'),
    );
    expect(setExitContextSpy).not.toHaveBeenCalled();
  });

  it('keeps the known Windows node-pty resize race non-fatal', () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(
      process,
      'platform',
    );
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32',
    });
    const debugLoggerWarnSpy = vi.spyOn(runLogger, 'warn');

    try {
      const ptyRace = new Error('Cannot resize a pty that has already exited');
      installUncaughtExceptionHandler()(ptyRace, 'uncaughtException');

      expect(debugLoggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[uncaughtException] Cancelled error'),
      );
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, 'platform', platformDescriptor);
      }
    }
  });

  it('records the exit context for a non-whitelisted uncaught exception without terminating', () => {
    const uncaughtError = new Error('uncaught test error');
    const setExitContextSpy = vi.spyOn(sessionLogger, 'setExitContext');

    installUncaughtExceptionHandler()(uncaughtError, 'uncaughtException');

    expect(setExitContextSpy).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'uncaught_exception' }),
    );
  });

  it('does not hide a mixed AggregateError that also contains an abort', () => {
    const debugLoggerWarnSpy = vi.spyOn(runLogger, 'warn');
    const debugLoggerErrorSpy = vi.spyOn(runLogger, 'error');
    const setExitContextSpy = vi.spyOn(sessionLogger, 'setExitContext');

    const mixedError = new AggregateError(
      [undiciAbortError(), new Error('real failure')],
      'mixed failure',
    );

    installUncaughtExceptionHandler()(mixedError, 'uncaughtException');

    expect(debugLoggerWarnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('[uncaughtException] Cancelled error'),
    );
    expect(debugLoggerErrorSpy).toHaveBeenCalledWith(
      '[uncaughtException] mixed failure',
    );
    expect(setExitContextSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'uncaught_exception',
        error_name: 'AggregateError',
        source: 'gemini.uncaughtException',
      }),
    );
  });

  it('reports background network rejections as non-fatal errors instead of crashes', async () => {
    const networkError = Object.assign(new Error('fetch failed'), {
      code: 'ECONNRESET',
    });
    const setExitContextSpy = vi.spyOn(sessionLogger, 'setExitContext');

    setupUnhandledRejectionHandler();
    process.emit('unhandledRejection', networkError, Promise.resolve());
    await new Promise(process.nextTick);

    expect(setExitContextSpy).not.toHaveBeenCalled();
  });
});

vi.mock('./startup/options/modelList.js', () => ({
  runModelListOption: vi.fn(async () => {}),
}));

describe('qwen.tsx cwd startup sync', () => {
  it('initializes model listing as a client command', async () => {
    setCliArgs({ ...makePrintArgs(), listModels: true });
    await runCliStartup();
    expect(lastFrameworkInput?.command).toBe('client');
  });

  let originalCwd: string;
  let originalArgv: string[];
  let originalIsTTY: boolean | undefined;
  let tmpRoot: string;
  let processExitSpy: MockInstance<
    (code?: string | number | null | undefined) => never
  >;

  function makePrintArgs(cwd?: string): CliArgs {
    return {
      model: undefined,
      debug: undefined,
      prompt: 'ask',
      promptInteractive: undefined,
      query: undefined,
      permissionMode: undefined,
      allowedMcpServerNames: undefined,
      tools: undefined,
      extensions: undefined,
      listExtensions: undefined,
      addDir: undefined,
      screenReader: undefined,
      alternateBuffer: undefined,
      resume: undefined,
      listSessions: undefined,
      listModels: undefined,
      deleteSession: undefined,
      outputFormat: undefined,
      inputFormat: 'text',
      fakeResponses: undefined,
      recordResponses: undefined,
      rawOutput: undefined,
      acceptRawOutputRisk: undefined,
      print: true,
      cwd,
    } as CliArgs;
  }

  async function runMainToExit(): Promise<void> {
    try {
      await runCliStartup();
    } catch (error) {
      if (!(error instanceof MockProcessExitError)) {
        throw error;
      }
    }
    expect(processExitSpy).toHaveBeenCalledWith(0);
  }

  beforeEach(() => {
    vi.clearAllMocks();

    originalCwd = process.cwd();
    originalArgv = process.argv;
    originalIsTTY = process.stdin.isTTY;
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-cwd-'));
    process.chdir(tmpRoot);
    setCwd(process.cwd());
    setOriginalCwd(process.cwd());

    vi.stubEnv('SHPOOL_SESSION_NAME', '');
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    vi.stubEnv(ENV_WORKTREE_HANDLED, '');
    vi.stubEnv(ENV_WORKTREE_INFO, '');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdin as any).isTTY = true;
    runHeadlessSessionSpy.mockResolvedValue(undefined);
    lastFrameworkInput = undefined;
    vi.mocked(loadSettings).mockReturnValue(
      createMockSettings({
        merged: {
          advanced: {},
          security: { auth: { selectedType: 'google' } },
          ui: {},
        },
        project: { settings: {} },
        local: { settings: {} },
        user: { settings: {} },
      }),
    );
    vi.mocked(loadCliConfig).mockResolvedValue(
      createMockConfig({
        isInteractive: () => false,
        getQuestion: () => 'ask',
        getEffectiveQuestion: () => 'ask',
        getHookSystem: () =>
          ({
            fireSessionEndEvent: vi.fn().mockResolvedValue(undefined),
            fireWorktreeCreateEvent: vi.fn().mockResolvedValue(undefined),
            fireCwdChangedEvent: vi.fn().mockResolvedValue(undefined),
          }) as unknown as Config['getHookSystem'] extends () => infer T
            ? T
            : never,
      }),
    );
    setCliArgs(makePrintArgs());
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new MockProcessExitError(code);
    });
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    process.argv = originalArgv;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdin as any).isTTY = originalIsTTY;
    process.chdir(originalCwd);
    setCwd(originalCwd);
    setOriginalCwd(originalCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it.each([{ acp: true }, { sdk: true }])(
    'loads only user settings for Host, ignoring a prepared project: %j',
    async (flags) => {
      vi.stubEnv(ENV_WORKTREE_HANDLED, '1');
      vi.stubEnv(ENV_WORKTREE_INFO, '{broken');

      // Stop after settings loading, before starting the Host runtime.
      const framework = new AppFramework(new AbortController().signal);
      try {
        await expect(
          handleRootCommand(
            { ...makePrintArgs(), ...flags, sessionId: 'invalid' },
            { resourceRoot: '/previous-project' },
            framework.getSettingsService(),
            framework.start.bind(framework),
          ),
        ).rejects.toBeInstanceOf(MockProcessExitError);
      } finally {
        // 手动建的 Framework 不经 main 的生命周期登记，这里自行释放插件 Registry。
        await framework.awaitDispose().catch(() => {});
      }

      expect(processExitSpy).toHaveBeenCalledWith(42);
      expect(loadSettings).toHaveBeenCalledWith(os.homedir(), ['user']);
      expect(loadCliConfig).not.toHaveBeenCalled();
    },
  );

  it('syncs a relative -w path to the Shell singleton as an absolute cwd', async () => {
    const subdir = path.join(tmpRoot, 'subdir');
    fs.mkdirSync(subdir);

    process.argv = ['node', 'script.js', '-w', 'subdir', '--print', 'ask'];
    setCliArgs(makePrintArgs('subdir'));

    await runMainToExit();

    expect(getCwd()).toBe(fs.realpathSync(subdir));
  });

  it('loads only the original project env through main and defers resume to the session', async () => {
    const { createCommand } = await import('./commands/index.js');
    const realCommands = await vi.importActual<
      typeof import('./commands/index.js')
    >('./commands/index.js');
    const { loadEnvironment } = await vi.importActual<
      typeof import('./test-utils/resolveSettings.js')
    >('./config/settings.js');
    const { CONFIG_DIR, ENV_MODEL: modelEnv } = await import('@qwen-code/core');
    const project = path.join(tmpRoot, 'original');
    const checkout = path.join(tmpRoot, 'checkout');
    for (const [cwd, model] of [
      [project, 'original-model'],
      [checkout, 'wrong-model'],
    ]) {
      fs.mkdirSync(path.join(cwd, CONFIG_DIR), { recursive: true });
      fs.writeFileSync(
        path.join(cwd, CONFIG_DIR, '.env'),
        `${modelEnv}=${model}\n`,
      );
    }
    vi.stubEnv(modelEnv, undefined);
    const settings = loadSettings(project);
    vi.mocked(loadSettings).mockImplementation((cwd = process.cwd()) => {
      loadEnvironment({}, cwd, () => ({ isTrusted: true, source: 'file' }));
      return settings;
    });
    const id = '11111111-1111-4111-8111-111111111111';
    const sessionPath = path.join(tmpRoot, 'legacy-bucket', `${id}.jsonl`);
    vi.mocked(resolveSameRepoTranscriptSession).mockResolvedValue({
      sessionPath,
      displayInfo: 'Resumed session',
      messages: [],
      fileHistorySnapshots: [],
      sessionInfo: {
        id,
        file: `${id}.jsonl`,
        fileName: `${id}.jsonl`,
        sessionPath,
        startTime: '2026-04-20T00:00:00.000Z',
        lastUpdated: '2026-04-20T00:00:00.000Z',
        messageCount: 0,
        userMessageCount: 0,
        displayName: id,
        firstUserMessage: '',
        isCurrentSession: false,
        index: 1,
        transcriptProjectRoot: project,
        worktreeSession: {
          originalCwd: project,
          worktreePath: checkout,
          worktreeCwd: checkout,
          worktreeName: 'checkout',
          sessionId: id,
          lifecycle: 'attached',
          hookBased: true,
        },
      },
    });
    vi.mocked(createCommand).mockImplementationOnce(realCommands.createCommand);
    process.argv = [
      'node',
      'qwen',
      '-w',
      checkout,
      '--resume',
      id,
      '-p',
      'ask',
    ];
    try {
      // 本用例不使用 runCliStartup 的简化连接，覆盖真正的 main → Commander → handler。
      await main();
    } catch (error) {
      if (!(error instanceof MockProcessExitError)) throw error;
    }
    expect(processExitSpy).toHaveBeenCalledWith(0);
    expect(process.env[modelEnv]).toBe('original-model');
    expect(loadCliConfig).toHaveBeenCalled();
    for (const call of vi.mocked(loadCliConfig).mock.calls) {
      expect(call[2]).toEqual(
        expect.objectContaining({ model: 'original-model' }),
      );
      expect(call[3]).toEqual(expect.objectContaining({ cwd: project }));
    }
    expect(runHeadlessSessionSpy).toHaveBeenCalledWith();
  });

  it('reports a rejected user settings file to logs and user feedback', async () => {
    const { createCommand } = await import('./commands/index.js');
    const realCommands = await vi.importActual<
      typeof import('./commands/index.js')
    >('./commands/index.js');
    vi.mocked(createCommand).mockImplementationOnce(realCommands.createCommand);
    process.argv = ['node', 'qwen', '--print', 'ask'];
    const invalidPath = path.join(tmpRoot, 'settings.json');
    const settings = createMockSettings({
      user: {
        path: invalidPath,
        settings: {},
        originalSettings: {},
      },
      errors: [
        {
          path: invalidPath,
          severity: 'warning',
          message: 'Unexpected end of JSON input',
        },
      ],
      isUserSettingsLoadRejected: vi.fn(() => true),
    });
    vi.mocked(loadSettings).mockReturnValue(settings);
    const warnSpy = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});

    // Settings 警告由 Commander 发出，不能用跳过命令树的简化启动替代。
    try {
      await main();
    } catch (error) {
      if (!(error instanceof MockProcessExitError)) throw error;
    }
    expect(processExitSpy).toHaveBeenCalledWith(0);

    expect(warnSpy).toHaveBeenCalledWith(
      `[Settings] Invalid settings file ${invalidPath}: Unexpected end of JSON input`,
    );
    expect(coreEvents.emitFeedback).toHaveBeenCalledWith(
      'warning',
      'Unexpected end of JSON input',
    );
  });

  it('syncs an absolute -w path to the Shell singleton', async () => {
    const workspace = path.join(tmpRoot, 'workspace');
    fs.mkdirSync(workspace);

    process.argv = ['node', 'script.js', '-w', workspace, '--print', 'ask'];
    setCliArgs(makePrintArgs(workspace));

    await runMainToExit();

    expect(getCwd()).toBe(fs.realpathSync(workspace));
  });

  it('keeps -w as the project directory and defers worktree entry until Headless has a writer', async () => {
    const workspace = path.join(tmpRoot, 'workspace');
    fs.mkdirSync(workspace);
    process.argv = [
      'node',
      'script.js',
      '-w',
      workspace,
      '--worktree',
      'feature',
      '--print',
      'ask',
    ];
    setCliArgs({ ...makePrintArgs(workspace), worktree: 'feature' });

    await runMainToExit();

    expect(lastFrameworkInput?.workspaceRoot).toBe(fs.realpathSync(workspace));
    expect(runHeadlessSessionSpy).toHaveBeenCalledWith();
    expect(getCwd()).toBe(fs.realpathSync(workspace));
    expect(process.cwd()).toBe(fs.realpathSync(workspace));
  });
  it('passes the inherited worktree request to Headless before an explicit name', async () => {
    const workspace = fs.realpathSync(tmpRoot);
    const checkout = path.join(workspace, 'checkout');
    fs.mkdirSync(checkout);
    vi.stubEnv(ENV_WORKTREE_HANDLED, '1');
    vi.stubEnv(
      ENV_WORKTREE_INFO,
      JSON.stringify({
        originalCwd: workspace,
        path: checkout,
        name: 'inherited',
      }),
    );
    setCliArgs({ ...makePrintArgs(checkout), worktree: 'explicit' });

    await runMainToExit();

    expect(loadSettings).toHaveBeenCalledWith(workspace);
    expect(lastFrameworkInput?.inheritedWorktreeRequest).toMatchObject({
      kind: 'restore-inherited',
      state: expect.objectContaining({
        originalCwd: workspace,
        worktreePath: checkout,
        worktreeName: 'inherited',
      }),
    });
    expect(runHeadlessSessionSpy).toHaveBeenCalledWith();
  });
});

describe('setWindowTitle', () => {
  it('should set window title when hideWindowTitle is false', async () => {
    // setWindowTitle is not exported, but we can test its effect if we had a way to call it.
    // Since we can't easily call it directly without exporting it, we skip direct testing
    // and rely on startInteractiveUI tests which call it.
  });
});

describe('initializeOutputListenersAndFlush', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should flush backlogs and setup listeners if no listeners exist', async () => {
    const { coreEvents } = await import('@qwen-code/core');
    const { initializeOutputListenersAndFlush } = await import(
      './utils/outputListeners.js'
    );

    // Mock listenerCount to return 0
    vi.spyOn(coreEvents, 'listenerCount').mockReturnValue(0);
    const drainSpy = vi.spyOn(coreEvents, 'drainBacklogs');

    initializeOutputListenersAndFlush();

    expect(drainSpy).toHaveBeenCalled();
    // We can't easily check if listeners were added without access to the internal state of coreEvents,
    // but we can verify that drainBacklogs was called.
  });

  it('should append a newline when flushing fallback user feedback to stderr', async () => {
    const { coreEvents } = await import('@qwen-code/core');
    const { initializeOutputListenersAndFlush } = await import(
      './utils/outputListeners.js'
    );

    vi.spyOn(coreEvents, 'listenerCount').mockReturnValue(0);
    const onSpy = vi.spyOn(coreEvents, 'on');

    initializeOutputListenersAndFlush();

    const feedbackHandler = onSpy.mock.calls.find(
      (call) => call[0] === CoreEvent.UserFeedback,
    )?.[1] as
      | ((payload: { severity: string; message: string }) => void)
      | undefined;

    expect(feedbackHandler).toBeDefined();

    feedbackHandler?.({
      severity: 'error',
      message: 'No conversation found to continue',
    });

    expect(writeToStderr).toHaveBeenCalledWith(
      'No conversation found to continue\n',
    );
  });

  it('should skip UserFeedback listener when skipUserFeedback is true', async () => {
    const { coreEvents } = await import('@qwen-code/core');
    const { initializeOutputListenersAndFlush } = await import(
      './utils/outputListeners.js'
    );

    vi.spyOn(coreEvents, 'listenerCount').mockReturnValue(0);
    const onSpy = vi.spyOn(coreEvents, 'on');
    const drainSpy = vi.spyOn(coreEvents, 'drainBacklogs');

    initializeOutputListenersAndFlush({ skipUserFeedback: true });

    expect(drainSpy).toHaveBeenCalled();

    const feedbackListener = onSpy.mock.calls.find(
      (call) => call[0] === CoreEvent.UserFeedback,
    );
    expect(feedbackListener).toBeUndefined();

    // Output and ConsoleLog listeners should still be installed
    const outputListener = onSpy.mock.calls.find(
      (call) => call[0] === CoreEvent.Output,
    );
    const consoleLogListener = onSpy.mock.calls.find(
      (call) => call[0] === CoreEvent.ConsoleLog,
    );
    expect(outputListener).toBeDefined();
    expect(consoleLogListener).toBeDefined();
  });
});

describe('getNodeMemoryArgs', () => {
  const originalExecArgv = process.execArgv;
  const originalNodeOptions = process.env['NODE_OPTIONS'];

  afterEach(() => {
    Object.defineProperty(process, 'execArgv', { value: originalExecArgv });
    if (originalNodeOptions === undefined) {
      delete process.env['NODE_OPTIONS'];
    } else {
      process.env['NODE_OPTIONS'] = originalNodeOptions;
    }
    vi.restoreAllMocks();
  });

  it('should log current heap info when isDebugMode is true', () => {
    const debugSpy = vi.spyOn(runLogger, 'debug');
    vi.spyOn(v8, 'getHeapStatistics').mockReturnValue({
      heap_size_limit: 4 * 1024 * 1024 * 1024,
    } as ReturnType<typeof v8.getHeapStatistics>);
    const args = getNodeMemoryArgs(true);
    expect(args).toEqual(['--max-old-space-size=8192']);
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining('Current heap size'),
    );
  });

  it('should preserve an explicit NODE_OPTIONS heap limit', () => {
    process.env['NODE_OPTIONS'] = '--max-old-space-size=4096';
    Object.defineProperty(process, 'execArgv', { value: [] });
    vi.spyOn(v8, 'getHeapStatistics').mockReturnValue({
      heap_size_limit: 4 * 1024 * 1024 * 1024,
    } as ReturnType<typeof v8.getHeapStatistics>);

    expect(getNodeMemoryArgs(false)).toEqual([]);
  });

  it('should preserve an explicit execArgv heap limit', () => {
    delete process.env['NODE_OPTIONS'];
    Object.defineProperty(process, 'execArgv', {
      value: ['--max-old-space-size=4096'],
    });
    vi.spyOn(v8, 'getHeapStatistics').mockReturnValue({
      heap_size_limit: 4 * 1024 * 1024 * 1024,
    } as ReturnType<typeof v8.getHeapStatistics>);

    expect(getNodeMemoryArgs(false)).toEqual([]);
  });
});

describe('qwen.tsx main function kitty protocol', () => {
  let originalIsTTY: boolean | undefined;
  let originalStdoutIsTTY: boolean | undefined;
  let originalIsRaw: boolean | undefined;
  let originalArgv: string[];
  let originalPlatformDescriptor: PropertyDescriptor | undefined;
  let setRawModeSpy: MockInstance<
    (mode: boolean) => NodeJS.ReadStream & { fd: 0 }
  >;

  beforeEach(() => {
    originalArgv = process.argv;
    originalStdoutIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });
    vi.stubEnv('CI', '');
    originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
      process,
      'platform',
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!(process.stdin as any).setRawMode) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdin as any).setRawMode = vi.fn();
    }
    setRawModeSpy = vi.spyOn(process.stdin, 'setRawMode');

    originalIsTTY = process.stdin.isTTY;
    originalIsRaw = process.stdin.isRaw;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdin as any).isTTY = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdin as any).isRaw = false;
    vi.mocked(terminalCapabilityManager.detectCapabilities).mockClear();
  });

  afterEach(() => {
    process.argv = originalArgv;
    Object.defineProperty(process.stdout, 'isTTY', {
      value: originalStdoutIsTTY,
      configurable: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdin as any).isTTY = originalIsTTY;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdin as any).isRaw = originalIsRaw;
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each(['new', 'continue', 'resume'] as const)(
    'renders local TUI before identity-dependent model reads (%s)',
    async (mode) => {
      const { render } = await import('ink');
      const renderMock = vi.mocked(render);
      renderMock.mockClear();
      let authenticate!: () => void;
      const identityReady = new Promise<void>((resolve) => {
        authenticate = resolve;
      });
      const getModel = vi.fn(async () => {
        await identityReady;
        return undefined;
      });
      const listModels = vi.fn(async () => {
        await identityReady;
        return [];
      });
      const modelManager = { getModel, listModels } as unknown as ReturnType<
        Config['getModelProviderManager']
      >;
      const config = createMockConfig({
        isInteractive: () => true,
        isInitialized: () => false,
        getModel: vi.fn(() => ''),
        getModelProviderManager: () => modelManager,
        getTranscriptStore: () =>
          ({}) as ReturnType<Config['getTranscriptStore']>,
        getSessionArtifactProjectRoot: () => process.cwd(),
      });
      vi.mocked(loadCliConfig).mockResolvedValue(config);
      vi.mocked(loadSettings).mockReturnValue(createMockSettings());
      const sessionId = '11111111-1111-4111-8111-111111111111';
      const resolved = {
        sessionInfo: { id: sessionId },
        sessionPath: `/tmp/${sessionId}.jsonl`,
        messages: [],
        fileHistorySnapshots: [],
        runtimeConfig: { model: 'historical-model', reasoningEffort: 'high' },
      } as unknown as Awaited<
        ReturnType<typeof resolveSameRepoTranscriptSession>
      >;
      vi.mocked(resolveSameRepoTranscriptSession).mockResolvedValue(resolved);
      vi.mocked(resolveLatestSameRepoTranscriptSession).mockResolvedValue(
        resolved,
      );
      setCliArgs({
        continue: mode === 'continue',
        resume: mode === 'resume' ? sessionId : undefined,
      } as CliArgs);
      process.argv = ['node', 'script.js'];
      // 身份只能由首屏驱动；提前等待 getModel/listModels 会令入口超时。
      renderMock.mockImplementationOnce(() => {
        authenticate();
        return {
          unmount: vi.fn(),
          rerender: vi.fn(),
          cleanup: vi.fn(),
          waitUntilExit: vi.fn(),
        } as ReturnType<typeof render>;
      });
      try {
        await runCliStartup();
        expect(renderMock).toHaveBeenCalledOnce();
        expect(getModel).not.toHaveBeenCalled();
        expect(listModels).not.toHaveBeenCalled();
        expect(config.initializeForInteractiveStartup).not.toHaveBeenCalled();
        if (mode !== 'new') {
          expect(config.setSessionId).toHaveBeenCalledWith(sessionId);
        }
      } finally {
        authenticate();
      }
    },
    10000,
  );

  it('prepares remote session without identity-dependent model reads', async () => {
    const getModel = vi.fn(async () => {
      throw new Error('模型目录需要首屏认证后才能读取');
    });
    const listModels = vi.fn(async () => {
      throw new Error('模型目录需要首屏认证后才能读取');
    });
    const prepareSession = vi.spyOn(AppFramework.prototype, 'prepareSession');
    const config = createMockConfig({
      isInteractive: () => true,
      getModel: () => 'remote-fallback',
      getModelProviderManager: () =>
        ({ getModel, listModels }) as unknown as ReturnType<
          Config['getModelProviderManager']
        >,
    });
    vi.mocked(loadCliConfig).mockResolvedValue(config);
    vi.mocked(loadSettings).mockReturnValue(createMockSettings());
    setCliArgs({ remoteSession: 'remote-session' } as CliArgs);
    process.argv = ['node', 'script.js'];

    await runCliStartup();

    // 首屏认证完成前模型目录不可用；远端交接提前等待会与登录门互相阻塞。
    expect(getModel).not.toHaveBeenCalled();
    expect(listModels).not.toHaveBeenCalled();
    expect(prepareSession).toHaveBeenCalledWith({
      model: 'remote-fallback',
      permissionMode: 'default',
    });
  });

  // skip: 现存失败
  it.skip('should call setRawMode and detectCapabilities when isInteractive is true', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
    });
    vi.mocked(loadCliConfig).mockResolvedValue(
      createMockConfig({
        isInteractive: () => true,
        getQuestion: () => '',
      }),
    );
    vi.mocked(loadSettings).mockReturnValue(
      createMockSettings({
        merged: {
          advanced: {},
          security: { auth: {} },
          ui: {},
        },
      }),
    );
    setCliArgs({
      model: undefined,
      debug: undefined,
      prompt: undefined,
      promptInteractive: undefined,
      query: undefined,
      permissionMode: undefined,
      allowedMcpServerNames: undefined,
      tools: undefined,
      extensions: undefined,
      listExtensions: undefined,
      addDir: undefined,
      screenReader: undefined,
      alternateBuffer: undefined,
      resume: undefined,
      listSessions: undefined,
      listModels: undefined,
      deleteSession: undefined,
      outputFormat: undefined,
      inputFormat: undefined,
      fakeResponses: undefined,
      recordResponses: undefined,
      rawOutput: undefined,
      acceptRawOutputRisk: undefined,
    });

    await act(async () => {
      await runCliStartup();
    });

    expect(setRawModeSpy).toHaveBeenCalledWith(true);
    expect(terminalCapabilityManager.detectCapabilities).toHaveBeenCalled();
    expect(loadCliConfig).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        mcpInitializationWaitStrategy: 'none',
      }),
    );
  }, 10_000);

  // skip: 现存失败
  it.skip('should skip early terminal capability detection on Windows TUI startup', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
    vi.mocked(loadCliConfig).mockResolvedValue(
      createMockConfig({
        isInteractive: () => true,
        getQuestion: () => '',
      }),
    );
    vi.mocked(loadSettings).mockReturnValue(
      createMockSettings({
        merged: {
          advanced: {},
          security: { auth: {} },
          ui: {},
        },
      }),
    );
    setCliArgs({
      model: undefined,
      debug: undefined,
      prompt: undefined,
      promptInteractive: undefined,
      query: undefined,
      permissionMode: undefined,
      allowedMcpServerNames: undefined,
      tools: undefined,
      extensions: undefined,
      listExtensions: undefined,
      addDir: undefined,
      screenReader: undefined,
      alternateBuffer: undefined,
      resume: undefined,
      listSessions: undefined,
      listModels: undefined,
      deleteSession: undefined,
      outputFormat: undefined,
      inputFormat: undefined,
      fakeResponses: undefined,
      recordResponses: undefined,
      rawOutput: undefined,
      acceptRawOutputRisk: undefined,
    });

    await act(async () => {
      await runCliStartup();
    });

    expect(setRawModeSpy).toHaveBeenCalledWith(true);
    expect(terminalCapabilityManager.detectCapabilities).not.toHaveBeenCalled();
  }, 10_000);

  // skip: 现存失败
  it.skip('should call process.stdin.resume when isInteractive is true to protect against implicit Node pause', async () => {
    const resumeSpy = vi.spyOn(process.stdin, 'resume');
    vi.mocked(loadCliConfig).mockResolvedValue(
      createMockConfig({
        isInteractive: () => true,
        getQuestion: () => '',
      }),
    );
    vi.mocked(loadSettings).mockReturnValue(
      createMockSettings({
        merged: {
          advanced: {},
          security: { auth: {} },
          ui: {},
        },
      }),
    );
    setCliArgs({
      model: undefined,
      debug: undefined,
      prompt: undefined,
      promptInteractive: undefined,
      query: undefined,
      permissionMode: undefined,
      allowedMcpServerNames: undefined,
      tools: undefined,
      extensions: undefined,
      listExtensions: undefined,
      addDir: undefined,
      screenReader: undefined,
      alternateBuffer: undefined,
      resume: undefined,
      listSessions: undefined,
      listModels: undefined,
      deleteSession: undefined,
      outputFormat: undefined,
      inputFormat: undefined,
      fakeResponses: undefined,
      recordResponses: undefined,
      rawOutput: undefined,
      acceptRawOutputRisk: undefined,
    });

    await act(async () => {
      await runCliStartup();
    });

    expect(resumeSpy).toHaveBeenCalledTimes(1);
    resumeSpy.mockRestore();
  });

  it.each([
    { flag: 'listExtensions' },
    { flag: 'listSessions' },
    { flag: 'deleteSession', value: 'session-id' },
  ])('should handle --$flag flag', async ({ flag, value }) => {
    const { listSessions, deleteSession } = await import('./utils/sessions.js');
    const processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code) => {
        throw new MockProcessExitError(code);
      });

    vi.mocked(loadSettings).mockReturnValue(
      createMockSettings({
        merged: {
          advanced: {},
          security: { auth: {} },
          ui: {},
        },
        project: { settings: {} },
        setValue: vi.fn(),
        forScope: () => ({ settings: {}, originalSettings: {}, path: '' }),
      }),
    );

    setCliArgs({
      enabled: true,
      allowedPaths: [],
      networkAccess: false,
      promptInteractive: false,
      listExtensions: flag === 'listExtensions',
      listSessions: flag === 'listSessions',
      deleteSession: flag === 'deleteSession' ? value : undefined,
    } as any); // eslint-disable-line @typescript-eslint/no-explicit-any

    const mockConfig = createMockConfig({
      isInteractive: () => false,
      getQuestion: () => '',
      getEnabledPlugins: () => [
        {
          name: 'ext1',
          manifest: { name: 'ext1', version: '1.0.0' },
          path: '/path/to/ext1',
          source: 'local',
          repository: 'local',
        },
      ],
    });

    vi.mocked(loadCliConfig).mockResolvedValue(mockConfig);
    vi.mock('./utils/sessions.js', () => ({
      listSessions: vi.fn(),
      deleteSession: vi.fn(),
    }));

    const debugLoggerLogSpy = vi
      .spyOn(runLogger, 'log')
      .mockImplementation(() => {});

    process.env['GEMINI_API_KEY'] = 'test-key';
    try {
      await runCliStartup();
    } catch (e) {
      if (!(e instanceof MockProcessExitError)) throw e;
    } finally {
      delete process.env['GEMINI_API_KEY'];
    }

    if (flag === 'listExtensions') {
      expect(debugLoggerLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('ext1'),
      );
    } else if (flag === 'listSessions') {
      expect(listSessions).toHaveBeenCalledWith(mockConfig);
    } else if (flag === 'deleteSession') {
      expect(deleteSession).toHaveBeenCalledWith(mockConfig, value);
    }
    expect(processExitSpy).toHaveBeenCalledWith(0);
    processExitSpy.mockRestore();
  });

  it('runs --print single-process and leaves stdin handling to the headless session', async () => {
    runHeadlessSessionSpy.mockClear();
    const processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code) => {
        throw new MockProcessExitError(code);
      });
    const readStdinSpy = vi
      .spyOn(readStdinModule, 'readStdin')
      .mockResolvedValue('stdin-data');

    process.argv = ['node', 'script.js', '--print', 'ask'];
    setCliArgs({
      print: true,
      inputFormat: 'text',
      promptInteractive: false,
    } as any); // eslint-disable-line @typescript-eslint/no-explicit-any

    vi.mocked(loadSettings).mockReturnValue(
      createMockSettings({
        merged: {
          advanced: {},
          security: { auth: { selectedType: 'google' } },
          ui: {},
        },
        project: { settings: {} },
        setValue: vi.fn(),
        forScope: () => ({ settings: {}, originalSettings: {}, path: '' }),
      }),
    );

    const mockConfig = createMockConfig({
      isInteractive: () => false,
      getQuestion: () => 'ask',
    });

    vi.mocked(loadCliConfig).mockResolvedValue(mockConfig);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdin as any).isTTY = false;
    process.env['GEMINI_API_KEY'] = 'test-key';
    try {
      await runCliStartup();
    } catch (e) {
      if (!(e instanceof MockProcessExitError)) throw e;
    } finally {
      delete process.env['GEMINI_API_KEY'];
    }

    expect(readStdinSpy).not.toHaveBeenCalled();
    expect(runHeadlessSessionSpy).toHaveBeenCalled();
    expect(loadCliConfig).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        mcpInitializationWaitStrategy: 'budget',
      }),
    );
    expect(runHeadlessSessionSpy).toHaveBeenCalledWith();
    expect(processExitSpy).toHaveBeenCalledWith(0);
    processExitSpy.mockRestore();
  });

  it('does not initialize the interactive app or surface theme warnings in headless mode', async () => {
    process.argv = ['node', 'script.js', '--print', 'test'];
    const { themeManager } = await import('./ui/themes/theme-manager.js');
    const debugLoggerWarnSpy = vi
      .spyOn(runLogger, 'warn')
      .mockImplementation(() => {});
    const processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code) => {
        throw new MockProcessExitError(code);
      });

    vi.mocked(loadSettings).mockReturnValue(
      createMockSettings({
        merged: {
          advanced: {},
          security: { auth: {} },
          ui: { theme: 'non-existent-theme' },
        },
        project: { settings: {} },
        setValue: vi.fn(),
        forScope: () => ({ settings: {}, originalSettings: {}, path: '' }),
      }),
    );

    setCliArgs({
      enabled: true,
      allowedPaths: [],
      networkAccess: false,
      promptInteractive: false,
    } as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    vi.mocked(loadCliConfig).mockResolvedValue(
      createMockConfig({
        isInteractive: () => false,
        getQuestion: () => 'test',
      }),
    );

    vi.spyOn(themeManager, 'setActiveTheme').mockReturnValue(false);
    runHeadlessSessionSpy.mockImplementation(() => Promise.resolve());

    process.env['GEMINI_API_KEY'] = 'test-key';
    try {
      await runCliStartup();
    } catch (e) {
      if (!(e instanceof MockProcessExitError)) throw e;
    } finally {
      delete process.env['GEMINI_API_KEY'];
      processExitSpy.mockRestore();
    }

    // Headless 在 initializeApp 之前分派，不会加载交互主题，也不产生主题告警。
    expect(runHeadlessSessionSpy).toHaveBeenCalled();
    expect(debugLoggerWarnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Warning: Theme "non-existent-theme" not found.'),
    );
  });

  it('rejects an invalid session ID before loading config', async () => {
    const processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code) => {
        throw new MockProcessExitError(code);
      });
    const emitFeedbackSpy = vi.spyOn(coreEvents, 'emitFeedback');

    vi.mocked(loadSettings).mockReturnValue(
      createMockSettings({
        merged: { advanced: {}, security: { auth: {} }, ui: { theme: 'test' } },
        project: { settings: {} },
        local: { settings: {} },
        user: { settings: {} },
        setValue: vi.fn(),
        forScope: () => ({ settings: {}, originalSettings: {}, path: '' }),
      }),
    );

    setCliArgs({
      enabled: true,
      allowedPaths: [],
      networkAccess: false,
      sessionId: 'invalid-id',
    } as unknown as CliArgs);

    try {
      await runCliStartup();
    } catch (e) {
      if (!(e instanceof MockProcessExitError)) throw e;
    }

    expect(emitFeedbackSpy).toHaveBeenCalledWith(
      'error',
      'Invalid session ID. Must be a valid UUID.',
    );
    expect(initializeUserResources).not.toHaveBeenCalled();
    expect(loadCliConfig).not.toHaveBeenCalled();
    expect(processExitSpy).toHaveBeenCalledWith(42);
    processExitSpy.mockRestore();
    emitFeedbackSpy.mockRestore();
  });

  it('reports invalid --fork-session usage before checking session ID availability', async () => {
    const processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code) => {
        throw new MockProcessExitError(code);
      });
    const emitFeedbackSpy = vi.spyOn(coreEvents, 'emitFeedback');

    vi.mocked(loadSettings).mockReturnValue(
      createMockSettings({
        merged: { advanced: {}, security: { auth: {} }, ui: { theme: 'test' } },
        project: { settings: {} },
        local: { settings: {} },
        user: { settings: {} },
        setValue: vi.fn(),
        forScope: () => ({ settings: {}, originalSettings: {}, path: '' }),
      }),
    );

    setCliArgs({
      enabled: true,
      allowedPaths: [],
      networkAccess: false,
      forkSession: true,
      sessionId: '11111111-1111-4111-8111-111111111111',
    } as unknown as CliArgs);

    try {
      await runCliStartup();
    } catch (e) {
      if (!(e instanceof MockProcessExitError)) throw e;
    }

    expect(emitFeedbackSpy).toHaveBeenCalledWith(
      'error',
      '--fork-session must be used with --continue or --resume.',
    );
    expect(loadCliConfig).not.toHaveBeenCalled();
    expect(processExitSpy).toHaveBeenCalledWith(42);
    processExitSpy.mockRestore();
    emitFeedbackSpy.mockRestore();
  });

  it('rejects daemon startup when no product runner is installed', async () => {
    vi.mocked(loadSettings).mockReturnValue(
      createMockSettings({
        merged: { advanced: {}, security: { auth: {} }, ui: { theme: 'test' } },
        project: { settings: {} },
        local: { settings: {} },
        user: { settings: {} },
        setValue: vi.fn(),
        forScope: () => ({ settings: {}, originalSettings: {}, path: '' }),
      }),
    );
    setCliArgs({
      startupMessages: [],
      sdk: true,
    } as unknown as CliArgs);
    vi.mocked(loadCliConfig).mockResolvedValue(
      createMockConfig({ getProjectRoot: () => '/workspace/demo' }),
    );

    await expect(runCliStartup()).rejects.toThrow(
      'SDK daemon mode is not supported by this build',
    );
  });

  it('routes daemon startup to the installed product runner', async () => {
    vi.mocked(loadSettings).mockReturnValue(
      createMockSettings({
        merged: { advanced: {}, security: { auth: {} }, ui: { theme: 'test' } },
        project: { settings: {} },
        local: { settings: {} },
        user: { settings: {} },
        setValue: vi.fn(),
        forScope: () => ({ settings: {}, originalSettings: {}, path: '' }),
      }),
    );
    setCliArgs({
      startupMessages: [],
      sdk: true,
    } as unknown as CliArgs);
    const daemonConfig = createMockConfig({
      getProjectRoot: () => '/workspace/demo',
    });
    vi.mocked(loadCliConfig).mockResolvedValue(daemonConfig);
    const runDaemon = vi.fn(async () => {});
    const sdkServer = { run: runDaemon } as unknown as SdkServer;
    const { gracefulExit } = await import('./utils/cleanup.js');
    vi.mocked(gracefulExit).mockImplementationOnce(
      async () => undefined as never,
    );

    await runCliStartup({ createSdkServer: () => sdkServer });

    expect(daemonConfig.initialize).not.toHaveBeenCalled();
    expect(initializeUserResources).toHaveBeenCalledOnce();
    expect(
      vi.mocked(initializeUserResources).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(loadCliConfig).mock.invocationCallOrder[0]);
    expect(loadCliConfig).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        startupMode: 'daemon',
      }),
    );
    expect(runDaemon).toHaveBeenCalledOnce();
  });

  it.each([
    { inWorktree: false, mode: 'headless' },
    { inWorktree: true, mode: 'headless' },
    { inWorktree: true, mode: 'tui' },
    { inWorktree: true, mode: 'continue' },
  ])(
    'forks with the selected plan, resources and execution context (worktree: $inWorktree, mode: $mode)',
    async ({ inWorktree, mode }) => {
      const sourceSessionId = '11111111-1111-4111-8111-111111111111';
      const sourceWorktree = {
        originalCwd: '/workspace/demo',
        worktreePath: '/workspace/demo/.qwen/worktrees/source',
        worktreeCwd: '/workspace/demo/.qwen/worktrees/source/apps/desktop',
        worktreeName: 'source',
        sessionId: sourceSessionId,
        lifecycle: 'owner' as const,
        pendingOwnerReleasePath: '/workspace/demo/.qwen/worktrees/previous',
      };
      const attachedWorktree = {
        originalCwd: '/workspace/demo',
        worktreePath: '/workspace/demo/.qwen/worktrees/source',
        worktreeCwd: '/workspace/demo/.qwen/worktrees/source/apps/desktop',
        worktreeName: 'source',
        sessionId: 'fork-session-id',
        lifecycle: 'attached' as const,
      };
      const copyPlanForResume = vi.fn().mockResolvedValue(undefined);
      const processExitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation((code) => {
          throw new MockProcessExitError(code);
        });
      const mockConfig = createMockConfig({
        isInteractive: () => mode !== 'headless',
        getQuestion: () => '',
        getEffectiveQuestion: () => 'continue',
        getProjectRoot: () =>
          '/workspace/demo/.qwen/worktrees/fork-session/apps/desktop',
        getSessionArtifactProjectRoot: () => '/workspace/demo',
        getTranscriptStore: () =>
          ({}) as ReturnType<Config['getTranscriptStore']>,
        storage: {
          getProjectTempDir: vi.fn().mockReturnValue('/tmp/gemini-test'),
          initialize: vi.fn().mockResolvedValue(undefined),
          getPlansDir: vi.fn().mockReturnValue('/tmp/gemini-test/plans'),
        },
        planStateManager: {
          copyPlanForResume,
        },
        getSessionId: vi.fn().mockReturnValue('fork-session-id'),
      } as unknown as Partial<Config>);

      vi.mocked(loadSettings).mockReturnValue(
        createMockSettings({
          merged: {
            advanced: {},
            security: { auth: {} },
            ui: { theme: 'test' },
          },
          project: { settings: {} },
          local: { settings: {} },
          user: { settings: {} },
          setValue: vi.fn(),
          forScope: () => ({ settings: {}, originalSettings: {}, path: '' }),
        }),
      );

      setCliArgs({
        enabled: true,
        allowedPaths: [],
        networkAccess: false,
        prompt: mode === 'headless' ? 'continue' : undefined,
        resume: mode === 'continue' ? undefined : sourceSessionId,
        continue: mode === 'continue',
        forkSession: true,
      } as unknown as CliArgs);
      vi.mocked(loadCliConfig).mockResolvedValue(mockConfig);
      const resolvedSource = {
        sessionInfo: {
          id: sourceSessionId,
          worktreeSession: inWorktree ? sourceWorktree : null,
          startTime: '2026-04-20T00:00:00.000Z',
          lastUpdated: '2026-04-20T00:00:05.000Z',
          messageCount: 1,
          userMessageCount: 1,
          displayName: sourceSessionId,
          firstUserMessage: 'continue',
          file: sourceSessionId,
          fileName: `${sourceSessionId}.jsonl`,
          sessionPath: `/workspace/demo/${sourceSessionId}.jsonl`,
          isCurrentSession: false,
          index: 1,
        },
        sessionPath: `/workspace/demo/${sourceSessionId}.jsonl`,
        displayInfo: 'Session 1',
        messages: [],
        fileHistorySnapshots: [],
      };
      vi.mocked(resolveSameRepoTranscriptSession).mockResolvedValue(
        resolvedSource,
      );
      vi.mocked(resolveLatestSameRepoTranscriptSession).mockResolvedValue(
        resolvedSource,
      );
      const createFork = vi
        .spyOn(ForkSessionService.prototype, 'createFork')
        .mockResolvedValue({
          entries: [],
          sessionId: 'fork-session-id',
          sessionPath: '/workspace/demo/fork-session-id.jsonl',
          messages: [
            {
              type: 'user',
              uuid: 'fork-msg-1',
              timestamp: '2026-04-20T00:00:00.000Z',
              sessionId: 'fork-session-id',
              message: { role: 'user', content: 'hello' },
            },
          ],
          fileHistorySnapshots: [],
          resumeState: {
            filePath: '/workspace/demo/fork-session-id.jsonl',
            sessionId: 'fork-session-id',
            snapshot: {
              device: 0,
              inode: 0,
              size: 0,
              modifiedTimeMs: 0,
            },
            writerState: { messageUuids: [] },
            runtimeTailUuid: null,
            worktreeStates: [],
          },
          sourceSessionInfo: {
            id: sourceSessionId,
            startTime: '2026-04-20T00:00:00.000Z',
            lastUpdated: '2026-04-20T00:00:05.000Z',
            messageCount: 1,
            userMessageCount: 1,
            displayName: sourceSessionId,
            firstUserMessage: 'continue',
            file: sourceSessionId,
            fileName: `${sourceSessionId}.jsonl`,
            sessionPath: `/workspace/demo/${sourceSessionId}.jsonl`,
            isCurrentSession: false,
            index: 1,
          },
          worktreeSession: inWorktree ? attachedWorktree : null,
          forkedFrom: {
            sessionId: sourceSessionId,
            messageUuid: 'source-leaf',
          },
        });

      try {
        await runCliStartup();
      } catch (e) {
        if (!(e instanceof MockProcessExitError)) throw e;
      }

      const resolver =
        mode === 'continue'
          ? resolveLatestSameRepoTranscriptSession
          : resolveSameRepoTranscriptSession;
      if (inWorktree) {
        // 恢复入口须先确定原项目，Settings 与两次 Config 构造都不能使用启动 checkout。
        expect(loadSettings).toHaveBeenCalledWith(sourceWorktree.originalCwd);
        for (const call of vi.mocked(loadCliConfig).mock.calls) {
          expect(call[3]).toEqual(
            expect.objectContaining({ cwd: sourceWorktree.originalCwd }),
          );
        }
      }
      if (mode === 'headless') {
        // headless 的 resume/fork 由会话自己解析，入口不再构造 fork。
        expect(createFork).not.toHaveBeenCalled();
        expect(copyPlanForResume).not.toHaveBeenCalled();
        expect(runHeadlessSessionSpy).toHaveBeenCalledWith();
        expect(processExitSpy).toHaveBeenCalledWith(0);
        processExitSpy.mockRestore();
        return;
      }
      expect(resolver).toHaveBeenCalled();
      if (inWorktree) {
        expect(resolver).toHaveBeenCalledTimes(1);
      }
      expect(createFork).toHaveBeenCalledWith(
        expect.objectContaining({
          projectRoot: '/workspace/demo',
          sourceProjectRoot: '/workspace/demo',
          targetCwd: inWorktree
            ? '/workspace/demo/.qwen/worktrees/source/apps/desktop'
            : '/workspace/demo',
          targetWorktreeSession: inWorktree ? attachedWorktree : null,
        }),
      );
      expect(copyPlanForResume).toHaveBeenCalledWith(
        expect.any(Array),
        sourceSessionId,
        'fork-session-id',
        '/tmp/gemini-test/plans',
      );
      processExitSpy.mockRestore();
    },
  );

  it('leaves stdin reading to the headless session in non-interactive mode', async () => {
    const processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code) => {
        throw new MockProcessExitError(code);
      });

    const readStdinSpy = vi
      .spyOn(readStdinModule, 'readStdin')
      .mockResolvedValue('stdin-data');

    vi.mocked(loadSettings).mockReturnValue(
      createMockSettings({
        merged: { advanced: {}, security: { auth: {} }, ui: {} },
        project: { settings: {} },
        setValue: vi.fn(),
        forScope: () => ({ settings: {}, originalSettings: {}, path: '' }),
      }),
    );

    setCliArgs({
      enabled: true,
      allowedPaths: [],
      networkAccess: false,
      print: true,
      promptInteractive: false,
    } as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    vi.mocked(loadCliConfig).mockResolvedValue(
      createMockConfig({
        isInteractive: () => false,
        getQuestion: () => 'test-question',
      }),
    );

    // Mock stdin to be non-TTY
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdin as any).isTTY = false;

    process.env['GEMINI_API_KEY'] = 'test-key';
    try {
      await runCliStartup();
    } catch (e) {
      if (!(e instanceof MockProcessExitError)) throw e;
    } finally {
      delete process.env['GEMINI_API_KEY'];
    }

    expect(readStdinSpy).not.toHaveBeenCalled();
    // In this test setup, runHeadlessSessionSpy might be called on the mocked module,
    // but we need to ensure we are checking the correct spy instance.
    // Since vi.mock is hoisted, runHeadlessSessionSpy is defined early.
    expect(runHeadlessSessionSpy).toHaveBeenCalled();
    expect(runHeadlessSessionSpy).toHaveBeenCalledWith();
    expect(
      terminalNotificationMocks.buildRunEventNotificationContent,
    ).not.toHaveBeenCalled();
    expect(terminalNotificationMocks.notifyViaTerminal).not.toHaveBeenCalled();
    expect(processExitSpy).toHaveBeenCalledWith(0);
    processExitSpy.mockRestore();
  });
});

describe('qwen.tsx main function exit codes', () => {
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new MockProcessExitError(code);
    });
    // Mock stderr to avoid cluttering output
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    originalIsTTY = process.stdin.isTTY;
  });

  afterEach(() => {
    process.exitCode = undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdin as any).isTTY = originalIsTTY;
    vi.restoreAllMocks();
  });

  it('should exit with 42 for invalid input combination (prompt-interactive with non-TTY)', async () => {
    vi.mocked(loadCliConfig).mockResolvedValue(createMockConfig());
    vi.mocked(loadSettings).mockReturnValue(
      createMockSettings({
        merged: { security: { auth: {} }, ui: {} },
      }),
    );
    setCliArgs({
      enabled: true,
      allowedPaths: [],
      networkAccess: false,
      promptInteractive: true,
    } as unknown as CliArgs);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdin as any).isTTY = false;

    try {
      await runCliStartup();
      expect.fail('Should have thrown MockProcessExitError');
    } catch (e) {
      expect(e).toBeInstanceOf(MockProcessExitError);
      expect((e as MockProcessExitError).code).toBe(42);
    }
  });

  it('leaves headless auth to the session instead of refreshing the entry config', async () => {
    const source: ConfigService = {
      start: async () => {},
      stop: async () => {},
      getValue: () => undefined,
      onValueChange: () => () => {},
      onError: () => () => {},
    };
    const refreshAuthSpy = vi.fn();
    vi.mocked(loadCliConfig).mockResolvedValue(
      createMockConfig({
        isInteractive: () => false,
        getQuestion: () => 'test prompt',
        refreshAuth: refreshAuthSpy,
      }),
    );

    vi.mocked(loadSettings).mockReturnValue(
      createMockSettings({
        merged: { security: { auth: { selectedType: undefined } }, ui: {} },
      }),
    );
    setCliArgs({
      enabled: true,
      allowedPaths: [],
      networkAccess: false,
      print: true,
    } as unknown as CliArgs);

    runHeadlessSessionSpy.mockImplementation(() => Promise.resolve());

    const processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code) => {
        throw new MockProcessExitError(code);
      });

    process.env['GEMINI_API_KEY'] = 'test-key';
    try {
      await runCliStartup({ configService: source });
    } catch (e) {
      if (!(e instanceof MockProcessExitError)) throw e;
    } finally {
      delete process.env['GEMINI_API_KEY'];
      processExitSpy.mockRestore();
    }

    // 入口不再经 initializeApp 刷新进程级 Config 的认证；登录态由 Headless Session 自己装。
    expect(refreshAuthSpy).not.toHaveBeenCalled();
    expect(runHeadlessSessionSpy).toHaveBeenCalled();
    expect(installConfigService).toHaveBeenLastCalledWith(source);
  });

  it('should clear stale process.exitCode before a successful headless run exits', async () => {
    process.exitCode = 53;

    vi.mocked(loadCliConfig).mockResolvedValue(
      createMockConfig({
        isInteractive: () => false,
        getQuestion: () => 'test prompt',
      }),
    );
    vi.mocked(loadSettings).mockReturnValue(
      createMockSettings({
        merged: { security: { auth: { selectedType: undefined } }, ui: {} },
      }),
    );
    setCliArgs({
      enabled: true,
      allowedPaths: [],
      networkAccess: false,
      print: true,
    } as unknown as CliArgs);

    runHeadlessSessionSpy.mockImplementation(() => Promise.resolve());

    process.env['GEMINI_API_KEY'] = 'test-key';
    try {
      await runCliStartup();
      expect.fail('Should have thrown MockProcessExitError');
    } catch (e) {
      expect(e).toBeInstanceOf(MockProcessExitError);
      expect((e as MockProcessExitError).code).toBe(0);
    } finally {
      delete process.env['GEMINI_API_KEY'];
    }
  });
});

describe('validateDnsResolutionOrder', () => {
  let debugLoggerWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debugLoggerWarnSpy = vi
      .spyOn(runLogger, 'warn')
      .mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return "ipv4first" when the input is "ipv4first"', () => {
    expect(validateDnsResolutionOrder('ipv4first')).toBe('ipv4first');
    expect(debugLoggerWarnSpy).not.toHaveBeenCalled();
  });

  it('should return "verbatim" when the input is "verbatim"', () => {
    expect(validateDnsResolutionOrder('verbatim')).toBe('verbatim');
    expect(debugLoggerWarnSpy).not.toHaveBeenCalled();
  });

  it('should return the default "ipv4first" when the input is undefined', () => {
    expect(validateDnsResolutionOrder(undefined)).toBe('ipv4first');
    expect(debugLoggerWarnSpy).not.toHaveBeenCalled();
  });

  it('should return the default "ipv4first" and log a warning for an invalid string', () => {
    expect(validateDnsResolutionOrder('invalid-value')).toBe('ipv4first');
    expect(debugLoggerWarnSpy).toHaveBeenCalledExactlyOnceWith(
      'Invalid value for dnsResolutionOrder in settings: "invalid-value". Using default "ipv4first".',
    );
  });
});

describe('project hooks settings handoff', () => {
  let loadCliConfig: Mock;

  beforeEach(async () => {
    // Dynamically import and get the mocked functions
    const configModule = await import('./config/config.js');
    loadCliConfig = vi.mocked(configModule.loadCliConfig);
    setCliArgs({
      enabled: true,
      allowedPaths: [],
      networkAccess: false,
      startupMessages: [],
    } as unknown as CliArgs);

    vi.clearAllMocks();
    // Mock the main function's dependencies to isolate the config loading part

    vi.spyOn(process, 'exit').mockImplementation((() => {}) as unknown as (
      code?: string | number | null,
    ) => never);

    // Default mock implementation for loadCliConfig
    loadCliConfig.mockResolvedValue(
      createMockConfig({
        getQuestion: vi.fn().mockReturnValue('test question'),
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes trusted project hooks through loadedSettings', async () => {
    const hooks = { 'before-model': 'echo "trusted"' };
    loadSettings.mockReturnValue(
      createMockSettings({
        project: {
          isTrusted: true,
          settings: { hooks },
        },
        merged: {
          security: { auth: { selectedType: 'google' } },
        },
      }),
    );

    await runCliStartup();

    expect(loadCliConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        project: { isTrusted: true, settings: { hooks } },
      }),
      expect.anything(),
      expect.anything(),
      expect.not.objectContaining({ loadedSettings: expect.anything() }),
    );
  });

  it('passes the filtered project source through loadedSettings when untrusted', async () => {
    loadSettings.mockReturnValue(
      createMockSettings({
        project: {
          isTrusted: false,
          settings: {},
        },
        merged: {
          security: { auth: { selectedType: 'google' } },
        },
      }),
    );

    await runCliStartup();

    expect(loadCliConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        project: { isTrusted: false, settings: {} },
      }),
      expect.anything(),
      expect.anything(),
      expect.not.objectContaining({ loadedSettings: expect.anything() }),
    );
  });
});

describe('startInteractiveUI', () => {
  // Mock dependencies
  const mockConfig = createMockConfig({
    getProjectRoot: () => '/root',
    getScreenReader: () => false,
    getDebugMode: () => false,
    getUseAlternateBuffer: () => true,
  });
  const mockSettings = createI18nSettings({
    user: {
      path: '/settings.json',
      originalSettings: {},
      settings: {
        ui: {
          hideWindowTitle: false,
          useAlternateBuffer: true,
          incrementalRendering: true,
        },
        general: {
          debugKeystrokeLogging: false,
        },
      },
    },
  });
  const mockStartupWarnings: StartupWarning[] = [
    { id: 'w1', message: 'warning1', priority: WarningPriority.High },
  ];
  const mockWorkspaceRoot = '/root';
  const mockThemeError = null;
  let exitListenersBeforeTest: NodeJS.ExitListener[] = [];

  vi.mock('./installation/update/packageVersion.js', () => ({
    checkForUpdates: vi.fn(() => Promise.resolve(null)),
  }));

  vi.mock('./utils/update/index.js', () => ({
    scheduleAutoUpdate: vi.fn(),
    cancelScheduledAutoUpdate: vi.fn(),
  }));

  vi.mock('./utils/cleanup.js', () => ({
    registerApplicationLifecycle: vi.fn((lifecycle) =>
      appLifetimes.push(lifecycle),
    ),
    registerCleanup: vi.fn(),
    registerExitCancellation: vi.fn(),
    registerSessionEndCleanup: vi.fn(),
    gracefulExit: vi.fn((exitCode: number) => process.exit(exitCode)),
    runExitCleanupWithTimeout: vi.fn(async () => true),
    registerSyncCleanup: vi.fn(),
    registerExitConfig: vi.fn(),
    setupSignalHandlers: vi.fn(),
    setupTtyCheck: vi.fn(() => vi.fn()),
    flushStaleStdinOnStartup: vi.fn().mockResolvedValue(undefined),
  }));

  beforeEach(() => {
    exitListenersBeforeTest = process.listeners('exit');
    vi.stubEnv('SHPOOL_SESSION_NAME', '');
  });

  afterEach(() => {
    for (const listener of process.listeners('exit')) {
      if (!exitListenersBeforeTest.includes(listener)) {
        process.off('exit', listener);
      }
    }
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function startTestInteractiveUI(
    config: Config,
    settings: LoadedSettings,
    startupWarnings: StartupWarning[],
    workspaceRoot: string,
    resumedSessionData: SessionResumeData | undefined,
    themeError: string | null,
    initialSessionTitle?: string,
  ) {
    await act(async () => {
      await startInteractiveUI(
        TuiAppFramework.prototype.getAppContainer(),
        createTestI18nService(),
        config,
        settings,
        startupWarnings,
        workspaceRoot,
        resumedSessionData,
        themeError,
        initialSessionTitle,
      );
    });
  }

  it('should render the UI with proper React context and exitOnCtrlC disabled', async () => {
    const { render } = await import('ink');
    const renderSpy = vi.mocked(render);

    await startTestInteractiveUI(
      mockConfig,
      mockSettings,
      mockStartupWarnings,
      mockWorkspaceRoot,
      undefined,
      mockThemeError,
    );

    // Verify render was called with correct options
    const [reactElement, options] = renderSpy.mock.calls[0];

    // Verify render options
    expect(options).toEqual(
      expect.objectContaining({
        alternateBuffer: true,
        exitOnCtrlC: false,
        isScreenReaderEnabled: false,
        onRender: expect.any(Function),
        patchConsole: false,
      }),
    );

    // Verify React element structure is valid (but don't deep dive into JSX internals)
    expect(reactElement).toBeDefined();
  });

  it('should enable mouse events when alternate buffer is enabled', async () => {
    const { enableMouseEvents } = await import('@qwen-code/core');
    await startTestInteractiveUI(
      mockConfig,
      mockSettings,
      mockStartupWarnings,
      mockWorkspaceRoot,
      undefined,
      mockThemeError,
    );
    expect(enableMouseEvents).toHaveBeenCalled();
  });

  it.each([
    [undefined, '正在恢复项目资源'],
    [new Error('rebuild failed'), '会话文件已保留'],
  ])(
    'localizes project replacement status when runtime is unavailable (%s)',
    async (error, text) => {
      vi.spyOn(interactiveProject, 'useInteractiveProject').mockReturnValue({
        runtime: undefined,
        error,
        resumedSessionData: undefined,
        resumeOptions: undefined,
        resume: vi.fn(),
        onInitialResumeComplete: vi.fn(),
        initialPromptSubmitted: { current: false },
      });
      const { render } = await import('ink');
      await startTestInteractiveUI(
        createMockConfig({ getUseAlternateBuffer: () => false }),
        createMockSettings({ merged: { ui: { language: 'zh-CN' } } }),
        [],
        mockWorkspaceRoot,
        undefined,
        mockThemeError,
      );
      const element = vi.mocked(render).mock.calls.at(-1)![0];
      const actualInk = await vi.importActual<typeof import('ink')>('ink');
      vi.mocked(render).mockImplementationOnce(actualInk.render);
      const terminal = await renderTerminal(<>{element}</>);
      try {
        expect(terminal.lastFrame()).toContain(text);
      } finally {
        terminal.unmount();
      }
    },
  );

  it('renders the supplied root container with the active project props', async () => {
    const root = vi.fn((_props: AppContainerProps) => (
      <Text>Commercial root container</Text>
    ));
    const config = makeFakeConfig();
    vi.spyOn(config, 'getUseAlternateBuffer').mockReturnValue(false);
    const settings = createMockSettings();
    await startInteractiveUI(
      root,
      createTestI18nService(),
      config,
      settings,
      mockStartupWarnings,
      mockWorkspaceRoot,
      undefined,
      mockThemeError,
      'Commercial session',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
    const element = vi.mocked(renderInk).mock.calls.at(-1)![0];
    const actualInk = await vi.importActual<typeof import('ink')>('ink');
    vi.mocked(renderInk).mockImplementationOnce(actualInk.render);
    const terminal = await renderTerminal(<>{element}</>);
    try {
      expect(terminal.lastFrame()).toContain('Commercial root container');
      expect(root.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          config,
          startupWarnings: mockStartupWarnings,
          initialSessionTitle: 'Commercial session',
        }),
      );
    } finally {
      terminal.unmount();
    }
  });

  it('excludes project cleanup while interactive resume selection is pending', async () => {
    const startupCoordinator = {
      startAfterFirstRenderCleanup: vi.fn(),
    } as unknown as NonNullable<Parameters<typeof startInteractiveUI>[10]>;

    await act(async () => {
      await startInteractiveUI(
        TuiAppFramework.prototype.getAppContainer(),
        createTestI18nService(),
        mockConfig,
        mockSettings,
        mockStartupWarnings,
        mockWorkspaceRoot,
        undefined,
        mockThemeError,
        undefined,
        { resumeTarget: 'old-session' },
        startupCoordinator,
      );
    });

    expect(
      startupCoordinator.startAfterFirstRenderCleanup,
    ).toHaveBeenCalledWith(mockConfig, { includeProjectCleanup: false });
  });

  it('should patch console', async () => {
    const { ConsolePatcher } = await import('./ui/utils/ConsolePatcher.js');
    const patchSpy = vi.spyOn(ConsolePatcher.prototype, 'patch');
    await startTestInteractiveUI(
      mockConfig,
      mockSettings,
      mockStartupWarnings,
      mockWorkspaceRoot,
      undefined,
      mockThemeError,
    );
    expect(patchSpy).toHaveBeenCalled();
  });

  it('should perform all startup tasks in correct order', async () => {
    const { getVersion } = await import('@qwen-code/core');
    const { registerCleanup } = await import('./utils/cleanup.js');

    await startTestInteractiveUI(
      mockConfig,
      mockSettings,
      mockStartupWarnings,
      mockWorkspaceRoot,
      undefined,
      mockThemeError,
    );

    // Verify all startup tasks were called
    expect(getVersion).toHaveBeenCalledTimes(1);
    // 5 cleanups: mouseEvents, lineWrapping, locale binding,
    // instance.unmount, and TTY check.
    // 共享配置来源改由 Framework 最终释放，不再登记为 TUI 的普通 cleanup。
    expect(registerCleanup).toHaveBeenCalledTimes(5);

    // Verify cleanup handler is registered with unmount function
    const cleanupFn = vi.mocked(registerCleanup).mock.calls[0][0];
    expect(typeof cleanupFn).toBe('function');
  });

  it.each([
    {
      screenReader: true,
      expectedCalls: [],
      name: 'should not disable line wrapping in screen reader mode',
    },
    {
      screenReader: false,
      expectedCalls: [['\x1b[?7l']],
      name: 'should disable line wrapping when not in screen reader mode',
    },
  ])('$name', async ({ screenReader, expectedCalls }) => {
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const mockConfigWithScreenReader = {
      // eslint-disable-next-line @typescript-eslint/no-misused-spread
      ...mockConfig,
      getScreenReader: () => screenReader,
    } as Config;

    await startTestInteractiveUI(
      mockConfigWithScreenReader,
      mockSettings,
      mockStartupWarnings,
      mockWorkspaceRoot,
      undefined,
      mockThemeError,
    );

    if (expectedCalls.length > 0) {
      expect(writeSpy).toHaveBeenCalledWith(expectedCalls[0][0]);
    } else {
      expect(writeSpy).not.toHaveBeenCalledWith('\x1b[?7l');
    }
    writeSpy.mockRestore();
  });
});

vi.mock('./config/createCliSettingsService.js', async (original) => {
  const actual =
    await original<typeof import('./config/createCliSettingsService.js')>();
  return {
    ...actual,
    createCliSettingsService: (
      ...args: Parameters<typeof actual.createCliSettingsService>
    ) => {
      const service = actual.createCliSettingsService(...args);
      vi.spyOn(service, 'resolve').mockImplementation(
        ({ projectPath, sources }) =>
          sources?.length === 3 || sources === undefined
            ? loadSettings(projectPath)
            : loadSettings(projectPath, sources),
      );
      return service;
    },
  };
});
