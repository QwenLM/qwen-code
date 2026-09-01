/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verifies the OpenTUI dialog core reproduces the original ink selection
 * machinery: wrap-around navigation that skips disabled rows
 * (useSelectionList), the scroll-follow window (BaseSelectionList), the
 * numeric quick-select buffer, and the shared tab-cycle/search helpers.
 */

import { describe, it, expect } from 'vitest';
import {
  applyNumberSelectKey,
  computeInitialActiveIndex,
  cycleTab,
  findNextEnabledIndex,
  followScrollOffset,
  getSelectionScrollOffset,
  matchesSearchQuery,
  selectionWindow,
  type DialogListItem,
} from './dialogs-core.js';

function rows(flags: string): Array<DialogListItem<number>> {
  return [...flags].map((ch, i) => ({
    key: `k${i}`,
    value: i,
    disabled: ch === 'x',
  }));
}

describe('findNextEnabledIndex', () => {
  it('moves down and up one step', () => {
    const items = rows('aaa');
    expect(findNextEnabledIndex(items, 0, 'down')).toBe(1);
    expect(findNextEnabledIndex(items, 2, 'up')).toBe(1);
  });

  it('wraps around at both ends — parity with useSelectionList', () => {
    const items = rows('aaa');
    expect(findNextEnabledIndex(items, 2, 'down')).toBe(0);
    expect(findNextEnabledIndex(items, 0, 'up')).toBe(2);
  });

  it('skips disabled rows while wrapping', () => {
    const items = rows('axa');
    expect(findNextEnabledIndex(items, 0, 'down')).toBe(2);
    expect(findNextEnabledIndex(items, 2, 'up')).toBe(0);
  });

  it('keeps the current index when every row is disabled', () => {
    const items = rows('xx');
    expect(findNextEnabledIndex(items, 1, 'down')).toBe(1);
    expect(findNextEnabledIndex(items, 1, 'up')).toBe(1);
  });

  it('keeps the index for an empty list', () => {
    expect(findNextEnabledIndex([], 3, 'down')).toBe(3);
  });
});

describe('scroll window rules (BaseSelectionList parity)', () => {
  it('getSelectionScrollOffset clamps to both ends', () => {
    expect(getSelectionScrollOffset(0, 20, 10)).toBe(0);
    expect(getSelectionScrollOffset(12, 20, 10)).toBe(3);
    expect(getSelectionScrollOffset(19, 20, 10)).toBe(10);
  });

  it('followScrollOffset only moves the window when the row leaves it', () => {
    // Inside the window: unchanged.
    expect(followScrollOffset(3, 2, 20, 5)).toBe(2);
    // Above the window: snap the window top to the row.
    expect(followScrollOffset(1, 4, 20, 5)).toBe(1);
    // Below the window: recompute via getSelectionScrollOffset.
    expect(followScrollOffset(9, 2, 20, 5)).toBe(5);
  });

  it('selectionWindow reports slice bounds and arrow reachability', () => {
    const top = selectionWindow(0, 20, 5);
    expect(top).toEqual({ start: 0, end: 5, showUp: false, showDown: true });
    const middle = selectionWindow(5, 20, 5);
    expect(middle).toEqual({
      start: 5,
      end: 10,
      showUp: true,
      showDown: true,
    });
    const bottom = selectionWindow(15, 20, 5);
    expect(bottom).toEqual({
      start: 15,
      end: 20,
      showUp: true,
      showDown: false,
    });
  });

  it('selectionWindow never slices past the item count', () => {
    expect(selectionWindow(0, 3, 10).end).toBe(3);
  });
});

describe('computeInitialActiveIndex', () => {
  it('clamps out-of-range initial indices to the first row', () => {
    expect(computeInitialActiveIndex(99, rows('aaa'))).toBe(0);
    expect(computeInitialActiveIndex(-1, rows('aaa'))).toBe(0);
  });

  it('skips a disabled initial row downwards', () => {
    expect(computeInitialActiveIndex(0, rows('xaa'))).toBe(1);
  });

  it('returns 0 for an empty list', () => {
    expect(computeInitialActiveIndex(5, [])).toBe(0);
  });
});

describe('applyNumberSelectKey (numeric quick-select parity)', () => {
  it('activates the 1-indexed row and waits when another digit could follow', () => {
    // In a 12-row list '1' might extend to 10-12.
    const result = applyNumberSelectKey({ buffer: '' }, '1', 12);
    expect(result.activeIndex).toBe(0);
    expect(result.selectNow).toBe(false);
    expect(result.pendingSelect).toBe(true);
    expect(result.buffer).toBe('1');
  });

  it('selects immediately when no digit can extend the number', () => {
    // '3' cannot extend in a 12-row list ('30' > 12), so it selects at once.
    const single = applyNumberSelectKey({ buffer: '' }, '3', 12);
    expect(single.activeIndex).toBe(2);
    expect(single.selectNow).toBe(true);
    // In a 12-row list, '12' cannot extend ('120' > 12).
    const result = applyNumberSelectKey({ buffer: '1' }, '2', 12);
    expect(result.activeIndex).toBe(11);
    expect(result.selectNow).toBe(true);
  });

  it('treats a lone 0 as invalid (rows are 1-indexed)', () => {
    const result = applyNumberSelectKey({ buffer: '' }, '0', 12);
    expect(result.buffer).toBe('');
    expect(result.activeIndex).toBeUndefined();
    expect(result.selectNow).toBe(false);
  });

  it('drops out-of-range numbers and clears the buffer', () => {
    const result = applyNumberSelectKey({ buffer: '9' }, '9', 12);
    expect(result.buffer).toBe('');
    expect(result.activeIndex).toBeUndefined();
  });
});

describe('cycleTab', () => {
  const order = ['a', 'b', 'c'] as const;
  it('cycles forwards and backwards with wrap', () => {
    expect(cycleTab(order, 'a', 1)).toBe('b');
    expect(cycleTab(order, 'c', 1)).toBe('a');
    expect(cycleTab(order, 'a', -1)).toBe('c');
  });
});

describe('matchesSearchQuery', () => {
  it('matches any field case-insensitively and trims the query', () => {
    expect(matchesSearchQuery('  VIM ', ['general.vimMode'])).toBe(true);
    expect(matchesSearchQuery('vim', ['General.VimMode'])).toBe(true);
    expect(matchesSearchQuery('nope', ['general.vimMode'])).toBe(false);
  });

  it('empty query matches everything', () => {
    expect(matchesSearchQuery('', [])).toBe(true);
    expect(matchesSearchQuery('   ', ['x'])).toBe(true);
  });
});
