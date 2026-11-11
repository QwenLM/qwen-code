/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { calculateExponentialBackoffMs } from './backoff.js';

describe('calculateExponentialBackoffMs', () => {
  it('caps the exponential base before applying caller-defined jitter', () => {
    expect(
      calculateExponentialBackoffMs({
        attempt: 20,
        baseDelayMs: 500,
        maxBaseDelayMs: 30_000,
        minJitterFactor: 0.5,
        maxJitterFactor: 1,
        random: () => 0,
      }),
    ).toBe(15_000);
    expect(
      calculateExponentialBackoffMs({
        attempt: 20,
        baseDelayMs: 500,
        maxBaseDelayMs: 32_000,
        minJitterFactor: 1,
        maxJitterFactor: 1.25,
        random: () => 1,
      }),
    ).toBe(40_000);
  });
});
