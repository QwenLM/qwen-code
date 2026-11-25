/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import type { Config } from '@qwen-code/core';
import type { LoadedSettings } from '../../config/settings.js';
import { renderWithProviders } from '../../test-utils/render.js';
import { AuthDialog } from './AuthDialog.js';

describe('AuthDialog', () => {
  it('lists every connect-provider category', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <AuthDialog
        config={{} as Config}
        settings={{} as LoadedSettings}
        canClose
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
      { width: 120 },
    );

    try {
      const frame = lastFrame();
      expect(frame).toContain('Connect a Provider');
      expect(frame).toContain('QwenCloud');
      expect(frame).toContain('Alibaba Cloud Model Studio');
      expect(frame).toContain('Other Providers');
      expect(frame).toContain('Custom Provider');
      expect(frame).toContain('Qoder');
      expect(frame).toContain('Token Plan or a standard API key');
      expect(frame).toContain('Configure a local model server');
    } finally {
      unmount();
    }
  });

  it('closes on Escape when the session already has models', async () => {
    const onClose = vi.fn();
    const view = await renderWithProviders(
      <AuthDialog
        config={{} as Config}
        settings={{} as LoadedSettings}
        canClose
        onClose={onClose}
        onDone={vi.fn()}
      />,
      { width: 120 },
    );
    await view.waitUntilReady();

    try {
      await act(async () => {
        view.stdin.write('\u001b');
      });
      await view.waitUntilReady();
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      view.unmount();
    }
  });

  it('removes an invalid custom provider from the main menu', async () => {
    const config = {
      getCustomProvidersState: () => ({
        status: 'invalid_configuration',
        issues: [
          {
            providerId: 'custom-bad',
            field: 'baseUrl',
            message: 'baseUrl is invalid',
          },
        ],
      }),
      reloadModelConfigFromDisk: vi.fn(async () => {}),
    } as unknown as Config;
    const settings = {
      merged: {
        providers: { 'custom-bad': { baseUrl: 'bad' } },
      },
      user: {
        settings: {
          providers: { 'custom-bad': { baseUrl: 'bad' } },
        },
      },
      flag: { settings: {} },
      project: { settings: {} },
      local: { settings: {} },
      isTrusted: true,
      deleteValue: vi.fn(() => true),
    } as unknown as LoadedSettings;
    const view = await renderWithProviders(
      <AuthDialog
        config={config}
        settings={settings}
        canClose
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
      { width: 120 },
    );
    await view.waitUntilReady();

    const press = async (value: string) => {
      await act(async () => {
        view.stdin.write(value);
      });
      await view.waitUntilReady();
      await new Promise((resolve) => setTimeout(resolve, 80));
    };

    try {
      for (let i = 0; i < 6; i++) await press('\u001b[B');
      await press('\r');
      expect(view.lastFrame()).toContain('custom-bad');
      await press('\u001b[B');
      await press('\r');
      expect(settings.deleteValue).toHaveBeenCalledWith(expect.anything(), [
        'providers',
        'custom-bad',
      ]);
      expect(config.reloadModelConfigFromDisk).toHaveBeenCalledOnce();
    } finally {
      view.unmount();
    }
  });

  it('stays open on Escape when no provider is connected', async () => {
    const onClose = vi.fn();
    const view = await renderWithProviders(
      <AuthDialog
        config={{} as Config}
        settings={{} as LoadedSettings}
        canClose={false}
        onClose={onClose}
        onDone={vi.fn()}
      />,
      { width: 120 },
    );
    await view.waitUntilReady();

    try {
      await act(async () => {
        view.stdin.write('\u001b');
      });
      await view.waitUntilReady();
      expect(onClose).not.toHaveBeenCalled();
      expect(view.lastFrame()).toContain(
        'You must connect a provider to proceed',
      );
    } finally {
      view.unmount();
    }
  });
});
