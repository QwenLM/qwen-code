/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { LruCache } from './LruCache.js';

describe('LruCache', () => {
  it('stores and retrieves values, including falsy ones', () => {
    const cache = new LruCache<string, number | string | boolean | null>(10);
    cache.set('zero', 0);
    cache.set('empty', '');
    cache.set('false', false);
    cache.set('null', null);

    // Retrieval must return the stored falsy value, not undefined.
    expect(cache.get('zero')).toBe(0);
    expect(cache.get('empty')).toBe('');
    expect(cache.get('false')).toBe(false);
    expect(cache.get('null')).toBe(null);
  });

  it('returns undefined for a missing key', () => {
    const cache = new LruCache<string, number>(2);
    expect(cache.get('nope')).toBeUndefined();
  });

  it('evicts the least-recently-used entry when over capacity', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3); // 'a' is LRU and should be evicted

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });

  it('promotes an entry on get() so it survives eviction', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a'); // promote 'a' → 'b' becomes LRU
    cache.set('c', 3); // should evict 'b', not 'a'

    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
  });

  it('promotes a falsy-valued entry on get() so it survives eviction', () => {
    // Regression: the previous `if (value)` guard skipped the recency reorder
    // for falsy values, so a get() on a 0/''/false/null entry did not mark it
    // as recently used and it was wrongly evicted next.
    const cache = new LruCache<string, number>(2);
    cache.set('a', 0); // falsy value
    cache.set('b', 2);
    cache.get('a'); // promote 'a' → 'b' becomes LRU
    cache.set('c', 3); // should evict 'b', not 'a'

    expect(cache.get('a')).toBe(0);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
  });

  it('clear() empties the cache', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
  });
});
