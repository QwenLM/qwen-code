/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { effortBudget, DEFAULT_MEDIA_EFFORT } from './media-effort.js';

describe('media-effort', () => {
  it('maps each effort tier to a concrete budget', () => {
    const low = effortBudget('low');
    const max = effortBudget('max');
    expect(low.maxFrames).toBeLessThan(max.maxFrames);
    expect(low.frameLongEdge).toBeLessThan(max.frameLongEdge);
    expect(low.segmentsPer30s).toBeLessThan(max.segmentsPer30s);
  });

  it('defaults undefined effort to the medium tier', () => {
    expect(effortBudget(undefined)).toEqual(effortBudget(DEFAULT_MEDIA_EFFORT));
    expect(DEFAULT_MEDIA_EFFORT).toBe('medium');
  });

  it('higher tiers never shrink the image cap below full', () => {
    expect(effortBudget('low').imageLongEdgeScale).toBeLessThan(1);
    expect(effortBudget('high').imageLongEdgeScale).toBe(1);
  });
});
