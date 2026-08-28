/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isQwenFamilyWireModel,
  isTieredEffortWireModel,
  type Config,
} from '@qwen-code/qwen-code-core';
import { getWritableScopes } from './modelProvidersScope.js';
import { SettingScope, type LoadedSettings } from './settings.js';
import { settingExistsInScope } from './settingsUtils.js';

export function clearReasoningEffortForToggleOnlyModel(
  config: Config,
  settings: LoadedSettings,
  modelId: string,
): boolean {
  if (!isQwenFamilyWireModel(modelId) || isTieredEffortWireModel(modelId)) {
    return false;
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
    return false;
  }

  for (const scope of owningScopes) {
    settings.setValue(scope, 'model.reasoningEffort', undefined, undefined, {
      throwOnWriteFailure: true,
    });
  }
  config.setReasoningEffort(undefined);
  return true;
}
