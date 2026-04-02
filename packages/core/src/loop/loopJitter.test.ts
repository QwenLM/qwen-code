/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { computeJitter } from './loopJitter.js';

describe('computeJitter', () => {
  it('returns 0 for 0 interval', () => {
    expect(computeJitter('any-id', 0)).toBe(0);
  });

  it('is non-negative', () => {
    for (const id of ['a', 'b', 'loop-123', 'very-long-id-string']) {
      expect(computeJitter(id, 60_000)).toBeGreaterThanOrEqual(0);
    }
  });

  it('is capped at 10% of interval', () => {
    // 60s interval → max 6s jitter
    expect(computeJitter('test', 60_000)).toBeLessThanOrEqual(6_000);
  });

  it('is capped at 30s regardless of interval', () => {
    // 10-minute interval → 10% = 60s, but cap is 30s
    expect(computeJitter('test', 600_000)).toBeLessThanOrEqual(30_000);
  });

  it('is deterministic for the same ID', () => {
    const a = computeJitter('stable-id', 60_000);
    const b = computeJitter('stable-id', 60_000);
    expect(a).toBe(b);
  });

  it('produces different values for different IDs', () => {
    const a = computeJitter('id-alpha', 60_000);
    const b = computeJitter('id-beta', 60_000);
    // Extremely unlikely to collide with a good hash
    expect(a).not.toBe(b);
  });
});
