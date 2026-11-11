/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { runLogger } from '../../utils/runLogger.js';
import {
  toQoderAccountSummary,
  type QoderAccountInput,
  type QoderAccountRecord,
  type QoderAccountSummary,
} from './account.js';
import {
  QoderCredentialStore,
  type QoderCredentialStoreOptions,
} from './credential-store.js';
import {
  QoderOAuthClient,
  QoderOAuthError,
  type QoderOAuthRequestOptions,
  type QoderTokenResponse,
  type QoderUserProfile,
} from './oauth-client.js';
import type { QoderAccountRegion } from './regions.js';

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1_000;
const ACCESS_TOKEN_EXPIRY_BUFFER_MS = 60_000;

export type QoderAuthState =
  | 'missing'
  | 'authenticated'
  | 'refresh_required'
  | 'expired';

export interface QoderAuthStatus {
  readonly region: QoderAccountRegion;
  readonly state: QoderAuthState;
  readonly account?: QoderAccountSummary;
  /** Epoch milliseconds. */
  readonly expiresAt?: number;
  /** Whether the stored refresh token can still be used. */
  readonly canRefresh: boolean;
}

export interface QoderLoginResult {
  readonly region: QoderAccountRegion;
  readonly account: QoderAccountSummary;
}

export interface QoderAccessToken {
  readonly accessToken: string;
  readonly account: QoderAccountSummary;
}

export interface QoderDeviceLoginHandle {
  readonly region: QoderAccountRegion;
  readonly authUrl: string;
  /** Epoch milliseconds; the browser sign-in window deadline. */
  readonly expiresAt: number;
  readonly completion: Promise<QoderLoginResult>;
  cancel(): void;
}

export interface QoderAuthServiceOptions {
  readonly credentialStore?: QoderCredentialStore;
  readonly credentialStoreOptions?: QoderCredentialStoreOptions;
  readonly fetchImpl?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly clientId?: string;
  readonly requestTimeoutMs?: number;
}

export interface QoderDeviceLoginOptions extends QoderAuthServiceOptions {
  readonly region: QoderAccountRegion;
  readonly signal?: AbortSignal;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  /** Persist the account when the flow completes; defaults to true. */
  readonly persist?: boolean;
}

export interface QoderAuthRequestOptions
  extends QoderAuthServiceOptions,
    Pick<QoderOAuthRequestOptions, 'signal' | 'timeoutMs' | 'fetchImpl'> {}

const refreshInFlight = new Map<string, Promise<QoderAccountSummary>>();

/**
 * Starts a Qoder browser sign-in. The authorization URL is produced
 * synchronously so callers can render it before polling begins.
 */
export function startQoderDeviceLogin(
  options: QoderDeviceLoginOptions,
): QoderDeviceLoginHandle {
  const { region } = options;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const store = resolveStore(options);
  const client = createOAuthClient(region, options);
  const authorization = client.createAuthorization();
  const expiresAt = now() + timeoutMs;
  const controller = new AbortController();
  const detachCallerSignal = linkAbortSignal(options.signal, controller);

  const completion = runDeviceLogin({
    client,
    region,
    authorization,
    expiresAt,
    pollIntervalMs,
    persist: options.persist ?? true,
    store,
    now,
    signal: controller.signal,
  }).then(
    (result) => {
      detachCallerSignal?.();
      return result;
    },
    (error: unknown) => {
      detachCallerSignal?.();
      throw error;
    },
  );

  return {
    region,
    authUrl: authorization.authUrl,
    expiresAt,
    completion,
    cancel() {
      if (!controller.signal.aborted) {
        controller.abort(cancelledError());
      }
    },
  };
}

/**
 * Read-only login-state check. Callers deciding whether to start a browser
 * flow should check this first; `authenticated` and `refresh_required` do not
 * need a new device flow.
 */
export async function getQoderAuthStatus(
  region: QoderAccountRegion,
  options: QoderAuthServiceOptions = {},
): Promise<QoderAuthStatus> {
  const store = resolveStore(options);
  const now = options.now ?? Date.now;
  const account = await readAccount(store, region);
  if (!account) {
    return { region, state: 'missing', canRefresh: false };
  }

  const summary = toQoderAccountSummary(account);
  const canRefresh =
    !isLegacyPatAccount(account) &&
    (account.refreshTokenExpiresAt === undefined ||
      account.refreshTokenExpiresAt > now());

  if (account.expiresAt > now() + ACCESS_TOKEN_EXPIRY_BUFFER_MS) {
    return {
      region,
      state: 'authenticated',
      account: summary,
      expiresAt: account.expiresAt,
      canRefresh,
    };
  }

  return {
    region,
    state: canRefresh ? 'refresh_required' : 'expired',
    account: summary,
    expiresAt: account.expiresAt,
    canRefresh,
  };
}

/**
 * Return a usable access token for a region, refreshing it when needed.
 * Throws `QoderOAuthError('invalid_grant')` when a new sign-in is required.
 */
export async function ensureQoderAccessToken(
  region: QoderAccountRegion,
  options: QoderAuthRequestOptions = {},
): Promise<QoderAccessToken> {
  const status = await getQoderAuthStatus(region, options);
  if (status.state === 'authenticated') {
    const store = resolveStore(options);
    const account = await readAccount(store, region);
    if (!account) {
      throw authRequiredError(region);
    }
    return {
      accessToken: account.accessToken,
      account: toQoderAccountSummary(account),
    };
  }

  if (status.state === 'refresh_required') {
    const summary = await refreshQoderAccount(region, options);
    const store = resolveStore(options);
    const account = await readAccount(store, region);
    if (!account) {
      throw authRequiredError(region);
    }
    return { accessToken: account.accessToken, account: summary };
  }

  throw authRequiredError(region);
}

/**
 * Rotate the stored refresh/access tokens for one region. Concurrent callers
 * share one in-flight request so the refresh token is not consumed twice.
 */
export function refreshQoderAccount(
  region: QoderAccountRegion,
  options: QoderAuthRequestOptions = {},
): Promise<QoderAccountSummary> {
  const store = resolveStore(options);
  const key = `${store.path}:${region}`;
  const existing = refreshInFlight.get(key);
  if (existing) {
    return existing;
  }

  const pending = performRefresh(region, store, options).finally(() => {
    refreshInFlight.delete(key);
  });
  refreshInFlight.set(key, pending);
  return pending;
}

export async function listQoderAccounts(
  options: QoderAuthServiceOptions = {},
): Promise<Partial<Record<QoderAccountRegion, QoderAccountSummary>>> {
  return resolveStore(options).listSummaries();
}

/** @internal */
export function resetQoderRefreshInFlightForTests(): void {
  refreshInFlight.clear();
}

interface RunDeviceLoginParams {
  client: QoderOAuthClient;
  region: QoderAccountRegion;
  authorization: ReturnType<QoderOAuthClient['createAuthorization']>;
  expiresAt: number;
  pollIntervalMs: number;
  persist: boolean;
  store: QoderCredentialStore;
  now: () => number;
  signal: AbortSignal;
}

async function runDeviceLogin(
  params: RunDeviceLoginParams,
): Promise<QoderLoginResult> {
  const {
    client,
    region,
    authorization,
    expiresAt,
    pollIntervalMs,
    persist,
    store,
    now,
    signal,
  } = params;

  for (;;) {
    throwIfAborted(signal);
    const remainingMs = expiresAt - now();
    if (remainingMs <= 0) {
      throw new QoderOAuthError(
        'timeout',
        `Qoder sign-in timed out for ${region}.`,
      );
    }

    let result;
    try {
      result = await client.pollToken(authorization, { signal });
    } catch (error) {
      if (signal.aborted) {
        throw toCancelledError(signal);
      }
      if (error instanceof QoderOAuthError) {
        throw error;
      }
      runLogger.debug(
        `[qoder-auth] ${region} poll network error; retrying: ${errorMessage(error)}`,
      );
      await sleep(Math.min(pollIntervalMs, remainingMs), signal);
      continue;
    }

    if (result.kind === 'pending') {
      await sleep(Math.min(pollIntervalMs, remainingMs), signal);
      continue;
    }

    const account = await completeLogin({
      client,
      region,
      token: result.token,
      persist,
      store,
      now,
      signal,
    });
    return { region, account };
  }
}

async function completeLogin(params: {
  client: QoderOAuthClient;
  region: QoderAccountRegion;
  token: QoderTokenResponse;
  persist: boolean;
  store: QoderCredentialStore;
  now: () => number;
  signal: AbortSignal;
}): Promise<QoderAccountSummary> {
  const { client, region, token, persist, store, now, signal } = params;
  const userInfo = await readUserInfo(client, token.accessToken, signal);
  const userId = userInfo?.uid || token.userId;
  if (!userId) {
    throw new QoderOAuthError(
      'invalid_response',
      'Qoder sign-in did not return a user id.',
    );
  }

  const account: QoderAccountInput = {
    region,
    userId,
    userName: userInfo?.nickName || userInfo?.name || token.userName || userId,
    ...(userInfo?.email ? { email: userInfo.email } : {}),
    ...(userInfo?.organizationId
      ? { organizationId: userInfo.organizationId }
      : {}),
    ...(userInfo?.organizationName
      ? { organizationName: userInfo.organizationName }
      : {}),
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: token.expiresAt,
    ...(token.refreshTokenExpiresAt !== undefined
      ? { refreshTokenExpiresAt: token.refreshTokenExpiresAt }
      : {}),
  };

  if (!persist) {
    const timestamp = now();
    return toQoderAccountSummary({
      ...account,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  return toQoderAccountSummary(await store.upsert(account));
}

async function readUserInfo(
  client: QoderOAuthClient,
  accessToken: string,
  signal: AbortSignal,
): Promise<QoderUserProfile | undefined> {
  try {
    return await client.fetchUserInfo(accessToken, { signal });
  } catch (error) {
    if (signal.aborted) {
      throw toCancelledError(signal);
    }
    runLogger.debug(
      `[qoder-auth] userinfo failed; continuing without profile: ${errorMessage(error)}`,
    );
    return undefined;
  }
}

async function performRefresh(
  region: QoderAccountRegion,
  store: QoderCredentialStore,
  options: QoderAuthRequestOptions,
): Promise<QoderAccountSummary> {
  const account = await readAccount(store, region);
  if (!account) {
    throw new QoderOAuthError(
      'invalid_grant',
      `No Qoder account is connected for ${region}.`,
    );
  }
  if (isLegacyPatAccount(account)) {
    throw new QoderOAuthError(
      'invalid_grant',
      'Qoder PAT sign-in is no longer supported. Run /auth and sign in with browser.',
    );
  }

  const client = createOAuthClient(region, options);
  const requestOptions = {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
  };
  const refreshed = await client.refresh(account.refreshToken, requestOptions);

  const updated: QoderAccountInput = {
    region: account.region,
    userId: account.userId,
    userName: account.userName,
    ...(account.email ? { email: account.email } : {}),
    ...(account.organizationId
      ? { organizationId: account.organizationId }
      : {}),
    ...(account.organizationName
      ? { organizationName: account.organizationName }
      : {}),
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresAt: refreshed.expiresAt,
    ...(refreshed.refreshTokenExpiresAt !== undefined
      ? { refreshTokenExpiresAt: refreshed.refreshTokenExpiresAt }
      : account.refreshTokenExpiresAt !== undefined
        ? { refreshTokenExpiresAt: account.refreshTokenExpiresAt }
        : {}),
  };
  return toQoderAccountSummary(await store.upsert(updated));
}

async function readAccount(
  store: QoderCredentialStore,
  region: QoderAccountRegion,
): Promise<QoderAccountRecord | undefined> {
  return store.getAccount(region);
}

function isLegacyPatAccount(account: QoderAccountRecord): boolean {
  return (
    (account as QoderAccountRecord & { refreshKind?: unknown }).refreshKind ===
    'pat'
  );
}

function resolveStore(options: QoderAuthServiceOptions): QoderCredentialStore {
  if (options.credentialStore) {
    return options.credentialStore;
  }
  return new QoderCredentialStore({
    ...options.credentialStoreOptions,
    ...(options.now ? { now: options.now } : {}),
  });
}

function createOAuthClient(
  region: QoderAccountRegion,
  options: QoderAuthServiceOptions,
): QoderOAuthClient {
  return new QoderOAuthClient({
    region,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.clientId ? { clientId: options.clientId } : {}),
    ...(options.requestTimeoutMs !== undefined
      ? { requestTimeoutMs: options.requestTimeoutMs }
      : {}),
  });
}

function authRequiredError(region: QoderAccountRegion): QoderOAuthError {
  return new QoderOAuthError(
    'invalid_grant',
    `Qoder sign-in is required for ${region}.`,
  );
}

function cancelledError(): QoderOAuthError {
  return new QoderOAuthError('cancelled', 'Qoder sign-in was cancelled.');
}

function linkAbortSignal(
  parent: AbortSignal | undefined,
  controller: AbortController,
): (() => void) | undefined {
  if (!parent) {
    return undefined;
  }
  if (parent.aborted) {
    controller.abort(toCancelledError(parent));
    return undefined;
  }
  const onAbort = () => controller.abort(toCancelledError(parent));
  parent.addEventListener('abort', onAbort, { once: true });
  return () => parent.removeEventListener('abort', onAbort);
}

function toCancelledError(signal: AbortSignal): QoderOAuthError {
  return signal.reason instanceof QoderOAuthError &&
    signal.reason.code === 'cancelled'
    ? signal.reason
    : cancelledError();
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw toCancelledError(signal);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(toCancelledError(signal));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(toCancelledError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
