/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { toggleInSet } from './toggle-in-set.js';

describe('toggleInSet', () => {
  it('preserves sibling members when adding and removing a value', () => {
    const values = new Set(['batch-1', 'batch-2']);
    const added = toggleInSet(values, 'batch-3');
    const removed = toggleInSet(values, 'batch-2');

    expect(added).toEqual(new Set(['batch-1', 'batch-2', 'batch-3']));
    expect(removed).toEqual(new Set(['batch-1']));
    expect(values).toEqual(new Set(['batch-1', 'batch-2']));
    expect(added).not.toBe(values);
    expect(removed).not.toBe(values);
  });

  it('adds and removes a value without mutating the input', () => {
    const empty = new Set<string>();
    const added = toggleInSet(empty, 'batch-1');
    const removed = toggleInSet(added, 'batch-1');

    expect(empty).toEqual(new Set());
    expect(added).toEqual(new Set(['batch-1']));
    expect(removed).toEqual(new Set());
  });
});
