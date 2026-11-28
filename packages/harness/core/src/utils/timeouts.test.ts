/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { normalizePositiveTimeoutMs } from './timeouts.js';

describe('normalizePositiveTimeoutMs', () => {
  it('rejects disabled and invalid timeout values', () => {
    expect(normalizePositiveTimeoutMs(0)).toBeUndefined();
    expect(normalizePositiveTimeoutMs(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(normalizePositiveTimeoutMs('100')).toBeUndefined();
  });

  it('preserves timer precision unless integer rounding is requested', () => {
    expect(normalizePositiveTimeoutMs(0.25)).toBe(0.25);
    expect(normalizePositiveTimeoutMs(0.25, { roundUp: true })).toBe(1);
    expect(normalizePositiveTimeoutMs(10.2, { roundUp: true })).toBe(11);
  });
});
