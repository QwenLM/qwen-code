/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

import type { SettingsService } from '@qwen-code/resource';
import type { ModelTransportManager } from '../../provider/transport/modelTransportManager.js';
import { OPENAI_CHAT_COMPLETIONS } from '../../provider/transport/modelProtocol.js';
import {
  QwenSubscriptionProvider,
  QwenSubscriptionProviderConfig,
} from './provider.js';
import type { QwenSubscriptionSession } from './session.js';

const transportManager = {
  resolve: () => ({ protocol: OPENAI_CHAT_COMPLETIONS }),
} as unknown as ModelTransportManager;
const settingsService = {} as SettingsService;

function provider(session: QwenSubscriptionSession): QwenSubscriptionProvider {
  return new QwenSubscriptionProvider({
    transportManager,
    settingsService,
    session,
  });
}

function fakeSession(options: {
  signedIn?: boolean;
  cached?: string[];
  gateway?: string[] | Promise<string[]>;
  error?: Error;
}): QwenSubscriptionSession {
  return {
    isSignedIn: () => options.signedIn ?? true,
    getCachedModels: () => options.cached ?? [],
    getModels: vi.fn(async () => {
      if (options.error) throw options.error;
      const models = await options.gateway;
      return { models: models ?? [], cached: false };
    }),
    getAccessToken: vi.fn(async () => 'access-token'),
  } as unknown as QwenSubscriptionSession;
}

describe('QwenSubscriptionProvider', () => {
  it('lists the account catalog from the gateway in display order', async () => {
    const instance = provider(
      fakeSession({
        gateway: ['custom-model', 'qwen3.8-flash', 'qwen3.8-max'],
      }),
    );

    const models = await instance.listModels();

    expect(models.map((model) => model.key)).toEqual([
      'qwen-subscription/qwen3.8-max',
      'qwen-subscription/qwen3.8-flash',
      'qwen-subscription/custom-model',
    ]);
  });

  it('lists nothing while signed out', async () => {
    const instance = provider(fakeSession({ signedIn: false }));

    await expect(instance.listModels()).resolves.toEqual([]);
    await expect(
      instance.getModel('qwen-subscription/qwen3.8-max'),
    ).resolves.toBeUndefined();
  });

  it('uses the credential cache without waiting on the gateway', async () => {
    const pending = new Promise<string[]>(() => {});
    const instance = provider(
      fakeSession({ cached: ['qwen3.8-max'], gateway: pending }),
    );

    const models = await instance.listModels();

    expect(models.map((model) => model.key)).toEqual([
      'qwen-subscription/qwen3.8-max',
    ]);
  });

  it('keeps the last good catalog when a refresh fails', async () => {
    const session = fakeSession({ gateway: ['qwen3.8-max'] });
    const instance = provider(session);
    await instance.listModels();

    vi.mocked(session.getModels).mockRejectedValue(new Error('offline'));
    const models = await instance.listModels({ skipCache: true });

    expect(models.map((model) => model.key)).toEqual([
      'qwen-subscription/qwen3.8-max',
    ]);
  });
});

describe('QwenSubscriptionProviderConfig', () => {
  it('reads and renews the session bearer', async () => {
    const getAccessToken = vi.fn(async () => 'access-token');
    const config = new QwenSubscriptionProviderConfig({
      models: [],
      session: { getAccessToken } as unknown as QwenSubscriptionSession,
    });

    expect(config.providerId).toBe('qwen-subscription');
    expect(config.getBearer()).toBeUndefined();
    await expect(config.getBearerAsync()).resolves.toBe('access-token');

    await config.refreshBearer('rejected-token');
    expect(getAccessToken).toHaveBeenLastCalledWith(undefined, 'rejected-token');
  });
});
