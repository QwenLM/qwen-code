/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { runLogger } from '../../utils/runLogger.js';
import { getConfigValue, subscribeConfigValue } from '../index.js';
import { parseEnabledGateValue } from './gateParseUtils.js';

export const POWERSHELL_TOOL_FEATURE_GATE = 'powershell_tool';

let currentEnabled = false;
let hasResolvedValue = false;

function parseEnabled(value: unknown): boolean | undefined {
  if (value == null) return false;
  return parseEnabledGateValue(value);
}

function resolveEnabled(): boolean {
  const freshValue = getConfigValue(POWERSHELL_TOOL_FEATURE_GATE);
  if (freshValue !== undefined) {
    const parsed = parseEnabled(freshValue);
    if (parsed !== undefined) {
      currentEnabled = parsed;
      hasResolvedValue = true;
    }
  }
  return currentEnabled;
}

export function isPowerShellToolQcsEnabled(): boolean {
  return resolveEnabled();
}

export function hasPowerShellToolQcsValue(): boolean {
  resolveEnabled();
  return hasResolvedValue;
}

export function registerPowerShellToolFeature(): void {
  subscribeConfigValue(POWERSHELL_TOOL_FEATURE_GATE, (value) => {
    if (value === undefined) return;
    const parsed = parseEnabled(value);
    if (parsed === undefined) {
      runLogger.warn(
        '[config-service] Ignoring invalid powershell_tool feature gate value',
        { value },
      );
      return;
    }
    currentEnabled = parsed;
    hasResolvedValue = true;
    runLogger.log(
      '[config-service] powershell_tool feature gate value received',
      { enabled: parsed },
    );
  });
}

/** @internal test-only */
export function _resetPowerShellToolFeatureGateForTesting(): void {
  currentEnabled = false;
  hasResolvedValue = false;
}
