/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { normalizeDescription } from './suggestions.js';

describe('normalizeDescription', () => {
  it('collapses all whitespace runs into single spaces and trims', () => {
    expect(normalizeDescription('  a\n\nb\t c  ')).toBe('a b c');
  });
});
