/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { runLogger } from '../../utils/runLogger.js';
import { getConfigValue, subscribeConfigValue } from '../index.js';
import { parseEnabledGateValue } from './gateParseUtils.js';

export const LEGACY_INFER_DOMAIN_FAILOVER_FEATURE_GATE =
  'legacy_infer_domain_failover';

let currentEnabled = false;

function resolveEnabled(): boolean {
  const freshValue = getConfigValue(LEGACY_INFER_DOMAIN_FAILOVER_FEATURE_GATE);
  if (freshValue !== undefined) {
    const parsed = parseEnabledGateValue(freshValue);
    if (parsed !== undefined) currentEnabled = parsed;
  }
  return currentEnabled;
}

export function isLegacyInferDomainFailoverEnabledByFeatureGate(): boolean {
  return resolveEnabled();
}

export function registerLegacyInferDomainFailoverFeature(): void {
  subscribeConfigValue(LEGACY_INFER_DOMAIN_FAILOVER_FEATURE_GATE, (value) => {
    if (value === undefined) {
      return;
    }
      const parsed = parseEnabledGateValue(value);
      if (parsed === undefined) {
        runLogger.warn(
          '[config-service] Ignoring invalid legacy_infer_domain_failover feature gate value',
          { value },
        );
        return;
      }
      currentEnabled = parsed;
      runLogger.log(
        '[config-service] legacy_infer_domain_failover feature gate value received',
        { enabled: parsed },
      );
  });
}

/** @internal test-only */
export function _resetLegacyInferDomainFailoverFeatureGateForTesting(): void {
  currentEnabled = false;
}
