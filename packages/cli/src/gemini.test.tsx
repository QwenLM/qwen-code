/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createNonInteractivePromptId,
  main,
  registerLspHotReload,
  setupUnhandledRejectionHandler,
  validateDnsResolutionOrder,
} from './gemini.js';
import { startInteractiveUI } from './ui/startInteractiveUI.js';
import type { CliArgs } from './config/config.js';
import { type LoadedSettings } from './config/settings.js';
import { appEvents, AppEvent } from './utils/events.js';
import type { Config } from '@qwen-code/qwen-code-core';
import { ApprovalMode, OutputFormat } from '@qwen-code/qwen-code-core';

const mockWriteStderrLine = vi.hoisted(() => vi.fn());
const mockHandleListExtensions = vi.hoisted(() => vi.fn());
const mockStartEarlyStartupPrefetches = vi.hoisted(() => vi.fn());
const mockStartPostRenderPrefetches = vi.hoisted(() => vi.fn());
const mockRunAcpAgent = vi.hoisted(() => vi.fn());
const mockUpdateBeforeRelaunch = vi.hoisted(() => vi.fn());
const mockGetInstallationInfo = vi.hoisted(() => vi.fn());
const lspConfigWatcherMock = vi.hoisted(() => ({
  instances: [] as Array<{
    listener?: (event: unknown) => void | Promise<void>;
    startWatching: ReturnType<typeof vi.fn>;
    stopWatching: ReturnType<typeof vi.fn>;
  }>,
}));

describe('gemini import boundary', () => {
  it('does not statically import ACP or noninteractive auth branches', () => {
    const source = readFileSync('src/gemini.tsx', 'utf8');

    expect(source).not.toContain(
      "import { runAcpAgent } from './acp-integration/acpAgent.js'",
    );
    expect(source).not.toContain(
      "import { validateNonInteractiveAuth } from './validateNonInterActiveAuth.js'",
    );
    expect(source).not.toContain(
      "import { initializeApp } from './core/initializer.js'",
    );
    expect(source).toMatch(
      /await import\(\s*['"]\.\/acp-integration\/acpAgent\.js['"]\s*\)/,
    );
    expect(source).toMatch(
      /await import\(\s*['"]\.\/validateNonInterActiveAuth\.js['"]\s*\)/,
    );
    expect(source).toMatch(
      /await import\(\s*['"]\.\/core\/initializer\.js['"]\s*\)/,
    );
  });
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
  return {
    ...actual,
    loadSettings: vi.fn(),
    createMinimalSettings: vi.fn(),
  };
});

vi.mock('./config/config.js', () => ({
  loadCliConfig: vi.fn().mockResolvedValue({
    getSandbox: vi.fn(() => false),
    getQuestion: vi.fn(() => ''),
    isInteractive: () => false,
    isLspEnabled: () => false,
    getLspClient: () => undefined,
    getWarnings: vi.fn(() => []),
    isSafeMode: vi.fn(() => false),
    getModelsConfig: vi.fn(() => ({ getCurrentAuthType: () => null })),
  } as unknown as Config),
  parseArguments: vi.fn().mockResolvedValue({}),
  isDebugMode: vi.fn(() => false),
  buildDisabledSkillNamesProvider: vi.fn(() => () => new Set<string>()),
}));

vi.mock('read-package-up', () => ({
  readPackageUp: vi.fn().mockResolvedValue({
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

vi.mock('./utils/sandbox.js', () => ({
  sandbox_command: vi.fn(() => ''), // Default to no sandbox command
  start_sandbox: vi.fn(() => Promise.resolve()), // Mock as an async function that resolves
}));

vi.mock('./utils/stdioHelpers.js', () => ({
  writeStderrLine: mockWriteStderrLine,
  writeStdoutLine: vi.fn(),
  clearScreen: vi.fn(),
}));

vi.mock('./utils/relaunch.js', () => ({
  relaunchAppInChildProcess: vi.fn(),
  relaunchOnExitCode: vi.fn((fn: () => Promise<number>) => fn()),
}));

vi.mock('./config/sandboxConfig.js', () => ({
  loadSandboxConfig: vi.fn(),
}));

vi.mock('./core/initializer.js', () => ({
  initializeApp: vi.fn().mockResolvedValue({
    authError: null,
    themeError: null,
    shouldOpenAuthDialog: false,
    geminiMdFileCount: 0,
  }),
}));

vi.mock('./startup/startup-prefetch.js', () => ({
  startEarlyStartupPrefetches: (...args: unknown[]) =>
    mockStartEarlyStartupPrefetches(...args),
  startPostRenderPrefetches: (...args: unknown[]) =>
    mockStartPostRenderPrefetches(...args),
}));

vi.mock('./utils/update-relaunch.js', () => ({
  updateBeforeRelaunch: (...args: unknown[]) =>
    mockUpdateBeforeRelaunch(...args),
}));

vi.mock('./utils/installationInfo.js', () => ({
  getInstallationInfo: (...args: unknown[]) => mockGetInstallationInfo(...args),
}));

vi.mock('./acp-integration/acpAgent.js', () => ({
  runAcpAgent: (...args: unknown[]) => mockRunAcpAgent(...args),
}));

vi.mock('./commands/extensions/list.js', () => ({
  handleList: mockHandleListExtensions,
}));

vi.mock('./ui/AppContainer.js', () => ({
  AppContainer: () => null,
}));

// Stub the settings watcher: main() constructs one and calls startWatching()
// in non-bare mode. The real implementation reads settings.user/.workspace
// paths and arms chokidar file watchers, neither of which these main()-flow
// tests supply or want as a side effect.
vi.mock('./config/settingsWatcher.js', () => ({
  SettingsWatcher: class {
    startWatching() {}
    stopWatching() {}
    addChangeListener() {
      return () => {};
    }
  },
}));

vi.mock('./config/lsp-config-watcher.js', () => ({
  LspConfigWatcher: class {
    listener?: (event: unknown) => void | Promise<void>;
    startWatching = vi.fn(
      (listener: (event: unknown) => void | Promise<void>) => {
        this.listener = listener;
      },
    );
    stopWatching = vi.fn();

    constructor() {
      lspConfigWatcherMock.instances.push(this);
    }
  },
}));

vi.mock('./config/extension-file-watcher.js', () => ({
  ExtensionFileWatcher: class {
    startWatching() {}
    restartWatching() {}
    stopWatching() {}
  },
}));

function withLspDisabledConfig<T extends object>(
  config: T,
): T & {
  isLspEnabled: () => boolean;
  getLspClient: () => undefined;
} {
  return {
    isLspEnabled: () => false,
    getLspClient: () => undefined,
    ...config,
  };
}

describe('gemini.tsx main function', () => {
  let originalEnvGeminiSandbox: string | undefined;
  let originalEnvSandbox: string | undefined;
  let originalEnvQwenCodeSimple: string | undefined;
  let initialUnhandledRejectionListeners: NodeJS.UnhandledRejectionListener[] =
    [];

  beforeEach(() => {
    lspConfigWatcherMock.instances.length = 0;
    mockUpdateBeforeRelaunch.mockResolvedValue(true);
    mockGetInstallationInfo.mockReturnValue({
      updateCommand: 'npm install -g @qwen-code/qwen-code@latest',
    });
    // Store and clear sandbox-related env variables to ensure a consistent test environment
    originalEnvGeminiSandbox = process.env['QWEN_SANDBOX'];
    originalEnvSandbox = process.env['SANDBOX'];
    originalEnvQwenCodeSimple = process.env['QWEN_CODE_SIMPLE'];
    delete process.env['QWEN_SANDBOX'];
    delete process.env['SANDBOX'];
    delete process.env['QWEN_CODE_SIMPLE'];

    initialUnhandledRejectionListeners =
      process.listeners('unhandledRejection');
  });

  afterEach(() => {
    // Restore original env variables
    if (originalEnvGeminiSandbox !== undefined) {
      process.env['QWEN_SANDBOX'] = originalEnvGeminiSandbox;
    } else {
      delete process.env['QWEN_SANDBOX'];
    }
    if (originalEnvSandbox !== undefined) {
      process.env['SANDBOX'] = originalEnvSandbox;
    } else {
      delete process.env['SANDBOX'];
    }
    if (originalEnvQwenCodeSimple !== undefined) {
      process.env['QWEN_CODE_SIMPLE'] = originalEnvQwenCodeSimple;
    } else {
      delete process.env['QWEN_CODE_SIMPLE'];
    }

    const currentListeners = process.listeners('unhandledRejection');
    const addedListener = currentListeners.find(
      (listener) => !initialUnhandledRejectionListeners.includes(listener),
    );

    if (addedListener) {
      process.removeListener('unhandledRejection', addedListener);
    }
    vi.restoreAllMocks();
  });

  it('verifies that we dont load the config before relaunchAppInChildProcess', async () => {
    const processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code) => {
        throw new MockProcessExitError(code);
      });
    const { relaunchAppInChildProcess } = await import('./utils/relaunch.js');
    const { loadCliConfig } = await import('./config/config.js');
    const { loadSettings } = await import('./config/settings.js');
    const { loadSandboxConfig } = await import('./config/sandboxConfig.js');
    vi.mocked(loadSandboxConfig).mockResolvedValue(undefined);

    const callOrder: string[] = [];
    vi.mocked(relaunchAppInChildProcess).mockImplementation(async () => {
      callOrder.push('relaunch');
    });
    vi.mocked(loadCliConfig).mockImplementation(async () => {
      callOrder.push('loadCliConfig');
      return {
        isInteractive: () => false,
        getQuestion: () => '',
        getSandbox: () => false,
        getApprovalMode: () => ApprovalMode.DEFAULT,
        getDebugMode: () => false,
        getListExtensions: () => false,
        getMcpServers: () => ({}),
        getTopTierMcpServers: () => undefined,
        initialize: vi.fn(),
        waitForMcpReady: vi.fn().mockResolvedValue(undefined),
        getIdeMode: () => false,
        getExperimentalZedIntegration: () => false,
        getScreenReader: () => false,
        getGeminiMdFileCount: () => 0,
        getProjectRoot: () => '/',
        getOutputFormat: () => OutputFormat.TEXT,
        getWarnings: () => [],
        isSafeMode: () => false,
        getModelsConfig: () => ({ getCurrentAuthType: () => null }),
        getSessionId: () => 'test-session-id',
      } as unknown as Config;
    });
    vi.mocked(loadSettings).mockReturnValue({
      errors: [],
      merged: {
        advanced: { autoConfigureMemory: true },
        security: { auth: {} },
        ui: {},
      },
      setValue: vi.fn(),
      forScope: () => ({ settings: {}, originalSettings: {}, path: '' }),
      migrationWarnings: [],
      getUserHooks: () => undefined,
      getProjectHooks: () => undefined,
    } as never);
    try {
      await main();
    } catch (e) {
      // Mocked process exit throws an error.
      if (!(e instanceof MockProcessExitError)) throw e;
    }

    // It is critical that we call relaunch before loadCliConfig to avoid
    // loading config in the outer process when we are going to relaunch.
    // By ensuring we don't load the config we also ensure we don't trigger any
    // operations that might require loading the config such as such as
    // initializing mcp servers.
    // For the sandbox case we still have to load a partial cli config.
    // we can authorize outside the sandbox.
    expect(callOrder).toEqual(['relaunch', 'loadCliConfig']);
    expect(relaunchAppInChildProcess).toHaveBeenCalledWith(
      expect.any(Array),
      [],
      expect.objectContaining({ onUpdateRelaunch: expect.any(Function) }),
    );
    processExitSpy.mockRestore();
  });

  it('handles --list-extensions before sandbox and app config startup', async () => {
    vi.clearAllMocks();
    const processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code) => {
        throw new MockProcessExitError(code);
      });

    const { loadCliConfig, parseArguments } = await import(
      './config/config.js'
    );
    const { loadSettings } = await import('./config/settings.js');
    const { loadSandboxConfig } = await import('./config/sandboxConfig.js');

    vi.mocked(parseArguments).mockResolvedValue({
      listExtensions: true,
    } as unknown as CliArgs);
    vi.mocked(loadSettings).mockReturnValue({
      errors: [],
      merged: {
        advanced: {},
        security: { auth: {} },
        ui: {},
      },
      setValue: vi.fn(),
      forScope: () => ({ settings: {}, originalSettings: {}, path: '' }),
      migrationWarnings: [],
      getUserHooks: () => undefined,
      getProjectHooks: () => undefined,
    } as never);
    mockHandleListExtensions.mockResolvedValue(undefined);

    try {
      await main();
    } catch (e) {
      if (!(e instanceof MockProcessExitError)) throw e;
    }

    expect(mockHandleListExtensions).toHaveBeenCalledOnce();
    expect(processExitSpy).toHaveBeenCalledWith(0);
    expect(loadSandboxConfig).not.toHaveBeenCalled();
    expect(loadCliConfig).not.toHaveBeenCalled();

    processExitSpy.mockRestore();
  });

  it.each([
    ['before the ACP relaunch', { acp: true }, {}, undefined, '1'],
    [
      'in the relaunched ACP process',
      { acp: true },
      { QWEN_CODE_NO_RELAUNCH: 'true' },
      undefined,
      undefined,
    ],
    [
      'in the sandboxed ACP process',
      { acp: true },
      { SANDBOX: 'sandbox-exec' },
      undefined,
      undefined,
    ],
    [
      'outside managed ACP startup',
      {},
      { QWEN_CODE_NO_RELAUNCH: 'true' },
      '1',
      '1',
    ],
  ])(
    'manages Electron bootstrap env %s',
    async (_name, argv, extraEnv, expectedElectron, expectedMarker) => {
      vi.stubEnv('ELECTRON_RUN_AS_NODE', '1');
      vi.stubEnv('QWEN_CODE_SCRUB_ELECTRON_RUN_AS_NODE', '1');
      vi.stubEnv('QWEN_CODE_NO_RELAUNCH', '');
      for (const [key, value] of Object.entries(extraEnv)) {
        vi.stubEnv(key, value);
      }

      const { parseArguments } = await import('./config/config.js');
      const { loadSettings } = await import('./config/settings.js');
      vi.mocked(parseArguments).mockResolvedValue(argv as CliArgs);
      vi.mocked(loadSettings).mockImplementation(() => {
        expect(process.env['ELECTRON_RUN_AS_NODE']).toBe(expectedElectron);
        expect(process.env['QWEN_CODE_SCRUB_ELECTRON_RUN_AS_NODE']).toBe(
          expectedMarker,
        );
        throw new Error('stop after env check');
      });

      try {
        await expect(main()).rejects.toThrow('stop after env check');
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it('should skip full settings discovery in bare mode', async () => {
    const originalArgv = process.argv;
    process.argv = ['node', 'script.js', '--bare'];

    const { loadCliConfig, parseArguments } = await import(
      './config/config.js'
    );
    const { loadSettings, createMinimalSettings } = await import(
      './config/settings.js'
    );
    const { loadSandboxConfig } = await import('./config/sandboxConfig.js');
    const { relaunchAppInChildProcess } = await import('./utils/relaunch.js');
    const nonInteractiveModule = await import('./nonInteractiveCli.js');
    const processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code) => {
        throw new MockProcessExitError(code);
      });

    const minimalSettings = {
      errors: [],
      merged: {},
      setValue: vi.fn(),
      forScope: () => ({ settings: {}, originalSettings: {}, path: '' }),
      migrationWarnings: [],
      getUserHooks: () => undefined,
      getProjectHooks: () => undefined,
    };
    const configStub = {
      isInteractive: () => false,
      getQuestion: () => 'bare prompt',
      getSandbox: () => false,
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getDebugMode: () => false,
      getListExtensions: () => false,
      getMcpServers: () => ({}),
      getTopTierMcpServers: () => undefined,
      initialize: vi.fn().mockResolvedValue(undefined),
      waitForMcpReady: vi.fn().mockResolvedValue(undefined),
      getIdeMode: () => false,
      getExperimentalZedIntegration: () => false,
      getScreenReader: () => false,
      getGeminiMdFileCount: () => 0,
      getProjectRoot: () => '/',
      getOutputFormat: () => OutputFormat.TEXT,
      getWarnings: () => [],
      isSafeMode: () => false,
      getModelsConfig: () => ({ getCurrentAuthType: () => null }),
      getSessionId: () => 'test-session-id',
    } as unknown as Config;

    vi.mocked(parseArguments).mockResolvedValue({
      bare: true,
    } as unknown as CliArgs);
    vi.mocked(createMinimalSettings).mockReturnValue(minimalSettings as never);
    vi.mocked(loadSandboxConfig).mockResolvedValue(undefined);
    vi.mocked(relaunchAppInChildProcess).mockResolvedValue(undefined);
    vi.mocked(loadCliConfig).mockResolvedValue(configStub);
    vi.spyOn(nonInteractiveModule, 'runNonInteractive').mockResolvedValue(0);

    try {
      await main();
    } catch (error) {
      if (!(error instanceof MockProcessExitError)) {
        throw error;
      }
    } finally {
      process.argv = originalArgv;
      processExitSpy.mockRestore();
    }

    expect(createMinimalSettings).toHaveBeenCalledOnce();
    expect(loadSettings).not.toHaveBeenCalled();
    expect(loadCliConfig).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ bare: true }),
      process.cwd(),
      undefined,
      {
        userHooks: undefined,
        projectHooks: undefined,
      },
      expect.any(Function),
      undefined,
      // settingsWatcher: not started in bare mode
      undefined,
    );
  });

  describe('registerLspHotReload', () => {
    it('does not register a watcher when LSP is disabled', () => {
      const registerCleanup = vi.fn();

      registerLspHotReload(
        withLspDisabledConfig({
          getProjectRoot: () => '/workspace',
        }) as unknown as Config,
        registerCleanup,
      );

      expect(lspConfigWatcherMock.instances).toHaveLength(0);
      expect(registerCleanup).not.toHaveBeenCalled();
    });

    it('does not register a watcher when the client cannot reinitialize', () => {
      const registerCleanup = vi.fn();

      registerLspHotReload(
        {
          isLspEnabled: () => true,
          getLspClient: () => ({}),
          getProjectRoot: () => '/workspace',
        } as unknown as Config,
        registerCleanup,
      );

      expect(lspConfigWatcherMock.instances).toHaveLength(0);
      expect(registerCleanup).not.toHaveBeenCalled();
    });

    it('emits an LSP status update after successful reload', async () => {
      const registerCleanup = vi.fn();
      const reinitializeLsp = vi.fn(async () => ({
        reconcile: {
          added: ['clangd'],
          removed: [],
          restarted: [],
          unchanged: [],
          failed: [],
        },
        skipped: [],
      }));

      registerLspHotReload(
        {
          isLspEnabled: () => true,
          getLspClient: () => ({ reinitialize: vi.fn() }),
          getProjectRoot: () => '/workspace',
          reinitializeLsp,
        } as unknown as Config,
        registerCleanup,
      );

      await lspConfigWatcherMock.instances[0]?.listener?.({
        path: '/workspace/.lsp.json',
        changeType: 'modified',
      });

      expect(reinitializeLsp).toHaveBeenCalledOnce();
      expect(appEvents.emit).toHaveBeenCalledWith(AppEvent.LspStatusChanged);
    });

    it('emits an LSP status update when reload is skipped by the config', async () => {
      const reinitializeLsp = vi.fn(async () => undefined);

      registerLspHotReload(
        {
          isLspEnabled: () => true,
          getLspClient: () => ({ reinitialize: vi.fn() }),
          getProjectRoot: () => '/workspace',
          reinitializeLsp,
        } as unknown as Config,
        vi.fn(),
      );

      await lspConfigWatcherMock.instances[0]?.listener?.({
        path: '/workspace/.lsp.json',
        changeType: 'modified',
      });

      expect(reinitializeLsp).toHaveBeenCalledOnce();
      expect(appEvents.emit).not.toHaveBeenCalledWith(
        AppEvent.LogError,
        expect.any(String),
      );
      expect(appEvents.emit).toHaveBeenCalledWith(AppEvent.LspStatusChanged);
    });

    it('emits a user-visible error and rejects when reload fails', async () => {
      const reinitializeLsp = vi.fn(async () => {
        throw new Error('invalid lsp json');
      });

      registerLspHotReload(
        {
          isLspEnabled: () => true,
          getLspClient: () => ({ reinitialize: vi.fn() }),
          getProjectRoot: () => '/workspace',
          reinitializeLsp,
        } as unknown as Config,
        vi.fn(),
      );

      await expect(
        lspConfigWatcherMock.instances[0]?.listener?.({
          path: '/workspace/.lsp.json',
          changeType: 'modified',
        }),
      ).rejects.toThrow('invalid lsp json');

      expect(appEvents.emit).toHaveBeenCalledWith(
        AppEvent.LogError,
        'Failed to reload LSP server settings: invalid lsp json. Some LSP servers may have been partially updated. Run with --debug for details.',
      );
    });

    it('emits a user-visible error and rejects when reload has failed servers', async () => {
      const reinitializeLsp = vi.fn(async () => ({
        reconcile: {
          added: [],
          removed: [],
          restarted: [],
          unchanged: [],
          failed: ['clangd'],
        },
        skipped: [],
      }));

      registerLspHotReload(
        {
          isLspEnabled: () => true,
          getLspClient: () => ({ reinitialize: vi.fn() }),
          getProjectRoot: () => '/workspace',
          reinitializeLsp,
        } as unknown as Config,
        vi.fn(),
      );

      await expect(
        lspConfigWatcherMock.instances[0]?.listener?.({
          path: '/workspace/.lsp.json',
          changeType: 'modified',
        }),
      ).rejects.toThrow('LSP reload partially completed');

      expect(appEvents.emit).toHaveBeenCalledWith(
        AppEvent.LogError,
        'LSP reload partially completed: changed=<none>, failed=clangd. Run with --debug for details.',
      );
      expect(appEvents.emit).toHaveBeenCalledWith(AppEvent.LspStatusChanged);
    });

    it('surfaces invalid config without reinitializing LSP', async () => {
      const reinitializeLsp = vi.fn();

      registerLspHotReload(
        {
          isLspEnabled: () => true,
          getLspClient: () => ({ reinitialize: vi.fn() }),
          getProjectRoot: () => '/workspace',
          reinitializeLsp,
        } as unknown as Config,
        vi.fn(),
      );

      await lspConfigWatcherMock.instances[0]?.listener?.({
        path: '/workspace/.lsp.json',
        changeType: 'invalid',
        error:
          'Invalid JSON in .lsp.json; existing LSP runtime state is unchanged.',
      });

      expect(reinitializeLsp).not.toHaveBeenCalled();
      expect(appEvents.emit).toHaveBeenCalledWith(
        AppEvent.LogError,
        'Invalid JSON in .lsp.json; existing LSP runtime state is unchanged.',
      );
    });
  });

  it('writes non-interactive warnings discovered during config initialization', async () => {
    const originalNoRelaunch = process.env['QWEN_CODE_NO_RELAUNCH'];
    const originalIsTTY = Object.getOwnPropertyDescriptor(
      process.stdin,
      'isTTY',
    );
    process.env['QWEN_CODE_NO_RELAUNCH'] = 'true';
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });

    const processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code) => {
        throw new MockProcessExitError(code);
      });
    const { loadCliConfig, parseArguments } = await import(
      './config/config.js'
    );
    const { loadSettings } = await import('./config/settings.js');
    const cleanupModule = await import('./utils/cleanup.js');
    const validatorModule = await import('./validateNonInterActiveAuth.js');
    const nonInteractiveModule = await import('./nonInteractiveCli.js');
    const initializerModule = await import('./core/initializer.js');
    const startupWarningsModule = await import('./utils/startupWarnings.js');
    const userStartupWarningsModule = await import(
      './utils/userStartupWarnings.js'
    );

    mockWriteStderrLine.mockClear();
    vi.mocked(cleanupModule.runExitCleanup).mockResolvedValue(undefined);
    vi.spyOn(initializerModule, 'initializeApp').mockResolvedValue({
      authError: null,
      themeError: null,
      shouldOpenAuthDialog: false,
      geminiMdFileCount: 0,
    });
    vi.spyOn(startupWarningsModule, 'getStartupWarnings').mockResolvedValue([]);
    vi.spyOn(
      userStartupWarningsModule,
      'getUserStartupWarnings',
    ).mockResolvedValue([]);
    vi.spyOn(nonInteractiveModule, 'runNonInteractive').mockResolvedValue(0);

    let initialized = false;
    const configStub = {
      isInteractive: () => false,
      getQuestion: () => 'hello',
      getSandbox: () => false,
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getDebugMode: () => false,
      getListExtensions: () => false,
      getMcpServers: () => ({}),
      getTopTierMcpServers: () => undefined,
      initialize: vi.fn().mockImplementation(async () => {
        initialized = true;
      }),
      waitForMcpReady: vi.fn().mockResolvedValue(undefined),
      getFailedMcpServerNames: () => [],
      getIdeMode: () => false,
      getExperimentalZedIntegration: () => false,
      getScreenReader: () => false,
      getGeminiMdFileCount: () => 0,
      getProjectRoot: () => '/',
      getOutputFormat: () => OutputFormat.TEXT,
      getWarnings: () => (initialized ? ['late memory warning'] : []),
      isSafeMode: () => false,
      getModelsConfig: () => ({ getCurrentAuthType: () => null }),
      getContentGeneratorConfig: () => undefined,
      getUsageStatisticsEnabled: () => true,
      getSessionId: () => 'test-session-id',
      getProxy: () => undefined,
    } as unknown as Config;

    vi.mocked(parseArguments).mockResolvedValue({
      extensions: [],
    } as unknown as CliArgs);
    vi.mocked(loadSettings).mockReturnValue({
      errors: [],
      merged: {
        advanced: {},
        security: { auth: {} },
        ui: {},
      },
      setValue: vi.fn(),
      forScope: () => ({ settings: {}, originalSettings: {}, path: '' }),
      migrationWarnings: [],
      getUserHooks: () => undefined,
      getProjectHooks: () => undefined,
    } as never);
    vi.mocked(loadCliConfig).mockResolvedValue(configStub);
    vi.spyOn(validatorModule, 'validateNonInteractiveAuth').mockResolvedValue(
      configStub,
    );

    try {
      await main();
    } catch (error) {
      if (!(error instanceof MockProcessExitError)) {
        throw error;
      }
    } finally {
      processExitSpy.mockRestore();
      if (originalIsTTY) {
        Object.defineProperty(process.stdin, 'isTTY', originalIsTTY);
      } else {
        delete (process.stdin as { isTTY?: unknown }).isTTY;
      }
      if (originalNoRelaunch !== undefined) {
        process.env['QWEN_CODE_NO_RELAUNCH'] = originalNoRelaunch;
      } else {
        delete process.env['QWEN_CODE_NO_RELAUNCH'];
      }
    }

    expect(mockWriteStderrLine).toHaveBeenCalledWith('late memory warning');
    expect(initializerModule.initializeApp).toHaveBeenCalledWith(
      configStub,
      expect.any(Object),
      { deferIdeConnection: false },
    );
  });

  it('creates non-interactive prompt ids that preserve session correlation', () => {
    expect(createNonInteractivePromptId('test-session-id')).toBe(
      'test-session-id########0',
    );
  });

  const runSandboxRelaunch = async (
    argv: string[],
    sessionId = '123e4567-e89b-12d3-a456-426614174000',
    command: 'docker' | 'podman' | 'sandbox-exec' = 'sandbox-exec',
  ): Promise<string[]> => {
    const originalArgv = process.argv;
    process.argv = argv;
    const processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code) => {
        throw new MockProcessExitError(code);
      });

    const { loadCliConfig, parseArguments } = await import(
      './config/config.js'
    );
    const { loadSettings } = await import('./config/settings.js');
    const { loadSandboxConfig } = await import('./config/sandboxConfig.js');
    const { start_sandbox } = await import('./utils/sandbox.js');
    const { relaunchOnExitCode } = await import('./utils/relaunch.js');

    vi.mocked(start_sandbox).mockClear();
    vi.mocked(relaunchOnExitCode).mockClear();
    vi.mocked(parseArguments).mockResolvedValue({
      debug: true,
      prompt: 'hello',
      extensions: [],
    } as unknown as CliArgs);
    vi.mocked(loadSettings).mockReturnValue({
      errors: [],
      merged: {
        advanced: {},
        security: { auth: {} },
        ui: {},
      },
      setValue: vi.fn(),
      forScope: () => ({ settings: {}, originalSettings: {}, path: '' }),
      migrationWarnings: [],
      getUserHooks: () => undefined,
      getProjectHooks: () => undefined,
    } as never);
    vi.mocked(loadSandboxConfig).mockResolvedValue({
      command,
      image: 'ghcr.io/qwenlm/qwen-code:1.0.0',
    });
    vi.mocked(loadCliConfig).mockResolvedValue({
      getModelsConfig: () => ({ getCurrentAuthType: () => null }),
      getSessionId: () => sessionId,
    } as unknown as Config);

    try {
      await main();
    } catch (error) {
      if (!(error instanceof MockProcessExitError)) {
        throw error;
      }
    } finally {
      process.argv = originalArgv;
      processExitSpy.mockRestore();
    }

    expect(start_sandbox).toHaveBeenCalledOnce();
    expect(relaunchOnExitCode).toHaveBeenCalledWith(expect.any(Function), {
      onUpdateRelaunch: expect.any(Function),
    });
    return vi.mocked(start_sandbox).mock.calls[0]![3]!;
  };

  it('passes the outer session ID into the sandbox child process', async () => {
    const sessionId = '123e4567-e89b-12d3-a456-426614174000';
    const sandboxArgs = await runSandboxRelaunch(
      ['node', 'script.js', '--debug', '-p', 'hello'],
      sessionId,
    );

    const idx = sandboxArgs.indexOf('--sandbox-session-id');
    expect(idx).not.toBe(-1);
    expect(sandboxArgs[idx + 1]).toBe(sessionId);
    expect(sandboxArgs).not.toContain('--session-id');
  });

  it('starts a fresh CLI after the host update completes', async () => {
    await runSandboxRelaunch(['node', 'script.js', '--debug', '-p', 'hello']);
    const { relaunchOnExitCode } = await import('./utils/relaunch.js');
    const [, options] = vi.mocked(relaunchOnExitCode).mock.calls[0]!;

    await expect(options?.onUpdateRelaunch?.()).resolves.toBe(44);

    expect(mockUpdateBeforeRelaunch).toHaveBeenCalledTimes(1);
  });

  it('passes host update capability into a container sandbox', async () => {
    const originalCapability = process.env['QWEN_CODE_HOST_UPDATE_RELAUNCH'];

    try {
      await runSandboxRelaunch(
        ['node', 'script.js', '--debug', '-p', 'hello'],
        '',
        'docker',
      );

      expect(mockGetInstallationInfo).toHaveBeenCalledWith(
        expect.any(String),
        true,
      );
      expect(process.env['QWEN_CODE_HOST_UPDATE_RELAUNCH']).toBe('true');
    } finally {
      if (originalCapability === undefined) {
        delete process.env['QWEN_CODE_HOST_UPDATE_RELAUNCH'];
      } else {
        process.env['QWEN_CODE_HOST_UPDATE_RELAUNCH'] = originalCapability;
      }
    }
  });

  it('does not pass an empty session ID into the sandbox child process', async () => {
    const sandboxArgs = await runSandboxRelaunch(
      ['node', 'script.js', '--debug', '-p', 'hello'],
      '',
    );

    expect(sandboxArgs).not.toContain('--sandbox-session-id');
    expect(sandboxArgs).not.toContain('--session-id');
  });

  it.each([
    ['--continue', ['node', 'script.js', '--debug', '--continue']],
    ['-c', ['node', 'script.js', '--debug', '-c']],
    ['--resume', ['node', 'script.js', '--debug', '--resume', 'session-id']],
    ['-r', ['node', 'script.js', '--debug', '-r', 'session-id']],
    [
      '--session-id',
      [
        'node',
        'script.js',
        '--debug',
        '--session-id',
        '123e4567-e89b-12d3-a456-426614174999',
      ],
    ],
  ])(
    'does not inject sandbox session ID when argv contains %s',
    async (_flag, argv) => {
      const sandboxArgs = await runSandboxRelaunch(argv);

      expect(sandboxArgs).not.toContain('--sandbox-session-id');
    },
  );

  it('inserts the sandbox session ID before the argument separator', async () => {
    const sessionId = '123e4567-e89b-12d3-a456-426614174000';
    const sandboxArgs = await runSandboxRelaunch(
      ['node', 'script.js', '--debug', '--', '--not-a-cli-flag'],
      sessionId,
    );

    expect(sandboxArgs).toEqual([
      'node',
      'script.js',
      '--debug',
      '--sandbox-session-id',
      sessionId,
      '--',
      '--not-a-cli-flag',
    ]);
  });

  it('should log unhandled promise rejections and open debug console on first error', async () => {
    const processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code) => {
        throw new MockProcessExitError(code);
      });
    const appEventsMock = vi.mocked(appEvents);
    const rejectionError = new Error('Test unhandled rejection');

    setupUnhandledRejectionHandler();
    // Simulate an unhandled rejection.
    // We are not using Promise.reject here as vitest will catch it.
    // Instead we will dispatch the event manually.
    process.emit('unhandledRejection', rejectionError, Promise.resolve());

    // We need to wait for the rejection handler to be called.
    await new Promise(process.nextTick);

    expect(appEventsMock.emit).toHaveBeenCalledWith(AppEvent.OpenDebugConsole);
    expect(appEventsMock.emit).toHaveBeenCalledWith(
      AppEvent.LogError,
      expect.stringContaining('Unhandled Promise Rejection'),
    );
    expect(appEventsMock.emit).toHaveBeenCalledWith(
      AppEvent.LogError,
      expect.stringContaining('Please file a bug report using the /bug tool.'),
    );

    // Simulate a second rejection
    const secondRejectionError = new Error('Second test unhandled rejection');
    process.emit('unhandledRejection', secondRejectionError, Promise.resolve());
    await new Promise(process.nextTick);

    // Ensure emit was only called once for OpenDebugConsole
    const openDebugConsoleCalls = appEventsMock.emit.mock.calls.filter(
      (call) => call[0] === AppEvent.OpenDebugConsole,
    );
    expect(openDebugConsoleCalls.length).toBe(1);

    // Avoid the process.exit error from being thrown.
    processExitSpy.mockRestore();
  });

  it('invokes runNonInteractiveStreamJson and performs cleanup in stream-json mode', async () => {
    const originalIsTTY = Object.getOwnPropertyDescriptor(
      process.stdin,
      'isTTY',
    );
    const originalIsRaw = Object.getOwnPropertyDescriptor(
      process.stdin,
      'isRaw',
    );
    Object.defineProperty(process.stdin, 'isTTY', {
      value: false, // 在 stream-json 模式下应为 false
      configurable: true,
    });
    Object.defineProperty(process.stdin, 'isRaw', {
      value: false,
      configurable: true,
    });

    const processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code) => {
        throw new MockProcessExitError(code);
      });

    const { loadCliConfig, parseArguments } = await import(
      './config/config.js'
    );
    const { loadSettings } = await import('./config/settings.js');
    const cleanupModule = await import('./utils/cleanup.js');
    const validatorModule = await import('./validateNonInterActiveAuth.js');
    const streamJsonModule = await import('./nonInteractive/session.js');
    const initializerModule = await import('./core/initializer.js');
    const startupWarningsModule = await import('./utils/startupWarnings.js');
    const userStartupWarningsModule = await import(
      './utils/userStartupWarnings.js'
    );

    vi.mocked(cleanupModule.cleanupCheckpoints).mockResolvedValue(undefined);
    vi.mocked(cleanupModule.registerCleanup).mockImplementation(() => {});
    const runExitCleanupMock = vi.mocked(cleanupModule.runExitCleanup);
    runExitCleanupMock.mockResolvedValue(undefined);
    vi.spyOn(initializerModule, 'initializeApp').mockResolvedValue({
      authError: null,
      themeError: null,
      shouldOpenAuthDialog: false,
      geminiMdFileCount: 0,
    });
    vi.spyOn(startupWarningsModule, 'getStartupWarnings').mockResolvedValue([]);
    vi.spyOn(
      userStartupWarningsModule,
      'getUserStartupWarnings',
    ).mockResolvedValue([]);

    const validatedConfig = { validated: true } as unknown as Config;
    const validateAuthSpy = vi
      .spyOn(validatorModule, 'validateNonInteractiveAuth')
      .mockResolvedValue(validatedConfig);
    const runStreamJsonSpy = vi
      .spyOn(streamJsonModule, 'runNonInteractiveStreamJson')
      .mockResolvedValue(undefined);

    vi.mocked(loadSettings).mockReturnValue({
      errors: [],
      merged: {
        advanced: {},
        security: { auth: {} },
        ui: {},
      },
      setValue: vi.fn(),
      forScope: () => ({ settings: {}, originalSettings: {}, path: '' }),
      migrationWarnings: [],
      getUserHooks: () => undefined,
      getProjectHooks: () => undefined,
    } as never);

    vi.mocked(parseArguments).mockResolvedValue({
      extensions: [],
    } as never);

    const configStub = {
      isInteractive: () => false,
      getQuestion: () => '  hello stream  ',
      getSandbox: () => false,
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getDebugMode: () => false,
      getListExtensions: () => false,
      getMcpServers: () => ({}),
      getTopTierMcpServers: () => undefined,
      initialize: vi.fn().mockResolvedValue(undefined),
      waitForMcpReady: vi.fn().mockResolvedValue(undefined),
      getIdeMode: () => false,
      getExperimentalZedIntegration: () => false,
      getScreenReader: () => false,
      getGeminiMdFileCount: () => 0,
      getProjectRoot: () => '/',
      getInputFormat: () => 'stream-json',
      getContentGeneratorConfig: () => ({ authType: 'test-auth' }),
      getWarnings: () => [],
      isSafeMode: () => false,
      getModelsConfig: () => ({ getCurrentAuthType: () => null }),
      getUsageStatisticsEnabled: () => true,
      getSessionId: () => 'test-session-id',
      getOutputFormat: () => OutputFormat.TEXT,
    } as unknown as Config;

    vi.mocked(loadCliConfig).mockResolvedValue(configStub);

    process.env['SANDBOX'] = '1';
    try {
      await main();
    } catch (error) {
      if (!(error instanceof MockProcessExitError)) {
        throw error;
      }
    } finally {
      processExitSpy.mockRestore();
      if (originalIsTTY) {
        Object.defineProperty(process.stdin, 'isTTY', originalIsTTY);
      } else {
        delete (process.stdin as { isTTY?: unknown }).isTTY;
      }
      if (originalIsRaw) {
        Object.defineProperty(process.stdin, 'isRaw', originalIsRaw);
      } else {
        delete (process.stdin as { isRaw?: unknown }).isRaw;
      }
      delete process.env['SANDBOX'];
    }

    expect(runStreamJsonSpy).toHaveBeenCalledTimes(1);
    const [configArg, inputArg, settingsArg] = runStreamJsonSpy.mock.calls[0];
    expect(configArg).toBe(validatedConfig);
    expect(inputArg).toBe('hello stream');
    // Regression guard: PR-A's progressive-MCP refactor previously
    // dropped the `settings` argument here, which silently fell back to
    // `createMinimalSettings()` inside `runNonInteractiveStreamJson`.
    // The parallel `runNonInteractive` path still received settings, so
    // stream-json sessions lost any user-configured permission /
    // approval / hook setup.
    expect(settingsArg).toBeDefined();

    expect(validateAuthSpy).toHaveBeenCalledWith(
      undefined,
      configStub,
      expect.any(Object),
    );
    expect(initializerModule.initializeApp).toHaveBeenCalledWith(
      configStub,
      expect.any(Object),
      { deferIdeConnection: false },
    );
    expect(runExitCleanupMock).toHaveBeenCalledTimes(1);
  });
});

describe('gemini.tsx main function kitty protocol', () => {
  let originalEnvNoRelaunch: string | undefined;
  let setRawModeSpy: MockInstance<
    (mode: boolean) => NodeJS.ReadStream & { fd: 0 }
  >;
  let initialSigintListeners: NodeJS.SignalsListener[];
  let initialSigtermListeners: NodeJS.SignalsListener[];

  beforeEach(() => {
    // Set no relaunch in tests since process spawning causing issues in tests
    originalEnvNoRelaunch = process.env['QWEN_CODE_NO_RELAUNCH'];
    process.env['QWEN_CODE_NO_RELAUNCH'] = 'true';
    initialSigintListeners = process.listeners(
      'SIGINT',
    ) as NodeJS.SignalsListener[];
    initialSigtermListeners = process.listeners(
      'SIGTERM',
    ) as NodeJS.SignalsListener[];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!(process.stdin as any).setRawMode) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdin as any).setRawMode = vi.fn();
    }
    setRawModeSpy = vi.spyOn(process.stdin, 'setRawMode');

    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });
    Object.defineProperty(process.stdin, 'isRaw', {
      value: false,
      configurable: true,
    });
  });

  afterEach(() => {
    for (const listener of process.listeners('SIGINT')) {
      if (!initialSigintListeners.includes(listener)) {
        process.removeListener('SIGINT', listener as NodeJS.SignalsListener);
      }
    }
    for (const listener of process.listeners('SIGTERM')) {
      if (!initialSigtermListeners.includes(listener)) {
        process.removeListener('SIGTERM', listener as NodeJS.SignalsListener);
      }
    }

    // Restore original env variables
    if (originalEnvNoRelaunch !== undefined) {
      process.env['QWEN_CODE_NO_RELAUNCH'] = originalEnvNoRelaunch;
    } else {
      delete process.env['QWEN_CODE_NO_RELAUNCH'];
    }
    vi.restoreAllMocks();
  });

  it('should call setRawMode and detectAndEnableKittyProtocol when isInteractive is true', async () => {
    const { detectAndEnableKittyProtocol } = await import(
      './ui/utils/kittyProtocolDetector.js'
    );
    const { loadCliConfig, parseArguments } = await import(
      './config/config.js'
    );
    const { loadSettings } = await import('./config/settings.js');
    const initializerModule = await import('./core/initializer.js');
    const initializeAppSpy = vi
      .spyOn(initializerModule, 'initializeApp')
      .mockResolvedValue({
        authError: null,
        themeError: null,
        shouldOpenAuthDialog: false,
        geminiMdFileCount: 0,
      });
    vi.mocked(loadCliConfig).mockResolvedValue({
      isInteractive: () => true,
      getQuestion: () => '',
      getSandbox: () => false,
      getDebugMode: () => false,
      getListExtensions: () => false,
      getMcpServers: () => ({}),
      getTopTierMcpServers: () => undefined,
      initialize: vi.fn(),
      waitForMcpReady: vi.fn().mockResolvedValue(undefined),
      getIdeMode: () => false,
      getExperimentalZedIntegration: () => false,
      getScreenReader: () => false,
      getGeminiMdFileCount: () => 0,
      getWarnings: () => [],
      isSafeMode: () => false,
      getModelsConfig: () => ({ getCurrentAuthType: () => null }),
      getUsageStatisticsEnabled: () => true,
      getSessionId: () => 'test-session-id',
      isTelemetryInitializationDeferred: () => true,
    } as unknown as Config);
    vi.mocked(loadSettings).mockReturnValue({
      errors: [],
      merged: {
        advanced: {},
        security: { auth: {} },
        ui: {},
      },
      setValue: vi.fn(),
      forScope: () => ({ settings: {}, originalSettings: {}, path: '' }),
      migrationWarnings: [],
      getUserHooks: () => undefined,
      getProjectHooks: () => undefined,
    } as never);
    vi.mocked(parseArguments).mockResolvedValue({
      model: undefined,
      sandbox: undefined,
      sandboxImage: undefined,
      debug: undefined,
      prompt: undefined,
      promptInteractive: undefined,
      systemPrompt: undefined,
      appendSystemPrompt: undefined,
      query: undefined,
      yolo: undefined,
      bare: undefined,
      approvalMode: undefined,
      telemetry: undefined,
      telemetryTarget: undefined,
      telemetryOtlpEndpoint: undefined,
      telemetryOtlpProtocol: undefined,
      telemetryLogPrompts: undefined,
      telemetryOutfile: undefined,
      allowedMcpServerNames: undefined,
      mcpConfig: undefined,
      allowedTools: undefined,
      acp: undefined,
      experimentalAcp: undefined,
      extensions: undefined,
      listExtensions: undefined,
      openaiLogging: undefined,
      openaiApiKey: undefined,
      openaiBaseUrl: undefined,
      openaiLoggingDir: undefined,
      proxy: undefined,
      includeDirectories: undefined,
      screenReader: undefined,
      inputFormat: undefined,
      outputFormat: undefined,
      includePartialMessages: undefined,
      continue: undefined,
      resume: undefined,
      coreTools: undefined,
      excludeTools: undefined,
      disabledSlashCommands: undefined,
      authType: undefined,
      maxSessionTurns: undefined,
      maxWallTime: undefined,
      maxToolCalls: undefined,
      maxSubagentDepth: undefined,
      experimentalLsp: undefined,
      channel: undefined,
      chatRecording: undefined,
      sessionId: undefined,
      fallbackModel: undefined,
    });

    await main();

    expect(setRawModeSpy).toHaveBeenCalledWith(true);
    expect(detectAndEnableKittyProtocol).toHaveBeenCalledTimes(1);
    expect(initializeAppSpy).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      {
        deferIdeConnection: true,
      },
    );
    expect(mockStartPostRenderPrefetches).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      {
        connectIde: true,
        initializeTelemetry: true,
      },
    );
    expect(mockStartEarlyStartupPrefetches).toHaveBeenCalledWith(
      expect.any(Object),
    );
  });

  it('should await IDE connection when interactive mode has an initial prompt', async () => {
    const { loadCliConfig, parseArguments } = await import(
      './config/config.js'
    );
    const { loadSettings } = await import('./config/settings.js');
    const initializerModule = await import('./core/initializer.js');
    const initializeAppSpy = vi
      .spyOn(initializerModule, 'initializeApp')
      .mockResolvedValue({
        authError: null,
        themeError: null,
        shouldOpenAuthDialog: false,
        geminiMdFileCount: 0,
      });
    vi.mocked(loadCliConfig).mockResolvedValue({
      isInteractive: () => true,
      getQuestion: () => 'hello from prompt-interactive',
      getSandbox: () => false,
      getDebugMode: () => false,
      getListExtensions: () => false,
      getMcpServers: () => ({}),
      getTopTierMcpServers: () => undefined,
      initialize: vi.fn(),
      waitForMcpReady: vi.fn().mockResolvedValue(undefined),
      getIdeMode: () => false,
      getExperimentalZedIntegration: () => false,
      getScreenReader: () => false,
      getGeminiMdFileCount: () => 0,
      getWarnings: () => [],
      isSafeMode: () => false,
      getModelsConfig: () => ({ getCurrentAuthType: () => null }),
      getUsageStatisticsEnabled: () => true,
      getSessionId: () => 'test-session-id',
      isTelemetryInitializationDeferred: () => false,
    } as unknown as Config);
    vi.mocked(loadSettings).mockReturnValue({
      errors: [],
      merged: {
        advanced: {},
        security: { auth: {} },
        ui: {},
      },
      setValue: vi.fn(),
      forScope: () => ({ settings: {}, originalSettings: {}, path: '' }),
      migrationWarnings: [],
      getUserHooks: () => undefined,
      getProjectHooks: () => undefined,
    } as never);
    vi.mocked(parseArguments).mockResolvedValue({
      model: undefined,
      sandbox: undefined,
      sandboxImage: undefined,
      debug: undefined,
      prompt: undefined,
      promptInteractive: undefined,
      systemPrompt: undefined,
      appendSystemPrompt: undefined,
      query: undefined,
      yolo: undefined,
      bare: undefined,
      approvalMode: undefined,
      telemetry: undefined,
      telemetryTarget: undefined,
      telemetryOtlpEndpoint: undefined,
      telemetryOtlpProtocol: undefined,
      telemetryLogPrompts: undefined,
      telemetryOutfile: undefined,
      allowedMcpServerNames: undefined,
      mcpConfig: undefined,
      allowedTools: undefined,
      acp: undefined,
      experimentalAcp: undefined,
      extensions: undefined,
      listExtensions: undefined,
      openaiLogging: undefined,
      openaiApiKey: undefined,
      openaiBaseUrl: undefined,
      openaiLoggingDir: undefined,
      proxy: undefined,
      includeDirectories: undefined,
      screenReader: undefined,
      inputFormat: undefined,
      outputFormat: undefined,
      includePartialMessages: undefined,
      continue: undefined,
      resume: undefined,
      coreTools: undefined,
      excludeTools: undefined,
      disabledSlashCommands: undefined,
      authType: undefined,
      maxSessionTurns: undefined,
      maxWallTime: undefined,
      maxToolCalls: undefined,
      maxSubagentDepth: undefined,
      experimentalLsp: undefined,
      channel: undefined,
      chatRecording: undefined,
      sessionId: undefined,
      fallbackModel: undefined,
    });

    await main();

    expect(initializeAppSpy).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      {
        deferIdeConnection: false,
      },
    );
    expect(mockStartPostRenderPrefetches).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      {
        connectIde: false,
        initializeTelemetry: false,
      },
    );
    expect(mockStartEarlyStartupPrefetches).toHaveBeenCalledWith(
      expect.any(Object),
    );
  });

  it('should await IDE connection when interactive mode has an input file', async () => {
    const { loadCliConfig, parseArguments } = await import(
      './config/config.js'
    );
    const { loadSettings } = await import('./config/settings.js');
    const initializerModule = await import('./core/initializer.js');
    const initializeAppSpy = vi
      .spyOn(initializerModule, 'initializeApp')
      .mockResolvedValue({
        authError: null,
        themeError: null,
        shouldOpenAuthDialog: false,
        geminiMdFileCount: 0,
      });
    vi.mocked(loadCliConfig).mockResolvedValue({
      isInteractive: () => true,
      getQuestion: () => '',
      getInputFile: () => '/tmp/qwen-input.jsonl',
      getSandbox: () => false,
      getDebugMode: () => false,
      getListExtensions: () => false,
      getMcpServers: () => ({}),
      getTopTierMcpServers: () => undefined,
      initialize: vi.fn(),
      waitForMcpReady: vi.fn().mockResolvedValue(undefined),
      getIdeMode: () => false,
      getExperimentalZedIntegration: () => false,
      getScreenReader: () => false,
      getGeminiMdFileCount: () => 0,
      getWarnings: () => [],
      isSafeMode: () => false,
      getModelsConfig: () => ({ getCurrentAuthType: () => null }),
      getUsageStatisticsEnabled: () => true,
      getSessionId: () => 'test-session-id',
      isTelemetryInitializationDeferred: () => true,
    } as unknown as Config);
    vi.mocked(loadSettings).mockReturnValue({
      errors: [],
      merged: {
        advanced: {},
        security: { auth: {} },
        ui: {},
      },
      setValue: vi.fn(),
      forScope: () => ({ settings: {}, originalSettings: {}, path: '' }),
      migrationWarnings: [],
      getUserHooks: () => undefined,
      getProjectHooks: () => undefined,
    } as never);
    vi.mocked(parseArguments).mockResolvedValue({
      model: undefined,
      sandbox: undefined,
      sandboxImage: undefined,
      debug: undefined,
      prompt: undefined,
      promptInteractive: undefined,
      systemPrompt: undefined,
      appendSystemPrompt: undefined,
      query: undefined,
      yolo: undefined,
      bare: undefined,
      approvalMode: undefined,
      telemetry: undefined,
      telemetryTarget: undefined,
      telemetryOtlpEndpoint: undefined,
      telemetryOtlpProtocol: undefined,
      telemetryLogPrompts: undefined,
      telemetryOutfile: undefined,
      allowedMcpServerNames: undefined,
      mcpConfig: undefined,
      allowedTools: undefined,
      acp: undefined,
      experimentalAcp: undefined,
      extensions: undefined,
      listExtensions: undefined,
      openaiLogging: undefined,
      openaiApiKey: undefined,
      openaiBaseUrl: undefined,
      openaiLoggingDir: undefined,
      proxy: undefined,
      includeDirectories: undefined,
      screenReader: undefined,
      inputFormat: undefined,
      outputFormat: undefined,
      includePartialMessages: undefined,
      continue: undefined,
      resume: undefined,
      coreTools: undefined,
      excludeTools: undefined,
      disabledSlashCommands: undefined,
      authType: undefined,
      maxSessionTurns: undefined,
      maxWallTime: undefined,
      maxToolCalls: undefined,
      maxSubagentDepth: undefined,
      experimentalLsp: undefined,
      channel: undefined,
      chatRecording: undefined,
      sessionId: undefined,
      fallbackModel: undefined,
    });

    await main();

    expect(initializeAppSpy).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      {
        deferIdeConnection: false,
      },
    );
    expect(mockStartPostRenderPrefetches).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      {
        connectIde: false,
        initializeTelemetry: true,
      },
    );
  });

  it('should not defer IDE connection when Zed integration is enabled', async () => {
    const { loadCliConfig, parseArguments } = await import(
      './config/config.js'
    );
    const { loadSettings } = await import('./config/settings.js');
    const initializerModule = await import('./core/initializer.js');
    const initializeAppSpy = vi
      .spyOn(initializerModule, 'initializeApp')
      .mockResolvedValue({
        authError: null,
        themeError: null,
        shouldOpenAuthDialog: false,
        geminiMdFileCount: 0,
      });
    vi.mocked(loadCliConfig).mockResolvedValue({
      isInteractive: () => true,
      getQuestion: () => '',
      getSandbox: () => false,
      getDebugMode: () => false,
      getListExtensions: () => false,
      getMcpServers: () => ({}),
      getTopTierMcpServers: () => undefined,
      initialize: vi.fn(),
      waitForMcpReady: vi.fn().mockResolvedValue(undefined),
      getIdeMode: () => false,
      getExperimentalZedIntegration: () => true,
      getScreenReader: () => false,
      getGeminiMdFileCount: () => 0,
      getWarnings: () => [],
      isSafeMode: () => false,
      getModelsConfig: () => ({ getCurrentAuthType: () => null }),
      getUsageStatisticsEnabled: () => true,
      getSessionId: () => 'test-session-id',
    } as unknown as Config);
    vi.mocked(loadSettings).mockReturnValue({
      errors: [],
      merged: {
        advanced: {},
        security: { auth: {} },
        ui: {},
      },
      setValue: vi.fn(),
      forScope: () => ({ settings: {}, originalSettings: {}, path: '' }),
      migrationWarnings: [],
      getUserHooks: () => undefined,
      getProjectHooks: () => undefined,
    } as never);
    vi.mocked(parseArguments).mockResolvedValue({
      model: undefined,
      sandbox: undefined,
      sandboxImage: undefined,
      debug: undefined,
      prompt: undefined,
      promptInteractive: undefined,
      systemPrompt: undefined,
      appendSystemPrompt: undefined,
      query: undefined,
      yolo: undefined,
      bare: undefined,
      approvalMode: undefined,
      telemetry: undefined,
      telemetryTarget: undefined,
      telemetryOtlpEndpoint: undefined,
      telemetryOtlpProtocol: undefined,
      telemetryLogPrompts: undefined,
      telemetryOutfile: undefined,
      allowedMcpServerNames: undefined,
      mcpConfig: undefined,
      allowedTools: undefined,
      acp: undefined,
      experimentalAcp: undefined,
      extensions: undefined,
      listExtensions: undefined,
      openaiLogging: undefined,
      openaiApiKey: undefined,
      openaiBaseUrl: undefined,
      openaiLoggingDir: undefined,
      proxy: undefined,
      includeDirectories: undefined,
      screenReader: undefined,
      inputFormat: undefined,
      outputFormat: undefined,
      includePartialMessages: undefined,
      continue: undefined,
      resume: undefined,
      coreTools: undefined,
      excludeTools: undefined,
      disabledSlashCommands: undefined,
      authType: undefined,
      maxSessionTurns: undefined,
      maxWallTime: undefined,
      maxToolCalls: undefined,
      maxSubagentDepth: undefined,
      experimentalLsp: undefined,
      channel: undefined,
      chatRecording: undefined,
      sessionId: undefined,
      fallbackModel: undefined,
    });

    // Mock process.exit to throw instead of terminating the process
    const originalExit = process.exit;
    process.exit = ((code?: string | number | null | undefined) => {
      throw new MockProcessExitError(code);
    }) as unknown as typeof process.exit;

    try {
      await main();
    } catch (e) {
      if (!(e instanceof MockProcessExitError)) throw e;
    } finally {
      process.exit = originalExit;
    }

    expect(initializeAppSpy).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      {
        deferIdeConnection: false,
      },
    );
    expect(mockRunAcpAgent).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.any(Object),
    );
    expect(mockStartEarlyStartupPrefetches).toHaveBeenCalledWith(
      expect.any(Object),
    );
  });

  it('should run cleanup before exiting on interactive SIGINT', async () => {
    const { loadCliConfig, parseArguments } = await import(
      './config/config.js'
    );
    const { loadSettings } = await import('./config/settings.js');
    const cleanupModule = await import('./utils/cleanup.js');
    const signalHandlers = new Map<string, (...args: unknown[]) => void>();
    const processOnceSpy = vi.spyOn(process, 'once').mockImplementation(((
      eventName: string | symbol,
      listener: (...args: unknown[]) => void,
    ) => {
      if (eventName === 'SIGTERM' || eventName === 'SIGINT') {
        signalHandlers.set(eventName, listener);
      }
      return process;
    }) as typeof process.once);
    const processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as unknown as typeof process.exit);
    const runExitCleanupMock = vi.mocked(cleanupModule.runExitCleanup);
    runExitCleanupMock.mockResolvedValue(undefined);

    vi.mocked(loadCliConfig).mockResolvedValue({
      isInteractive: () => true,
      getQuestion: () => '',
      getSandbox: () => false,
      getDebugMode: () => false,
      getListExtensions: () => false,
      getMcpServers: () => ({}),
      getTopTierMcpServers: () => undefined,
      initialize: vi.fn(),
      waitForMcpReady: vi.fn().mockResolvedValue(undefined),
      getIdeMode: () => false,
      getExperimentalZedIntegration: () => false,
      getScreenReader: () => false,
      getGeminiMdFileCount: () => 0,
      getWarnings: () => [],
      isSafeMode: () => false,
      getModelsConfig: () => ({
        getCurrentAuthType: () => null,
        getGenerationConfig: () => ({}),
      }),
      getProxy: () => undefined,
      getUsageStatisticsEnabled: () => true,
      getSessionId: () => 'test-session-id',
      isTelemetryInitializationDeferred: () => true,
    } as unknown as Config);
    vi.mocked(loadSettings).mockReturnValue({
      errors: [],
      merged: {
        advanced: {},
        security: { auth: {} },
        ui: {},
      },
      setValue: vi.fn(),
      forScope: () => ({ settings: {}, originalSettings: {}, path: '' }),
      migrationWarnings: [],
      getUserHooks: () => undefined,
      getProjectHooks: () => undefined,
    } as never);
    vi.mocked(parseArguments).mockResolvedValue({
      extensions: undefined,
    } as never);

    await main();
    signalHandlers.get('SIGINT')?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(setRawModeSpy).toHaveBeenCalledWith(false);
    expect(runExitCleanupMock).toHaveBeenCalledTimes(1);
    expect(processExitSpy).toHaveBeenCalledWith(130);

    processOnceSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  it('rejects --json-schema when running in interactive (TUI) mode', async () => {
    // The synthetic structured_output tool only terminates the run inside
    // runNonInteractive. In TUI mode it's an inert tool that prints
    // "accepted" and leaves the chat alive — silently stranding the run.
    // gemini.tsx must reject this combination at runtime (parse-time
    // gating can't catch the no-prompt-on-TTY case because stdin
    // availability isn't probed yet at parse time).
    const { loadCliConfig, parseArguments } = await import(
      './config/config.js'
    );
    const { loadSettings } = await import('./config/settings.js');
    const cleanupModule = await import('./utils/cleanup.js');

    const callOrder: string[] = [];
    const exitCodes: Array<string | number | null | undefined> = [];

    mockWriteStderrLine.mockClear();
    mockWriteStderrLine.mockImplementation(() => {
      callOrder.push('writeStderrLine');
    });
    const runExitCleanupMock = vi.mocked(cleanupModule.runExitCleanup);
    runExitCleanupMock.mockReset();
    runExitCleanupMock.mockImplementation(async () => {
      callOrder.push('runExitCleanup');
    });
    const processExitSpy = vi.spyOn(process, 'exit').mockImplementation(((
      code?: string | number | null,
    ) => {
      callOrder.push('processExit');
      exitCodes.push(code);
      throw new MockProcessExitError(code);
    }) as unknown as typeof process.exit);

    vi.mocked(loadCliConfig).mockResolvedValue({
      isInteractive: () => true,
      getJsonSchema: () => ({ type: 'object' }),
      getQuestion: () => '',
      getSandbox: () => false,
      getDebugMode: () => false,
      getListExtensions: () => false,
      getMcpServers: () => ({}),
      getTopTierMcpServers: () => undefined,
      initialize: vi.fn(),
      waitForMcpReady: vi.fn().mockResolvedValue(undefined),
      getIdeMode: () => false,
      getExperimentalZedIntegration: () => false,
      getScreenReader: () => false,
      getGeminiMdFileCount: () => 0,
      getWarnings: () => [],
      isSafeMode: () => false,
      getModelsConfig: () => ({ getCurrentAuthType: () => null }),
      getUsageStatisticsEnabled: () => true,
      getSessionId: () => 'test-session-id',
      shutdown: vi.fn(),
    } as unknown as Config);
    vi.mocked(loadSettings).mockReturnValue({
      errors: [],
      merged: {
        advanced: {},
        security: { auth: {} },
        ui: {},
      },
      setValue: vi.fn(),
      forScope: () => ({ settings: {}, originalSettings: {}, path: '' }),
      migrationWarnings: [],
      getUserHooks: () => undefined,
      getProjectHooks: () => undefined,
    } as never);
    vi.mocked(parseArguments).mockResolvedValue({} as never);

    try {
      await main();
    } catch (e) {
      if (!(e instanceof MockProcessExitError)) throw e;
    }

    // The headless-only message must reach stderr…
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('--json-schema is a headless-only flag'),
    );
    // …runExitCleanup must run before exit so MCP subprocesses /
    // telemetry exporters registered earlier get torn down…
    expect(runExitCleanupMock).toHaveBeenCalledTimes(1);
    // …and exit must be 1, not 0.
    expect(processExitSpy).toHaveBeenCalledWith(1);
    // Order: stderr → cleanup → exit. A regression that swapped any of
    // these (cleanup before stderr; exit without cleanup; exit 0
    // instead of 1) would silently strand TUI users.
    expect(callOrder).toEqual([
      'writeStderrLine',
      'runExitCleanup',
      'processExit',
    ]);
    expect(exitCodes).toEqual([1]);

    processExitSpy.mockRestore();
  });
});

describe('validateDnsResolutionOrder', () => {
  beforeEach(() => {
    mockWriteStderrLine.mockClear();
  });

  it('should return "ipv4first" when the input is "ipv4first"', () => {
    expect(validateDnsResolutionOrder('ipv4first')).toBe('ipv4first');
    expect(mockWriteStderrLine).not.toHaveBeenCalled();
  });

  it('should return "verbatim" when the input is "verbatim"', () => {
    expect(validateDnsResolutionOrder('verbatim')).toBe('verbatim');
    expect(mockWriteStderrLine).not.toHaveBeenCalled();
  });

  it('should return the default "ipv4first" when the input is undefined', () => {
    expect(validateDnsResolutionOrder(undefined)).toBe('ipv4first');
    expect(mockWriteStderrLine).not.toHaveBeenCalled();
  });

  it('should return the default "ipv4first" and log a warning for an invalid string', () => {
    expect(validateDnsResolutionOrder('invalid-value')).toBe('ipv4first');
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      'Invalid value for dnsResolutionOrder in settings: "invalid-value". Using default "ipv4first".',
    );
  });
});

describe('startInteractiveUI', () => {
  // Mock dependencies
  const mockConfig = {
    getProjectRoot: () => '/root',
    getScreenReader: () => false,
    isTelemetryInitializationDeferred: () => true,
  } as unknown as Config;
  const mockSettings = {
    merged: {
      ui: {
        hideWindowTitle: false,
      },
    },
    getUserHooks: () => undefined,
    getProjectHooks: () => undefined,
  } as LoadedSettings;
  const mockStartupWarnings = ['warning1'];
  const mockWorkspaceRoot = '/root';

  vi.mock('./utils/version.js', () => ({
    getCliVersion: vi.fn(() => Promise.resolve('1.0.0')),
  }));

  vi.mock('./ui/utils/kittyProtocolDetector.js', () => ({
    detectAndEnableKittyProtocol: vi.fn(() => Promise.resolve(true)),
    disableKittyProtocol: vi.fn(),
  }));

  vi.mock('./utils/cleanup.js', () => ({
    cleanupCheckpoints: vi.fn(() => Promise.resolve()),
    registerCleanup: vi.fn(),
    runExitCleanup: vi.fn(() => Promise.resolve()),
  }));

  vi.mock('ink', () => ({
    render: vi.fn().mockReturnValue({ unmount: vi.fn() }),
  }));

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render the UI with proper React context and exitOnCtrlC disabled', async () => {
    const { render } = await import('ink');
    const renderSpy = vi.mocked(render);

    const mockInitializationResult = {
      authError: null,
      themeError: null,
      shouldOpenAuthDialog: false,
      geminiMdFileCount: 0,
    };

    await startInteractiveUI(
      mockConfig,
      mockSettings,
      mockStartupWarnings,
      mockWorkspaceRoot,
      mockInitializationResult,
    );

    // Verify render was called with correct options
    expect(renderSpy).toHaveBeenCalledTimes(1);
    const [reactElement, options] = renderSpy.mock.calls[0];

    // Verify render options
    expect(options).toEqual({
      exitOnCtrlC: false,
      isScreenReaderEnabled: false,
      alternateScreen: false,
    });

    // Verify React element structure is valid (but don't deep dive into JSX internals)
    expect(reactElement).toBeDefined();
  });

  it('should perform all startup tasks in correct order', async () => {
    const { getCliVersion } = await import('./utils/version.js');
    const { registerCleanup } = await import('./utils/cleanup.js');

    const mockInitializationResult = {
      authError: null,
      themeError: null,
      shouldOpenAuthDialog: false,
      geminiMdFileCount: 0,
    };

    await startInteractiveUI(
      mockConfig,
      mockSettings,
      mockStartupWarnings,
      mockWorkspaceRoot,
      mockInitializationResult,
    );

    // Verify all startup tasks were called
    expect(getCliVersion).toHaveBeenCalledTimes(1);
    expect(registerCleanup).toHaveBeenCalledTimes(1);

    // Verify cleanup handler is registered with unmount function
    const cleanupFn = vi.mocked(registerCleanup).mock.calls[0][0];
    expect(typeof cleanupFn).toBe('function');

    expect(mockStartPostRenderPrefetches).toHaveBeenCalledWith(
      mockConfig,
      mockSettings,
      { connectIde: false, initializeTelemetry: true },
    );
  });

  it('delegates disabled auto-update settings to post-render prefetch', async () => {
    const settingsWithAutoUpdateDisabled = {
      merged: {
        general: {
          enableAutoUpdate: false,
        },
        ui: {
          hideWindowTitle: false,
        },
      },
    } as LoadedSettings;

    const mockInitializationResult = {
      authError: null,
      themeError: null,
      shouldOpenAuthDialog: false,
      geminiMdFileCount: 0,
    };

    await startInteractiveUI(
      mockConfig,
      settingsWithAutoUpdateDisabled,
      mockStartupWarnings,
      mockWorkspaceRoot,
      mockInitializationResult,
    );

    expect(mockStartPostRenderPrefetches).toHaveBeenCalledWith(
      mockConfig,
      settingsWithAutoUpdateDisabled,
      { connectIde: false, initializeTelemetry: true },
    );
  });

  it('can skip post-render IDE connection after prompt-interactive awaited it', async () => {
    const promptInteractiveConfig = {
      ...mockConfig,
      isTelemetryInitializationDeferred: () => false,
    } as unknown as Config;
    const mockInitializationResult = {
      authError: null,
      themeError: null,
      shouldOpenAuthDialog: false,
      geminiMdFileCount: 0,
    };

    await startInteractiveUI(
      promptInteractiveConfig,
      mockSettings,
      mockStartupWarnings,
      mockWorkspaceRoot,
      mockInitializationResult,
      { postRenderConnectIde: false },
    );

    expect(mockStartPostRenderPrefetches).toHaveBeenCalledWith(
      promptInteractiveConfig,
      mockSettings,
      { connectIde: false, initializeTelemetry: false },
    );
  });

  describe('periodic memory-pressure check', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    // Regression: the tool scheduler only checks after a tool call, so a
    // long conversation with no tool calls would never reclaim and could
    // OOM on quit. The interactive UI must run a periodic check itself.
    it('runs performCheck on an interval without any tool calls', async () => {
      const performCheck = vi.fn();
      const config = {
        ...mockConfig,
        getMemoryPressureMonitor: () => ({ performCheck }),
      } as unknown as Config;
      const settings = {
        merged: { ui: { hideWindowTitle: true } },
      } as unknown as LoadedSettings;

      await startInteractiveUI(
        config,
        settings,
        mockStartupWarnings,
        mockWorkspaceRoot,
        {
          authError: null,
          themeError: null,
          shouldOpenAuthDialog: false,
          geminiMdFileCount: 0,
        },
      );

      expect(performCheck).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(performCheck).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(performCheck).toHaveBeenCalledTimes(2);
    });

    it('clears the interval and runs a final check before unmount', async () => {
      const performCheck = vi.fn();
      const unmount = vi.fn();
      const config = {
        ...mockConfig,
        getMemoryPressureMonitor: () => ({ performCheck }),
      } as unknown as Config;
      const settings = {
        merged: { ui: { hideWindowTitle: true } },
      } as unknown as LoadedSettings;
      // An earlier describe's vi.restoreAllMocks() wipes the shared ink
      // render mock's return value in the full run, so re-arm it here.
      const { render } = await import('ink');
      vi.mocked(render).mockReturnValue({ unmount } as never);

      await startInteractiveUI(
        config,
        settings,
        mockStartupWarnings,
        mockWorkspaceRoot,
        {
          authError: null,
          themeError: null,
          shouldOpenAuthDialog: false,
          geminiMdFileCount: 0,
        },
      );
      await vi.advanceTimersByTimeAsync(30_000);
      const beforeCleanup = performCheck.mock.calls.length;
      expect(beforeCleanup).toBeGreaterThan(0);

      const { registerCleanup } = await import('./utils/cleanup.js');
      const cleanupFn = vi.mocked(registerCleanup).mock.calls.at(-1)?.[0] as
        | (() => Promise<void> | void)
        | undefined;
      expect(cleanupFn).toBeTypeOf('function');
      await cleanupFn?.();

      // Final pre-unmount reclaim ran, then Ink was unmounted, and the
      // interval was cleared (no further checks fire).
      expect(performCheck.mock.calls.length).toBeGreaterThan(beforeCleanup);
      expect(unmount).toHaveBeenCalledTimes(1);
      const afterCleanup = performCheck.mock.calls.length;
      await vi.advanceTimersByTimeAsync(90_000);
      expect(performCheck.mock.calls.length).toBe(afterCleanup);
    });
  });
});
