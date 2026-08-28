/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isBuiltInReasoningEffort,
  isQwenFamilyWireModel,
  isTieredEffortWireModel,
  type Config,
} from '@qwen-code/qwen-code-core';
import { getWritableScopes } from './modelProvidersScope.js';
import { SettingScope, type LoadedSettings } from './settings.js';
import { settingExistsInScope } from './settingsUtils.js';

export function clearIncompatibleReasoningEffortForModel(
  config: Config,
  settings: LoadedSettings,
  modelId: string,
  persistSettings = true,
  previousModelRouteIdentity?: string,
): boolean {
  const preference = config.getReasoningPreference();
  if (isTieredEffortWireModel(modelId)) {
    return false;
  }
  if (
    previousModelRouteIdentity !== undefined &&
    previousModelRouteIdentity === config.getModelRouteIdentity()
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

  for (const scope of incompatibleScopes) {
    settings.setValue(scope, 'model.reasoningEffort', undefined, undefined, {
      throwOnWriteFailure: true,
    });
  }
  if (hasIncompatibleLivePreference) {
    resetLivePreference();
  }
  return incompatibleScopes.length > 0 || hasIncompatibleLivePreference;
}
