/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const addMarketplaceSource = vi.hoisted(() => vi.fn());
const loadKnownMarketplacesConfig = vi.hoisted(() => vi.fn());
const replaceMarketplaceSource = vi.hoisted(() => vi.fn());

vi.mock('./management/marketplaceManager.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('./management/marketplaceManager.js')
    >();
  return {
    ...actual,
    addMarketplaceSource,
    loadKnownMarketplacesConfig,
    replaceMarketplaceSource,
  };
});

const { diffMarketplaces, reconcileMarketplaces } = await import(
  './reconciler.js'
);

beforeEach(() => {
  vi.clearAllMocks();
  loadKnownMarketplacesConfig.mockReturnValue({
    team: {
      source: { source: 'git', url: 'https://example.com/old.git' },
      installLocation: '/cache/team',
      lastUpdated: '2026-01-01T00:00:00.000Z',
      autoUpdate: true,
    },
  });
  replaceMarketplaceSource.mockResolvedValue({
    name: 'team',
    plugins: [],
  });
});

describe('reconcileMarketplaces', () => {
  it('reconciles a changed source even when marketplace auto-update is disabled', async () => {
    loadKnownMarketplacesConfig.mockReturnValue({
      team: {
        source: { source: 'git', url: 'https://example.com/old.git' },
        installLocation: '/cache/team',
        lastUpdated: '2026-01-01T00:00:00.000Z',
        autoUpdate: false,
      },
    });
    const declaredSource = {
      source: 'git' as const,
      url: 'https://example.com/new.git',
    };

    const onProgress = vi.fn();
    const result = await reconcileMarketplaces(
      {
        team: { name: 'team', source: declaredSource },
      },
      { onProgress },
    );

    expect(replaceMarketplaceSource).toHaveBeenCalledWith(
      'team',
      declaredSource,
    );
    expect(addMarketplaceSource).not.toHaveBeenCalled();
    expect(result.updated).toEqual(['team']);
    expect(onProgress).toHaveBeenNthCalledWith(1, {
      type: 'installing',
      name: 'team',
      action: 'update',
    });
    expect(onProgress).toHaveBeenNthCalledWith(2, {
      type: 'installed',
      name: 'team',
      action: 'update',
    });
  });

  it('treats structurally equal sources as unchanged regardless of key order', () => {
    const declaredSource = {
      url: 'https://example.com/team.git',
      source: 'git' as const,
      ref: 'main',
    };
    const materializedSource = {
      source: 'git' as const,
      ref: 'main',
      url: 'https://example.com/team.git',
    };

    const diff = diffMarketplaces(
      {
        team: { name: 'team', source: declaredSource },
      },
      {
        team: {
          source: materializedSource,
          installLocation: '/cache/team',
          lastUpdated: '2026-01-01T00:00:00.000Z',
          autoUpdate: false,
        },
      },
    );

    expect(diff).toEqual({
      missing: [],
      sourceChanged: [],
      upToDate: ['team'],
    });
  });
});
