/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../config/settings.js';
import {
  AppEvent,
  appEvents,
  type StartupIdeConnectionStatus,
} from '../utils/events.js';
import {
  startEarlyStartupPrefetches,
  startPostRenderPrefetches,
} from './startup-prefetch.js';

const mockDebug = vi.hoisted(() => vi.fn());
const mockWarn = vi.hoisted(() => vi.fn());
const mockPreconnectApi = vi.hoisted(() => vi.fn());
const mockRecordStartupEvent = vi.hoisted(() => vi.fn());
const mockCheckForUpdatesDetailed = vi.hoisted(() => vi.fn());
const mockHandleAutoUpdate = vi.hoisted(() => vi.fn());
const mockRequestUpdateOnExit = vi.hoisted(() => vi.fn());
const mockGetInstallationInfo = vi.hoisted(() => vi.fn());
const mockUpdateEventEmit = vi.hoisted(() => vi.fn());
const mockConnectIdeForStartup = vi.hoisted(() => vi.fn());
const mockDisconnectIde = vi.hoisted(() => vi.fn());
const mockGetIdeClientInstance = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ disconnect: mockDisconnectIde }),
);
const mockInitializeTelemetry = vi.hoisted(() => vi.fn());
const mockStartBackgroundHousekeeping = vi.hoisted(() => vi.fn());

vi.mock('@qwen-code/qwen-code-core', () => ({
  createDebugLogger: () => ({
    debug: mockDebug,
    warn: mockWarn,
  }),
  IdeClient: { getInstance: () => mockGetIdeClientInstance() },
  initializeTelemetry: (...args: unknown[]) => mockInitializeTelemetry(...args),
}));

vi.mock('../utils/apiPreconnect.js', () => ({
  preconnectApi: (...args: unknown[]) => mockPreconnectApi(...args),
}));

vi.mock('../utils/startupProfiler.js', () => ({
  recordStartupEvent: (...args: unknown[]) => mockRecordStartupEvent(...args),
}));

vi.mock('../ui/utils/updateCheck.js', () => ({
  checkForUpdatesDetailed: (...args: unknown[]) =>
    mockCheckForUpdatesDetailed(...args),
}));

vi.mock('../utils/processUtils.js', () => ({
  CUSTOM_SANDBOX_IMAGE_ENV_VAR: 'QWEN_CODE_CUSTOM_SANDBOX_IMAGE',
  HOST_UPDATE_RELAUNCH_ENV_VAR: 'QWEN_CODE_HOST_UPDATE_RELAUNCH',
  SKIP_UPDATE_CHECK_ENV_VAR: 'QWEN_CODE_SKIP_UPDATE_CHECK_ONCE',
  requestUpdateOnExit: (...args: unknown[]) => mockRequestUpdateOnExit(...args),
}));

vi.mock('../utils/handleAutoUpdate.js', () => ({
  handleAutoUpdate: (...args: unknown[]) => mockHandleAutoUpdate(...args),
}));

vi.mock('../utils/installationInfo.js', () => ({
  getInstallationInfo: (...args: unknown[]) => mockGetInstallationInfo(...args),
}));

vi.mock('../utils/updateEventEmitter.js', () => ({
  updateEventEmitter: {
    emit: (...args: unknown[]) => mockUpdateEventEmit(...args),
  },
}));

vi.mock('../i18n/index.js', () => ({
  t: (key: string) => key,
}));

vi.mock('../core/initializer.js', () => ({
  connectIdeForStartup: (...args: unknown[]) =>
    mockConnectIdeForStartup(...args),
}));

vi.mock('../utils/housekeeping/scheduler.js', () => ({
  startBackgroundHousekeeping: (...args: unknown[]) =>
    mockStartBackgroundHousekeeping(...args),
}));

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    getModelsConfig: () => ({
      getCurrentAuthType: () => 'openai',
      getGenerationConfig: () => ({ baseUrl: 'https://api.openai.com/v1' }),
    }),
    getProxy: () => 'http://proxy.example',
    getProjectRoot: () => '/repo',
    getIdeMode: () => true,
    isInteractive: () => true,
    ...overrides,
  } as unknown as Config;
}

function makeSettings(
  enableAutoUpdate: boolean | undefined = undefined,
): LoadedSettings {
  return {
    merged: {
      general: enableAutoUpdate === undefined ? {} : { enableAutoUpdate },
    },
  } as LoadedSettings;
}

describe('startupPrefetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['QWEN_CODE_CUSTOM_SANDBOX_IMAGE'];
    delete process.env['QWEN_CODE_HOST_UPDATE_RELAUNCH'];
    delete process.env['QWEN_CODE_SKIP_UPDATE_CHECK_ONCE'];
    vi.useRealTimers();
    mockCheckForUpdatesDetailed.mockResolvedValue({
      status: 'up-to-date',
      currentVersion: '1.0.0',
    });
    mockGetInstallationInfo.mockReturnValue({
      updateCommand: 'npm install -g @qwen-code/qwen-code@latest',
      isStandalone: false,
    });
    mockRequestUpdateOnExit.mockReturnValue(true);
    mockConnectIdeForStartup.mockResolvedValue(undefined);
    mockDisconnectIde.mockResolvedValue(undefined);
    mockGetIdeClientInstance.mockResolvedValue({
      disconnect: mockDisconnectIde,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function captureIdeConnectionStatuses() {
    const statuses: StartupIdeConnectionStatus[] = [];
    const listener = (status: StartupIdeConnectionStatus) => {
      statuses.push(status);
    };
    appEvents.on(AppEvent.StartupIdeConnectionStatusChanged, listener);
    return {
      statuses,
      stop: () => {
        appEvents.off(AppEvent.StartupIdeConnectionStatusChanged, listener);
      },
    };
  }

  it('starts API preconnect with resolved auth config', () => {
    const config = makeConfig();

    startEarlyStartupPrefetches(config);

    expect(mockPreconnectApi).toHaveBeenCalledWith('openai', {
      resolvedBaseUrl: 'https://api.openai.com/v1',
      proxy: 'http://proxy.example',
    });
  });

  it('does not record an unbalanced lifecycle event for API preconnect', () => {
    const config = makeConfig();

    startEarlyStartupPrefetches(config);

    expect(mockRecordStartupEvent).not.toHaveBeenCalledWith(
      'startup_prefetch_started',
      { name: 'api_preconnect' },
    );
  });

  it('starts early prefetch only once per config', () => {
    const config = makeConfig();

    startEarlyStartupPrefetches(config);
    startEarlyStartupPrefetches(config);

    expect(mockPreconnectApi).toHaveBeenCalledTimes(1);
  });

  it('skips preconnect errors without throwing', () => {
    const config = makeConfig({
      getModelsConfig: () => {
        throw new Error('bad config');
      },
    } as Partial<Config>);

    expect(() => startEarlyStartupPrefetches(config)).not.toThrow();
    expect(mockPreconnectApi).not.toHaveBeenCalled();
    expect(mockDebug).toHaveBeenCalled();
  });

  it('records completed profiler lifecycle events for successful deferred tasks', async () => {
    const config = makeConfig({
      isInteractive: () => false,
    } as Partial<Config>);

    startPostRenderPrefetches(config, makeSettings());

    await vi.dynamicImportSettled();

    expect(mockCheckForUpdatesDetailed).toHaveBeenCalledTimes(1);
    expect(mockRequestUpdateOnExit).not.toHaveBeenCalled();
    expect(mockRecordStartupEvent).toHaveBeenCalledWith(
      'startup_prefetch_started',
      { name: 'update_check' },
    );
    expect(mockRecordStartupEvent).toHaveBeenCalledWith(
      'startup_prefetch_completed',
      { name: 'update_check' },
    );
  });

  it('defers an available update until the session exits', async () => {
    const config = makeConfig();
    mockCheckForUpdatesDetailed.mockResolvedValue({
      status: 'update',
      info: {
        message: 'Update available',
        update: { latest: '2.0.0' },
      },
    });

    startPostRenderPrefetches(config, makeSettings());

    await vi.dynamicImportSettled();

    expect(mockRequestUpdateOnExit).toHaveBeenCalledTimes(1);
    expect(mockUpdateEventEmit).toHaveBeenCalledWith('update-info', {
      message:
        'Update available\nThe update will be installed after you exit this session.',
    });
  });

  it('prompts for an explicit update when no parent supervisor is available', async () => {
    mockRequestUpdateOnExit.mockReturnValue(false);
    mockCheckForUpdatesDetailed.mockResolvedValue({
      status: 'update',
      info: {
        message: 'Update available',
        update: { latest: '2.0.0' },
      },
    });

    startPostRenderPrefetches(makeConfig(), makeSettings());
    await vi.dynamicImportSettled();

    expect(mockUpdateEventEmit).toHaveBeenCalledWith('update-info', {
      message: 'Update available\nRun /update to install the update.',
    });
  });

  it('defers standalone updates until the session exits', async () => {
    const config = makeConfig();
    mockCheckForUpdatesDetailed.mockResolvedValue({
      status: 'update',
      info: {
        message: 'Update available',
        update: { latest: '2.0.0' },
      },
    });
    mockGetInstallationInfo.mockReturnValue({
      updateCommand: 'standalone update',
      isStandalone: true,
      standaloneDir: '/tmp/qwen-code',
    });

    startPostRenderPrefetches(config, makeSettings());

    await vi.dynamicImportSettled();

    expect(mockRequestUpdateOnExit).toHaveBeenCalledTimes(1);
    expect(mockHandleAutoUpdate).not.toHaveBeenCalled();
  });

  it('keeps a container running until the user updates the host', async () => {
    process.env['QWEN_CODE_HOST_UPDATE_RELAUNCH'] = 'true';
    mockCheckForUpdatesDetailed.mockResolvedValue({
      status: 'update',
      info: {
        message: 'Update available',
        update: { latest: '2.0.0' },
      },
    });

    startPostRenderPrefetches(makeConfig(), makeSettings());
    await vi.dynamicImportSettled();

    expect(mockRequestUpdateOnExit).not.toHaveBeenCalled();
    expect(mockGetInstallationInfo).not.toHaveBeenCalled();
    expect(mockUpdateEventEmit).toHaveBeenCalledWith('update-info', {
      message:
        'Update available\nRun /update to install the update on the host.',
    });
  });

  it('keeps a container running when the host requires manual updates', async () => {
    process.env['QWEN_CODE_HOST_UPDATE_RELAUNCH'] = 'false';
    mockCheckForUpdatesDetailed.mockResolvedValue({
      status: 'update',
      info: {
        message: 'Update available',
        update: { latest: '2.0.0' },
      },
    });

    startPostRenderPrefetches(makeConfig(), makeSettings());
    await vi.dynamicImportSettled();

    expect(mockRequestUpdateOnExit).not.toHaveBeenCalled();
    expect(mockHandleAutoUpdate).not.toHaveBeenCalled();
    expect(mockUpdateEventEmit).toHaveBeenCalledWith('update-info', {
      message:
        'Update available\nUpdate Qwen Code on the host, then restart the sandbox.',
    });
  });

  it('skips one automatic update check after an update relaunch', async () => {
    process.env['QWEN_CODE_SKIP_UPDATE_CHECK_ONCE'] = 'true';

    try {
      startPostRenderPrefetches(makeConfig(), makeSettings());
      await vi.dynamicImportSettled();

      expect(mockCheckForUpdatesDetailed).not.toHaveBeenCalled();
    } finally {
      delete process.env['QWEN_CODE_SKIP_UPDATE_CHECK_ONCE'];
    }
  });

  it('leaves explicitly configured sandbox images user-managed', async () => {
    process.env['QWEN_CODE_CUSTOM_SANDBOX_IMAGE'] =
      'example.com/custom-qwen:1.0.0';

    try {
      startPostRenderPrefetches(makeConfig(), makeSettings());
      await vi.dynamicImportSettled();

      expect(mockCheckForUpdatesDetailed).not.toHaveBeenCalled();
      expect(mockRequestUpdateOnExit).not.toHaveBeenCalled();
    } finally {
      delete process.env['QWEN_CODE_CUSTOM_SANDBOX_IMAGE'];
    }
  });

  it('starts post-render tasks without awaiting completion', async () => {
    const config = makeConfig();
    const updatePromise = new Promise<null>(() => {});
    mockCheckForUpdatesDetailed.mockReturnValue(updatePromise);

    startPostRenderPrefetches(config, makeSettings(), { connectIde: true });

    await vi.dynamicImportSettled();

    expect(mockCheckForUpdatesDetailed).toHaveBeenCalledTimes(1);
    expect(mockConnectIdeForStartup).toHaveBeenCalledWith(config);
    expect(mockStartBackgroundHousekeeping).toHaveBeenCalledWith(
      config,
      expect.any(Object),
    );
  });

  it('does not run update check when auto-update is disabled', async () => {
    const config = makeConfig();

    startPostRenderPrefetches(config, makeSettings(false), {
      connectIde: true,
    });

    await vi.dynamicImportSettled();

    expect(mockCheckForUpdatesDetailed).not.toHaveBeenCalled();
    expect(mockConnectIdeForStartup).toHaveBeenCalledWith(config);
  });

  it('logs update check errors without surfacing them to the user', async () => {
    const config = makeConfig();
    const error = new Error('registry unavailable');
    mockCheckForUpdatesDetailed.mockResolvedValue({
      status: 'error',
      error,
    });

    startPostRenderPrefetches(config, makeSettings());

    await vi.dynamicImportSettled();

    expect(mockWarn).toHaveBeenCalledWith(
      'Startup update check failed:',
      error,
    );
    expect(mockUpdateEventEmit).not.toHaveBeenCalledWith(
      'update-failed',
      expect.anything(),
    );
    expect(mockRequestUpdateOnExit).not.toHaveBeenCalled();
  });

  it('requires connectIde option before connecting IDE', async () => {
    const config = makeConfig();
    const { statuses, stop } = captureIdeConnectionStatuses();

    try {
      startPostRenderPrefetches(config, makeSettings());

      await vi.dynamicImportSettled();

      expect(mockConnectIdeForStartup).not.toHaveBeenCalled();
      expect(statuses).toEqual([]);
    } finally {
      stop();
    }
  });

  it('does not connect IDE when IDE mode is disabled', async () => {
    const config = makeConfig({ getIdeMode: () => false } as Partial<Config>);
    const { statuses, stop } = captureIdeConnectionStatuses();

    try {
      startPostRenderPrefetches(config, makeSettings(), { connectIde: true });

      await vi.dynamicImportSettled();

      expect(mockConnectIdeForStartup).not.toHaveBeenCalled();
      expect(statuses).toEqual([]);
    } finally {
      stop();
    }
  });

  it('emits IDE connecting and connected statuses for deferred IDE startup', async () => {
    const config = makeConfig();
    const { statuses, stop } = captureIdeConnectionStatuses();

    try {
      startPostRenderPrefetches(config, makeSettings(), { connectIde: true });

      await vi.dynamicImportSettled();

      expect(statuses).toEqual([
        { state: 'connecting' },
        { state: 'connected' },
      ]);
    } finally {
      stop();
    }
  });

  it('fails deferred IDE connection when the startup connect hangs', async () => {
    vi.useFakeTimers();
    const config = makeConfig();
    const hangingConnect = new Promise<void>(() => {});
    mockConnectIdeForStartup.mockReturnValue(hangingConnect);
    const { statuses, stop } = captureIdeConnectionStatuses();

    try {
      startPostRenderPrefetches(config, makeSettings(), { connectIde: true });

      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(15_000);

      expect(statuses).toEqual([
        { state: 'connecting' },
        {
          state: 'failed',
          message: 'ide_connect timed out after 15000ms',
        },
      ]);
      expect(mockRecordStartupEvent).toHaveBeenCalledWith(
        'startup_prefetch_failed',
        { name: 'ide_connect' },
      );
      expect(mockWarn).toHaveBeenCalledWith(
        'ide_connect failed:',
        expect.objectContaining({
          message: 'ide_connect timed out after 15000ms',
        }),
      );
      expect(mockDisconnectIde).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });

  it('disconnects IDE again if startup connect succeeds after timeout', async () => {
    vi.useFakeTimers();
    const config = makeConfig();
    let resolveConnect!: () => void;
    const delayedSuccess = new Promise<void>((resolve) => {
      resolveConnect = resolve;
    });
    mockConnectIdeForStartup.mockReturnValue(delayedSuccess);

    startPostRenderPrefetches(config, makeSettings(), { connectIde: true });

    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.dynamicImportSettled();

    expect(mockDisconnectIde).toHaveBeenCalledTimes(1);

    resolveConnect();
    await vi.dynamicImportSettled();

    expect(mockDisconnectIde).toHaveBeenCalledTimes(2);
    expect(mockWarn).toHaveBeenCalledWith(
      'ide_connect failed:',
      expect.objectContaining({
        message: 'ide_connect timed out after 15000ms',
      }),
    );
  });

  it('fails deferred IDE connection when the startup connect rejects quickly', async () => {
    const config = makeConfig();
    const error = new Error('connection refused');
    mockConnectIdeForStartup.mockRejectedValue(error);
    const { statuses, stop } = captureIdeConnectionStatuses();

    try {
      startPostRenderPrefetches(config, makeSettings(), { connectIde: true });

      await vi.dynamicImportSettled();

      expect(statuses).toEqual([
        { state: 'connecting' },
        { state: 'failed', message: 'connection refused' },
      ]);
      expect(mockRecordStartupEvent).toHaveBeenCalledWith(
        'startup_prefetch_failed',
        { name: 'ide_connect' },
      );
      expect(mockWarn).toHaveBeenCalledWith('ide_connect failed:', error);
      expect(mockDisconnectIde).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it('logs the underlying IDE connection error after timeout', async () => {
    vi.useFakeTimers();
    const config = makeConfig();
    let rejectConnect!: (error: Error) => void;
    const delayedFailure = new Promise<void>((_, reject) => {
      rejectConnect = reject;
    });
    mockConnectIdeForStartup.mockReturnValue(delayedFailure);

    startPostRenderPrefetches(config, makeSettings(), { connectIde: true });

    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(15_000);

    const underlyingError = new Error('socket closed');
    rejectConnect(underlyingError);
    await vi.dynamicImportSettled();

    expect(mockWarn).toHaveBeenCalledWith(
      'ide_connect failed:',
      expect.objectContaining({
        message: 'ide_connect timed out after 15000ms',
      }),
    );
    expect(mockDebug).toHaveBeenCalledWith(
      'ide_connect underlying error after timeout:',
      underlyingError,
    );
  });

  it('initializes telemetry when requested', async () => {
    const config = makeConfig();

    startPostRenderPrefetches(config, makeSettings(), {
      initializeTelemetry: true,
    });

    await vi.dynamicImportSettled();

    expect(mockInitializeTelemetry).toHaveBeenCalledWith(config);
  });

  it('does not initialize telemetry unless requested', async () => {
    const config = makeConfig();

    startPostRenderPrefetches(config, makeSettings());

    await vi.dynamicImportSettled();

    expect(mockInitializeTelemetry).not.toHaveBeenCalled();
  });

  it('swallows telemetry initialization failures', async () => {
    const config = makeConfig();
    const error = new Error('otel unavailable');
    mockInitializeTelemetry.mockImplementation(() => {
      throw error;
    });

    expect(() =>
      startPostRenderPrefetches(config, makeSettings(), {
        initializeTelemetry: true,
      }),
    ).not.toThrow();

    await vi.dynamicImportSettled();

    expect(mockWarn).toHaveBeenCalledWith('telemetry_init failed:', error);
  });

  it('swallows deferred task failures', async () => {
    const config = makeConfig();
    const error = new Error('network down');
    mockCheckForUpdatesDetailed.mockRejectedValue(error);

    expect(() =>
      startPostRenderPrefetches(config, makeSettings()),
    ).not.toThrow();

    await vi.dynamicImportSettled();

    expect(mockWarn).toHaveBeenCalledWith(
      'Startup update check failed:',
      error,
    );
    expect(mockRecordStartupEvent).toHaveBeenCalledWith(
      'startup_prefetch_failed',
      { name: 'update_check' },
    );
    expect(mockUpdateEventEmit).not.toHaveBeenCalledWith(
      'update-failed',
      expect.anything(),
    );
  });

  it('does not start housekeeping for non-interactive configs', async () => {
    const config = makeConfig({
      isInteractive: () => false,
    } as Partial<Config>);

    startPostRenderPrefetches(config, makeSettings());

    await vi.dynamicImportSettled();

    expect(mockStartBackgroundHousekeeping).not.toHaveBeenCalled();
  });

  it('starts post-render prefetch only once per config', async () => {
    const config = makeConfig();

    startPostRenderPrefetches(config, makeSettings());
    startPostRenderPrefetches(config, makeSettings());

    await vi.dynamicImportSettled();

    expect(mockCheckForUpdatesDetailed).toHaveBeenCalledTimes(1);
  });
});
