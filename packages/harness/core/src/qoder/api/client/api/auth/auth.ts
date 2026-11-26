/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  QoderAccessToken,
  QoderAuthStatus,
  QoderDeviceLoginHandle,
} from '../../../auth-service.js';
import type { QoderAccountSummary } from '../../../account.js';
import type { QoderAccountRegion } from '../../../regions.js';

export interface QoderLoginOptions {
  readonly signal?: AbortSignal;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly persist?: boolean;
}

/** Qoder account access: device login, login-state checks, and refresh. */
export interface QoderAuthApi {
  startDeviceLogin(options?: QoderLoginOptions): QoderDeviceLoginHandle;
  getStatus(): Promise<QoderAuthStatus>;
  ensureAccessToken(): Promise<QoderAccessToken>;
  refresh(): Promise<QoderAccountSummary>;
  logout(): Promise<void>;
  listAccounts(): Promise<
    Partial<Record<QoderAccountRegion, QoderAccountSummary>>
  >;
}
