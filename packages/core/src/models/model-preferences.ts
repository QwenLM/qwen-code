/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { ContentGeneratorConfig } from '../core/contentGenerator.js';
import {
  normalizeReasoningEffort,
  type ReasoningEffort,
} from '../core/reasoning-effort.js';
import { stripRuntimeSnapshotPrefix } from '../utils/runtimeModelPrefix.js';

export interface ModelPreference {
  reasoning?: { enabled?: boolean; effort?: ReasoningEffort };
  contextWindow?: number;
}

export type ModelPreferences = Readonly<
  Partial<Record<string, ModelPreference>>
>;

export function getModelPreferenceKey(
  authType: string,
  modelId: string,
  endpoint: string | undefined,
): string {
  const id = encodeURIComponent(stripRuntimeSnapshotPrefix(modelId));
  const suffix = endpoint
    ? `#${createHash('sha256').update(endpoint).digest('hex')}`
    : '';
  return `${authType}/${id}${suffix}`;
}

export function readModelPreference(
  preference: ModelPreference | undefined,
): ModelPreference | undefined {
  const enabled = preference?.reasoning?.enabled;
  const effort = normalizeReasoningEffort(preference?.reasoning?.effort);
  const window = preference?.contextWindow;
  const copy: ModelPreference = {};
  if (typeof enabled === 'boolean' || effort !== undefined) {
    copy.reasoning = {
      ...(typeof enabled === 'boolean' ? { enabled } : {}),
      ...(effort ? { effort } : {}),
    };
  }
  if (
    typeof window === 'number' &&
    Number.isSafeInteger(window) &&
    window > 0
  ) {
    copy.contextWindow = window;
  }
  return copy.reasoning || copy.contextWindow !== undefined ? copy : undefined;
}

export function copyModelPreferences(
  preferences: ModelPreferences | undefined,
): ModelPreferences {
  const values: Record<string, ModelPreference> = {};
  for (const [key, preference] of Object.entries(preferences ?? {})) {
    if (!key.includes('/')) continue;
    const copy = readModelPreference(preference);
    if (copy) values[key] = copy;
  }
  return values;
}

export function resolveModelPreferenceReasoning(
  baseline: ContentGeneratorConfig['reasoning'],
  preference: ModelPreference['reasoning'],
  fallback: ReasoningEffort | 'none' | undefined,
  canDisable: boolean,
): ContentGeneratorConfig['reasoning'] {
  const savedEffort = normalizeReasoningEffort(preference?.effort);
  const enabled = preference?.enabled;
  if (
    canDisable &&
    (enabled === false ||
      (enabled === undefined &&
        savedEffort === undefined &&
        fallback === 'none'))
  ) {
    return false;
  }
  const reasoning = enabled === true ? baseline || {} : baseline;
  const effort = savedEffort ?? (fallback === 'none' ? undefined : fallback);
  return effort && reasoning !== false ? { ...reasoning, effort } : reasoning;
}
