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
): boolean {
  const preference = config.getReasoningPreference();
  if (isTieredEffortWireModel(modelId)) {
    return false;
  }
  const hasOpaquePreference =
    typeof preference === 'string' && !isBuiltInReasoningEffort(preference);
  const isToggleOnlyQwen = isQwenFamilyWireModel(modelId);
  const hasIncompatibleLivePreference =
    typeof preference === 'string' && (isToggleOnlyQwen || hasOpaquePreference);

  if (!isToggleOnlyQwen && !hasOpaquePreference) {
    return false;
  }

  if (!persistSettings) {
    if (!hasIncompatibleLivePreference) {
      return false;
    }
    config.setReasoningEffort(undefined);
    return true;
  }

  const owningScopes = getWritableScopes(settings).filter((scope) =>
    settingExistsInScope(
      'model.reasoningEffort',
      scope === SettingScope.Workspace
        ? settings.workspace.settings
        : settings.user.settings,
    ),
  );
  if (owningScopes.length === 0) {
    if (!hasIncompatibleLivePreference) {
      return false;
    }
    config.setReasoningEffort(undefined);
    return true;
  }

  for (const scope of owningScopes) {
    settings.setValue(scope, 'model.reasoningEffort', undefined, undefined, {
      throwOnWriteFailure: true,
    });
  }
  config.setReasoningEffort(undefined);
  return true;
}
