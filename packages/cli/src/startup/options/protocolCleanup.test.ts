/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfiguredStartupContext } from '../startupContext.js';
import type { StartupCoordinator } from '../startupCoordinator.js';

const mocks = vi.hoisted(() => ({
  cleanups: [] as Array<() => void | Promise<void>>,
  stopSource: vi.fn(async () => {}),
  runCleanup: vi.fn(async () => {}),
  acp: vi.fn(async () => {}),
}));

vi.mock('@qwen-code/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qwen-code/core')>()),
  createWorkingStdio: () => ({ stdout: {} }),
  runLogger: { log: vi.fn() },
  setPkillSelfProtectionEnabled: vi.fn(),
  enableDetachedProcessGuard: vi.fn(),
  stopConfigService: mocks.stopSource,
}));
vi.mock('../../utils/cleanup.js', () => ({
  registerCleanup: (callback: () => void | Promise<void>) => {
    mocks.cleanups.push(callback);
  },
  registerExitCancellation: vi.fn(),
  runExitCleanupWithTimeout: mocks.runCleanup,
  gracefulExit: vi.fn(async () => {}),
}));
vi.mock('../route/routeLogging.js', () => ({ logRouteEntered: vi.fn() }));
vi.mock('../../acp/acpServer.js', () => ({ runAcpServer: mocks.acp }));

import { runAcpOption } from './acp.js';

describe('protocol root resource cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cleanups.length = 0;
    mocks.runCleanup.mockImplementation(async () => {
      try {
        for (const callback of mocks.cleanups) await callback();
      } finally {
        // 真正的公共退出流程最后调用 Framework，而不是由协议入口提前关闭来源。
        await mocks.stopSource();
      }
    });
    // The real ACP client invokes common cleanup when the connection closes.
    mocks.acp.mockImplementation(() => mocks.runCleanup());
  });

  function setup() {
    const config = {
      getSessionId: () => 'daemon-test',
      getTargetDir: () => '/test/workspace',
      initialize: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const context = {
      config,
      framework: {
        signal: new AbortController().signal,
        getAppPlugins: () => ({ markHostReady: vi.fn() }),
        mode: 'acp',
        threadManager: {
          whenCreated: vi.fn(async () => ({})),
          whenReady: vi.fn(async () => ({})),
        },
      },
      settings: { argv: {}, settings: { merged: {} } },
    } as unknown as ConfiguredStartupContext;
    const coordinator = {
      startAfterModeEntryCleanup: vi.fn(),
    } as unknown as StartupCoordinator;
    return { config, context, coordinator };
  }

  it('stops Config Service when ACP connection cleanup runs', async () => {
    const { context, coordinator } = setup();
    await runAcpOption(context, coordinator);
    expect(mocks.stopSource).toHaveBeenCalledOnce();
  });
});
