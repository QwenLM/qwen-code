/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { runLogger } from '../../utils/runLogger.js';
import { subscribeConfigValue } from '../index.js';

/** Register the echo feature gate (called by features/index.ts) */
export function registerEchoFeature(): void {
  subscribeConfigValue('echo', (value) => {
    if (value === undefined) {
      return;
    }

    runLogger.log('[config-service] Echo feature gate value received', {
      value,
    });
  });
}
