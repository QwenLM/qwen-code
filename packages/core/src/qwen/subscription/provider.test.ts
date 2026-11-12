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
import { buildChatCompletionsStreamReq } from '../../provider/transport/impl/chat-completions-factory/request/chatCompletionsStreamReqFactory.js';
import {
  qwenSubscriptionModel,
  type QwenSubscriptionModelMetadata,
} from './models.js';
import {
  QwenSubscriptionProvider,
  QwenSubscriptionProviderConfig,
  resolveQwenSubscriptionStreamRequest,
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
  cachedMetadata?: QwenSubscriptionModelMetadata[];
  gateway?: string[] | Promise<string[]>;
  gatewayMetadata?: QwenSubscriptionModelMetadata[];
  error?: Error;
}): QwenSubscriptionSession {
  return {
    isSignedIn: () => options.signedIn ?? true,
    getCachedModels: () => options.cached ?? [],
    getCachedCatalog: () => ({
      models: options.cached ?? [],
      ...(options.cachedMetadata
        ? { modelMetadata: options.cachedMetadata }
        : {}),
    }),
    getModels: vi.fn(async () => {
      if (options.error) throw options.error;
      const models = await options.gateway;
      return {
        models: models ?? [],
        ...(options.gatewayMetadata
          ? { modelMetadata: options.gatewayMetadata }
          : {}),
        cached: false,
      };
    }),
    getAccessToken: vi.fn(async () => 'access-token'),
  } as unknown as QwenSubscriptionSession;
}

describe('QwenSubscriptionProvider', () => {
  it('lists the account catalog in the order returned by the gateway and applies metadata', async () => {
    const instance = provider(
      fakeSession({
        gateway: ['qwen4', 'qwen3.8-flash', 'qwen3.8-max'],
        gatewayMetadata: [
          {
            id: 'qwen4',
            modalities: { image: true },
            contextWindowSize: 512_000,
          },
        ],
      }),
    );

    const models = await instance.listModels();

    expect(models.map((model) => model.key)).toEqual([
      'qwen-subscription/qwen4',
      'qwen-subscription/qwen3.8-flash',
      'qwen-subscription/qwen3.8-max',
    ]);
    expect(models[0]).toMatchObject({
      key: 'qwen-subscription/qwen4',
      capabilities: {
        vision: true,
        reasoning: {
          supported: true,
          supportedEfforts: ['none', 'low', 'medium', 'high'],
        },
        contextWindows: [{ tokens: 512_000 }],
      },
      limits: { maxContextTokens: 512_000 },
      defaultModelConfig: {
        reasoning: { effort: 'medium' },
        context: { contextWindow: 512_000 },
      },
    });
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

  it('normalizes reasoning effort into thinking_budget within QwenSubscriptionProvider', () => {
    const model = qwenSubscriptionModel('qwen3.8-max');
    const enabled = buildChatCompletionsStreamReq(
      resolveQwenSubscriptionStreamRequest({
        resolution: { model, config: { reasoning: { effort: 'medium' } } },
        prompt: { messages: [] },
      }),
    );
    expect(enabled).toMatchObject({
      model: 'qwen3.8-max',
      enable_thinking: true,
      thinking_budget: 16_384,
    });
    expect(enabled).not.toHaveProperty('reasoning_effort');

    const disabled = buildChatCompletionsStreamReq(
      resolveQwenSubscriptionStreamRequest({
        resolution: { model, config: { reasoning: { effort: 'none' } } },
        prompt: { messages: [] },
      }),
    );
    expect(disabled).toMatchObject({
      enable_thinking: false,
    });
    expect(disabled).not.toHaveProperty('thinking_budget');
  });
});
