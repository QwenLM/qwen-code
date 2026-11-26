/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';

import { delay } from '../../utils/delay.js';
import { composeAbortSignals } from '../../utils/fetch.js';
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

export type QwenSubscriptionDeviceAuthorization = z.infer<
  typeof deviceSchema
> & { readonly expiresAt: number };
export type QwenSubscriptionTokens = z.infer<typeof tokenSchema>;
export type QwenSubscriptionUserInfo = z.infer<typeof userInfoSchema>;
export type QwenSubscriptionOAuthStage =
  | 'device'
  | 'exchange'
  | 'credentials'
  | 'userinfo'
  | 'refresh'
  | 'revoke'
  | 'cleanup';

export class QwenSubscriptionOAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
    readonly description?: string,
    readonly retryAfterMs?: number,
    readonly stage?: QwenSubscriptionOAuthStage,
  ) {
    super(description ? `${code}: ${description}` : code);
    this.name = 'QwenSubscriptionOAuthError';
  }
}

export function toSubscriptionOAuthError(
  error: unknown,
  stage: QwenSubscriptionOAuthStage,
): QwenSubscriptionOAuthError {
  if (error instanceof QwenSubscriptionOAuthError) {
    return new QwenSubscriptionOAuthError(
      error.code,
      error.status,
      error.description,
      error.retryAfterMs,
      error.stage ?? stage,
    );
  }
  return new QwenSubscriptionOAuthError(
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
  const parsed = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - Date.now();
  return Number.isFinite(parsed) ? Math.max(0, parsed) : undefined;
}

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Device-code OAuth client for the Qwen membership service.
 *
 * Mirrors the device flow contract: request a code, poll the token endpoint
 * until the browser approves it, refresh rotating pairs, and revoke on
 * sign-out. Errors keep the OAuth code, HTTP status and Retry-After so the
 * UI can distinguish expiry, denial and rate limiting.
 */
export class QwenSubscriptionOAuthClient {
  private readonly config = getQwenOAuthConfig();

  private async request<T>(
    endpoint: string,
    schema: z.ZodType<T> | null,
    signal?: AbortSignal,
    form?: Record<string, string>,
    accessToken?: string,
  ): Promise<T> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const composed = composeAbortSignals(
      signal ? [signal, timeout] : [timeout],
    );
    try {
      composed.signal.throwIfAborted();
      const response = await fetch(
        `${this.config.baseUrl}/api/oauth/${endpoint}`,
        {
          method: form ? 'POST' : 'GET',
          headers: {
            Accept: 'application/json',
            ...(form
              ? { 'Content-Type': 'application/x-www-form-urlencoded' }
              : {}),
            ...(accessToken
              ? { Authorization: `Bearer ${accessToken}` }
              : {}),
          },
          ...(form ? { body: new URLSearchParams(form).toString() } : {}),
          signal: composed.signal,
        },
      );
      if (response.ok && !schema) return undefined as T;
      const data: unknown = await response.json().catch(() => undefined);
      composed.signal.throwIfAborted();
      if (!response.ok) {
        const parsed = errorSchema.safeParse(data);
        throw new QwenSubscriptionOAuthError(
          parsed.success ? parsed.data.error : 'invalid_response',
          response.status,
          parsed.success ? parsed.data.error_description : undefined,
          retryAfterMs(response.headers.get('Retry-After')),
        );
      }
      const parsed = schema!.safeParse(data);
      if (!parsed.success) {
        throw new QwenSubscriptionOAuthError('invalid_response', response.status);
      }
      return parsed.data;
    } catch (error) {
      signal?.throwIfAborted();
      throw toSubscriptionOAuthError(
        error,
        endpoint === 'device/code'
          ? 'device'
          : endpoint === 'token'
            ? form?.['grant_type'] === 'refresh_token'
              ? 'refresh'
              : 'exchange'
            : endpoint === 'revoke'
              ? 'revoke'
              : 'userinfo',
      );
    } finally {
      composed.cleanup();
    }
  }

  async requestDeviceAuthorization(
    signal?: AbortSignal,
  ): Promise<QwenSubscriptionDeviceAuthorization> {
    const issuedAt = Date.now();
    const data = await this.request('device/code', deviceSchema, signal, {
      client_id: this.config.clientId,
      scope: 'model:invoke profile:read',
    });
    return { ...data, expiresAt: issuedAt + data.expires_in * 1000 };
  }

  async pollForToken(
    authorization: QwenSubscriptionDeviceAuthorization,
    signal?: AbortSignal,
  ): Promise<QwenSubscriptionTokens> {
    signal?.throwIfAborted();
    if (Date.now() >= authorization.expiresAt) {
      throw new QwenSubscriptionOAuthError(
        'expired_token',
        undefined,
        undefined,
        undefined,
        'exchange',
      );
    }
    let interval = authorization.interval * 1000;
    let waitMs = interval;
    while (true) {
      signal?.throwIfAborted();
      await delay(
        Math.min(waitMs, Math.max(0, authorization.expiresAt - Date.now())),
        signal,
      );
      if (Date.now() >= authorization.expiresAt) {
        throw new QwenSubscriptionOAuthError(
          'expired_token',
          undefined,
          undefined,
          undefined,
          'exchange',
        );
      }
      try {
        return await this.request('token', tokenSchema, signal, {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: this.config.clientId,
          device_code: authorization.device_code,
        });
      } catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof QwenSubscriptionOAuthError)) throw error;
        if (error.status === 400 && error.code === 'authorization_pending') {
          waitMs = interval;
          continue;
        }
        if (error.status === 400 && error.code === 'slow_down') {
          interval += 5000;
          waitMs = interval;
          continue;
        }
        // Transient failures back off; contract violations end the flow.
        if (
          error.status !== 429 &&
          !(error.status && error.status >= 500) &&
          error.code !== 'network_error' &&
          error.code !== 'request_timeout'
        ) {
          throw error;
        }
        waitMs = Math.max(interval, waitMs * 2, error.retryAfterMs ?? 0);
      }
    }
  }

  refreshToken(
    refreshToken: string,
    signal?: AbortSignal,
  ): Promise<QwenSubscriptionTokens> {
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
  ): Promise<QwenSubscriptionUserInfo> {
    return this.request(
      'userinfo',
      userInfoSchema,
      signal,
      undefined,
      accessToken,
    );
  }
}
