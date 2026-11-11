/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { runLogger } from '../../utils/runLogger.js';
import { getConfigValue, subscribeConfigValue } from '../index.js';
import { parseFiniteInteger } from './gateParseUtils.js';

export const AUTO_MEMORY_POLICY_FEATURE_GATE = 'auto_memory_policy';
export const DEFAULT_AUTO_MEMORY_EXTRACTION_EVERY_N_TURNS = 1;

export interface AutoMemoryPolicyConfig {
  /** Whether native Turn Complete automatic memory generation is enabled. */
  enabled: boolean;
  extractionEveryNTurns: number;
}

const DEFAULT_CONFIG: AutoMemoryPolicyConfig = {
  enabled: false,
  extractionEveryNTurns: DEFAULT_AUTO_MEMORY_EXTRACTION_EVERY_N_TURNS,
};

let currentConfig: AutoMemoryPolicyConfig = DEFAULT_CONFIG;

function parseAutoMemoryPolicy(value: unknown): AutoMemoryPolicyConfig {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return DEFAULT_CONFIG;
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return DEFAULT_CONFIG;
  }

  const record = value as Record<string, unknown>;
  const rawInterval =
    record['extraction_every_n_turns'] ??
    record['extractionEveryNTurns'];
  const parsedInterval = parseFiniteInteger(
    rawInterval,
  );
  if (
    record['enabled'] !== true ||
    parsedInterval === undefined ||
    parsedInterval <= 0 ||
    Number(rawInterval) !== parsedInterval
  ) {
    return DEFAULT_CONFIG;
  }
  return { enabled: true, extractionEveryNTurns: parsedInterval };
}

function refreshRemoteConfig(): void {
  currentConfig = parseAutoMemoryPolicy(
    getConfigValue(AUTO_MEMORY_POLICY_FEATURE_GATE)
  );
}

export function getAutoMemoryPolicyConfig(): Readonly<AutoMemoryPolicyConfig> {
  refreshRemoteConfig();
  return currentConfig;
}

export function isAutoMemoryTurnCompleteGenerationEnabled(): boolean {
  return getAutoMemoryPolicyConfig().enabled;
}

/** Number of eligible completed turns accumulated before extraction runs. */
export function getAutoMemoryExtractionEveryNTurns(): number {
  return getAutoMemoryPolicyConfig().extractionEveryNTurns;
}

export function registerAutoMemoryPolicyFeature(): void {
  subscribeConfigValue(AUTO_MEMORY_POLICY_FEATURE_GATE, (value) => {
    if (value === undefined) {
      return;
    }
      currentConfig = parseAutoMemoryPolicy(value);
      runLogger.log(
        '[config-service] auto_memory_policy feature gate value received',
        {
          enabled: currentConfig.enabled,
          extractionEveryNTurns: currentConfig.extractionEveryNTurns,
        },
      );
  });
}

/** @internal test-only */
export function _resetAutoMemoryPolicyFeatureForTesting(): void {
  currentConfig = DEFAULT_CONFIG;
}
