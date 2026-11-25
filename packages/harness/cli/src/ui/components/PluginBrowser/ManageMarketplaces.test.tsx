/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ManageMarketplaces } from './ManageMarketplaces.js';
import { renderWithProviders } from '../../../test-utils/render.js';
import { createMockSettings } from '../../../test-utils/settings.js';
import type { Key } from '../../contexts/KeypressContext.js';

const coreMocks = vi.hoisted(() => ({
  getEffectiveBlockedMarketplaces: vi.fn(() => []),
  getInstalledPluginsForMarketplace: vi.fn(() => ({ pluginIds: [] })),
  getMarketplace: vi.fn(async () => ({ plugins: [] })),
  loadKnownMarketplacesConfig: vi.fn(() => ({
    'team-market': {
      source: 'owner/repo',
      installLocation: '/tmp/team-market',
      autoUpdate: true,
    },
  })),
  setMarketplaceAutoUpdate: vi.fn(),
}));

const serviceMocks = vi.hoisted(() => ({
  removeMarketplaceForCommand: vi.fn(),
  updateMarketplaceForCommand: vi.fn(),
}));

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return { ...actual, ...coreMocks };
});

vi.mock('@qwen-code/core/plugin-management', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@qwen-code/core/plugin-management')
  >();
  return { ...actual, ...serviceMocks };
});

const KEY: Key = {
  name: 'enter',
  sequence: '\r',
  insertable: false,
  shift: false,
  alt: false,
  ctrl: false,
  cmd: false,
};

describe('ManageMarketplaces', () => {
  it('routes marketplace refresh through the plugin command service', async () => {
    const settings = createMockSettings();
    let resolveMarketplace!: (value: { plugins: never[] }) => void;
    coreMocks.getMarketplace.mockReturnValue(
      new Promise((resolve) => {
        resolveMarketplace = resolve;
      }),
    );
    let resolveRefresh!: (value: string) => void;
    serviceMocks.updateMarketplaceForCommand.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveRefresh = resolve;
      }),
    );

    const { capturedRegistry, lastFrame, waitUntilReady, unmount } =
      await renderWithProviders(
        <ManageMarketplaces settings={settings} onClose={vi.fn()} />,
        { settings },
      );
    await waitUntilReady();
    await act(async () => {
      resolveMarketplace({ plugins: [] });
    });
    await waitUntilReady();
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('team-market');
    });

    await act(async () => {
      capturedRegistry?.invokeAction('Dialog', 'dialog:navigate:down', KEY);
    });
    await waitUntilReady();
    await act(async () => {
      capturedRegistry?.invokeAction('Dialog', 'dialog:confirm', KEY);
    });
    await waitUntilReady();
    expect(lastFrame()).toContain('↻ Refresh');
    expect(lastFrame()).toContain(
      'Enabled · marketplace data + installed plugins',
    );
    expect(lastFrame()).toContain('Settings source changes still apply');

    await act(async () => {
      for (let i = 0; i < 7; i++) {
        capturedRegistry?.invokeAction('Dialog', 'dialog:navigate:down', KEY);
      }
    });
    await waitUntilReady();
    await act(async () => {
      capturedRegistry?.invokeAction('Dialog', 'dialog:confirm', KEY);
    });

    await vi.waitFor(() => {
      expect(serviceMocks.updateMarketplaceForCommand).toHaveBeenCalledWith(
        'team-market',
        expect.any(Function),
      );
    });
    await act(async () => {
      resolveRefresh('updated');
    });
    await waitUntilReady();
    unmount();
  });
});
