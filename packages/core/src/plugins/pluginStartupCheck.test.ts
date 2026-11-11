/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const startupMocks = vi.hoisted(() => ({
  isPluginInstalled: vi.fn(),
  isPluginInstalledForCwd: vi.fn(),
  getPluginByIdCacheOnly: vi.fn(),
}));

vi.mock('./management/pluginInstallationHelpers.js', () => ({
  installResolvedPlugin: vi.fn(),
}));

vi.mock('./management/installedPluginsManager.js', () => ({
  isPluginInstalled: startupMocks.isPluginInstalled,
  isPluginInstalledForCwd: startupMocks.isPluginInstalledForCwd,
}));

vi.mock('./management/marketplaceManager.js', () => ({
  getPluginByIdCacheOnly: startupMocks.getPluginByIdCacheOnly,
}));

vi.mock('../utils/runLogger.js', () => ({
  runLogger: {
    log: vi.fn(),
    warn: vi.fn(),
  },
}));

import { runLogger } from '../utils/runLogger.js';
import { installResolvedPlugin } from './management/pluginInstallationHelpers.js';
import {
  findMissingPlugins,
  installSelectedPlugins,
} from './pluginStartupCheck.js';

describe('installSelectedPlugins', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    startupMocks.isPluginInstalled.mockReturnValue(false);
    startupMocks.isPluginInstalledForCwd.mockReturnValue(false);
    startupMocks.getPluginByIdCacheOnly.mockResolvedValue(null);
    vi.mocked(installResolvedPlugin).mockResolvedValue({
      ok: true,
      pluginId: 'demo@market',
      installPath: '/plugins/demo',
      version: '1.0.0',
    });
  });

  it('re-checks desired state before an asynchronous startup install', async () => {
    const result = await installSelectedPlugins(['demo@market'], 'user', {
      shouldInstall: () => false,
    });

    expect(installResolvedPlugin).not.toHaveBeenCalled();
    expect(result).toEqual({ installed: [], failed: [] });
  });

  it('installs a plugin that is still enabled', async () => {
    const result = await installSelectedPlugins(['demo@market'], 'user', {
      shouldInstall: () => true,
    });

    expect(installResolvedPlugin).toHaveBeenCalledWith(
      'demo@market',
      'user',
      expect.objectContaining({}),
    );
    expect(result.installed).toEqual(['demo@market']);
  });

  it('treats an installation from another project as missing in this cwd', async () => {
    startupMocks.getPluginByIdCacheOnly.mockResolvedValue({
      entry: {
        name: 'demo',
        source: { source: 'github', repo: 'owner/demo' },
      },
      marketplaceName: 'market',
    });

    await expect(
      findMissingPlugins(['demo@market'], '/workspace/current'),
    ).resolves.toEqual([
      { pluginId: 'demo@market', reason: 'not-installed' },
    ]);
    expect(startupMocks.isPluginInstalledForCwd).toHaveBeenCalledWith(
      'demo@market',
      '/workspace/current',
    );
  });

  it('does not require installation for a local-path marketplace plugin', async () => {
    startupMocks.getPluginByIdCacheOnly.mockResolvedValue({
      entry: { name: 'demo', source: '/market/plugins/demo' },
      marketplaceName: 'market',
    });

    await expect(
      findMissingPlugins(['demo@market'], '/workspace/current'),
    ).resolves.toEqual([]);
  });

  it('ignores unresolved shared settings intent and records it at info level', async () => {
    await expect(
      findMissingPlugins(['orphan@project-market'], '/workspace/current'),
    ).resolves.toEqual([]);
    expect(runLogger.log).toHaveBeenCalledWith(
      expect.stringContaining('Ignoring enabled plugin intent "orphan@project-market"'),
    );
    expect(runLogger.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['local-plugin@local', 'local plugin intent'],
    ['managed@qoder-enterprise-acme', 'enterprise-managed plugin intent'],
    ['managed@qoderwork-enterprise-acme', 'enterprise-managed plugin intent'],
  ])('does not use ordinary marketplace lookup for %s', async (pluginId, logKind) => {
    await expect(
      findMissingPlugins([pluginId], '/workspace/current'),
    ).resolves.toEqual([]);
    expect(startupMocks.getPluginByIdCacheOnly).not.toHaveBeenCalled();
    expect(runLogger.log).toHaveBeenCalledWith(expect.stringContaining(logKind));
  });
});
