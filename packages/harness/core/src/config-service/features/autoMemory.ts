/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { runLogger } from '../../utils/runLogger.js';
import { getConfigValue, subscribeConfigValue } from '../index.js';

export const AUTO_MEMORY_FEATURE_GATE = 'auto_memory';

/**
 * Parsed `auto_memory` QCS payload. `project_enabled` and `user_enabled`
 * independently own the two TUI defaults.
 */
export interface AutoMemoryGateConfig {
  /** Default for project-scoped memory when the user has no local setting. */
  projectEnabled: boolean;
  /** Default for user-scoped memory when the user has no local setting. */
  userEnabled: boolean;
}

const DEFAULT_AUTO_MEMORY_GATE_CONFIG: AutoMemoryGateConfig = {
  projectEnabled: false,
  userEnabled: false,
};

let currentConfig = DEFAULT_AUTO_MEMORY_GATE_CONFIG;
let onConfigChange:
  | ((config: Readonly<AutoMemoryGateConfig>) => void)
  | undefined;

function parseOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function parseGateValue(value: unknown): AutoMemoryGateConfig {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return DEFAULT_AUTO_MEMORY_GATE_CONFIG;
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return DEFAULT_AUTO_MEMORY_GATE_CONFIG;
  }
  const record = value as Record<string, unknown>;
  const projectEnabled =
    parseOptionalBoolean(
      record['project_enabled'] ?? record['projectEnabled'],
    ) ??
    DEFAULT_AUTO_MEMORY_GATE_CONFIG.projectEnabled;
  const userEnabled =
    parseOptionalBoolean(record['user_enabled'] ?? record['userEnabled']) ??
    DEFAULT_AUTO_MEMORY_GATE_CONFIG.userEnabled;
  return {
    projectEnabled,
    userEnabled,
  };
}

function refreshRemoteConfig(): void {
  const freshValue = getConfigValue(AUTO_MEMORY_FEATURE_GATE);
  currentConfig = parseGateValue(freshValue);
}

export function getAutoMemoryFeatureGateConfig(): Readonly<AutoMemoryGateConfig> {
  refreshRemoteConfig();
  return currentConfig;
}

/**
 * Returns the raw QCS rollout state without applying the environment override.
 * Used to distinguish gray rollout from a manual opt-in.
 */
export function isAutoMemoryFeatureGateEnabled(): boolean {
  const config = getAutoMemoryFeatureGateConfig();
  return config.projectEnabled || config.userEnabled;
}

export function isAutoMemoryProjectFeatureGateEnabled(): boolean {
  return getAutoMemoryFeatureGateConfig().projectEnabled;
}

export function isAutoMemoryUserFeatureGateEnabled(): boolean {
  return getAutoMemoryFeatureGateConfig().userEnabled;
}

/**
 * Returns the QCS Auto Memory rollout signal. Runtime scope enablement is owned
 * by `Config.isAutoMemoryEnabled()` and the merged settings.
 */
export function resolveAutoMemoryEnabled(): boolean {
  return isAutoMemoryFeatureGateEnabled();
}

/**
 * Installs the process-local runtime callback used to refresh memory context
 * and the cached system prompt when the remote rollout changes.
 */
export function setAutoMemoryFeatureGateChangeHandler(
  handler:
    | ((config: Readonly<AutoMemoryGateConfig>) => void)
    | undefined,
): void {
  onConfigChange = handler;
}

export function registerAutoMemoryFeature(): void {
  subscribeConfigValue(AUTO_MEMORY_FEATURE_GATE, (value) => {
    if (value === undefined) {
      return;
    }
      const nextConfig = parseGateValue(value);
      const changed =
        nextConfig.projectEnabled !== currentConfig.projectEnabled ||
        nextConfig.userEnabled !== currentConfig.userEnabled;
      currentConfig = nextConfig;

      runLogger.log('[config-service] auto_memory feature gate value received', {
        enabled:
          currentConfig.projectEnabled || currentConfig.userEnabled,
        projectEnabled: currentConfig.projectEnabled,
        userEnabled: currentConfig.userEnabled,
      });

      if (changed) {
        onConfigChange?.(currentConfig);
      }
  });
}

/** @internal test-only */
export function _resetAutoMemoryFeatureGateForTesting(): void {
  currentConfig = DEFAULT_AUTO_MEMORY_GATE_CONFIG;
  onConfigChange = undefined;
}
