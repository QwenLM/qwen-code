/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import {
  QODER_ENV_ACCOUNT_REGION,
  type Config,
} from '@qwen-code/core';
import type { LoadedSettings } from '../../config/settings.js';
import { renderWithProviders } from '../../test-utils/render.js';
import { AuthDialog } from './AuthDialog.js';

const openBrowserSecurely = vi.hoisted(() => vi.fn(async () => {}));
const createQoderClient = vi.hoisted(() => vi.fn());

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@qwen-code/core')>();
  return { ...actual, createQoderClient, openBrowserSecurely };
});

describe('AuthDialog Qoder login', () => {
  it('offers model selection after sign-in', async () => {
    createQoderClient.mockReturnValue({
      api: {
        auth: {
          getStatus: async () => ({ state: 'missing' }),
          startDeviceLogin: () => ({
            region: 'global',
            authUrl: 'https://qoder.test/device?sourceType=QwenCode',
            expiresAt: Date.now() + 60_000,
            cancel: vi.fn(),
            completion: Promise.resolve({
              region: 'global',
              account: {
                region: 'global',
                userId: 'u1',
                userName: 'Ada',
                expiresAt: Date.now() + 3_600_000,
              },
            }),
          }),
        },
      },
    });
    const setModel = vi.fn(async () => true);
    const registerAccountProvider = vi.fn(async () => {});
    const config = {
      isBrowserLaunchSuppressed: () => true,
      getModelProviderManager: () => ({
        listModels: async () => [
          { source: 'qoder', key: 'qmodel_38max', displayName: 'Qwen3.8-Max' },
          { source: 'custom', key: 'other/model', displayName: 'Other' },
        ],
        registerAccountProvider,
      }),
      getSettingsService: () => ({}),
      getModelTransportManager: () => ({ resolve: () => ({}) }),
      setModel,
    } as unknown as Config;
    const settings = {
      merged: { security: { auth: {} } },
      setValue: vi.fn(() => true),
    } as unknown as LoadedSettings;
    const onDone = vi.fn();
    const view = await renderWithProviders(
      <AuthDialog
        config={config}
        settings={settings}
        canClose
        onClose={vi.fn()}
        onDone={onDone}
      />,
      { width: 120 },
    );
    await view.waitUntilReady();

    try {
      await act(async () => {
        view.stdin.write('\r');
      });
      await view.waitUntilReady();
      await act(async () => {
        view.stdin.write('\r');
      });
      await view.waitUntilReady();
      await vi.waitFor(() =>
        expect(view.lastFrame()).toContain('Qoder · Select Model'),
      );
      expect(view.lastFrame()).toContain('Qwen3.8-Max');
      expect(view.lastFrame()).not.toContain('Other');
      await act(async () => {
        view.stdin.write('\r');
      });
      await view.waitUntilReady();
      expect(onDone).toHaveBeenCalledWith({ modelKey: 'qmodel_38max' });
      expect(setModel).not.toHaveBeenCalled();
    } finally {
      view.unmount();
    }
  });

  it('keeps a configured model or adopts the catalog default on Escape', async () => {
    createQoderClient.mockReturnValue({
      api: {
        auth: {
          getStatus: async () => ({ state: 'missing' }),
          startDeviceLogin: () => ({
            region: 'global',
            authUrl: 'https://qoder.test/device?sourceType=QwenCode',
            expiresAt: Date.now() + 60_000,
            cancel: vi.fn(),
            completion: Promise.resolve({
              region: 'global',
              account: {
                region: 'global',
                userId: 'u1',
                userName: 'Ada',
                expiresAt: Date.now() + 3_600_000,
              },
            }),
          }),
        },
      },
    });
    const config = {
      isBrowserLaunchSuppressed: () => true,
      getModelProviderManager: () => ({
        listModels: async () => [
          {
            source: 'qoder',
            key: 'qmodel_default',
            displayName: 'Default',
            isDefault: true,
          },
          { source: 'qoder', key: 'qmodel_other', displayName: 'Other' },
        ],
        registerAccountProvider: async () => {},
      }),
      getSettingsService: () => ({}),
      getModelTransportManager: () => ({ resolve: () => ({}) }),
    } as unknown as Config;
    const settings = {
      merged: { security: { auth: {} } },
      setValue: vi.fn(() => true),
    } as unknown as LoadedSettings;
    const onDone = vi.fn();
    const view = await renderWithProviders(
      <AuthDialog
        config={config}
        settings={settings}
        canClose
        onClose={vi.fn()}
        onDone={onDone}
      />,
      { width: 120 },
    );
    await view.waitUntilReady();

    try {
      await act(async () => {
        view.stdin.write('\r');
      });
      await view.waitUntilReady();
      await act(async () => {
        view.stdin.write('\r');
      });
      await view.waitUntilReady();
      await vi.waitFor(() =>
        expect(view.lastFrame()).toContain('Qoder · Select Model'),
      );
      await act(async () => {
        view.stdin.write('\u001b');
      });
      await view.waitUntilReady();
      expect(onDone).toHaveBeenCalledWith({ modelKey: 'qmodel_default' });
    } finally {
      view.unmount();
    }
  });

  it('opens the browser for the international account', async () => {
    createQoderClient.mockReturnValue({
      api: {
        auth: {
          getStatus: async () => ({ state: 'missing' }),
          startDeviceLogin: () => ({
            region: 'global',
            authUrl: 'https://qoder.test/device?sourceType=QwenCode',
            expiresAt: Date.now() + 60_000,
            cancel: vi.fn(),
            completion: new Promise(() => {}),
          }),
        },
      },
    });
    const config = {
      isBrowserLaunchSuppressed: () => false,
      getModelProviderManager: () => ({ listModels: async () => [] }),
    } as unknown as Config;
    const settings = {
      merged: { security: { auth: {} } },
      setValue: vi.fn(() => true),
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

    try {
      // Main menu → Qoder.
      await act(async () => {
        view.stdin.write('\r');
      });
      await view.waitUntilReady();
      // Sign-in method → browser.
      await act(async () => {
        view.stdin.write('\r');
      });
      await view.waitUntilReady();

      expect(createQoderClient).toHaveBeenCalledWith({ region: 'global' });
      expect(openBrowserSecurely).toHaveBeenCalledWith(
        'https://qoder.test/device?sourceType=QwenCode',
      );
    } finally {
      view.unmount();
    }
  });

  it('targets the cn account region when configured', async () => {
    vi.stubEnv(QODER_ENV_ACCOUNT_REGION, 'cn');
    createQoderClient.mockReturnValue({
      api: {
        auth: {
          getStatus: async () => ({ state: 'missing' }),
          startDeviceLogin: () => ({
            region: 'cn',
            authUrl: 'https://qoder.cn/device/selectAccounts?sourceType=QwenCode',
            expiresAt: Date.now() + 60_000,
            cancel: vi.fn(),
            completion: new Promise(() => {}),
          }),
        },
      },
    });
    const config = {
      isBrowserLaunchSuppressed: () => false,
      getModelProviderManager: () => ({ listModels: async () => [] }),
    } as unknown as Config;
    const settings = {
      merged: { security: { auth: {} } },
      setValue: vi.fn(() => true),
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

    try {
      await act(async () => {
        view.stdin.write('\r');
      });
      await view.waitUntilReady();
      await act(async () => {
        view.stdin.write('\r');
      });
      await view.waitUntilReady();

      expect(createQoderClient).toHaveBeenCalledWith({ region: 'cn' });
      expect(openBrowserSecurely).toHaveBeenCalledWith(
        'https://qoder.cn/device/selectAccounts?sourceType=QwenCode',
      );
    } finally {
      vi.unstubAllEnvs();
      view.unmount();
    }
  });
});
