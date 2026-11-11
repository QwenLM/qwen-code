/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Live evaluation settings, validated so a misconfigured run fails loudly. */

import type { LiveModel } from './harness.js';

const MODEL_FIELDS = ['BASE_URL', 'API_KEY', 'MODEL'] as const;

/**
 * The model configured under `prefix`, or `undefined` when none of its
 * variables is set. A partial set throws: a typo must not silently drop the
 * gating model and leave nothing measured.
 */
export function modelFrom(
  env: Record<string, string | undefined>,
  prefix: string,
  label: string,
): LiveModel | undefined {
  const [baseUrl, apiKey, model] = MODEL_FIELDS.map(
    (field) => env[`${prefix}_${field}`] || undefined,
  );
  if (!baseUrl && !apiKey && !model) return undefined;
  const missing = MODEL_FIELDS.filter(
    (_, index) => ![baseUrl, apiKey, model][index],
  );
  if (missing.length) {
    throw new Error(
      `${prefix} is incomplete: set ${missing.map((field) => `${prefix}_${field}`).join(', ')}`,
    );
  }
  return {
    label: `${label}:${model}`,
    baseUrl: baseUrl!,
    apiKey: apiKey!,
    model: model!,
  };
}

/** The gating model (required) and the optional comparison model. */
export function liveModels(env: Record<string, string | undefined>) {
  const gating = modelFrom(env, 'QWEN_GENERATED_UI_LIVE', 'gating');
  if (!gating) {
    throw new Error(
      'QWEN_GENERATED_UI_LIVE=1 needs QWEN_GENERATED_UI_LIVE_BASE_URL, _API_KEY and _MODEL',
    );
  }
  const comparison = modelFrom(env, 'QWEN_GENERATED_UI_COMPARE', 'comparison');
  return comparison ? [gating, comparison] : [gating];
}

/** The selected case names; every name must exist. Empty selects all. */
export function selectCases(available: string[], raw = ''): string[] {
  const selected = raw
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const unknown = selected.filter((name) => !available.includes(name));
  if (unknown.length) {
    throw new Error(
      `unknown QWEN_GENERATED_UI_LIVE_CASES: ${unknown.join(', ')} (available: ${available.join(', ')})`,
    );
  }
  return selected.length
    ? available.filter((name) => selected.includes(name))
    : available;
}
