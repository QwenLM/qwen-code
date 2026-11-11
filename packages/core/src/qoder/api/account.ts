/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { QoderAccountRegion } from './regions.js';

const CREDENTIAL_VERSION = 1;

/** Persisted Qoder account for one region. Never exposed to UI as-is. */
export interface QoderAccountRecord {
  readonly region: QoderAccountRegion;
  readonly userId: string;
  readonly userName: string;
  readonly email?: string;
  readonly organizationId?: string;
  readonly organizationName?: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
  /** Epoch milliseconds. */
  readonly refreshTokenExpiresAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Account fields supplied when a login or refresh is persisted. */
export type QoderAccountInput = Omit<
  QoderAccountRecord,
  'createdAt' | 'updatedAt'
>;

/** Safe for UI display; never contains credentials. */
export interface QoderAccountSummary {
  readonly region: QoderAccountRegion;
  readonly userId: string;
  readonly userName: string;
  readonly email?: string;
  readonly organizationName?: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
}

export interface QoderCredentialsSnapshot {
  readonly version: typeof CREDENTIAL_VERSION;
  readonly accounts: Partial<Record<QoderAccountRegion, QoderAccountRecord>>;
}

export const QODER_CREDENTIAL_VERSION = CREDENTIAL_VERSION;

export function toQoderAccountSummary(
  account: QoderAccountRecord,
): QoderAccountSummary {
  return {
    region: account.region,
    userId: account.userId,
    userName: account.userName,
    ...(account.email ? { email: account.email } : {}),
    ...(account.organizationName
      ? { organizationName: account.organizationName }
      : {}),
    expiresAt: account.expiresAt,
  };
}
