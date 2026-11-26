/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type AnchoredWindowAnchor<Key> = {
  key: Key;
  index: number;
} | null;

export interface AnchoredWindowOptions<Item, Key> {
  capacity: number;
  step: number;
  keyOf: (item: Item) => Key;
}

export interface AnchoredWindowResult<Item, Key> {
  items: readonly Item[];
  startIndex: number;
  anchor: AnchoredWindowAnchor<Key>;
}

/**
 * Keeps a stable prefix anchor while allowing the window to grow by `step`.
 * Once `capacity + step` is exceeded, the anchor advances in one batch and
 * the returned window shrinks back to `capacity` items.
 */
export function anchoredWindow<Item, Key>(
  items: readonly Item[],
  anchor: AnchoredWindowAnchor<Key>,
  options: AnchoredWindowOptions<Item, Key>,
): AnchoredWindowResult<Item, Key> {
  const { capacity, step, keyOf } = options;
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new RangeError('anchoredWindow capacity must be a positive integer');
  }
  if (!Number.isInteger(step) || step < 0) {
    throw new RangeError('anchoredWindow step must be a non-negative integer');
  }

  let startIndex = 0;
  if (anchor) {
    const itemAtStoredIndex = items[anchor.index];
    const keyStillAtStoredIndex =
      itemAtStoredIndex !== undefined &&
      Object.is(keyOf(itemAtStoredIndex), anchor.key);
    const foundIndex = keyStillAtStoredIndex
      ? anchor.index
      : items.findIndex((item) => Object.is(keyOf(item), anchor.key));

    if (foundIndex >= 0) {
      startIndex = foundIndex;
    } else if (anchor.index >= 0 && anchor.index < items.length) {
      startIndex = anchor.index;
    }
  }

  if (items.length - startIndex > capacity + step) {
    startIndex = items.length - capacity;
  }

  const itemAtStart = items[startIndex];
  const nextAnchor =
    itemAtStart === undefined
      ? null
      : anchor &&
          anchor.index === startIndex &&
          Object.is(anchor.key, keyOf(itemAtStart))
        ? anchor
        : { key: keyOf(itemAtStart), index: startIndex };

  return {
    items: startIndex === 0 ? items : items.slice(startIndex),
    startIndex,
    anchor: nextAnchor,
  };
}
