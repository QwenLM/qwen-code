/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  stdout: { name: 'working-stdout' },
  createWorkingStdio: vi.fn(),
  enableGuard: vi.fn(),
  setPkill: vi.fn(),
  cleanup: vi.fn(async () => true),
  gracefulExit: vi.fn(async () => {}),
}));
mocks.createWorkingStdio.mockReturnValue({ stdout: mocks.stdout });

vi.mock('@qwen-code/core', async (importActual) => {
  const actual = await importActual<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    createWorkingStdio: mocks.createWorkingStdio,
    enableDetachedProcessGuard: mocks.enableGuard,
    setPkillSelfProtectionEnabled: mocks.setPkill,
    StartupDiagnostics: class {
      phase(_name: string, body: () => unknown) {
        return body();
      }
    },
  };
});
vi.mock('../../utils/cleanup.js', () => ({
  gracefulExit: mocks.gracefulExit,
  runExitCleanupWithTimeout: mocks.cleanup,
}));
vi.mock('../route/routeLogging.js', () => ({
  logRouteEntered: vi.fn(),
}));

import { SdkServer } from '../../sdk/sdkServer.js';
import { runSdkOption } from './sdk.js';

describe('runSdkOption', () => {
  type OptionContext = Parameters<typeof runSdkOption>[0];
  type OptionCoordinator = Parameters<typeof runSdkOption>[1];

  const config = {
    getSessionId: () => 'session',
    getTargetDir: () => '/workspace',
  };

  function setup(createSdkServer: (params: unknown) => unknown) {
    const markHostReady = vi.fn();
    const framework = {
      getAppPlugins: () => ({ markHostReady }),
      createSdkServer,
    };
    const startupCoordinator = {
      startAfterModeEntryCleanup: vi.fn(),
    } as unknown as OptionCoordinator;
    const context = {
      phase: 'configured',
      config,
      framework,
      settings: { argv: {}, settings: { merged: {} } },
    } as unknown as OptionContext;
    return { context, startupCoordinator, framework, markHostReady };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cleanup.mockResolvedValue(true);
    mocks.gracefulExit.mockResolvedValue(undefined);
  });

  it('creates the product server with the protocol stdio and runs it', async () => {
    const run = vi.fn(async () => {});
    const createSdkServer = vi.fn(() => ({ run }));
    const { context, startupCoordinator, markHostReady } = setup(createSdkServer);

    await runSdkOption(context, startupCoordinator);

    expect(mocks.setPkill).toHaveBeenCalledWith(true);
    expect(mocks.enableGuard).toHaveBeenCalledOnce();
    expect(markHostReady).toHaveBeenCalledOnce();
    expect(
      startupCoordinator.startAfterModeEntryCleanup,
    ).toHaveBeenCalledWith(config);
    expect(createSdkServer).toHaveBeenCalledWith({
      input: process.stdin,
      output: mocks.stdout,
      config,
      framework: expect.anything(),
    });
    expect(run).toHaveBeenCalledOnce();
    expect(mocks.cleanup).toHaveBeenCalledOnce();
    expect(mocks.gracefulExit).toHaveBeenCalledWith(0, {
      exitReason: 'natural_end',
    });
  });

  it('rejects unsupported builds and still runs common cleanup', async () => {
    const { context, startupCoordinator } = setup(
      (params) => new SdkServer(params as never),
    );

    await expect(runSdkOption(context, startupCoordinator)).rejects.toThrow(
      'SDK daemon mode is not supported by this build',
    );
    expect(mocks.cleanup).toHaveBeenCalledOnce();
    expect(mocks.gracefulExit).not.toHaveBeenCalled();
  });

  it('runs common cleanup when server construction fails', async () => {
    const error = new Error('construction failed');
    const { context, startupCoordinator } = setup(() => {
      throw error;
    });

    await expect(runSdkOption(context, startupCoordinator)).rejects.toBe(error);
    expect(mocks.cleanup).toHaveBeenCalledOnce();
    expect(mocks.gracefulExit).not.toHaveBeenCalled();
  });

  it('runs common cleanup when the server run rejects', async () => {
    const error = new Error('connection failed');
    const { context, startupCoordinator } = setup(() => ({
      run: vi.fn(async () => {
        throw error;
      }),
    }));

    await expect(runSdkOption(context, startupCoordinator)).rejects.toBe(error);
    expect(mocks.cleanup).toHaveBeenCalledOnce();
    expect(mocks.gracefulExit).not.toHaveBeenCalled();
  });
});
