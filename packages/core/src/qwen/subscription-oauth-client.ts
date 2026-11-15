/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import { combineAbortSignals } from '../utils/abortController.js';
import { getQwenOAuthConfig } from './oauth-config.js';

const deviceSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().url(),
  verification_uri_complete: z.string().url(),
  expires_in: z.number().positive().finite(),
  interval: z.number().positive().finite(),
});
const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  token_type: z.literal('Bearer'),
  expires_in: z.number().positive().finite(),
  scope: z.string(),
});
const userInfoSchema = z.object({
  sub: z.string().min(1),
  name: z.string(),
  email: z.string(),
  member_type: z.string().min(1),
});
const errorSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

export type SubscriptionDeviceAuthorization = z.infer<typeof deviceSchema> & {
  expiresAt: number;
};
export type SubscriptionTokens = z.infer<typeof tokenSchema>;
export type SubscriptionUserInfo = z.infer<typeof userInfoSchema>;
export type SubscriptionOAuthStage =
  | 'device'
  | 'exchange'
  | 'credentials'
  | 'userinfo'
  | 'refresh'
  | 'revoke'
  | 'cleanup';

export class SubscriptionOAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
    readonly description?: string,
    readonly retryAfterMs?: number,
    readonly stage?: SubscriptionOAuthStage,
  ) {
    super(description ? `${code}: ${description}` : code);
    this.name = 'SubscriptionOAuthError';
  }
}

export function subscriptionError(
  error: unknown,
  stage: SubscriptionOAuthStage,
): SubscriptionOAuthError {
  if (error instanceof SubscriptionOAuthError) {
    return new SubscriptionOAuthError(
      error.code,
      error.status,
      error.description,
      error.retryAfterMs,
      error.stage ?? stage,
    );
  }
  return new SubscriptionOAuthError(
    stage === 'credentials' || stage === 'cleanup'
      ? 'credentials_error'
      : error instanceof Error && error.name === 'TimeoutError'
        ? 'request_timeout'
        : error instanceof TypeError
          ? 'network_error'
          : 'operation_failed',
    undefined,
    error instanceof Error ? error.message : undefined,
    undefined,
    stage,
  );
}

export function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - Date.now();
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class QwenSubscriptionOAuthClient {
  private readonly config = getQwenOAuthConfig();

  private async request<T>(
    path: string,
    schema: z.ZodType<T> | null,
    signal?: AbortSignal,
    form?: Record<string, string>,
    accessToken?: string,
  ): Promise<T> {
    const request = combineAbortSignals([signal], { timeoutMs: 30_000 });
    try {
      request.signal.throwIfAborted();
      const response = await fetch(`${this.config.baseUrl}/api/oauth/${path}`, {
        method: form ? 'POST' : 'GET',
        headers: {
          Accept: 'application/json',
          ...(form
            ? { 'Content-Type': 'application/x-www-form-urlencoded' }
            : {}),
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        ...(form ? { body: new URLSearchParams(form).toString() } : {}),
        signal: request.signal,
      });
      if (response.ok && !schema) return undefined as T;
      const data: unknown = await response.json().catch(() => undefined);
      request.signal.throwIfAborted();
      if (!response.ok) {
        const parsed = errorSchema.safeParse(data);
        throw new SubscriptionOAuthError(
          parsed.success ? parsed.data.error : 'invalid_response',
          response.status,
          parsed.success ? parsed.data.error_description : undefined,
          retryAfterMs(response.headers.get('Retry-After')),
        );
      }
      const parsed = schema!.safeParse(data);
      if (!parsed.success) {
        throw new SubscriptionOAuthError('invalid_response', response.status);
      }
      return parsed.data;
    } catch (error) {
      signal?.throwIfAborted();
      throw subscriptionError(
        error,
        path === 'device/code'
          ? 'device'
          : path === 'token'
            ? form?.['grant_type'] === 'refresh_token'
              ? 'refresh'
              : 'exchange'
            : path === 'revoke'
              ? 'revoke'
              : 'userinfo',
      );
    } finally {
      request.cleanup();
    }
  }

  async requestDeviceAuthorization(
    signal?: AbortSignal,
  ): Promise<SubscriptionDeviceAuthorization> {
    const issuedAt = Date.now();
    const data = await this.request('device/code', deviceSchema, signal, {
      client_id: this.config.clientId,
      scope: 'model:invoke profile:read',
    });
    return { ...data, expiresAt: issuedAt + data.expires_in * 1000 };
  }

  async pollForToken(
    authorization: SubscriptionDeviceAuthorization,
    signal?: AbortSignal,
  ): Promise<SubscriptionTokens> {
    signal?.throwIfAborted();
    if (Date.now() >= authorization.expiresAt) {
      throw new SubscriptionOAuthError(
        'expired_token',
        undefined,
        undefined,
        undefined,
        'exchange',
      );
    }
    const polling = combineAbortSignals([signal], {
      timeoutMs: authorization.expiresAt - Date.now(),
    });
    let interval = authorization.interval * 1000;
    let delay = interval;
    try {
      while (true) {
        await wait(
          Math.min(delay, authorization.expiresAt - Date.now()),
          polling.signal,
        );
        try {
          return await this.request('token', tokenSchema, polling.signal, {
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            client_id: this.config.clientId,
            device_code: authorization.device_code,
          });
        } catch (error) {
          polling.signal.throwIfAborted();
          if (error instanceof SubscriptionOAuthError) {
            if (
              error.status === 400 &&
              error.code === 'authorization_pending'
            ) {
              delay = interval;
              continue;
            }
            if (error.status === 400 && error.code === 'slow_down') {
              interval += 5000;
              delay = interval;
              continue;
            }
            if (
              error.status !== 429 &&
              !(error.status && error.status >= 500) &&
              error.code !== 'network_error' &&
              error.code !== 'request_timeout'
            ) {
              throw error;
            }
            delay = Math.max(interval, delay * 2, error.retryAfterMs ?? 0);
          } else {
            throw error;
          }
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (polling.signal.aborted || Date.now() >= authorization.expiresAt) {
        throw new SubscriptionOAuthError(
          'expired_token',
          undefined,
          undefined,
          undefined,
          'exchange',
        );
      }
      throw error;
    } finally {
      polling.cleanup();
    }
  }

  refreshToken(
    refreshToken: string,
    signal?: AbortSignal,
  ): Promise<SubscriptionTokens> {
    return this.request('token', tokenSchema, signal, {
      grant_type: 'refresh_token',
      client_id: this.config.clientId,
      refresh_token: refreshToken,
    });
  }

  revokeToken(
    token: string,
    tokenTypeHint: 'refresh_token' | 'access_token' = 'refresh_token',
    signal?: AbortSignal,
  ): Promise<void> {
    return this.request<void>('revoke', null, signal, {
      client_id: this.config.clientId,
      token,
      token_type_hint: tokenTypeHint,
    });
  }

  getUserInfo(
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<SubscriptionUserInfo> {
    return this.request(
      'userinfo',
      userInfoSchema,
      signal,
      undefined,
      accessToken,
    );
  }
}
