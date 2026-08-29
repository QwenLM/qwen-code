/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createDebugLogger,
  isBuiltInReasoningEffort,
  isQwenFamilyWireModel,
  isTieredEffortWireModel,
  type Config,
} from '@qwen-code/qwen-code-core';
import { getWritableScopes } from './modelProvidersScope.js';
import { SettingScope, type LoadedSettings } from './settings.js';
import {
  deleteNestedPropertySafe,
  settingExistsInScope,
} from './settingsUtils.js';

const debugLogger = createDebugLogger('REASONING_EFFORT_PERSISTENCE');

export function clearIncompatibleReasoningEffortForModel(
  config: Config,
  settings: LoadedSettings,
  modelId: string,
  persistSettings = true,
  previousModelRouteIdentity?: string,
): boolean {
  const preference = config.getReasoningPreference?.();
  if (isTieredEffortWireModel(modelId)) {
    return false;
  }
  if (
    previousModelRouteIdentity !== undefined &&
    previousModelRouteIdentity === config.getModelRouteIdentity?.()
  ) {
    return false;
  }
  const hasOpaquePreference =
    typeof preference === 'string' && !isBuiltInReasoningEffort(preference);
  const isToggleOnlyQwen = isQwenFamilyWireModel(modelId);
  const hasIncompatibleLivePreference =
    typeof preference === 'string' && (isToggleOnlyQwen || hasOpaquePreference);

  const resetLivePreference = () => {
    const persistedEffort = settings.merged.model?.reasoningEffort;
    if (persistedEffort === 'none') {
      config.disableReasoning();
    } else if (!isToggleOnlyQwen && isBuiltInReasoningEffort(persistedEffort)) {
      config.setReasoningEffort(persistedEffort);
    } else {
      config.setReasoningEffort(undefined);
    }
  };

  if (!persistSettings) {
    if (!hasIncompatibleLivePreference) {
      return false;
    }
    resetLivePreference();
    return true;
  }

  const incompatibleScopes = getWritableScopes(settings).filter((scope) => {
    const scopeSettings =
      scope === SettingScope.Workspace
        ? settings.workspace.settings
        : settings.user.settings;
    if (!settingExistsInScope('model.reasoningEffort', scopeSettings)) {
      return false;
    }
    const persistedEffort = scopeSettings.model?.reasoningEffort;
    return (
      typeof persistedEffort === 'string' &&
      persistedEffort !== 'none' &&
      (isToggleOnlyQwen || !isBuiltInReasoningEffort(persistedEffort))
    );
  });

  let clearedScopeCount = 0;
  for (const scope of incompatibleScopes) {
    try {
      settings.setValue(scope, 'model.reasoningEffort', undefined, undefined, {
        throwOnWriteFailure: true,
      });
    } catch (error) {
      debugLogger.warn(
        `Failed to clear ${scope} model.reasoningEffort after model switch: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }
    const settingsFile =
      scope === SettingScope.Workspace ? settings.workspace : settings.user;
    deleteNestedPropertySafe(
      settingsFile.settings as Record<string, unknown>,
      'model.reasoningEffort',
    );
    deleteNestedPropertySafe(
      settingsFile.originalSettings as Record<string, unknown>,
      'model.reasoningEffort',
    );
    clearedScopeCount++;
  }
  if (clearedScopeCount > 0) {
    settings.recomputeMerged();
  }
  if (hasIncompatibleLivePreference) {
    resetLivePreference();
  }
  return incompatibleScopes.length > 0 || hasIncompatibleLivePreference;
}
