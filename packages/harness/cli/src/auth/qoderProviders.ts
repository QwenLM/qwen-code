/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  QODER_ACCOUNT_REGIONS,
  QoderProvider,
  createQoderClient,
  hasQoderStoredAccount,
  resolveQoderAccountRegion,
  runLogger,
  resolveQoderRegionEndpoints,
  type QoderAccountRegion,
  type ModelProvider,
  type ModelTransportManager,
} from '@qwen-code/core';
import type { SettingsService } from '@qwen-code/resource';

/**
 * Whether a Qoder account is available to this process. Provider composition
 * uses it so an existing login keeps contributing Qoder models even when
 * settings select another provider.
 */
export function isQoderAccountConfigured(): boolean {
  return QODER_ACCOUNT_REGIONS.some((region) =>
    hasQoderStoredAccount(region),
  );
}

/** Prefer the configured region, then any region that has a stored account. */
export function resolveConfiguredQoderRegion(): QoderAccountRegion {
  const preferred = resolveQoderAccountRegion();
  if (hasQoderStoredAccount(preferred)) return preferred;
  return (
    QODER_ACCOUNT_REGIONS.find((region) => hasQoderStoredAccount(region)) ??
    preferred
  );
}

/**
 * Qoder OAuth provider: dynamic qcode catalog with explicit request attribution
 * over the shared Responses codecs. Registered for `qoder-oauth` or whenever a
 * Qoder account is already available.
 */
export function createQoderProviders(
  settingsService: SettingsService,
  _transportManager: ModelTransportManager,
  region: QoderAccountRegion = resolveConfiguredQoderRegion(),
): readonly ModelProvider[] {
  const gatewayBaseUrl = resolveQoderRegionEndpoints(region).gatewayBaseUrl;
  const client = createQoderClient({ region });
  runLogger.log(
    `[qoder-provider] provider enabled region=${region} gateway=${gatewayBaseUrl}`,
  );
  return [new QoderProvider({ client, gatewayBaseUrl, settingsService })];
}
