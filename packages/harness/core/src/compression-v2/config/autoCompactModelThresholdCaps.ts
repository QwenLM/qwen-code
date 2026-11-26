/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getConfigValue,
  subscribeConfigValue,
} from '../../config-service/index.js';
import { runLogger } from '../../utils/runLogger.js';

export const AUTO_COMPACT_MODEL_THRESHOLD_CAPS_GATE =
  'auto_compact_model_threshold_caps';

function parseCaps(value: unknown): Readonly<Record<string, number>> {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  if (record['enabled'] !== true) return {};
  const caps = record['model_threshold_caps'];
  if (!caps || typeof caps !== 'object' || Array.isArray(caps)) return {};
  return Object.fromEntries(
    Object.entries(caps).filter(
      ([key, cap]) =>
        key.length > 0 &&
        typeof cap === 'number' &&
        Number.isSafeInteger(cap) &&
        cap > 0,
    ),
  );
}

export function getAutoCompactModelThresholdCap(
  model: string,
): number | undefined {
  const caps = parseCaps(
    getConfigValue(AUTO_COMPACT_MODEL_THRESHOLD_CAPS_GATE),
  );
  return Object.hasOwn(caps, model) ? caps[model] : undefined;
}

export function registerAutoCompactModelThresholdCapsFeature(): void {
  subscribeConfigValue(AUTO_COMPACT_MODEL_THRESHOLD_CAPS_GATE, (value) => {
    if (value === undefined) {
      return;
    }

    runLogger.log('[config-service] auto_compact_model_threshold_caps received', {
      modelThresholdCaps: parseCaps(value),
    });
  });
}
