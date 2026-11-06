/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { formatCompressionTokenCount } from './compression-text.js';

describe('formatCompressionTokenCount', () => {
  it.each<[number | undefined, boolean | undefined, string]>([
    [1500, undefined, '1500'],
    [1500, false, '1500'],
    [1500, true, '~1500'],
    [0, false, '0'],
    [0, true, '~0'],
    [undefined, undefined, 'unknown'],
    [undefined, false, 'unknown'],
    [undefined, true, 'unknown'],
  ])(
    'formats count %s with estimated=%s as %s',
    (count, estimated, expected) => {
      expect(formatCompressionTokenCount(count, estimated)).toBe(expected);
    },
  );
});
