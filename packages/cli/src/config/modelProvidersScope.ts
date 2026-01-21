/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { SettingScope, type LoadedSettings } from './settings.js';

function hasOwnModelProviders(settingsObj: unknown): boolean {
  if (!settingsObj || typeof settingsObj !== 'object') {
    return false;
  }
  const obj = settingsObj as Record<string, unknown>;
  // Treat an explicitly configured empty object (modelProviders: {}) as "owned"
  // by this scope, which is important when mergeStrategy is REPLACE.
  return Object.prototype.hasOwnProperty.call(obj, 'modelProviders');
}

/**
 * Returns which writable scope (Workspace/User) owns the effective modelProviders
 * configuration.
 *
 * Note: Workspace scope is only considered when the workspace is trusted.
 */
export function getModelProvidersOwnerScope(
  settings: LoadedSettings,
): SettingScope | undefined {
  if (settings.isTrusted && hasOwnModelProviders(settings.workspace.settings)) {
    return SettingScope.Workspace;
  }

  if (hasOwnModelProviders(settings.user.settings)) {
    return SettingScope.User;
  }

  return undefined;
}

/**
 * Choose the settings scope to persist a model selection.
 * Prefer persisting back to the scope that contains the effective modelProviders
 * config, otherwise fall back to the legacy trust-based heuristic.
 */
export function getPersistScopeForModelSelection(
  settings: LoadedSettings,
): SettingScope {
  return getModelProvidersOwnerScope(settings) ?? SettingScope.User;
}
