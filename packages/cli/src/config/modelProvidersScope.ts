/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { SettingScope, type LoadedSettings } from './settings.js';

export function hasOwnModelProviders(settingsObj: unknown): boolean {
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

/**
 * The writable scopes that contribute to the effective (merged) config, highest
 * precedence first. Workspace is only writable/honored when trusted.
 */
export function getWritableScopes(settings: LoadedSettings): SettingScope[] {
  return settings.isTrusted
    ? [SettingScope.Workspace, SettingScope.User]
    : [SettingScope.User];
}

/**
 * Returns the highest-precedence writable scope that explicitly owns `key`
 * (top-level settings key), or `undefined` when no writable scope sets it.
 * Used to persist an edit to a key back to the same scope it lives in, since
 * keys like `modelFallbacks` / `model` are independently scoped from
 * `modelProviders`.
 */
export function getOwnKeyScope(
  settings: LoadedSettings,
  key: string,
): SettingScope | undefined {
  for (const scope of getWritableScopes(settings)) {
    const obj = settings.forScope(scope).settings as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(obj, key)) return scope;
  }
  return undefined;
}
