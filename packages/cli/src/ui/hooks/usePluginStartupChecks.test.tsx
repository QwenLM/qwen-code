/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BRAND_CLI_BIN } from '@qwen-code/core';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Config } from '@qwen-code/core';
import {
  clearAllPluginCaches,
  invalidateInstalledPluginsCache,
} from '@qwen-code/core';
import { renderHook } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import {
  AppEvent,
  appEvents,
  LONG_TRANSIENT_MESSAGE_DURATION_MS,
  TransientMessageType,
} from '../../utils/events.js';
import {
  createTestMergedSettings,
  type LoadedSettings,
} from '../../config/settings.js';
import { migrateLegacyPluginIdentities } from '@qwen-code/core/plugin-management';
import { usePluginStartupChecks } from './usePluginStartupChecks.js';

const reconcileInstalledStateMock = vi.hoisted(() => vi.fn());
const startAutoUpdateMock = vi.hoisted(() => vi.fn());

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    invalidateInstalledPluginsCache: vi.fn(),
    clearAllPluginCaches: vi.fn(),
    stopAutoUpdateScheduler: vi.fn(),
    runLogger: {
      log: vi.fn(),
      warn: vi.fn(),
    },
  };
});

vi.mock('@qwen-code/core/plugin-management', () => ({
  migrateLegacyPluginIdentities: vi.fn(async () => false),
  createCorePluginManager: vi.fn(() => ({
    reconcileInstalledState: reconcileInstalledStateMock,
    startAutoUpdate: startAutoUpdateMock,
  })),
}));

function createSettings(): LoadedSettings {
  return {
    merged: createTestMergedSettings({
      enabledPlugins: {
        'enabled@mp': true,
        'disabled@mp': false,
      },
    }),
  } as LoadedSettings;
}

describe('usePluginStartupChecks', () => {
  beforeEach(() => {
    reconcileInstalledStateMock.mockReset();
    vi.mocked(migrateLegacyPluginIdentities).mockResolvedValue(false);
    reconcileInstalledStateMock.mockResolvedValue({
      changed: true,
      marketplaces: { installed: 0, updated: 1, failed: 0, skipped: 0 },
      plugins: { installed: [], failed: [], missing: [] },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows plugin refresh success as a long transient message', async () => {
    const emitSpy = vi.spyOn(appEvents, 'emit');
    const settings = createSettings();

    const { result, unmount } = await renderHook(() =>
      usePluginStartupChecks({
        config: {} as Config,
        settings,
        isTrusted: true,
      }),
    );

    await waitFor(() => {
      expect(result.current.needsRefresh).toBe(true);
    });

    expect(invalidateInstalledPluginsCache).toHaveBeenCalled();
    expect(clearAllPluginCaches).toHaveBeenCalledWith({
      clearOrphanExclusions: false,
    });
    expect(reconcileInstalledStateMock).toHaveBeenCalledWith({
      includeProjectMarketplaces: true,
      onProgress: expect.any(Function),
    });
    expect(emitSpy).toHaveBeenCalledWith(AppEvent.TransientMessage, {
      id: 'plugins-startup-updated',
      message: 'Plugin configuration updated. Run /plugins reload to apply.',
      type: TransientMessageType.Success,
      durationMs: LONG_TRANSIENT_MESSAGE_DURATION_MS,
    });

    unmount();
  });

  it('requests a reload when legacy identities migrate without reinstalling', async () => {
    vi.mocked(migrateLegacyPluginIdentities).mockResolvedValue(true);
    reconcileInstalledStateMock.mockResolvedValue({
      changed: false,
      marketplaces: { installed: 0, updated: 0, failed: 0, skipped: 0 },
      plugins: { installed: [], failed: [], missing: [] },
    });

    const { result, unmount } = await renderHook(() =>
      usePluginStartupChecks({
        config: {} as Config,
        settings: createSettings(),
        isTrusted: true,
      }),
    );

    await waitFor(() => {
      expect(result.current.needsRefresh).toBe(true);
    });
    expect(invalidateInstalledPluginsCache).toHaveBeenCalled();
    expect(clearAllPluginCaches).toHaveBeenCalled();

    unmount();
  });

  it('starts the auto-update scheduler after the reconcile settles', async () => {
    let reconcileDone = false;
    reconcileInstalledStateMock.mockImplementation(async () => {
      expect(startAutoUpdateMock).not.toHaveBeenCalled();
      reconcileDone = true;
      return {
        changed: false,
        marketplaces: { installed: 0, updated: 0, failed: 0, skipped: 0 },
        plugins: { installed: [], failed: [], missing: [] },
      };
    });

    const { unmount } = await renderHook(() =>
      usePluginStartupChecks({
        config: {} as Config,
        settings: createSettings(),
        isTrusted: true,
      }),
    );

    await waitFor(() => {
      expect(startAutoUpdateMock).toHaveBeenCalledTimes(1);
    });
    expect(reconcileDone).toBe(true);
    expect(startAutoUpdateMock.mock.calls[0][0]).toMatchObject({
      enabled: true,
    });

    unmount();
  });

  it('shows a scoped install command for a missing external plugin', async () => {
    const emitSpy = vi.spyOn(appEvents, 'emit');
    reconcileInstalledStateMock.mockResolvedValue({
      changed: false,
      marketplaces: { installed: 0, updated: 0, failed: 0, skipped: 0 },
      plugins: {
        installed: [],
        failed: [],
        missing: [
          {
            pluginId: 'enabled@mp',
            scope: 'project',
            reason: 'not-installed',
          },
        ],
      },
    });

    const { unmount } = await renderHook(() =>
      usePluginStartupChecks({
        config: {} as Config,
        settings: createSettings(),
        isTrusted: true,
      }),
    );

    await waitFor(() => {
      expect(emitSpy).toHaveBeenCalledWith(AppEvent.TransientMessage, {
        id: 'plugins-not-installed',
        message:
          `Plugin "enabled@mp" is enabled for scope "project" but is not installed. Run \`${BRAND_CLI_BIN} plugins install enabled@mp --scope project\`.`,
        type: TransientMessageType.Warning,
        durationMs: LONG_TRANSIENT_MESSAGE_DURATION_MS,
      });
    });

    unmount();
  });

  it('summarizes multiple actionable missing installations in one line', async () => {
    const emitSpy = vi.spyOn(appEvents, 'emit');
    reconcileInstalledStateMock.mockResolvedValue({
      changed: false,
      marketplaces: { installed: 0, updated: 0, failed: 0, skipped: 0 },
      plugins: {
        installed: [],
        failed: [],
        missing: [
          { pluginId: 'a@mp', scope: 'user', reason: 'not-installed' },
          { pluginId: 'b@mp', scope: 'project', reason: 'not-installed' },
        ],
      },
    });

    const { unmount } = await renderHook(() =>
      usePluginStartupChecks({
        config: {} as Config,
        settings: createSettings(),
        isTrusted: true,
      }),
    );

    await waitFor(() => {
      expect(emitSpy).toHaveBeenCalledWith(
        AppEvent.TransientMessage,
        expect.objectContaining({
          id: 'plugins-not-installed',
          message:
            '2 enabled plugins are not installed. Run /plugins to install them.',
        }),
      );
    });

    unmount();
  });
});
