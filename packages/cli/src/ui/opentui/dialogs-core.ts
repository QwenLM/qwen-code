/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  clipToWidth,
  getCachedStringWidth,
  toCodePoints,
} from '../utils/textUtils.js';

/**
 * Pure dialog machinery for the OpenTUI dialog family (PR1 slice 3).
 *
 * Renderer-neutral parity layer for the original ink selection list:
 *  - ui/components/shared/BaseSelectionList.tsx — `getScrollOffsetForIndex`,
 *    the scroll-follow effect, and the ▲/▼ visibility rules
 *  - ui/hooks/useSelectionList.ts — wrap-around navigation that skips
 *    disabled rows, plus the 1-second numeric quick-select buffer
 *
 * Components in dialogs-core.tsx drive keyboard input through the original
 * keybinding table (key-map.ts), so these helpers only model the resulting
 * state transitions.
 */

export interface DialogListItem<T = string> {
  key: string;
  value: T;
  disabled?: boolean;
}

/**
 * Parity of `findNextValidIndex` in ui/hooks/useSelectionList.ts: move one
 * step at a time, wrapping around, until a non-disabled row is found. When
 * every row is disabled (or the list is empty) the current index is kept.
 */
export function findNextEnabledIndex(
  // Row shapes differ per caller and most never declare the flag; a
  // `disabled?: boolean` constraint would trip weak-type detection on all of
  // them, so the flag is read through a cast instead.
  items: readonly unknown[],
  from: number,
  direction: 'up' | 'down',
): number {
  const len = items.length;
  if (len === 0) return from;

  const step = direction === 'down' ? 1 : -1;
  let nextIndex = from;
  for (let i = 0; i < len; i++) {
    nextIndex = (nextIndex + step + len) % len;
    const row = items[nextIndex] as { disabled?: boolean } | undefined;
    if (!row?.disabled) {
      return nextIndex;
    }
  }
  return from;
}

/** Parity of `getScrollOffsetForIndex` in shared/BaseSelectionList.tsx. */
export function getSelectionScrollOffset(
  activeIndex: number,
  itemCount: number,
  maxItemsToShow: number,
): number {
  return Math.max(
    0,
    Math.min(activeIndex - maxItemsToShow + 1, itemCount - maxItemsToShow),
  );
}

/**
 * Parity of the scroll-follow effect in shared/BaseSelectionList.tsx: the
 * window only moves when the active row would leave it.
 */
export function followScrollOffset(
  activeIndex: number,
  scrollOffset: number,
  itemCount: number,
  maxItemsToShow: number,
): number {
  if (activeIndex < scrollOffset) {
    return activeIndex;
  }
  if (activeIndex >= scrollOffset + maxItemsToShow) {
    return getSelectionScrollOffset(activeIndex, itemCount, maxItemsToShow);
  }
  return scrollOffset;
}

/**
 * Rows a run paints once the terminal word-wraps it at `width` columns. A
 * budget that charges a wrapped run a flat row under-pays, so every chrome
 * text run is measured here instead of hand-counted: the budget pays for the
 * rows the run actually occupies.
 *
 * Two renderer rules the count has to share: a newline always starts a new
 * row, and a word wider than the row is broken by cell width without splitting
 * a double-width glyph — so a spaceless CJK run packs nine characters into a
 * nineteen-column row, not the ten a whole-width division predicts.
 */
export function wrappedRows(text: string, width: number): number {
  if (width <= 0) {
    return 1;
  }
  let rows = 0;
  for (const line of text.split('\n')) {
    let lineRows = 1;
    let used = 0;
    const words = line.split(' ');
    // The separator is charged by position, not by whether the row already
    // holds something: a run of leading spaces occupies columns the renderer
    // paints, and a `used > 0` test charges none of them.
    for (let i = 0; i < words.length; i += 1) {
      const wordWidth = renderWidth(words[i]);
      if (i > 0) {
        if (used + 1 + wordWidth > width) {
          lineRows += 1;
          used = 0;
        } else {
          used += 1;
        }
      }
      if (wordWidth <= width - used) {
        used += wordWidth;
        continue;
      }
      // A word wider than the space left to it is broken across rows, cell by
      // cell; a two-cell glyph that would straddle the boundary moves whole.
      for (const char of toCodePoints(words[i])) {
        const charWidth = renderWidth(char);
        if (used > 0 && used + charWidth > width) {
          lineRows += 1;
          used = 0;
        }
        used += charWidth;
      }
    }
    rows += lineRows;
  }
  return rows;
}

/**
 * The longest prefix of `text` whose word wrap at `width` columns pays at
 * most `rows` rows. A column clip alone under-pays: greedy word wrap leaves
 * the row a long token starts on partly empty, so `width * rows` columns can
 * wrap into `rows + 1` rows. The column budget walks down until the measured
 * rows fit; at zero the empty string still costs the one row an emptied
 * value pays, so callers must not ask for zero rows.
 */
export function clipToRows(text: string, width: number, rows: number): string {
  let budget = width * rows;
  let clipped = clipToWidth(text, budget);
  while (budget > 0 && wrappedRows(clipped, width) > rows) {
    budget -= 1;
    clipped = clipToWidth(text, budget);
  }
  return clipped;
}

// The renderer's own width table paints the warning sign in one column where
// string-width counts two, so the row charge is measured with it painted as
// one — otherwise the shipped warning is overcharged a row at narrow widths.
const renderWidth = (text: string): number =>
  getCachedStringWidth(text.replaceAll('\u26A0', ' '));

export interface SelectionWindow {
  start: number;
  end: number;
  showUp: boolean;
  showDown: boolean;
}

/**
 * Visible row window plus the ▲/▼ affordance rules. BaseSelectionList always
 * renders both arrows when enabled and colors them by reachability; dialogs
 * that render the arrows conditionally (SettingsDialog) use `showUp/showDown`.
 */
export function selectionWindow(
  scrollOffset: number,
  itemCount: number,
  maxItemsToShow: number,
): SelectionWindow {
  // The offset can outlive the window it was derived for: the follow rule
  // leaves it alone while the highlight stays inside, so a region grow (a
  // larger maxItemsToShow) would otherwise paint fewer rows than the budget
  // allows. Clamp to the same bound getSelectionScrollOffset derives.
  const start = Math.max(
    0,
    Math.min(scrollOffset, Math.max(0, itemCount - maxItemsToShow)),
  );
  return {
    start,
    end: Math.min(itemCount, start + maxItemsToShow),
    showUp: start > 0,
    showDown: start + maxItemsToShow < itemCount,
  };
}

/**
 * The chrome a region-mounted dialog pays out of the region before its list
 * windows from what is left. `fixed` counts only rows no text run can wrap
 * into — the frame's border and padding, margins and spacers. Every chrome
 * text run goes in `runs` and is charged the rows the renderer's own word
 * wrap gives it at the width it paints at: a run charged a flat row that
 * wraps under-pays the frame, and the unshrinkable frame grows past the
 * region by the difference. `measuredRows` carries what a dialog-level
 * measurement already derived from `wrappedRows` (e.g. a two-run title
 * row's), so no part of the charge is a hand count of what a run paints.
 */
export interface DialogChrome {
  readonly fixed: number;
  readonly runs?: ReadonlyArray<{
    readonly text: string;
    readonly width: number;
  }>;
  readonly measuredRows?: number;
}

/** The rows a dialog's chrome pays out of its region budget. */
export function chromeRows(chrome: DialogChrome): number {
  let rows = chrome.fixed + (chrome.measuredRows ?? 0);
  for (const run of chrome.runs ?? []) {
    rows += wrappedRows(run.text, run.width);
  }
  return rows;
}

/**
 * The window a region-mounted dialog's list pays for itself: the region rows
 * left after the dialog's own chrome, capped the way ink's selection lists
 * cap, with the scroll arrows paid out of the window itself — ink's rule,
 * which the mode-list budget also ports: arrows exist only when the window
 * is a strict subset with more than two rows to spare, so a tighter window
 * spends its rows on items. The floor is zero, not one: a region that cannot
 * pay the chrome shows no row at all, and the list hook's zero-row refusals
 * keep Enter, the digits and the arrows off a row nothing painted.
 */
export function regionListWindow(
  regionHeight: number | undefined,
  chrome: DialogChrome,
  itemCount: number,
  cap: number,
): { maxItemsToShow: number; showScrollArrows: boolean } {
  if (regionHeight === undefined) {
    const maxItemsToShow = Math.min(cap, itemCount);
    return { maxItemsToShow, showScrollArrows: maxItemsToShow < itemCount };
  }
  const rows = regionHeight - chromeRows(chrome);
  if (rows <= 0) {
    return { maxItemsToShow: 0, showScrollArrows: false };
  }
  const showScrollArrows = rows > 2 && Math.min(cap, rows) < itemCount;
  return {
    maxItemsToShow: Math.min(cap, itemCount, rows - (showScrollArrows ? 2 : 0)),
    showScrollArrows,
  };
}

/** Parity of `computeInitialIndex` in ui/hooks/useSelectionList.ts. */
export function computeInitialActiveIndex<T>(
  initialIndex: number,
  items: ReadonlyArray<DialogListItem<T>>,
): number {
  if (items.length === 0) return 0;
  let target = initialIndex;
  if (target < 0 || target >= items.length) target = 0;
  if (items[target]?.disabled) {
    target = findNextEnabledIndex(items, target, 'down');
  }
  return target;
}

export const NUMBER_SELECT_TIMEOUT_MS = 1000;

/**
 * One step of the numeric quick-select state machine
 * (ui/hooks/useSelectionList.ts). Pure: the caller owns the timeout
 * (NUMBER_SELECT_TIMEOUT_MS) that flushes `pendingSelect`.
 */
export interface NumberSelectState {
  buffer: string;
}

export interface NumberSelectResult {
  buffer: string;
  /** Row to highlight, when the digit moved the selection. */
  activeIndex?: number;
  /** Select immediately (no further digit could extend the number). */
  selectNow: boolean;
  /** Wait for another digit or the timeout, then select. */
  pendingSelect: boolean;
}

export function applyNumberSelectKey(
  state: NumberSelectState,
  digit: string,
  itemCount: number,
): NumberSelectResult {
  const buffer = state.buffer + digit;

  // Single '0' is invalid (rows are 1-indexed).
  if (buffer === '0') {
    return { buffer: '', selectNow: false, pendingSelect: false };
  }

  const targetIndex = Number.parseInt(buffer, 10) - 1;
  if (targetIndex < 0 || targetIndex >= itemCount) {
    return { buffer: '', selectNow: false, pendingSelect: false };
  }

  // If appending any digit would overshoot the list, the number is complete
  // and selects immediately; otherwise buffer it and wait for more input.
  const potentialNextNumber = Number.parseInt(`${buffer}0`, 10);
  return {
    buffer,
    activeIndex: targetIndex,
    selectNow: potentialNextNumber > itemCount,
    pendingSelect: potentialNextNumber <= itemCount,
  };
}

/** Parity of the tab-cycling helper used by the config/permissions dialogs. */
export function cycleTab<T>(
  order: readonly T[],
  current: T,
  direction: 1 | -1,
): T {
  const index = order.indexOf(current);
  const next = (index + direction + order.length) % Math.max(1, order.length);
  return order[next] ?? current;
}

/** Case-insensitive search match against any of the given fields. */
export function matchesSearchQuery(
  query: string,
  fields: ReadonlyArray<string | undefined>,
): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return fields.some((field) =>
    field ? field.toLowerCase().includes(normalized) : false,
  );
}
