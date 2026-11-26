/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { runLogger } from '../../utils/runLogger.js';
import { getConfigValue, subscribeConfigValue } from '../index.js';
import { parseEnabledGateValue } from './gateParseUtils.js';

export const ASYNC_USER_INTERACTION_FEATURE_GATE = 'async_user_interaction';

export function isAsyncUserInteractionFeatureGateEnabled(): boolean {
  return (
    parseEnabledGateValue(getConfigValue(ASYNC_USER_INTERACTION_FEATURE_GATE)) ??
    true
  );
}

export function registerAsyncUserInteractionFeature(): void {
  subscribeConfigValue(ASYNC_USER_INTERACTION_FEATURE_GATE, (value) => {
    runLogger.log(
      '[config-service] async_user_interaction feature gate value received',
      { enabled: parseEnabledGateValue(value) ?? true },
    );
  });
}
