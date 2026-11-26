/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { CircularBuffer } from './CircularBuffer.js';

describe('CircularBuffer', () => {
  it('add and getRecent for items under capacity', () => {
    const buf = new CircularBuffer<string>(5);
    buf.add('a');
    buf.add('b');
    buf.add('c');
    expect(buf.getRecent(5)).toEqual(['a', 'b', 'c']);
    expect(buf.getRecent(2)).toEqual(['b', 'c']);
    expect(buf.length()).toBe(3);
  });

  it('evicts oldest when capacity exceeded', () => {
    const buf = new CircularBuffer<number>(3);
    buf.add(1);
    buf.add(2);
    buf.add(3);
    buf.add(4);
    expect(buf.getRecent(3)).toEqual([2, 3, 4]);
    expect(buf.length()).toBe(3);
  });

  it('wraps around multiple times correctly', () => {
    const buf = new CircularBuffer<number>(3);
    for (let i = 1; i <= 10; i++) {
      buf.add(i);
    }
    expect(buf.getRecent(3)).toEqual([8, 9, 10]);
    expect(buf.getRecent(1)).toEqual([10]);
    expect(buf.length()).toBe(3);
  });

  it('getRecent returns fewer items when buffer has fewer', () => {
    const buf = new CircularBuffer<string>(10);
    buf.add('x');
    expect(buf.getRecent(5)).toEqual(['x']);
  });

  it('getRecent returns empty array for empty buffer', () => {
    const buf = new CircularBuffer<string>(5);
    expect(buf.getRecent(3)).toEqual([]);
    expect(buf.length()).toBe(0);
  });

  it('clear resets the buffer', () => {
    const buf = new CircularBuffer<number>(5);
    buf.add(1);
    buf.add(2);
    buf.clear();
    expect(buf.getRecent(5)).toEqual([]);
    expect(buf.length()).toBe(0);
  });

  it('works correctly after clear and re-add', () => {
    const buf = new CircularBuffer<string>(3);
    buf.add('a');
    buf.add('b');
    buf.clear();
    buf.add('x');
    buf.add('y');
    expect(buf.getRecent(3)).toEqual(['x', 'y']);
    expect(buf.length()).toBe(2);
  });

  it('handles capacity of 1', () => {
    const buf = new CircularBuffer<string>(1);
    buf.add('a');
    expect(buf.getRecent(1)).toEqual(['a']);
    buf.add('b');
    expect(buf.getRecent(1)).toEqual(['b']);
    expect(buf.length()).toBe(1);
  });
});
