/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runAcpServer: vi.fn(),
  enableGuard: vi.fn(),
  setPkillSelfProtectionEnabled: vi.fn(),
}));

vi.mock('@qwen-code/core', async (importActual) => {
  const actual = await importActual<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    enableDetachedProcessGuard: mocks.enableGuard,
    setPkillSelfProtectionEnabled: mocks.setPkillSelfProtectionEnabled,
  };
});
vi.mock('../../acp/acpServer.js', () => ({
  runAcpServer: mocks.runAcpServer,
}));
import { runAcpOption } from './acp.js';
import { createMockConfig } from '../../test-utils/mockConfig.js';

describe('runAcpOption', () => {
  type OptionContext = Parameters<typeof runAcpOption>[0];
  type OptionCoordinator = Parameters<typeof runAcpOption>[1];

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runAcpServer.mockResolvedValue(undefined);
  });

  it('starts the ACP client with managed-shell setup', async () => {
    const config = createMockConfig();
    const settings = {};
    const argv = {};
    const startupCoordinator = {
      startAfterModeEntryCleanup: vi.fn(),
    } as unknown as OptionCoordinator;
    const manager = {};
    const managerReady = Promise.resolve(manager);
    const connection = {};
    const server = {};
    const framework = {
      mode: 'acp',
      threadManager: {
        whenCreated: vi.fn(async () => manager),
        whenReady: vi.fn(() => managerReady),
      },
      createAcpServer: vi.fn(() => server),
    };
    const context = {
      phase: 'configured',
      config,
      framework,
      settings: { settings, argv },
    } as unknown as OptionContext;

    await runAcpOption(context, startupCoordinator);

    expect(mocks.setPkillSelfProtectionEnabled).toHaveBeenCalledWith(true);
    expect(mocks.enableGuard).toHaveBeenCalledOnce();
    expect(framework.threadManager.whenCreated).toHaveBeenCalledOnce();
    expect(
      startupCoordinator.startAfterModeEntryCleanup,
    ).toHaveBeenCalledWith();
    expect(mocks.runAcpServer).toHaveBeenCalledOnce();
    const createServer = mocks.runAcpServer.mock.calls[0]?.[0] as (
      connection: unknown,
    ) => unknown;
    expect(createServer(connection)).toBe(server);
    expect(framework.createAcpServer).toHaveBeenCalledWith({
      argv,
      connection,
      manager,
      managerReady,
    });
  });
});
