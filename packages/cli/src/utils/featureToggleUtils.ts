/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandSettings } from '../config/createCliSettingsService.js';
import {
  SettingScope,
  isLoadableSettingScope,
  type LoadableSettingScope,
} from '../config/settings.js';

export interface ModifiedScope {
  scope: SettingScope;
  path: string;
}

export type FeatureActionStatus = 'success' | 'no-op' | 'error';

export interface FeatureActionResult {
  status: FeatureActionStatus;
  featureName: string;
  action: 'enable' | 'disable';
  /** Scopes where the feature's state was actually changed. */
  modifiedScopes: ModifiedScope[];
  /** Scopes where the feature was already in the desired state. */
  alreadyInStateScopes: ModifiedScope[];
  /** Error message if status is 'error'. */
  error?: string;
}

/**
 * Strategy pattern to handle differences between feature types (e.g. skills vs agents).
 */
export interface FeatureToggleStrategy {
  /**
   * Checks if the feature needs to be enabled in the given scope.
   * For skills (blacklist): returns true if in disabled list.
   * For agents (whitelist): returns true if NOT explicitly enabled (false or undefined).
   */
  needsEnabling(
    settings: CommandSettings,
    scope: LoadableSettingScope,
    featureName: string,
  ): boolean;

  /**
   * Applies the enable change to the settings object.
   */
  enable(
    settings: CommandSettings,
    scope: LoadableSettingScope,
    featureName: string,
  ): boolean;

  /**
   * Checks if the feature is explicitly disabled in the given scope.
   * For skills (blacklist): returns true if in disabled list.
   * For agents (whitelist): returns true if explicitly set to false.
   */
  isExplicitlyDisabled(
    settings: CommandSettings,
    scope: LoadableSettingScope,
    featureName: string,
  ): boolean;

  /**
   * Applies the disable change to the settings object.
   */
  disable(
    settings: CommandSettings,
    scope: LoadableSettingScope,
    featureName: string,
  ): boolean;
}

/**
 * Enables a feature. When a specific scope is provided, only that scope is
 * written to. Otherwise falls back to enabling in all writable scopes.
 */
export function enableFeature(
  settings: CommandSettings,
  featureName: string,
  strategy: FeatureToggleStrategy,
  scope?: SettingScope,
): FeatureActionResult {
  const writableScopes =
    scope !== undefined && isLoadableSettingScope(scope)
      ? [scope]
      : [SettingScope.Project, SettingScope.User];
  const foundInDisabledScopes: ModifiedScope[] = [];
  const alreadyEnabledScopes: ModifiedScope[] = [];

  for (const scope of writableScopes) {
    if (isLoadableSettingScope(scope)) {
      const scopePath = settings.forScope(scope).path;
      if (strategy.needsEnabling(settings, scope, featureName)) {
        foundInDisabledScopes.push({ scope, path: scopePath });
      } else {
        alreadyEnabledScopes.push({ scope, path: scopePath });
      }
    }
  }

  if (foundInDisabledScopes.length === 0) {
    return {
      status: 'no-op',
      featureName,
      action: 'enable',
      modifiedScopes: [],
      alreadyInStateScopes: alreadyEnabledScopes,
    };
  }

  const modifiedScopes: ModifiedScope[] = [];
  for (const { scope, path } of foundInDisabledScopes) {
    if (isLoadableSettingScope(scope)) {
      if (!strategy.enable(settings, scope, featureName)) {
        return {
          status: 'error',
          featureName,
          action: 'enable',
          modifiedScopes,
          alreadyInStateScopes: alreadyEnabledScopes,
          error: `Failed to update settings for ${scope}.`,
        };
      }
      modifiedScopes.push({ scope, path });
    }
  }

  return {
    status: 'success',
    featureName,
    action: 'enable',
    modifiedScopes,
    alreadyInStateScopes: alreadyEnabledScopes,
  };
}

/**
 * Disables a feature in the specified scope.
 */
export function disableFeature(
  settings: CommandSettings,
  featureName: string,
  scope: SettingScope,
  strategy: FeatureToggleStrategy,
): FeatureActionResult {
  if (!isLoadableSettingScope(scope)) {
    return {
      status: 'error',
      featureName,
      action: 'disable',
      modifiedScopes: [],
      alreadyInStateScopes: [],
      error: `Invalid settings scope: ${scope}`,
    };
  }

  const scopePath = settings.forScope(scope).path;

  if (strategy.isExplicitlyDisabled(settings, scope, featureName)) {
    return {
      status: 'no-op',
      featureName,
      action: 'disable',
      modifiedScopes: [],
      alreadyInStateScopes: [{ scope, path: scopePath }],
    };
  }

  // Check if it's already disabled in the other writable scope
  const otherScope =
    scope === SettingScope.Project
      ? SettingScope.User
      : SettingScope.Project;
  const alreadyDisabledInOther: ModifiedScope[] = [];

  if (isLoadableSettingScope(otherScope)) {
    if (strategy.isExplicitlyDisabled(settings, otherScope, featureName)) {
      alreadyDisabledInOther.push({
        scope: otherScope,
        path: settings.forScope(otherScope).path,
      });
    }
  }

  if (!strategy.disable(settings, scope, featureName)) {
    return {
      status: 'error',
      featureName,
      action: 'disable',
      modifiedScopes: [],
      alreadyInStateScopes: alreadyDisabledInOther,
      error: `Failed to update settings for ${scope}.`,
    };
  }

  return {
    status: 'success',
    featureName,
    action: 'disable',
    modifiedScopes: [{ scope, path: scopePath }],
    alreadyInStateScopes: alreadyDisabledInOther,
  };
}
