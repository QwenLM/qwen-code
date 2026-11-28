/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import {
  applyReasoningEffort,
  type ReasoningEffort,
} from '@qwen-code/qwen-code-core/core/reasoning-effort.js';
import {
  getPersistScopeForModelSelection,
  getWritableScopes,
} from './modelProvidersScope.js';
import type { LoadedSettings } from './settings.js';

export function saveModelPreference(
  config: Config,
  settings: LoadedSettings,
  modelKey: string,
  patch: { effort: ReasoningEffort } | { contextWindow: number | undefined },
): void {
  const isEffort = 'effort' in patch;
  const existingScope = getWritableScopes(settings).find((scope) => {
    const preference =
      settings.forScope(scope).settings.model?.preferences?.[modelKey];
    const value = isEffort
      ? preference?.reasoning?.effort
      : preference?.contextWindow;
    return value !== undefined;
  });
  const value = isEffort ? patch.effort : patch.contextWindow;
  if (value !== undefined || existingScope !== undefined) {
    settings.setValue(
      existingScope ?? getPersistScopeForModelSelection(settings),
      [
        'model',
        'preferences',
        modelKey,
        ...(isEffort ? ['reasoning', 'effort'] : ['contextWindow']),
      ],
      value,
      undefined,
      { throwOnWriteFailure: true },
    );
  }
  config.setModelPreferences(
    settings.merged.model?.preferences ?? {},
    isEffort ? 'reasoning' : 'contextWindow',
  );
}

export function applyModelReasoningEffort(
  config: Config | undefined,
  settings: LoadedSettings,
  effort: ReasoningEffort,
  persist = true,
): void {
  if (config) {
    const modelKey = persist ? config.getModelPreferenceKey() : undefined;
    if (modelKey) {
      saveModelPreference(config, settings, modelKey, { effort });
      return;
    }
    applyReasoningEffort(config, effort);
  }
  if (persist) {
    settings.setValue(
      getPersistScopeForModelSelection(settings),
      'model.reasoningEffort',
      effort,
    );
  }
}
