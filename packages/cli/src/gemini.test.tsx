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
import {
  main,
  setupUnhandledRejectionHandler,
  validateDnsResolutionOrder,
  startInteractiveUI,
} from './gemini.js';
import type { CliArgs } from './config/config.js';
import { type LoadedSettings } from './config/settings.js';
import { appEvents, AppEvent } from './utils/events.js';
import type { Config } from '@qwen-code/qwen-code-core';
import { OutputFormat } from '@qwen-code/qwen-code-core';

const mockWriteStderrLine = vi.hoisted(() => vi.fn());

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
    getWarnings: vi.fn(() => []),
    getModelsConfig: vi.fn(() => ({ getCurrentAuthType: () => null })),
  } as unknown as Config),
  parseArguments: vi.fn().mockResolvedValue({}),
  isDebugMode: vi.fn(() => false),
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

describe('gemini.tsx main function', () => {
  let originalEnvGeminiSandbox: string | undefined;
  let originalEnvSandbox: string | undefined;
  let originalEnvQwenCodeSimple: string | undefined;
  let initialUnhandledRejectionListeners: NodeJS.UnhandledRejectionListener[] =
    [];

  beforeEach(() => {
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
        getDebugMode: () => false,
        getListExtensions: () => false,
        getMcpServers: () => ({}),
        initialize: vi.fn(),
        waitForMcpReady: vi.fn().mockResolvedValue(undefined),
        getIdeMode: () => false,
        getExperimentalZedIntegration: () => false,
        getScreenReader: () => false,
        getGeminiMdFileCount: () => 0,
        getProjectRoot: () => '/',
        getOutputFormat: () => OutputFormat.TEXT,
        getWarnings: () => [],
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
    processExitSpy.mockRestore();
  });

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
      getDebugMode: () => false,
      getListExtensions: () => false,
      getMcpServers: () => ({}),
      initialize: vi.fn().mockResolvedValue(undefined),
      waitForMcpReady: vi.fn().mockResolvedValue(undefined),
      getIdeMode: () => false,
      getExperimentalZedIntegration: () => false,
      getScreenReader: () => false,
      getGeminiMdFileCount: () => 0,
      getProjectRoot: () => '/',
      getOutputFormat: () => OutputFormat.TEXT,
      getWarnings: () => [],
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
    );
  });

  const runSandboxRelaunch = async (
    argv: string[],
    sessionId = '123e4567-e89b-12d3-a456-426614174000',
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

    vi.mocked(start_sandbox).mockClear();
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
      command: 'sandbox-exec',
      image: '',
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
      getDebugMode: () => false,
      getListExtensions: () => false,
      getMcpServers: () => ({}),
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
    vi.mocked(loadCliConfig).mockResolvedValue({
      isInteractive: () => true,
      getQuestion: () => '',
      getSandbox: () => false,
      getDebugMode: () => false,
      getListExtensions: () => false,
      getMcpServers: () => ({}),
      initialize: vi.fn(),
      waitForMcpReady: vi.fn().mockResolvedValue(undefined),
      getIdeMode: () => false,
      getExperimentalZedIntegration: () => false,
      getScreenReader: () => false,
      getGeminiMdFileCount: () => 0,
      getWarnings: () => [],
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
      checkpointing: undefined,
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
      experimentalLsp: undefined,
      channel: undefined,
      chatRecording: undefined,
      sessionId: undefined,
    });

    await main();

    expect(setRawModeSpy).toHaveBeenCalledWith(true);
    expect(detectAndEnableKittyProtocol).toHaveBeenCalledTimes(1);
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
      initialize: vi.fn(),
      waitForMcpReady: vi.fn().mockResolvedValue(undefined),
      getIdeMode: () => false,
      getExperimentalZedIntegration: () => false,
      getScreenReader: () => false,
      getGeminiMdFileCount: () => 0,
      getWarnings: () => [],
      getModelsConfig: () => ({
        getCurrentAuthType: () => null,
        getGenerationConfig: () => ({}),
      }),
      getProxy: () => undefined,
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
      initialize: vi.fn(),
      waitForMcpReady: vi.fn().mockResolvedValue(undefined),
      getIdeMode: () => false,
      getExperimentalZedIntegration: () => false,
      getScreenReader: () => false,
      getGeminiMdFileCount: () => 0,
      getWarnings: () => [],
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
  } as Config;
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

  vi.mock('./ui/utils/updateCheck.js', () => ({
    checkForUpdates: vi.fn(() => Promise.resolve(null)),
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
    });

    // Verify React element structure is valid (but don't deep dive into JSX internals)
    expect(reactElement).toBeDefined();
  });

  it('should perform all startup tasks in correct order', async () => {
    const { getCliVersion } = await import('./utils/version.js');
    const { checkForUpdates } = await import('./ui/utils/updateCheck.js');
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

    // checkForUpdates should be called asynchronously (not waited for)
    // We need a small delay to let it execute
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('should not call checkForUpdates when enableAutoUpdate is false', async () => {
    const { checkForUpdates } = await import('./ui/utils/updateCheck.js');

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

    await new Promise((resolve) => setTimeout(resolve, 0));

    // checkForUpdates should NOT be called when enableAutoUpdate is false
    expect(checkForUpdates).not.toHaveBeenCalled();
  });
});
