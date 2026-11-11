/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useMemo, useReducer, useCallback } from 'react';
import { calculateCenteredWindow } from '../utils/calculateCenteredWindow.js';

export interface UseSettingsNavigationProps {
  items: Array<{ key: string }>;
  maxItemsToShow: number;
  /** Optional key to focus initially. Falls back to first item if not found. */
  initialActiveKey?: string;
}

type NavState = {
  activeItemKey: string | null;
  windowStart: number;
};

type NavAction =
  | { type: 'MOVE_UP' }
  | { type: 'MOVE_DOWN' }
  | { type: 'RESET_TO_KEY'; key: string | null };

function createNavReducer(
  items: Array<{ key: string }>,
  maxItemsToShow: number,
) {
  return function navReducer(state: NavState, action: NavAction): NavState {
    if (items.length === 0) return state;

    const currentIndex = items.findIndex((i) => i.key === state.activeItemKey);
    const activeIndex = currentIndex !== -1 ? currentIndex : 0;

    switch (action.type) {
      case 'MOVE_UP': {
        // Hard-stop at top (no wrapping)
        const newIndex = activeIndex > 0 ? activeIndex - 1 : 0;
        // A move that goes nowhere must not rewrite the active key: when the
        // active item is filtered out, `activeIndex` is a display fallback, and
        // committing it here would silently discard the real selection.
        if (newIndex === activeIndex) return state;
        return {
          activeItemKey: items[newIndex].key,
          windowStart: calculateCenteredWindow(
            newIndex,
            items.length,
            maxItemsToShow,
          ),
        };
      }
      case 'MOVE_DOWN': {
        // Hard-stop at bottom (no wrapping)
        const newIndex =
          activeIndex < items.length - 1 ? activeIndex + 1 : activeIndex;
        if (newIndex === activeIndex) return state;
        return {
          activeItemKey: items[newIndex].key,
          windowStart: calculateCenteredWindow(
            newIndex,
            items.length,
            maxItemsToShow,
          ),
        };
      }
      case 'RESET_TO_KEY': {
        const targetKey = action.key;
        if (!targetKey) return state;
        const idx = items.findIndex((i) => i.key === targetKey);
        if (idx === -1) return state;
        return {
          activeItemKey: targetKey,
          windowStart: calculateCenteredWindow(
            idx,
            items.length,
            maxItemsToShow,
          ),
        };
      }
      default: {
        return state;
      }
    }
  };
}

export function useSettingsNavigation({
  items,
  maxItemsToShow,
  initialActiveKey,
}: UseSettingsNavigationProps) {
  const reducer = useMemo(
    () => createNavReducer(items, maxItemsToShow),
    [items, maxItemsToShow],
  );

  // Resolve initial active key: prefer provided key, fall back to first item
  const resolvedInitialKey = useMemo(() => {
    if (initialActiveKey && items.some((i) => i.key === initialActiveKey)) {
      return initialActiveKey;
    }
    return items[0]?.key ?? null;
  }, [initialActiveKey, items]);

  const [state, dispatch] = useReducer(reducer, {
    activeItemKey: resolvedInitialKey,
    windowStart: 0,
  });

  // Retain the proper highlighting when items change (e.g. search)
  const activeIndex = useMemo(() => {
    if (items.length === 0) return 0;
    const idx = items.findIndex((i) => i.key === state.activeItemKey);
    return idx !== -1 ? idx : 0;
  }, [items, state.activeItemKey]);

  const windowStart = useMemo(
    () => calculateCenteredWindow(activeIndex, items.length, maxItemsToShow),
    [activeIndex, items.length, maxItemsToShow],
  );

  const moveUp = useCallback(() => dispatch({ type: 'MOVE_UP' }), []);
  const moveDown = useCallback(() => dispatch({ type: 'MOVE_DOWN' }), []);
  const resetToKey = useCallback(
    (key: string | null) => dispatch({ type: 'RESET_TO_KEY', key }),
    [],
  );

  return {
    activeItemKey: state.activeItemKey,
    activeIndex,
    windowStart,
    moveUp,
    moveDown,
    resetToKey,
  };
}
