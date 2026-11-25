/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { composeAbortSignals, proxiedFetch } from '../../utils/fetch.js';
import {
  resolveQoderClientId,
  resolveQoderRegionEndpoints,
  type QoderAccountRegion,
} from './regions.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_ACCESS_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const POLL_PENDING_STATUS = 404;
/** Identifies the Qwen Code client on the account-selection page. */
const QODER_OAUTH_SOURCE_TYPE = 'QwenCode';

export type QoderOAuthErrorCode =
  | 'cancelled'
  | 'timeout'
  | 'http'
  | 'invalid_response'
  | 'invalid_grant';

export class QoderOAuthError extends Error {
  readonly code: QoderOAuthErrorCode;
  readonly status?: number;

  constructor(
    code: QoderOAuthErrorCode,
    message: string,
    options?: { status?: number },
  ) {
    super(message);
    this.name = 'QoderOAuthError';
    this.code = code;
    if (options?.status !== undefined) {
      this.status = options.status;
    }
  }
}

export interface QoderUserProfile {
  readonly uid: string;
  readonly name?: string;
  readonly nickName?: string;
  readonly email?: string;
  readonly organizationId?: string;
  readonly organizationName?: string;
}

export interface QoderTokenResponse {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly userId?: string;
  readonly userName?: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
  /** Epoch milliseconds. */
  readonly refreshTokenExpiresAt?: number;
}

export type QoderDevicePollResult =
  | { readonly kind: 'pending' }
  | { readonly kind: 'success'; readonly token: QoderTokenResponse };

export interface QoderDeviceAuthorization {
  readonly region: QoderAccountRegion;
  readonly nonce: string;
  readonly verifier: string;
  readonly authUrl: string;
}

export interface QoderOAuthRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
}

export interface QoderOAuthClientOptions {
  readonly region: QoderAccountRegion;
  readonly fetchImpl?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
  readonly clientId?: string;
  readonly requestTimeoutMs?: number;
}

/**
 * Wire-level client for Qoder OAuth. It only knows the documented HTTP
 * endpoints; persistence and login orchestration live in the auth service.
 */
export class QoderOAuthClient {
  private readonly region: QoderAccountRegion;
  private readonly fetchImpl: typeof fetch;
  private readonly env: NodeJS.ProcessEnv;
  private readonly clientId: string;
  private readonly requestTimeoutMs: number;

  constructor(options: QoderOAuthClientOptions) {
    this.region = options.region;
    this.fetchImpl =
      options.fetchImpl ?? (proxiedFetch as unknown as typeof fetch);
    this.env = options.env ?? process.env;
    this.clientId = options.clientId ?? resolveQoderClientId(this.env);
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  createAuthorization(): QoderDeviceAuthorization {
    const { verifier, challenge } = generatePkce();
    const nonce = randomUUID();
    const authUrl = this.buildAuthUrl(challenge, nonce);
    return { region: this.region, nonce, verifier, authUrl };
  }

  async pollToken(
    authorization: Pick<QoderDeviceAuthorization, 'nonce' | 'verifier'>,
    options: QoderOAuthRequestOptions = {},
  ): Promise<QoderDevicePollResult> {
    const endpoints = resolveQoderRegionEndpoints(this.region, this.env);
    const query = new URLSearchParams({
      nonce: authorization.nonce,
      verifier: authorization.verifier,
      challenge_method: 'S256',
    });
    const response = await this.request(
      `${endpoints.openApiBaseUrl}/api/v1/deviceToken/poll?${query.toString()}`,
      { headers: { Accept: 'application/json' } },
      options,
    );

    if (response.status === POLL_PENDING_STATUS) {
      await response.body?.cancel().catch(() => {});
      return { kind: 'pending' };
    }
    if (!response.ok) {
      throw new QoderOAuthError(
        'http',
        `Qoder sign-in failed with HTTP ${response.status} for ${this.region}.`,
        { status: response.status },
      );
    }

    const body = await readJson(response, this.region);
    const accessToken = readString(body, 'token');
    if (!accessToken) {
      return { kind: 'pending' };
    }
    const refreshToken = readString(body, 'refresh_token');
    if (!refreshToken) {
      throw new QoderOAuthError(
        'invalid_response',
        'Qoder sign-in did not return a refresh token.',
      );
    }

    const now = Date.now();
    const userId = readString(body, 'user_id');
    const userName = readString(body, 'user_name');
    const refreshTokenExpiresAt = parseOptionalExpiryMs(
      readString(body, 'refresh_token_expires_at'),
      readNumber(body, 'refresh_token_expires_in'),
      now,
    );

    return {
      kind: 'success',
      token: {
        accessToken,
        refreshToken,
        ...(userId ? { userId } : {}),
        ...(userName ? { userName } : {}),
        expiresAt:
          parseOptionalExpiryMs(
            readString(body, 'expires_at'),
            readNumber(body, 'expires_in'),
            now,
          ) ??
          now + DEFAULT_ACCESS_TOKEN_TTL_MS,
        ...(refreshTokenExpiresAt !== undefined
          ? { refreshTokenExpiresAt }
          : {}),
      },
    };
  }

  async fetchUserInfo(
    accessToken: string,
    options: QoderOAuthRequestOptions = {},
  ): Promise<QoderUserProfile> {
    const endpoints = resolveQoderRegionEndpoints(this.region, this.env);
    const response = await this.request(
      `${endpoints.openApiBaseUrl}/api/v1/userinfo`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      },
      options,
    );
    if (!response.ok) {
      throw new QoderOAuthError(
        'http',
        `Qoder userinfo failed with HTTP ${response.status} for ${this.region}.`,
        { status: response.status },
      );
    }
    return mapUserInfo(await readJson(response, this.region));
  }

  async refresh(
    refreshToken: string,
    options: QoderOAuthRequestOptions = {},
  ): Promise<QoderTokenResponse> {
    const endpoints = resolveQoderRegionEndpoints(this.region, this.env);
    const response = await this.request(
      `${endpoints.openApiBaseUrl}/api/v1/deviceToken/refresh`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ refresh_token: refreshToken }),
      },
      options,
    );

    if (response.status === 400 || response.status === 401) {
      throw new QoderOAuthError(
        'invalid_grant',
        `Qoder token refresh was rejected for ${this.region}.`,
        { status: response.status },
      );
    }
    if (!response.ok) {
      throw new QoderOAuthError(
        'http',
        `Qoder token refresh failed with HTTP ${response.status} for ${this.region}.`,
        { status: response.status },
      );
    }

    const body = await readJson(response, this.region);
    const accessToken =
      readString(body, 'device_token') ??
      readString(body, 'token') ??
      readString(body, 'access_token');
    if (!accessToken) {
      throw new QoderOAuthError(
        'invalid_response',
        'Qoder token refresh did not return an access token.',
      );
    }

    const now = Date.now();
    const refreshTokenExpiresAt = parseOptionalExpiryMs(
      readString(body, 'refresh_token_expires_at'),
      readNumber(body, 'refresh_token_expires_in'),
      now,
    );
    return {
      accessToken,
      refreshToken: readString(body, 'refresh_token') ?? refreshToken,
      expiresAt:
        parseOptionalExpiryMs(
          readString(body, 'expires_at'),
          readNumber(body, 'expires_in'),
          now,
        ) ??
        now + DEFAULT_ACCESS_TOKEN_TTL_MS,
      ...(refreshTokenExpiresAt !== undefined
        ? { refreshTokenExpiresAt }
        : {}),
    };
  }

  private buildAuthUrl(challenge: string, nonce: string): string {
    const endpoints = resolveQoderRegionEndpoints(this.region, this.env);
    const params = new URLSearchParams({
      sourceType: QODER_OAUTH_SOURCE_TYPE,
      challenge,
      challenge_method: 'S256',
      nonce,
      client_id: this.clientId,
    });
    return `${endpoints.websiteBaseUrl}/device/selectAccounts?${params.toString()}`;
  }

  private async request(
    url: string,
    init: RequestInit,
    options: QoderOAuthRequestOptions,
  ): Promise<Response> {
    const { signal, cleanup } = composeRequestSignal(
      options.signal,
      options.timeoutMs ?? this.requestTimeoutMs,
    );
    try {
      return await (options.fetchImpl ?? this.fetchImpl)(url, {
        ...init,
        signal,
      });
    } catch (error) {
      if (options.signal?.aborted) {
        throw cancelledError();
      }
      throw error;
    } finally {
      cleanup();
    }
  }
}

function composeRequestSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup(): void } {
  const signals: AbortSignal[] = [];
  if (signal) signals.push(signal);
  if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
  if (signals.length === 0) {
    return { signal: new AbortController().signal, cleanup() {} };
  }
  return composeAbortSignals(signals);
}

function cancelledError(): QoderOAuthError {
  return new QoderOAuthError('cancelled', 'Qoder sign-in was cancelled.');
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function readJson(
  response: Response,
  region: QoderAccountRegion,
): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new QoderOAuthError(
      'invalid_response',
      `Qoder returned an invalid response for ${region}.`,
    );
  }
}

function mapUserInfo(value: unknown): QoderUserProfile {
  if (!isRecord(value)) {
    throw new QoderOAuthError(
      'invalid_response',
      'Qoder userinfo returned an invalid response.',
    );
  }
  const organization = isRecord(value['organization'])
    ? value['organization']
    : undefined;
  const name =
    readString(value, 'name') ??
    readString(value, 'username') ??
    readString(value, 'user_name');
  const nickName =
    readString(value, 'nick_name') ?? readString(value, 'nickName');
  const email = readString(value, 'email');
  const organizationId = resolveOrganizationId(value, organization);
  const organizationName = resolveOrganizationName(value, organization);

  return {
    uid:
      readString(value, 'id') ??
      readString(value, 'user_id') ??
      readString(value, 'uid') ??
      '',
    ...(name ? { name } : {}),
    ...(nickName ? { nickName } : {}),
    ...(email ? { email } : {}),
    ...(organizationId ? { organizationId } : {}),
    ...(organizationName ? { organizationName } : {}),
  };
}

function resolveOrganizationId(
  value: Record<string, unknown>,
  organization: Record<string, unknown> | undefined,
): string | undefined {
  return (
    readString(value, 'organization_id') ??
    readString(value, 'orgId') ??
    (organization
      ? (readString(organization, 'org_id') ??
        readString(organization, 'orgId'))
      : undefined)
  );
}

function resolveOrganizationName(
  value: Record<string, unknown>,
  organization: Record<string, unknown> | undefined,
): string | undefined {
  return (
    readString(value, 'organization_name') ??
    readString(value, 'orgName') ??
    (organization
      ? (readString(organization, 'org_name') ??
        readString(organization, 'orgName'))
      : undefined)
  );
}

function parseOptionalExpiryMs(
  expiresAt: string | undefined,
  expiresIn: number | undefined,
  now: number,
): number | undefined {
  if (expiresAt) {
    const numeric = Number(expiresAt);
    if (Number.isFinite(numeric)) {
      if (numeric > 1e12) return numeric;
      if (numeric > 1e9) return numeric * 1_000;
    }
    const parsed = Date.parse(expiresAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof expiresIn === 'number' && Number.isFinite(expiresIn)) {
    return now + expiresIn * 1_000;
  }
  return undefined;
}

function readString(source: unknown, key: string): string | undefined {
  if (!isRecord(source)) return undefined;
  const value = source[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNumber(source: unknown, key: string): number | undefined {
  if (!isRecord(source)) return undefined;
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
