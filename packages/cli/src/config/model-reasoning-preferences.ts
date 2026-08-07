/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelReasoningPreference } from '@qwen-code/qwen-code-core';
import type { Settings } from './settings.js';

export function getModelReasoningPreference(
  settings: Settings,
  baseModelId: string,
): unknown {
  const preferences = settings.model?.reasoningPreferences;
  if (!preferences || typeof preferences !== 'object') return undefined;
  return (preferences as Record<string, unknown>)[baseModelId];
}

export function mergeModelReasoningPreference(
  settings: Settings,
  baseModelId: string,
  patch: ModelReasoningPreference,
): Record<string, unknown> {
  const preferences = settings.model?.reasoningPreferences;
  const current =
    preferences && typeof preferences === 'object'
      ? (preferences as Record<string, unknown>)
      : {};
  const currentPreference = current[baseModelId];
  return {
    ...current,
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
