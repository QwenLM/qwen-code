/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { setBoundedMapEntry } from './bounded-map.js';

describe('setBoundedMapEntry', () => {
  it('inserts under the cap without evicting', () => {
    const map = new Map<string, number>();
    setBoundedMapEntry(map, 'a', 1, 2);
    setBoundedMapEntry(map, 'b', 2, 2);
    expect([...map.keys()]).toEqual(['a', 'b']);
  });

  it('evicts the least-recently-used entry past the cap', () => {
    const map = new Map<string, number>();
    setBoundedMapEntry(map, 'a', 1, 2);
    setBoundedMapEntry(map, 'b', 2, 2);
    setBoundedMapEntry(map, 'c', 3, 2);
    expect([...map.keys()]).toEqual(['b', 'c']);
  });

  it('moves a re-set key to the newest position before evicting', () => {
    const map = new Map<string, number>();
    setBoundedMapEntry(map, 'a', 1, 2);
    setBoundedMapEntry(map, 'b', 2, 2);
    setBoundedMapEntry(map, 'a', 10, 2);
    setBoundedMapEntry(map, 'c', 3, 2);
    expect(map.get('a')).toBe(10);
    expect(map.has('b')).toBe(false);
    expect([...map.keys()]).toEqual(['a', 'c']);
  });

  it('evicts an empty-string key rather than stopping at it', () => {
    const map = new Map<string, number>();
    setBoundedMapEntry(map, '', 0, 1);
    setBoundedMapEntry(map, 'a', 1, 1);
    expect(map.has('')).toBe(false);
    expect(map.get('a')).toBe(1);
  });
});
