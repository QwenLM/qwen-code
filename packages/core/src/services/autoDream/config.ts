/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Dream (memory consolidation) configuration.
 *
 * Dream enablement depends on the caller mode:
 * - TUI: explicit local setting, otherwise the QCS rollout gate.
 * - Ordinary headless: the headless master switch plus the Dream env override.
 * - SDK Memory: always disabled.
 */

import { isAutoDreamFeatureGateEnabled } from '../../config-service/features/autoDream.js';
import type { Config } from '../../config/config.js';
import {
  getAutoMemoryHeadlessDreamEnvOverride,
  isAutoMemoryHeadlessEnvEnabled,
} from '../../config/brand.js';

export interface DreamConfig {
  /** Separate opt-in for background consolidation. */
  enabled: boolean;
  /** Hours between consolidation runs. */
  minHours: number;
  /** Minimum sessions accumulated since last consolidation. */
  minSessions: number;
  /** Minutes between consecutive transcript directory scans. */
  scanThrottleMinutes: number;
}

const DEFAULTS: DreamConfig = {
  enabled: false,
  minHours: 24,
  minSessions: 5,
  scanThrottleMinutes: 10,
};

/**
 * Resolves Dream enablement and scheduling thresholds from the merged
 * `dream` settings block, falling back to built-in defaults.
 */
export function resolveDreamConfig(config: Config): DreamConfig {
  const settings = config.getDreamSettings?.() ?? {};
  let enabled: boolean;

  if (config.isSdkMemoryRequestActive()) {
    enabled = false;
  } else if (!config.isInteractive()) {
    enabled =
      isAutoMemoryHeadlessEnvEnabled() &&
      (getAutoMemoryHeadlessDreamEnvOverride() ?? true);
  } else {
    enabled =
      typeof settings.enabled === 'boolean'
        ? settings.enabled
        : isAutoDreamFeatureGateEnabled();
  }

  return {
    enabled,
    minHours:
      typeof settings.minHours === 'number' && settings.minHours > 0
        ? settings.minHours
        : DEFAULTS.minHours,
    minSessions:
      typeof settings.minSessions === 'number' && settings.minSessions > 0
        ? settings.minSessions
        : DEFAULTS.minSessions,
    scanThrottleMinutes:
      typeof settings.scanThrottleMinutes === 'number' &&
      settings.scanThrottleMinutes > 0
        ? settings.scanThrottleMinutes
        : DEFAULTS.scanThrottleMinutes,
  };
}
