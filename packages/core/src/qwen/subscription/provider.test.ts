/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

import type { SettingsService } from '@qwen-code/resource';
import { ClientError } from '../../client/clientError.js';
import { ModelInferenceError } from '../../provider/modelInferenceError.js';
import type { ModelTransportManager } from '../../provider/transport/modelTransportManager.js';
import { OPENAI_CHAT_COMPLETIONS } from '../../provider/transport/modelProtocol.js';
import { buildChatCompletionsStreamReq } from '../../provider/transport/impl/chat-completions-factory/request/chatCompletionsStreamReqFactory.js';
import { resolveErrorPresentation } from '../../utils/errorPresentation.js';
import * as fetchUtils from '../../utils/fetch.js';
import {
  qwenSubscriptionModel,
  type QwenSubscriptionModelMetadata,
} from './models.js';
import {
  classifyQwenSubscriptionError,
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

  it('formats 402 insufficient_quota responses with reset countdown and upgrade hint', () => {
    const resetAt = Math.floor((Date.now() + 26 * 3_600_000) / 1000);
    const clientError = new ClientError('HTTP 402', {
      statusCode: 402,
      code: 'insufficient_quota',
      requestId: 'req_quota_1',
      responseBody: JSON.stringify({
        error: {
          code: 'insufficient_quota',
          message: 'Quota exceeded',
          quota: {
            member_type: 'plus',
            reset_at: resetAt,
          },
        },
      }),
    });

    const classify = classifyQwenSubscriptionError(clientError);

    expect(classify.kind).toBe('quota_exhausted');
    expect(classify.message).toBe(
      "You've used up your weekly credits. Your credits are expected to reset in 1 day and 2 hours. You can wait or run /upgrade to get more credits. (request_id: req_quota_1)",
    );

    const inferenceError = new ModelInferenceError(classify.message!, {
      ...classify,
      kind: 'quota_exhausted',
      phase: 'before_output',
    });
    expect(
      resolveErrorPresentation(inferenceError, 'qwen-subscription')
        .fallbackMessage,
    ).toBe(classify.message);

    const exactTwoDays = Math.floor((Date.now() + 48 * 3_600_000) / 1000);
    const exactDayError = new ClientError('HTTP 402', {
      statusCode: 402,
      code: 'insufficient_quota',
      responseBody: JSON.stringify({
        error: {
          code: 'insufficient_quota',
          quota: {
            member_type: 'pro',
            reset_at: exactTwoDays,
          },
        },
      }),
    });
    expect(classifyQwenSubscriptionError(exactDayError).message).toBe(
      "You've used up your weekly credits. Your credits are expected to reset in 2 days. Please try again after the reset.",
    );
  });

  it('attaches QwenCode User-Agent and captures gateway request id headers on inference requests', async () => {
    const fetchSpy = vi
      .spyOn(fetchUtils, 'proxiedFetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: 'insufficient_quota',
              message: 'Quota exceeded',
              quota: { member_type: 'pro' },
            },
          }),
          {
            status: 402,
            headers: {
              'Content-Type': 'application/json',
              'x-request-id': 'invalid request id with spaces',
              'x-gateway-request-id': 'gw_req_402',
            },
          },
        ),
      );

    try {
      const instance = provider(fakeSession({ cached: ['qwen3.8-max'] }));
      const client = (
        instance as unknown as {
          client: {
            api: {
              inference: {
                chatCompletions: {
                  stream: (req: unknown) => AsyncIterable<unknown>;
                };
              };
            };
          };
        }
      ).client;

      let caught: unknown;
      try {
        for await (const _ of client.api.inference.chatCompletions.stream({
          model: 'qwen3.8-max',
          messages: [],
          stream: true,
        })) {
          // expect 402 before any event
        }
      } catch (err) {
        caught = err;
      }

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, init] = fetchSpy.mock.calls[0]!;
      expect((init?.headers as Record<string, string>)['User-Agent']).toMatch(
        /^QwenCode\/\S+ \(\S+; \S+\)$/,
      );

      const classify = classifyQwenSubscriptionError(caught);

      expect(classify.kind).toBe('quota_exhausted');
      expect(classify.requestId).toBe('gw_req_402');
      expect(classify.message).toContain('(request_id: gw_req_402)');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
