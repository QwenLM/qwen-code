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
  chromeRows,
  computeInitialActiveIndex,
  cycleTab,
  findNextEnabledIndex,
  followScrollOffset,
  getSelectionScrollOffset,
  matchesSearchQuery,
  regionListWindow,
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

  it('selectionWindow clamps an offset the window outgrew', () => {
    // The follow rule leaves the offset alone while the highlight stays
    // inside, so a region grow can hand in an offset past the last full
    // window. Painting from it would show fewer rows than the budget allows
    // — and no arrows, since the budget just decided the whole list fits.
    expect(selectionWindow(3, 5, 5)).toEqual({
      start: 0,
      end: 5,
      showUp: false,
      showDown: false,
    });
    expect(selectionWindow(18, 20, 5)).toEqual({
      start: 15,
      end: 20,
      showUp: true,
      showDown: false,
    });
    // A mid-list offset inside the bound passes through unchanged.
    expect(selectionWindow(12, 20, 3).start).toBe(12);
  });
});

describe('regionListWindow (the rows a region-mounted list pays for itself)', () => {
  it('caps at the ink constant and flags the arrows when truncated without a region', () => {
    expect(regionListWindow(undefined, { fixed: 8 }, 20, 10)).toEqual({
      maxItemsToShow: 10,
      showScrollArrows: true,
    });
    expect(regionListWindow(undefined, { fixed: 8 }, 4, 10)).toEqual({
      maxItemsToShow: 4,
      showScrollArrows: false,
    });
  });

  it('subtracts the chrome and pays the scroll arrows out of the window', () => {
    // 15 - 8 = 7 rows left; the window is a strict subset with more than two
    // rows to spare, so two of them buy the ▲/▼ affordance.
    expect(regionListWindow(15, { fixed: 8 }, 20, 10)).toEqual({
      maxItemsToShow: 5,
      showScrollArrows: true,
    });
  });

  it('spends a tight window on items instead of arrows', () => {
    // 10 - 8 = 2 rows: too tight to spend two of them on the affordance.
    expect(regionListWindow(10, { fixed: 8 }, 20, 10)).toEqual({
      maxItemsToShow: 2,
      showScrollArrows: false,
    });
  });

  it('floors at zero, not one, when the region cannot pay the chrome', () => {
    expect(regionListWindow(8, { fixed: 8 }, 20, 10)).toEqual({
      maxItemsToShow: 0,
      showScrollArrows: false,
    });
    expect(regionListWindow(3, { fixed: 8 }, 20, 10)).toEqual({
      maxItemsToShow: 0,
      showScrollArrows: false,
    });
  });

  it('never windows past the item count', () => {
    expect(regionListWindow(40, { fixed: 8 }, 6, 10)).toEqual({
      maxItemsToShow: 6,
      showScrollArrows: false,
    });
  });

  it('charges each chrome text run the rows it wraps into at its painted width', () => {
    // The 30-column run wraps to three rows at ten columns: the charge is 9,
    // not the 7 a flat one-row count gives, and the window pays the
    // difference so the frame cannot grow past the region.
    const chrome = {
      fixed: 6,
      runs: [{ text: 'x'.repeat(30), width: 10 }],
    };
    expect(regionListWindow(15, chrome, 20, 10)).toEqual({
      maxItemsToShow: 4,
      showScrollArrows: true,
    });
  });

  it('keeps the zero floor when the measured chrome eats the region', () => {
    expect(
      regionListWindow(
        9,
        { fixed: 6, runs: [{ text: 'x'.repeat(30), width: 10 }] },
        20,
        10,
      ),
    ).toEqual({ maxItemsToShow: 0, showScrollArrows: false });
  });

  it('adds rows a dialog-level measurement already derived', () => {
    expect(
      chromeRows({
        fixed: 4,
        measuredRows: 3,
        runs: [{ text: 'x'.repeat(25), width: 10 }],
      }),
    ).toBe(10);
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
