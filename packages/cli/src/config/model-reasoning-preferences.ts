/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelReasoningPreference } from '@qwen-code/qwen-code-core';
import type { Settings } from './settings.js';

function asPreferencesRecord(
  preferences: unknown,
): Record<string, unknown> | undefined {
  return preferences &&
    typeof preferences === 'object' &&
    !Array.isArray(preferences)
    ? (preferences as Record<string, unknown>)
    : undefined;
}

export function getModelReasoningPreference(
  settings: Settings,
  baseModelId: string,
): unknown {
  const preferences = asPreferencesRecord(settings.model?.reasoningPreferences);
  return preferences?.[baseModelId];
}

export function mergeModelReasoningPreference(
  settings: Settings,
  baseModelId: string,
  patch: ModelReasoningPreference,
): Record<string, unknown> {
  const current = asPreferencesRecord(settings.model?.reasoningPreferences);
  const currentPreference = current?.[baseModelId];
  return {
    ...(current ?? {}),
    [baseModelId]: {
      ...(currentPreference &&
      typeof currentPreference === 'object' &&
      !Array.isArray(currentPreference)
        ? currentPreference
        : {}),
      ...patch,
    },
  };
}
