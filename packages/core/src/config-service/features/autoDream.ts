/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { runLogger } from '../../utils/runLogger.js';
import { getConfigValue, subscribeConfigValue } from '../index.js';

export const AUTO_DREAM_FEATURE_GATE = 'auto_dream';

let currentEnabled = false;

function parseGateValue(value: unknown): boolean {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return false;
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return (value as Record<string, unknown>)['enabled'] === true;
}

/**
 * Returns the QCS rollout switch for background Dream consolidation.
 * Missing or malformed values are disabled by default.
 */
export function isAutoDreamFeatureGateEnabled(): boolean {
  currentEnabled = parseGateValue(
    getConfigValue(AUTO_DREAM_FEATURE_GATE),
  );
  return currentEnabled;
}

export function registerAutoDreamFeature(): void {
  subscribeConfigValue(AUTO_DREAM_FEATURE_GATE, (value) => {
    if (value === undefined) {
      return;
    }

    currentEnabled = parseGateValue(value);
      runLogger.log('[config-service] auto_dream feature gate value received', {
        enabled: currentEnabled,
      });
  });
}

/** @internal test-only */
export function _resetAutoDreamFeatureGateForTesting(): void {
  currentEnabled = false;
}
