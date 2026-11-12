/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import {
  QWEN_SUBSCRIPTION_MODELS_UNAVAILABLE,
  QwenSubscriptionOAuthError,
  type Config,
} from '@qwen-code/core';
import { SettingScope, type LoadedSettings } from '../../config/settings.js';
import { renderWithProviders } from '../../test-utils/render.js';
import { AuthDialog } from './AuthDialog.js';

const subscription = vi.hoisted(() => ({
  signIn: vi.fn(),
  getModels: vi.fn(),
  getUserInfo: vi.fn(),
  signOut: vi.fn(async () => {}),
}));
const createSession = vi.hoisted(() => vi.fn(() => subscription));
const createSubscriptionProvider = vi.hoisted(() =>
  vi.fn(() => ({ providerId: 'qwen-subscription' })),
);

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@qwen-code/core')>();
  return { ...actual, QwenSubscriptionSession: createSession };
});

vi.mock('../../auth/subscriptionProviders.js', () => ({
  createQwenSubscriptionProvider: createSubscriptionProvider,
}));

async function press(
  view: {
    stdin: { write: (value: string) => void };
    waitUntilReady: () => Promise<void>;
  },
  value: string,
) {
  await act(async () => {
    view.stdin.write(value);
  });
  await view.waitUntilReady();
  await new Promise((resolve) => setTimeout(resolve, 120));
}

async function flush(ms = 200): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function createConfig(): Config {
  const manager = {
    listModels: async () => [],
    registerAccountProvider: vi.fn(async () => {}),
  };
  return {
    isBrowserLaunchSuppressed: () => true,
    reloadModelConfigFromDisk: vi.fn(async () => {}),
    getCustomProvidersState: vi.fn(async () => ({})),
    setModel: vi.fn(async () => true),
    getSettingsService: vi.fn(() => ({})),
    getModelTransportManager: vi.fn(() => ({})),
    getModelProviderManager: () => manager,
  } as unknown as Config;
}

function createSettings(): LoadedSettings {
  return {
    merged: { security: { auth: {} } },
    setValue: vi.fn(() => true),
  } as unknown as LoadedSettings;
}

describe('AuthDialog Qwen account', () => {
  beforeEach(() => {
    createSubscriptionProvider.mockClear();
  });

  it('signs in, activates the model and reports the account', async () => {
    let approve: (() => void) | undefined;
    subscription.signIn.mockImplementation(
      async (onDevice: (device: unknown) => void) => {
        onDevice({
          device_code: 'device-1',
          user_code: 'USER-1',
          verification_uri: 'https://chat.qwen.ai/device',
          verification_uri_complete:
            'https://chat.qwen.ai/device?user_code=USER-1',
          expires_in: 60,
          interval: 0.01,
          expiresAt: Date.now() + 60_000,
        });
        await new Promise<void>((resolve) => {
          approve = resolve;
        });
        return {
          sub: 'user-1',
          name: 'Ada',
          email: 'ada@example.com',
          member_type: 'plus',
        };
      },
    );
    subscription.getModels.mockResolvedValue({
      models: ['qwen3.8-max', 'qwen3.8-flash'],
      cached: false,
    });
    const config = createConfig();
    const settings = createSettings();
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
      await press(view, '\u001b[B');
      await press(view, '\r');
      await flush();
      expect(view.lastFrame()).toContain('Open this URL to sign in to Qwen');
      expect(view.lastFrame()).toContain('USER-1');

      await act(async () => {
        approve?.();
      });
      await flush();
      expect(view.lastFrame()).toContain('Signed in as ada@example.com.');
      expect(view.lastFrame()).toContain('Plan: Plus');

      expect(settings.setValue).toHaveBeenCalledWith(
        SettingScope.User,
        'security.auth.selectedType',
        'qwen-subscription',
      );
      expect(settings.setValue).not.toHaveBeenCalledWith(
        SettingScope.User,
        ['providers', 'qwen-subscription'],
        expect.anything(),
      );
      expect(createSubscriptionProvider).toHaveBeenCalledOnce();
      expect(
        (
          config.getModelProviderManager() as unknown as {
            registerAccountProvider: ReturnType<typeof vi.fn>;
          }
        ).registerAccountProvider,
      ).toHaveBeenCalledWith({ providerId: 'qwen-subscription' });

      await press(view, '\r');
      expect(onDone).toHaveBeenCalledWith({
        modelKey: 'qwen-subscription/qwen3.8-max',
      });
    } finally {
      view.unmount();
    }
  });

  it('keeps free accounts on the purchase page', async () => {
    subscription.signIn.mockImplementation(
      async (onDevice: (device: unknown) => void) => {
        onDevice({
          device_code: 'device-1',
          user_code: 'USER-1',
          verification_uri: 'https://chat.qwen.ai/device',
          verification_uri_complete:
            'https://chat.qwen.ai/device?user_code=USER-1',
          expires_in: 60,
          interval: 0.01,
          expiresAt: Date.now() + 60_000,
        });
        return {
          sub: 'user-1',
          name: 'Ada',
          email: 'ada@example.com',
          member_type: 'free',
        };
      },
    );
    subscription.getUserInfo.mockResolvedValue({
      sub: 'user-1',
      name: 'Ada',
      email: 'ada@example.com',
      member_type: 'free',
    });
    const config = createConfig();
    const settings = createSettings();
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
      await press(view, '\u001b[B');
      await press(view, '\r');
      await flush();

      expect(view.lastFrame()).toContain('Qwen Code requires Plus or Pro');
      expect(view.lastFrame()).toContain('View Plans');
      expect(config.setModel).not.toHaveBeenCalled();
    } finally {
      view.unmount();
    }
  });

  it('shows the server error message when /models returns a 403 description', async () => {
    subscription.signIn.mockImplementation(
      async (onDevice: (device: unknown) => void) => {
        onDevice({
          device_code: 'device-1',
          user_code: 'USER-1',
          verification_uri: 'https://chat.qwen.ai/device',
          verification_uri_complete:
            'https://chat.qwen.ai/device?user_code=USER-1',
          expires_in: 60,
          interval: 0.01,
          expiresAt: Date.now() + 60_000,
        });
        return {
          sub: 'user-1',
          name: 'Ada',
          email: 'ada@example.com',
          member_type: 'plus',
        };
      },
    );
    subscription.getModels.mockRejectedValue(
      new QwenSubscriptionOAuthError(
        'plan_required',
        403,
        'Your account cannot access this model catalog.',
      ),
    );
    const view = await renderWithProviders(
      <AuthDialog
        config={createConfig()}
        settings={createSettings()}
        canClose
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
      { width: 120 },
    );
    await view.waitUntilReady();

    try {
      await press(view, '\u001b[B');
      await press(view, '\r');
      await flush();

      expect(view.lastFrame()).toContain(
        'Your account cannot access this model catalog.',
      );
    } finally {
      view.unmount();
    }
  });

  it('shows the models_unavailable copy when the catalog cannot be loaded', async () => {
    subscription.signIn.mockImplementation(
      async (onDevice: (device: unknown) => void) => {
        onDevice({
          device_code: 'device-1',
          user_code: 'USER-1',
          verification_uri: 'https://chat.qwen.ai/device',
          verification_uri_complete:
            'https://chat.qwen.ai/device?user_code=USER-1',
          expires_in: 60,
          interval: 0.01,
          expiresAt: Date.now() + 60_000,
        });
        return {
          sub: 'user-1',
          name: 'Ada',
          email: 'ada@example.com',
          member_type: 'plus',
        };
      },
    );
    subscription.getModels.mockRejectedValue(
      new QwenSubscriptionOAuthError(
        'models_unavailable',
        undefined,
        QWEN_SUBSCRIPTION_MODELS_UNAVAILABLE,
      ),
    );
    const view = await renderWithProviders(
      <AuthDialog
        config={createConfig()}
        settings={createSettings()}
        canClose
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
      { width: 120 },
    );
    await view.waitUntilReady();

    try {
      await press(view, '\u001b[B');
      await press(view, '\r');
      await flush();

      expect(view.lastFrame()).toContain(QWEN_SUBSCRIPTION_MODELS_UNAVAILABLE);
    } finally {
      view.unmount();
    }
  });
});
