/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { toggleInSet } from './toggle-in-set.js';

describe('toggleInSet', () => {
  it('adds and removes a value without mutating the input', () => {
    const empty = new Set<string>();
    const added = toggleInSet(empty, 'batch-1');
    const removed = toggleInSet(added, 'batch-1');

    expect(empty).toEqual(new Set());
    expect(added).toEqual(new Set(['batch-1']));
    expect(removed).toEqual(new Set());
  });
});
