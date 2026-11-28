/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  anchoredWindow,
  type AnchoredWindowAnchor,
} from './anchoredWindow.js';

const CAPACITY = 50;
const STEP = 10;

type Item = { id: number; value: string };

const createItems = (count: number, startId = 1): Item[] =>
  Array.from({ length: count }, (_, index) => ({
    id: startId + index,
    value: `item-${startId + index}`,
  }));

const windowItems = (
  items: readonly Item[],
  anchor: AnchoredWindowAnchor<number>,
) =>
  anchoredWindow(items, anchor, {
    capacity: CAPACITY,
    step: STEP,
    keyOf: (item) => item.id,
  });

describe('anchoredWindow', () => {
  it.each([
    [50, 0, 50],
    [60, 0, 60],
    [61, 11, 50],
  ])(
    'uses the strict capacity boundary for %i items',
    (length, expectedStart, expectedLength) => {
      const result = windowItems(createItems(length), null);

      expect(result.startIndex).toBe(expectedStart);
      expect(result.items).toHaveLength(expectedLength);
    },
  );

  it('holds the new anchor through 71 items and advances again at 72', () => {
    const firstAdvance = windowItems(createItems(61), null);
    const atSeventyOne = windowItems(createItems(71), firstAdvance.anchor);
    const atSeventyTwo = windowItems(createItems(72), atSeventyOne.anchor);

    expect(firstAdvance.startIndex).toBe(11);
    expect(atSeventyOne.startIndex).toBe(11);
    expect(atSeventyOne.items).toHaveLength(60);
    expect(atSeventyTwo.startIndex).toBe(22);
    expect(atSeventyTwo.items).toHaveLength(50);
  });

  it('finds a stable key after items are inserted before its stored index', () => {
    const initial = windowItems(createItems(61), null);
    const withPrefix = [
      { id: -2, value: 'prefix-2' },
      { id: -1, value: 'prefix-1' },
      ...createItems(61),
    ];

    const result = windowItems(withPrefix, initial.anchor);

    expect(result.startIndex).toBe(13);
    expect(result.anchor).toEqual({ key: 12, index: 13 });
  });

  it('falls back to the stored index only while it remains in bounds', () => {
    const items = createItems(20);

    expect(windowItems(items, { key: 999, index: 7 }).startIndex).toBe(7);
    expect(windowItems(items, { key: 999, index: 20 }).startIndex).toBe(0);
  });

  it('does not mutate or truncate the source collection', () => {
    const source = createItems(61);
    const snapshot = [...source];

    const result = windowItems(source, null);

    expect(source).toEqual(snapshot);
    expect(source).toHaveLength(61);
    expect(result.items).toEqual(source.slice(11));
  });

  it('keeps the logical tail correct through repeated advances', () => {
    let anchor: AnchoredWindowAnchor<number> = null;

    for (let length = 1; length <= 250; length++) {
      const source = createItems(length);
      const result = windowItems(source, anchor);
      anchor = result.anchor;

      expect(result.items.at(-1)).toBe(source.at(-1));
      expect(result.items).toEqual(source.slice(result.startIndex));
      expect(result.items.length).toBeLessThanOrEqual(CAPACITY + STEP);
    }
  });

  it('rejects invalid window parameters', () => {
    expect(() =>
      anchoredWindow([], null, {
        capacity: 0,
        step: STEP,
        keyOf: (item: Item) => item.id,
      }),
    ).toThrow(RangeError);
    expect(() =>
      anchoredWindow([], null, {
        capacity: CAPACITY,
        step: -1,
        keyOf: (item: Item) => item.id,
      }),
    ).toThrow(RangeError);
  });
});
