/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { isFeatureOpen } from '../../config/feature-flags.js';
import { runLogger } from '../../utils/runLogger.js';
import { getConfigValue, subscribeConfigValue } from '../index.js';

export const CONTEXT_WINDOW_SELECTION_GATE = 'context_window_selection';

// Default ON: the selector only renders for models whose catalog entry
// has `context_config` (multi-tier models), so single-tier models are a
// no-op. A server-side gate value or the branded `FEATURE_CONTEXT_WINDOW_SELECTION`
// override still wins via parseEnabled below.
let currentEnabled = true;

function parseEnabled(value: unknown): boolean | undefined {
  if (value == null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === '' || normalized === 'false' || normalized === '0') {
      return false;
    }
    if (normalized === 'true' || normalized === '1') return true;
    try {
      return parseEnabled(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  if (typeof value !== 'object') return undefined;
  const enabled = (value as Record<string, unknown>)['enabled'];
  return parseEnabled(enabled);
}

function resolveEnabled(): boolean {
  const freshValue = getConfigValue(CONTEXT_WINDOW_SELECTION_GATE);
  if (freshValue !== undefined) {
    const parsed = parseEnabled(freshValue);
    if (parsed !== undefined) {
      currentEnabled = parsed;
    }
  }
  return currentEnabled || isFeatureOpen(CONTEXT_WINDOW_SELECTION_GATE);
}

export function isContextWindowSelectionEnabled(): boolean {
  return resolveEnabled();
}

export function registerContextWindowSelectionFeature(): void {
  subscribeConfigValue(CONTEXT_WINDOW_SELECTION_GATE, (value) => {
    if (value === undefined) {
      return;
    }

    const parsed = parseEnabled(value);
    if (parsed === undefined) {
      runLogger.warn(
        '[config-service] Ignoring invalid context_window_selection feature gate value',
        { value },
      );
      return;
    }
    currentEnabled = parsed;
    runLogger.log(
      '[config-service] context_window_selection feature gate value received',
      { enabled: parsed },
    );
  });
}
