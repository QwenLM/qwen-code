/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { parseCustomContext } from './sessionIdContext.js';

describe('parseCustomContext', () => {
  it('returns a frozen string map', () => {
    const parsed = parseCustomContext({ tenant: 'alpha' });
    expect(parsed).toEqual({ tenant: 'alpha' });
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it('ignores absent values', () => {
    expect(parseCustomContext(undefined)).toBeUndefined();
    expect(parseCustomContext(null)).toBeUndefined();
  });

  it('rejects non-string values and non-object shapes', () => {
    expect(parseCustomContext({ tenant: 1 })).toBeUndefined();
    expect(parseCustomContext(['alpha'])).toBeUndefined();
    expect(parseCustomContext('alpha')).toBeUndefined();
  });
});
