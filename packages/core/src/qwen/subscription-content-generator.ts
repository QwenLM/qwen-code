/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import OpenAI from 'openai';
import type { Config } from '../config/config.js';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
} from '../core/contentGenerator.js';
import { OpenAIContentGenerator } from '../core/openaiContentGenerator/openaiContentGenerator.js';
import { DefaultOpenAICompatibleProvider } from '../core/openaiContentGenerator/provider/default.js';
import {
  DEFAULT_MAX_RETRIES,
  resolveRequestTimeout,
} from '../core/openaiContentGenerator/constants.js';
import { buildSessionAwareFetch } from '../core/outbound-session-id.js';
import { buildRuntimeFetchOptions } from '../utils/runtimeFetchOptions.js';
import {
  QWEN_SUBSCRIPTION_BASE_URL,
  QWEN_SUBSCRIPTION_TOKEN_PLACEHOLDER,
} from './oauth-config.js';
import { QwenSubscriptionSession } from './subscription-session.js';
import {
  SubscriptionOAuthError,
  subscriptionError,
} from './subscription-oauth-client.js';
import { subscriptionErrorMessage } from './subscription-errors.js';

class SubscriptionProvider extends DefaultOpenAICompatibleProvider {
  override buildClient(): OpenAI {
    const runtimeOptions = buildRuntimeFetchOptions(
      'openai',
      this.cliConfig.getProxy(),
    );
    const baseFetch = buildSessionAwareFetch(
      runtimeOptions?.fetch,
      this.cliConfig,
      this.contentGeneratorConfig.customHeaders,
    );
    const session = new QwenSubscriptionSession();
    return new OpenAI({
      apiKey: QWEN_SUBSCRIPTION_TOKEN_PLACEHOLDER,
      baseURL: QWEN_SUBSCRIPTION_BASE_URL,
      timeout: resolveRequestTimeout(this.contentGeneratorConfig.timeout),
      maxRetries: this.contentGeneratorConfig.maxRetries ?? DEFAULT_MAX_RETRIES,
      defaultHeaders: this.buildHeaders(),
      ...(runtimeOptions || {}),
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.href !== `${QWEN_SUBSCRIPTION_BASE_URL}/chat/completions`) {
          throw new Error('Unsupported Qwen Subscription inference request.');
        }
        const signal = init?.signal ?? undefined;
        const getToken = async (rejectedToken?: string) => {
          try {
            return await session.getAccessToken(signal, rejectedToken);
          } catch (error) {
            signal?.throwIfAborted();
            const failure = subscriptionError(error, 'credentials');
            throw new SubscriptionOAuthError(
              failure.code,
              failure.status,
              subscriptionErrorMessage(failure),
              failure.retryAfterMs,
              failure.stage,
            );
          }
        };
        const token = await getToken();
        const send = (accessToken: string) => {
          const headers = new Headers(init?.headers);
          headers.set('Authorization', `Bearer ${accessToken}`);
          return baseFetch(input, { ...init, headers, redirect: 'error' });
        };
        const response = await send(token);
        if (response.status !== 401) return response;
        await response.body?.cancel();
        const refreshed = await getToken(token);
        return send(refreshed);
      },
    });
  }
}

export function createSubscriptionContentGenerator(
  config: ContentGeneratorConfig,
  cliConfig: Config,
): ContentGenerator {
  if (process.env['DEV'] !== 'true') {
    throw new Error('Qwen Subscription is only available in development.');
  }
  if (
    config.baseUrl !== undefined &&
    config.baseUrl !== QWEN_SUBSCRIPTION_BASE_URL
  ) {
    throw new Error('Unsupported Qwen Subscription gateway.');
  }
  const resolved = {
    ...config,
    apiKey: QWEN_SUBSCRIPTION_TOKEN_PLACEHOLDER,
    baseUrl: QWEN_SUBSCRIPTION_BASE_URL,
  };
  return new OpenAIContentGenerator(
    resolved,
    cliConfig,
    new SubscriptionProvider(resolved, cliConfig),
  );
}
