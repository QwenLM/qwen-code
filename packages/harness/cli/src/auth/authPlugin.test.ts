/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { QoderClient } from '@qwen-code/core';
import { SettingScope } from '../config/settings.js';
import type { CommandContext } from '../ui/commands/types.js';
import { AuthPlugin } from './authPlugin.js';

const requestAuthGate = vi.hoisted(() => vi.fn());

vi.mock('../ui/auth/authFlow.js', () => ({ requestAuthGate }));

function fakeClient(overrides: {
  status?: Awaited<ReturnType<QoderClient['api']['auth']['getStatus']>>;
  login?: Awaited<
    ReturnType<QoderClient['api']['auth']['startDeviceLogin']>['completion']
  >;
} = {}): QoderClient {
  const account = {
    region: 'global' as const,
    userId: 'user-1',
    userName: 'Ada',
    email: 'ada@example.com',
    expiresAt: Date.now() + 3_600_000,
  };
  return {
    api: {
      auth: {
        getStatus: vi.fn(async () => overrides.status ?? { state: 'missing' }),
        ensureAccessToken: vi.fn(async () => ({ accessToken: 'token', account })),
        refresh: vi.fn(async () => account),
        listAccounts: vi.fn(async () => ({})),
        logout: vi.fn(async () => {}),
        startDeviceLogin: vi.fn(() => ({
          region: 'global' as const,
          authUrl: 'https://qoder.test/device',
          expiresAt: Date.now() + 60_000,
          cancel: vi.fn(),
          completion: Promise.resolve(
            overrides.login ?? { region: 'global' as const, account },
          ),
        })),
      },
    },
  } as unknown as QoderClient;
}

function createContext(settings = createSettings()) {
  return {
    services: {
      settings,
      agentContext: {
        config: { isBrowserLaunchSuppressed: () => false },
      },
    },
    ui: { addItem: vi.fn() },
  } as unknown as CommandContext;
}

function createSettings(
  overrides: {
    auth?: Record<string, unknown>;
    model?: Record<string, unknown>;
  } = {},
) {
  return {
    merged: {
      security: { auth: overrides.auth ?? {} },
      ...(overrides.model ? { model: overrides.model } : {}),
    },
    setValue: vi.fn(() => true),
  };
}

describe('Qoder auth plugin', () => {
  beforeEach(() => {
    requestAuthGate.mockClear();
  });

  it('opens the connect-provider flow from /auth', async () => {
    const context = createContext();
    const command = new AuthPlugin()
      .getSlashCommands?.()
      .find((entry) => entry.name === 'auth')!;

    await command.action?.(context, '');

    expect(requestAuthGate).toHaveBeenCalledWith('login');
    expect(command.altNames).toEqual(
      expect.arrayContaining(['connect', 'login']),
    );
  });

  it('logs out both regions and clears the selected auth type', async () => {
    const client = fakeClient();
    const context = createContext(
      createSettings({ auth: { selectedType: 'qoder-oauth' } }),
    );
    const command = new AuthPlugin({
      createClient: () => client,
    })
      .getSlashCommands?.()
      .find((entry) => entry.name === 'logout')!;

    await command.action?.(context, '');

    expect(client.api.auth.logout).toHaveBeenCalledTimes(2);
    expect(context.services.settings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'security.auth.selectedType',
      undefined,
    );
  });

  it('guides to /model when the signed-out model is no longer listed', async () => {
    const client = fakeClient();
    const settings = createSettings({
      auth: { selectedType: 'qoder-oauth' },
      model: { name: 'qmodel_38max_prime' },
    });
    const context = createContext(settings);
    const config = context.services.agentContext!.config as unknown as {
      isBrowserLaunchSuppressed: () => boolean;
      getModel?: () => string;
      getModelProviderManager?: () => {
        listModels: () => Promise<Array<{ key: string; source: string }>>;
      };
    };
    config.getModel = () => 'qmodel_38max_prime';
    config.getModelProviderManager = () => ({
      listModels: async () => [{ key: 'token-plan/glm-5.3', source: 'token-plan' }],
    });
    const command = new AuthPlugin({ createClient: () => client })
      .getSlashCommands?.()
      .find((entry) => entry.name === 'logout')!;

    await command.action?.(context, '');

    const items = vi
      .mocked(context.ui.addItem)
      .mock.calls.map(([item]) => JSON.stringify(item));
    expect(
      items.some((item) =>
        item.includes('no longer available after signing out'),
      ),
    ).toBe(true);
  });

  it('leaves API-key connections untouched by /logout', async () => {
    const client = fakeClient();
    const settings = createSettings({ auth: { selectedType: 'openai' } });
    const context = createContext(settings);
    const command = new AuthPlugin({ createClient: () => client })
      .getSlashCommands?.()
      .find((entry) => entry.name === 'logout')!;

    await command.action?.(context, '');

    expect(client.api.auth.logout).not.toHaveBeenCalled();
    expect(settings.setValue).not.toHaveBeenCalledWith(
      SettingScope.User,
      'security.auth.selectedType',
      undefined,
    );
    expect(context.ui.addItem).toHaveBeenCalled();
  });

  it('signs out the Qwen account and removes its provider entry', async () => {
    const client = fakeClient();
    const settings = createSettings({
      auth: { selectedType: 'qwen-subscription' },
      model: { name: 'qwen-subscription/qwen3.8-max' },
    });
    const context = createContext(settings);
    const signOut = vi.fn(async () => {});
    const command = new AuthPlugin({
      createClient: () => client,
      createSubscriptionSession: () => ({
        signOut,
      }),
    })
      .getSlashCommands?.()
      .find((entry) => entry.name === 'logout')!;

    await command.action?.(context, '');

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(settings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      ['providers', 'qwen-subscription'],
      undefined,
    );
    expect(settings.setValue).not.toHaveBeenCalledWith(
      SettingScope.User,
      'model.name',
      undefined,
    );
    expect(context.ui.addItem).toHaveBeenCalled();
  });

  it('does not register /upgrade in the CLI auth plugin', () => {
    const commands = new AuthPlugin().getSlashCommands();

    expect(
      commands.some(
        (command) =>
          command.name === 'upgrade' || command.altNames?.includes('upgrade'),
      ),
    ).toBe(false);
  });

});
