/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  QoderAuthApi,
  QoderLoginOptions,
} from '../../api/auth/auth.js';
import {
  ensureQoderAccessToken,
  getQoderAuthStatus,
  listQoderAccounts,
  refreshQoderAccount,
  startQoderDeviceLogin,
  type QoderAccessToken,
  type QoderAuthStatus,
  type QoderDeviceLoginHandle,
} from '../../../auth-service.js';
import type { QoderAccountSummary } from '../../../account.js';
import type { QoderCredentialStore } from '../../../credential-store.js';
import type { QoderAccountRegion } from '../../../regions.js';
import type { QoderTokenProvider } from '../../pipeline/valve/authValve.js';

export interface QoderAuthApiOptions {
  readonly region: QoderAccountRegion;
  readonly credentialStore: QoderCredentialStore;
  readonly tokenProvider: QoderTokenProvider;
  readonly fetchImpl?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly clientId?: string;
  readonly requestTimeoutMs?: number;
}

/** Account facade; delegates login/refresh to the auth domain services. */
export class QoderAuthApiImpl implements QoderAuthApi {
  constructor(private readonly options: QoderAuthApiOptions) {}

  startDeviceLogin(
    options: QoderLoginOptions = {},
  ): QoderDeviceLoginHandle {
    const handle = startQoderDeviceLogin({
      ...this.authOptions(),
      region: this.options.region,
      credentialStore: this.options.credentialStore,
      ...options,
    });
    return {
      region: handle.region,
      authUrl: handle.authUrl,
      expiresAt: handle.expiresAt,
      cancel: () => handle.cancel(),
      completion: handle.completion.then((result) => {
        this.options.tokenProvider.invalidate?.();
        return result;
      }),
    };
  }

  getStatus(): Promise<QoderAuthStatus> {
    return getQoderAuthStatus(this.options.region, {
      ...this.authOptions(),
      credentialStore: this.options.credentialStore,
    });
  }

  ensureAccessToken(): Promise<QoderAccessToken> {
    return ensureQoderAccessToken(this.options.region, {
      ...this.authOptions(),
      credentialStore: this.options.credentialStore,
    });
  }

  async refresh(): Promise<QoderAccountSummary> {
    const summary = await refreshQoderAccount(this.options.region, {
      ...this.authOptions(),
      credentialStore: this.options.credentialStore,
    });
    this.options.tokenProvider.invalidate?.();
    return summary;
  }

  async logout(): Promise<void> {
    await this.options.credentialStore.clear(this.options.region);
    this.options.tokenProvider.invalidate?.();
  }

  listAccounts(): Promise<
    Partial<Record<QoderAccountRegion, QoderAccountSummary>>
  > {
    return listQoderAccounts({
      credentialStore: this.options.credentialStore,
    });
  }

  private authOptions(): {
    fetchImpl?: typeof fetch;
    env?: NodeJS.ProcessEnv;
    now?: () => number;
    clientId?: string;
    requestTimeoutMs?: number;
  } {
    return {
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      ...(this.options.env ? { env: this.options.env } : {}),
      ...(this.options.now ? { now: this.options.now } : {}),
      ...(this.options.clientId ? { clientId: this.options.clientId } : {}),
      ...(this.options.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: this.options.requestTimeoutMs }
        : {}),
    };
  }
}
