/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/core';
import type { Settings } from '../config/settings.js';
import { buildStartupPolicy } from './startupPolicy.js';
import { StartupCoordinator } from './startupCoordinator.js';
import { registerCleanup } from '../utils/cleanup.js';
import {
  cancelDeferredStartupCleanup,
  startDeferredStartupCleanup,
} from '../utils/deferredStartupTasks.js';
import {
  runAfterAuthAttemptStartup,
  runAfterConfigInitializedStartup,
} from '../core/startupLifecycle.js';

vi.mock('../utils/cleanup.js', () => ({
  registerCleanup: vi.fn(),
}));

vi.mock('../utils/deferredStartupTasks.js', () => ({
  cancelDeferredStartupCleanup: vi.fn(),
  startDeferredStartupCleanup: vi.fn(),
}));

vi.mock('../core/startupLifecycle.js', () => ({
  runAfterAuthAttemptStartup: vi.fn(async () => {}),
  runAfterConfigInitializedStartup: vi.fn(async () => true),
}));

describe('StartupCoordinator', () => {
  const settings = {} as Settings;
  const config = {} as Config;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runAfterConfigInitializedStartup).mockResolvedValue(true);
  });

  it('starts unreferenced cleanup after non-interactive mode entry', () => {
    const coordinator = new StartupCoordinator(
      buildStartupPolicy({ kind: 'headless' }),
      settings,
    );

    coordinator.startAfterModeEntryCleanup(config);

    expect(startDeferredStartupCleanup).toHaveBeenCalledWith(
      settings,
      config,
      {
        delayMs: 5000,
        ref: false,
      },
    );
  });

  it('starts after-render cleanup only for interactive plans', () => {
    const coordinator = new StartupCoordinator(
      buildStartupPolicy({ kind: 'interactive' }),
      settings,
    );

    coordinator.startAfterModeEntryCleanup(config);
    expect(startDeferredStartupCleanup).not.toHaveBeenCalled();

    coordinator.startAfterFirstRenderCleanup(config);
    expect(startDeferredStartupCleanup).toHaveBeenCalledWith(
      settings,
      config,
      {
        delayMs: 5000,
        ref: false,
      },
    );
  });

  it('can exclude project cleanup while the session browser owns resume selection', () => {
    const coordinator = new StartupCoordinator(
      buildStartupPolicy({ kind: 'interactive' }),
      settings,
    );

    coordinator.startAfterFirstRenderCleanup(config, {
      includeProjectCleanup: false,
    });

    expect(startDeferredStartupCleanup).toHaveBeenCalledWith(
      settings,
      config,
      {
        delayMs: 5000,
        ref: false,
        includeProjectCleanup: false,
      },
    );
  });

  it('registers exit cleanup that only cancels a pending timer', async () => {
    const coordinator = new StartupCoordinator(
      buildStartupPolicy({ kind: 'interactive' }),
      settings,
    );

    coordinator.registerStartupCleanupOnExit();
    const cleanup = vi.mocked(registerCleanup).mock.calls[0][0];
    await cleanup();

    expect(cancelDeferredStartupCleanup).toHaveBeenCalledWith(settings);
  });

  it('delegates auth-attempt lifecycle work', async () => {
    const coordinator = new StartupCoordinator(
      buildStartupPolicy({ kind: 'headless' }),
      settings,
    );

    await coordinator.runAfterAuthAttemptStartup(config);

    expect(runAfterAuthAttemptStartup).toHaveBeenCalledWith(config);
  });

  it('delegates config-initialized lifecycle work', async () => {
    const coordinator = new StartupCoordinator(
      buildStartupPolicy({ kind: 'headless' }),
      settings,
    );

    await expect(
      coordinator.runAfterConfigInitializedStartup(config),
    ).resolves.toBe(true);

    expect(runAfterConfigInitializedStartup).toHaveBeenCalledWith(config);
  });
});
