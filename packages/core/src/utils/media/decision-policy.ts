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
 * The default policy: start with everything on scaffold except whether to call
 * a tool at all (that is inherently the model's — it decides to invoke). This is
 * the "start simple" baseline; config can flip any knob to `model`.
 */
export const DEFAULT_MEDIA_DECISION_POLICY: MediaDecisionPolicy = {
  reader: 'scaffold',
  range: 'scaffold',
  fps: 'scaffold',
  region: 'scaffold',
  scale: 'scaffold',
  effort: 'scaffold',
};
