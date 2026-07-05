/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../config/settings.js';
import {
  startEarlyStartupPrefetches,
  startPostRenderPrefetches,
} from './startup-prefetch.js';

const mockDebug = vi.hoisted(() => vi.fn());
const mockWarn = vi.hoisted(() => vi.fn());
const mockPreconnectApi = vi.hoisted(() => vi.fn());
const mockRecordStartupEvent = vi.hoisted(() => vi.fn());
const mockCheckForUpdates = vi.hoisted(() => vi.fn());
const mockHandleAutoUpdate = vi.hoisted(() => vi.fn());
const mockConnectIdeForStartup = vi.hoisted(() => vi.fn());
const mockInitializeTelemetry = vi.hoisted(() => vi.fn());
const mockStartBackgroundHousekeeping = vi.hoisted(() => vi.fn());

vi.mock('@qwen-code/qwen-code-core', () => ({
  createDebugLogger: () => ({
    debug: mockDebug,
    warn: mockWarn,
  }),
  initializeTelemetry: (...args: unknown[]) => mockInitializeTelemetry(...args),
}));

vi.mock('../utils/apiPreconnect.js', () => ({
  preconnectApi: (...args: unknown[]) => mockPreconnectApi(...args),
}));

vi.mock('../utils/startupProfiler.js', () => ({
  recordStartupEvent: (...args: unknown[]) => mockRecordStartupEvent(...args),
}));

vi.mock('../ui/utils/updateCheck.js', () => ({
  checkForUpdates: (...args: unknown[]) => mockCheckForUpdates(...args),
}));

vi.mock('../utils/handleAutoUpdate.js', () => ({
  handleAutoUpdate: (...args: unknown[]) => mockHandleAutoUpdate(...args),
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
    mockCheckForUpdates.mockResolvedValue(null);
    mockConnectIdeForStartup.mockResolvedValue(undefined);
  });

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

  it('starts post-render tasks without awaiting completion', async () => {
    const config = makeConfig();
    const updatePromise = new Promise<null>(() => {});
    mockCheckForUpdates.mockReturnValue(updatePromise);

    startPostRenderPrefetches(config, makeSettings(), { connectIde: true });

    await vi.dynamicImportSettled();

    expect(mockCheckForUpdates).toHaveBeenCalledTimes(1);
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

    expect(mockCheckForUpdates).not.toHaveBeenCalled();
    expect(mockConnectIdeForStartup).toHaveBeenCalledWith(config);
  });

  it('requires connectIde option before connecting IDE', async () => {
    const config = makeConfig();

    startPostRenderPrefetches(config, makeSettings());

    await vi.dynamicImportSettled();

    expect(mockConnectIdeForStartup).not.toHaveBeenCalled();
  });

  it('does not connect IDE when IDE mode is disabled', async () => {
    const config = makeConfig({ getIdeMode: () => false } as Partial<Config>);

    startPostRenderPrefetches(config, makeSettings(), { connectIde: true });

    await vi.dynamicImportSettled();

    expect(mockConnectIdeForStartup).not.toHaveBeenCalled();
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
    mockCheckForUpdates.mockRejectedValue(error);

    expect(() =>
      startPostRenderPrefetches(config, makeSettings()),
    ).not.toThrow();

    await vi.dynamicImportSettled();

    expect(mockWarn).toHaveBeenCalledWith('update_check failed:', error);
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

    expect(mockCheckForUpdates).toHaveBeenCalledTimes(1);
  });
});
