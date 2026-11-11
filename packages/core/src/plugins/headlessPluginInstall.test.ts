/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BRAND_CLI_BIN } from '../config/brand.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkEnabledPlugins: vi.fn(),
  reconcileMarketplaces: vi.fn(),
  emitSessionPhaseStarted: vi.fn(),
  emitSessionPhaseFinished: vi.fn(),
  runLoggerLog: vi.fn(),
  runLoggerWarn: vi.fn(),
}));

vi.mock('./pluginStartupCheck.js', () => ({
  checkEnabledPlugins: mocks.checkEnabledPlugins,
}));

vi.mock('./reconciler.js', () => ({
  reconcileMarketplaces: mocks.reconcileMarketplaces,
}));

vi.mock('../utils/diagnosticInterceptors.js', () => ({
  emitSessionPhaseStarted: mocks.emitSessionPhaseStarted,
  emitSessionPhaseFinished: mocks.emitSessionPhaseFinished,
}));

vi.mock('../utils/runLogger.js', () => ({
  runLogger: {
    log: mocks.runLoggerLog,
    warn: mocks.runLoggerWarn,
  },
}));

vi.mock('./management/marketplaceManager.js', () => ({
  clearMarketplacesCache: vi.fn(),
}));

vi.mock('./zipCache.js', () => ({
  cleanupSessionPluginCache: vi.fn(),
  getZipCacheMarketplacesDir: vi.fn(() => '/tmp/marketplaces'),
  getZipCachePluginsDir: vi.fn(() => '/tmp/plugins'),
  isMarketplaceSourceSupportedByZipCache: vi.fn(() => true),
  isPluginZipCacheEnabled: vi.fn(() => false),
}));

vi.mock('./zipCacheAdapters.js', () => ({
  syncMarketplacesToZipCache: vi.fn(),
}));

import { reconcilePluginsForStartup } from './headlessPluginInstall.js';

describe('reconcilePluginsForStartup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkEnabledPlugins.mockResolvedValue([]);
    mocks.reconcileMarketplaces.mockResolvedValue({
      installed: [],
      updated: [],
      failed: [],
      skipped: [],
    });
  });

  it('reports missing external plugins without installing them', async () => {
    mocks.checkEnabledPlugins.mockResolvedValue([
      { pluginId: 'demo@market', reason: 'not-installed' },
    ]);
    const onProgress = vi.fn();

    const result = await reconcilePluginsForStartup({
      declaredMarketplaces: {},
      enabledPluginIds: ['demo@market'],
      scope: 'user',
      projectPath: '/workspace/project',
      getPluginScope: () => 'project',
      onProgress,
    });

    expect(mocks.checkEnabledPlugins).toHaveBeenCalledWith(
      ['demo@market'],
      undefined,
      '/workspace/project',
    );
    expect(result).toEqual({
      changed: false,
      marketplaces: { installed: 0, updated: 0, failed: 0, skipped: 0 },
      plugins: {
        installed: [],
        failed: [],
        missing: [
          {
            pluginId: 'demo@market',
            scope: 'project',
            reason: 'not-installed',
          },
        ],
      },
    });
    expect(onProgress).toHaveBeenCalledWith(
      `Plugin "demo@market" is enabled for scope "project" but is not installed. Run \`${BRAND_CLI_BIN} plugins install demo@market --scope project\`.`,
    );
  });

  it('keeps an empty missing result when shared settings intent is not actionable', async () => {
    const result = await reconcilePluginsForStartup({
      declaredMarketplaces: {},
      enabledPluginIds: ['orphan@project-market'],
      scope: 'project',
      projectPath: '/workspace/project',
    });

    expect(result.plugins.missing).toEqual([]);
  });

  it('reports source-change reconciliation separately from marketplace installation', async () => {
    mocks.reconcileMarketplaces.mockImplementation(
      async (_declared, options) => {
        options.onProgress({
          type: 'installed',
          name: 'team-market',
          action: 'update',
        });
        return {
          installed: [],
          updated: ['team-market'],
          failed: [],
          skipped: [],
        };
      },
    );
    const onProgress = vi.fn();

    const result = await reconcilePluginsForStartup({
      declaredMarketplaces: {
        'team-market': {
          name: 'team-market',
          source: { source: 'git', url: 'https://example.com/new.git' },
        },
      },
      enabledPluginIds: [],
      scope: 'user',
      onProgress,
    });

    expect(result.marketplaces.updated).toBe(1);
    expect(mocks.runLoggerLog).toHaveBeenCalledWith(
      '[HeadlessInstall] Reconciled marketplace "team-market" to its declared source',
    );
    expect(onProgress).toHaveBeenCalledWith(
      'Reconciled marketplace "team-market" to its declared source',
    );
  });
});
