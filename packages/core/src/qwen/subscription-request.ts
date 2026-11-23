/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { QWEN_SUBSCRIPTION_BASE_URL } from './oauth-config.js';
import { QwenSubscriptionSession } from './subscription-session.js';
import {
  logSubscriptionGatewayResponse,
  subscriptionErrorMessage,
  subscriptionHttpError,
} from './subscription-errors.js';
import { SubscriptionOAuthError } from './subscription-oauth-client.js';

export const SUBSCRIPTION_IMAGE_URL = new URL(
  '/api/v1/services/aigc/multimodal-generation/generation',
  QWEN_SUBSCRIPTION_BASE_URL,
).href;

export async function fetchSubscriptionInference(
  kind: 'chat' | 'image',
  init: RequestInit,
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  const session = new QwenSubscriptionSession();
  const identity = session.getIdentity();
  const signal = init.signal ?? undefined;
  const getToken = async (rejected?: string) => {
    try {
      if (!identity || session.getIdentity() !== identity) {
        throw new SubscriptionOAuthError('session_changed');
      }
      const token = await session.getAccessToken(signal, rejected);
      if (session.getIdentity() !== identity) {
        throw new SubscriptionOAuthError('session_changed');
      }
      return token;
    } catch (error) {
      if (error instanceof SubscriptionOAuthError) {
        error.message = subscriptionErrorMessage(error);
      }
      throw error;
    }
  };
  const send = async (token: string) => {
    signal?.throwIfAborted();
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    const response = await fetchFn(
      kind === 'image'
        ? SUBSCRIPTION_IMAGE_URL
        : `${QWEN_SUBSCRIPTION_BASE_URL}/chat/completions`,
      { ...init, headers, redirect: 'error' },
    );
    logSubscriptionGatewayResponse(response);
    return response;
  };
  const token = await getToken();
  let response = await send(token);
  if (response.status === 401) {
    await response.body?.cancel();
    response = await send(await getToken(token));
  }
  if (!response.ok) {
    const error = subscriptionHttpError(
      response.status,
      await response.json().catch(() => undefined),
      response.headers.get('retry-after'),
    );
    error.message = subscriptionErrorMessage(error);
    throw error;
  }
  return response;
}
