/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

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
export function findNextEnabledIndex<T>(
  items: ReadonlyArray<DialogListItem<T>>,
  from: number,
  direction: 'up' | 'down',
): number {
  const len = items.length;
  if (len === 0) return from;

  const step = direction === 'down' ? 1 : -1;
  let nextIndex = from;
  for (let i = 0; i < len; i++) {
    nextIndex = (nextIndex + step + len) % len;
    if (!items[nextIndex]?.disabled) {
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
  const start = Math.max(0, scrollOffset);
  return {
    start,
    end: Math.min(itemCount, start + maxItemsToShow),
    showUp: start > 0,
    showDown: start + maxItemsToShow < itemCount,
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
