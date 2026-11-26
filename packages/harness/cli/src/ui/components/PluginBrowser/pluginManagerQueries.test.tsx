/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import {
  PluginManager,
  type Config,
  type PluginMarketplace,
} from '@qwen-code/core';
import { DiscoverPlugins } from './DiscoverPlugins.js';
import { BrowseMarketplace } from './BrowseMarketplace.js';
import { renderWithProviders } from '../../../test-utils/render.js';
import { createMockSettings } from '../../../test-utils/settings.js';

vi.mock('@qwen-code/core', async (original) => ({
  ...(await original<typeof import('@qwen-code/core')>()),
  loadKnownMarketplacesConfig: () => ({ mp: { source: 'owner/repo' } }),
  isPluginInstalledForCwd: () => false,
  getMarketplace: () => {
    throw new Error('Plugin queries must use the manager');
  },
}));

describe('plugin browser manager queries', () => {
  it.each(['discover', 'browse'] as const)(
    'uses the product manager result in %s',
    async (view) => {
      const settings = createMockSettings();
      let resolveQuery!: (marketplace: PluginMarketplace) => void;
      const query = vi.fn(
        () =>
          new Promise<PluginMarketplace>((resolve) => {
            resolveQuery = resolve;
          }),
      );
      class ProductManager extends PluginManager {
        override getMarketplacePlugins = query;
      }
      const factory = vi.fn(
        (host: ConstructorParameters<typeof PluginManager>[0]) =>
          new ProductManager(host),
      );
      const config = {
        getSessionArtifactProjectRoot: () => '/workspace/项目 with spaces',
        getPluginManagerFactory: () => factory,
      } as unknown as Config;
      const props = { config, settings, onClose: vi.fn() };
      const rendered = await renderWithProviders(
        view === 'discover' ? (
          <DiscoverPlugins {...props} />
        ) : (
          <BrowseMarketplace {...props} marketplace="mp" />
        ),
        { settings },
      );
      try {
        await act(async () => {
          resolveQuery({
            name: 'mp',
            plugins: [
              {
                name: 'visible-from-manager',
                source: './visible',
                description: 'Product-selected plugin',
              },
            ],
          } as PluginMarketplace);
        });
        await rendered.waitUntilReady();
        await vi.waitFor(() =>
          expect(rendered.lastFrame()).toContain('visible-from-manager'),
        );
        expect(query).toHaveBeenCalledWith('mp');
        expect(factory).toHaveBeenCalledWith(
          expect.objectContaining({ cwd: '/workspace/项目 with spaces' }),
        );
      } finally {
        rendered.unmount();
      }
    },
  );
});
