/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MediaProbe } from './types.js';

/**
 * P3 · Decision knob / policy (贯穿件). The *mechanism* is locked in the
 * skeleton; the policy *table* (who owns each decision) is a plugin (config).
 *
 * Every knob has a scaffold default that is always available, so "everything
 * decided by the harness" is always a valid configuration. A knob whose
 * ownership is `model` is surfaced as a tool parameter; otherwise the model
 * never sees it and scaffold decides. Flipping ownership is a one-line policy
 * edit — the tool schema follows automatically, the read trunk does not move
 * (需求 §5.4).
 */

export type Ownership = 'scaffold' | 'model';

export type MediaDecisionPolicy = Record<string, Ownership>;

export interface DecisionKnob<T> {
  id: string;
  scaffoldDefault(probe: MediaProbe): T;
}

/**
 * Resolve a knob's value: use the model-supplied argument only when the policy
 * hands this knob to the model AND the model actually provided one; otherwise
 * fall back to the scaffold default.
 */
export function resolveKnob<T>(
  knob: DecisionKnob<T>,
  policy: MediaDecisionPolicy,
  modelArg: T | undefined,
  probe: MediaProbe,
): T {
  if (policy[knob.id] === 'model' && modelArg !== undefined) {
    return modelArg;
  }
  return knob.scaffoldDefault(probe);
}

/** Is a knob currently owned by the model (and thus exposed as a tool param)? */
export function isModelOwned(
  knobId: string,
  policy: MediaDecisionPolicy,
): boolean {
  return policy[knobId] === 'model';
}

/**
 * The default policy. The refinement knobs (range/fps/region/scale/effort) are
 * model-owned: they have no meaningful scaffold auto-value (there is no "right"
 * crop or time window without the question), and now that the readers actually
 * honor them, exposing them lets the model zoom / seek / trade cost for detail.
 * `reader` stays on scaffold (the registry picks). Config can flip any knob.
 */
export const DEFAULT_MEDIA_DECISION_POLICY: MediaDecisionPolicy = {
  reader: 'scaffold',
  range: 'model',
  fps: 'model',
  region: 'model',
  scale: 'model',
  effort: 'model',
};
