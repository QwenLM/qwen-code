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
import { buildQwenSubscriptionProviderEntry } from './models.js';
import {
  composeQwenSubscriptionProvider,
  QwenSubscriptionProviderConfig,
} from './provider.js';
import type { QwenSubscriptionSession } from './session.js';

function fakeSession(
  signedIn = true,
): QwenSubscriptionSession {
  return {
    isSignedIn: () => signedIn,
    getAccessToken: vi.fn(async () => 'access-token'),
  } as unknown as QwenSubscriptionSession;
}

function context(value: unknown) {
  return {
    providerId: 'qwen-subscription',
    value,
    transportManager: {
      resolve: () => ({ protocol: OPENAI_CHAT_COMPLETIONS }),
    } as unknown as ModelTransportManager,
    settingsService: {} as SettingsService,
    scope: 'user' as const,
  };
}

describe('buildQwenSubscriptionProviderEntry', () => {
  it('persists the membership gateway and catalog with a placeholder key', () => {
    const entry = buildQwenSubscriptionProviderEntry([
      'qwen3.8-flash',
      'custom-model',
    ]);

    expect(entry.providerId).toBe('qwen-subscription');
    expect(entry.value).toMatchObject({
      protocol: 'openai',
      baseUrl: 'https://api.qwen.ai/compatible-mode/v1',
      apiKey: 'QWEN_SUBSCRIPTION_DYNAMIC_TOKEN',
      displayName: 'Qwen Account',
      models: [
        { model: 'qwen3.8-flash', displayName: 'Qwen 3.8 Flash' },
        { model: 'custom-model' },
      ],
    });
  });
});

describe('composeQwenSubscriptionProvider', () => {
  it('builds a settings-backed provider when the account is signed in', async () => {
    const provider = composeQwenSubscriptionProvider(
      context({
        baseUrl: 'https://api.qwen.ai/compatible-mode/v1',
        models: [{ model: 'qwen3.8-flash' }, { model: 'qwen3.8-max' }],
      }),
      fakeSession(true),
    );

    expect(provider?.providerId).toBe('qwen-subscription');
    const models = await provider!.listModels();
    expect(models.map((model) => model.key)).toEqual([
      'qwen-subscription/qwen3.8-max',
      'qwen-subscription/qwen3.8-flash',
    ]);
  });

  it('builds nothing while signed out', () => {
    const provider = composeQwenSubscriptionProvider(
      context({ models: [{ model: 'qwen3.8-max' }] }),
      fakeSession(false),
    );

    expect(provider).toBeUndefined();
  });

  it('ignores a malformed entry', () => {
    expect(
      composeQwenSubscriptionProvider(context({ models: [] }), fakeSession()),
    ).toBeUndefined();
    expect(
      composeQwenSubscriptionProvider(context(undefined), fakeSession()),
    ).toBeUndefined();
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
