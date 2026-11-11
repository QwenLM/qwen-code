/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InstalledPluginsState } from './installedPluginsManager.js';

const loadInstalledPluginsFresh = vi.hoisted(() => vi.fn());
const updatePluginOp = vi.hoisted(() => vi.fn());
const getPluginById = vi.hoisted(() => vi.fn());
const loadKnownMarketplacesConfig = vi.hoisted(() => vi.fn());
const refreshMarketplace = vi.hoisted(() => vi.fn());

vi.mock('./installedPluginsManager.js', () => ({
  loadInstalledPluginsFresh,
}));
vi.mock('./pluginOperations.js', () => ({ updatePluginOp }));
vi.mock('./marketplaceManager.js', () => ({
  getPluginById,
  loadKnownMarketplacesConfig,
  refreshMarketplace,
}));
vi.mock('../pluginLoader.js', () => ({ loadPluginFromDirectory: vi.fn() }));
vi.mock('../pluginPolicy.js', () => ({
  getEffectiveBlockedMarketplaces: vi.fn().mockReturnValue([]),
}));

const { startAutoUpdateScheduler, stopAutoUpdateScheduler } = await import(
  './pluginAutoUpdate.js'
);

function seedState(plugins: InstalledPluginsState['plugins']): void {
  loadInstalledPluginsFresh.mockReturnValue({ version: 2, plugins });
}

function seedMarketplaces(
  marketplaces: Record<string, { autoUpdate?: boolean }> = {
    mp: { autoUpdate: true },
  },
): void {
  loadKnownMarketplacesConfig.mockReturnValue(marketplaces);
}

const userEntry = {
  scope: 'user' as const,
  installPath: '/cache/p/1.0.0',
  version: '1.0.0',
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  seedMarketplaces();
  refreshMarketplace.mockResolvedValue({ name: 'mp', plugins: [] });
  getPluginById.mockResolvedValue({
    entry: { name: 'p', source: 'p', version: '2.0.0' },
    marketplaceName: 'mp',
    marketplaceInstallLocation: '/marketplaces/mp',
  });
  updatePluginOp.mockResolvedValue({ ok: true, version: '2.0.0' });
});

afterEach(() => {
  stopAutoUpdateScheduler();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('pluginAutoUpdate scheduler', () => {
  it('uses the supplied manager for selection and execution after refreshing marketplaces', async () => {
    const candidate = { pluginId: 'owned-by-product@mp', entry: userEntry };
    const manager = {
      collectAutoUpdateCandidates: vi.fn(() => [candidate]),
      checkAndUpdatePlugin: vi.fn(async () => ({
        pluginId: candidate.pluginId,
        scope: userEntry.scope,
        updated: true,
      })),
    };
    const onUpdateResult = vi.fn();
    startAutoUpdateScheduler({ enabled: true, manager, onUpdateResult });
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(refreshMarketplace.mock.invocationCallOrder[0]).toBeLessThan(
      manager.collectAutoUpdateCandidates.mock.invocationCallOrder[0],
    );
    expect(manager.checkAndUpdatePlugin).toHaveBeenCalledWith(candidate);
    expect(onUpdateResult).toHaveBeenCalledWith([
      expect.objectContaining({ pluginId: candidate.pluginId, updated: true }),
    ]);
    expect(loadInstalledPluginsFresh).not.toHaveBeenCalled();
    expect(updatePluginOp).not.toHaveBeenCalled();
  });

  it('runs once per session, with no repeating timer', async () => {
    seedState({ 'p@mp': [userEntry] });

    startAutoUpdateScheduler({ enabled: true });

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(updatePluginOp).toHaveBeenCalledTimes(1);

    // A periodic scheduler would fire again over the next several hours.
    await vi.advanceTimersByTimeAsync(8 * 60 * 60 * 1000);
    expect(updatePluginOp).toHaveBeenCalledTimes(1);
  });

  it('delays the check by a jitter within [0, 10min)', async () => {
    seedState({ 'p@mp': [userEntry] });
    vi.spyOn(Math, 'random').mockReturnValue(0.99);

    startAutoUpdateScheduler({ enabled: true });

    await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
    expect(updatePluginOp).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(updatePluginOp).toHaveBeenCalledTimes(1);
  });

  it('updates nothing when there is no candidate', async () => {
    seedState({});

    startAutoUpdateScheduler({ enabled: true });

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(updatePluginOp).not.toHaveBeenCalled();
    expect(getPluginById).not.toHaveBeenCalled();
  });

  it('skips the check entirely once stopped', async () => {
    seedState({ 'p@mp': [userEntry] });

    startAutoUpdateScheduler({ enabled: true });
    stopAutoUpdateScheduler();

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(updatePluginOp).not.toHaveBeenCalled();
  });

  it('will not schedule a second check after the first one ran', async () => {
    seedState({ 'p@mp': [userEntry] });

    startAutoUpdateScheduler({ enabled: true });
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(updatePluginOp).toHaveBeenCalledTimes(1);

    // The timer cleared itself; that must not look like "never scheduled".
    startAutoUpdateScheduler({ enabled: true });
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(updatePluginOp).toHaveBeenCalledTimes(1);
  });

  it('treats an unreadable state file as having no candidates', async () => {
    loadInstalledPluginsFresh.mockReturnValue(null);

    startAutoUpdateScheduler({ enabled: true });

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(updatePluginOp).not.toHaveBeenCalled();
  });

  it('does nothing when disabled by settings', async () => {
    seedState({ 'p@mp': [userEntry] });

    startAutoUpdateScheduler({ enabled: false });

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(loadInstalledPluginsFresh).not.toHaveBeenCalled();
    expect(updatePluginOp).not.toHaveBeenCalled();
  });
});

describe('pluginAutoUpdate candidate selection', () => {
  it('refreshes an auto-update marketplace before checking plugin versions', async () => {
    seedState({ 'p@mp': [userEntry] });

    startAutoUpdateScheduler({ enabled: true });

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(refreshMarketplace).toHaveBeenCalledWith('mp');
    expect(refreshMarketplace.mock.invocationCallOrder[0]).toBeLessThan(
      getPluginById.mock.invocationCallOrder[0],
    );
  });

  it('skips both refresh and plugin updates when marketplace auto-update is disabled', async () => {
    seedMarketplaces({ mp: { autoUpdate: false } });
    seedState({ 'p@mp': [userEntry] });

    startAutoUpdateScheduler({ enabled: true });

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(refreshMarketplace).not.toHaveBeenCalled();
    expect(getPluginById).not.toHaveBeenCalled();
    expect(updatePluginOp).not.toHaveBeenCalled();
  });

  it('defaults an older marketplace without an auto-update flag to enabled', async () => {
    seedMarketplaces({ mp: {} });
    seedState({ 'p@mp': [userEntry] });

    startAutoUpdateScheduler({ enabled: true });

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(refreshMarketplace).toHaveBeenCalledWith('mp');
    expect(updatePluginOp).toHaveBeenCalledTimes(1);
  });

  it('refreshes at most three marketplaces concurrently', async () => {
    seedMarketplaces(
      Object.fromEntries(
        Array.from({ length: 7 }, (_, index) => [
          `mp-${index}`,
          { autoUpdate: true },
        ]),
      ),
    );
    seedState({});
    let activeRefreshes = 0;
    let maxActiveRefreshes = 0;
    refreshMarketplace.mockImplementation(async () => {
      activeRefreshes++;
      maxActiveRefreshes = Math.max(maxActiveRefreshes, activeRefreshes);
      await new Promise((resolve) => setTimeout(resolve, 100));
      activeRefreshes--;
      return { name: 'mp', plugins: [] };
    });

    startAutoUpdateScheduler({ enabled: true });

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(refreshMarketplace).toHaveBeenCalledTimes(7);
    expect(maxActiveRefreshes).toBe(3);
  });

  it('does not update plugins from a marketplace whose refresh failed', async () => {
    seedState({ 'p@mp': [userEntry] });
    refreshMarketplace.mockRejectedValue(new Error('offline'));

    startAutoUpdateScheduler({ enabled: true });

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(getPluginById).not.toHaveBeenCalled();
    expect(updatePluginOp).not.toHaveBeenCalled();
  });

  it('updates every non-managed installation scope', async () => {
    seedState({
      'p@mp': [
        userEntry,
        {
          scope: 'project',
          projectPath: '/workspace/project-a',
          installPath: '/cache/p/project',
          version: '1.0.0',
        },
      ],
    });

    startAutoUpdateScheduler({ enabled: true });

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(updatePluginOp).toHaveBeenCalledTimes(2);
    expect(updatePluginOp).toHaveBeenCalledWith('p@mp', 'user', {
      projectPath: undefined,
    });
    expect(updatePluginOp).toHaveBeenCalledWith('p@mp', 'project', {
      projectPath: '/workspace/project-a',
    });
  });

  it('skips enterprise-managed entries', async () => {
    seedState({
      'ent@qoder-enterprise-acme': [
        {
          scope: 'managed',
          installPath: '/cache/ent/1.0.0',
          version: '1.0.0',
          orgId: 'acme',
        },
      ],
    });

    startAutoUpdateScheduler({ enabled: true });

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(updatePluginOp).not.toHaveBeenCalled();
  });

  it('still updates a user entry that shadows a managed one', async () => {
    seedState({
      'p@mp': [
        { scope: 'managed', installPath: '/cache/p/managed', version: '0.9.0' },
        userEntry,
      ],
    });

    startAutoUpdateScheduler({ enabled: true });

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(updatePluginOp).toHaveBeenCalledWith(
      'p@mp',
      'user',
      expect.anything(),
    );
  });

  it('skips local-only plugins', async () => {
    seedState({ 'p@local': [userEntry] });

    startAutoUpdateScheduler({ enabled: true });

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(updatePluginOp).not.toHaveBeenCalled();
  });

  it('reads state fresh so a concurrent uninstall is honoured', async () => {
    seedState({ 'p@mp': [userEntry] });

    startAutoUpdateScheduler({ enabled: true });

    // Another process uninstalls it while the jitter delay is pending.
    seedState({});

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(updatePluginOp).not.toHaveBeenCalled();
  });
});
