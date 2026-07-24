/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MEDIA_DECISION_POLICY,
  isModelOwned,
  resolveKnob,
  type DecisionKnob,
} from './decision-policy.js';
import type { MediaProbe } from './types.js';

const probe: MediaProbe = {
  path: '/tmp/a.mp4',
  hash: 'abc',
  modality: 'video',
  mimeType: 'video/mp4',
  sizeBytes: 10,
};

const fpsKnob: DecisionKnob<number> = {
  id: 'fps',
  scaffoldDefault: () => 1,
};

describe('decision policy', () => {
  it('uses the model arg only when the knob is model-owned and provided', () => {
    expect(resolveKnob(fpsKnob, { fps: 'model' }, 5, probe)).toBe(5);
    expect(resolveKnob(fpsKnob, { fps: 'model' }, undefined, probe)).toBe(1);
    expect(resolveKnob(fpsKnob, { fps: 'scaffold' }, 5, probe)).toBe(1);
  });

  it('isModelOwned reflects the policy table', () => {
    expect(isModelOwned('fps', { fps: 'model' })).toBe(true);
    expect(isModelOwned('fps', { fps: 'scaffold' })).toBe(false);
    expect(isModelOwned('missing', {})).toBe(false);
  });

  it('default policy owns the refinement knobs by the model, reader by scaffold', () => {
    // The refinement knobs (range/fps/region/scale/effort) are model-owned so
    // the model can zoom/seek/trade cost for detail; reader stays on scaffold.
    expect(DEFAULT_MEDIA_DECISION_POLICY['reader']).toBe('scaffold');
    for (const knob of ['range', 'fps', 'region', 'scale', 'effort']) {
      expect(DEFAULT_MEDIA_DECISION_POLICY[knob]).toBe('model');
    }
  });
});
