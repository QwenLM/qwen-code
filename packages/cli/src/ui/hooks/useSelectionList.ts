/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useReducer, useRef, useEffect, useCallback } from 'react';
import type { Key } from './useKeypress.js';
import { useKeyMatchers } from './useKeyMatchers.js';
import { Command } from '../key/keyBindings.js';
import { runLogger } from '@qwen-code/core';
import { useRegisterKeyboardContext } from '../contexts/KeyboardContextRegistry.js';
import {
  useRegisterActionHandlers,
  useRegisterFallbackHandler,
} from '../contexts/ActionHandlerRegistry.js';

export interface SelectionListItem<T> {
  key: string;
  value: T;
  disabled?: boolean;
  hideNumber?: boolean;
}

interface BaseSelectionItem {
  key: string;
  disabled?: boolean;
  hideNumber?: boolean;
}

export interface UseSelectionListOptions<T> {
  /** Match arrow navigation to the rendered layout; existing lists stay vertical. */
  orientation?: 'vertical' | 'horizontal';
  items: Array<SelectionListItem<T>>;
  initialIndex?: number;
  onSelect: (value: T) => void;
  onCancel?: () => void;
  onHighlight?: (value: T) => void;
  isFocused?: boolean;
  showNumbers?: boolean;
  enableNumericSelection?: boolean;
  /** Preview lists use digits to focus an option, leaving confirmation to Enter. */
  selectOnNumericInput?: boolean;
  wrapAround?: boolean;
  focusKey?: string;
  /**
   * When true, prevents Enter from confirming the current selection,
   * allowing a sibling component (e.g. an inline TextInput) to handle it.
   */
  suppressAccept?: boolean;
}

export interface UseSelectionListResult {
  activeIndex: number;
  setActiveIndex: (index: number) => void;
}

interface SelectionListState {
  activeIndex: number;
  initialIndex: number;
  pendingHighlight: boolean;
  pendingSelect: boolean;
  items: BaseSelectionItem[];
  wrapAround: boolean;
}

type SelectionListAction =
  | {
      type: 'SET_ACTIVE_INDEX';
      payload: {
        index: number;
      };
    }
  | {
      type: 'MOVE_UP';
    }
  | {
      type: 'MOVE_DOWN';
    }
  | {
      type: 'SELECT_CURRENT';
    }
  | {
      type: 'INITIALIZE';
      payload: {
        initialIndex: number;
        items: BaseSelectionItem[];
        wrapAround: boolean;
      };
    }
  | {
      type: 'CLEAR_PENDING_FLAGS';
    };

const NUMBER_INPUT_TIMEOUT_MS = 1000;
const COALESCED_NUMERIC_INPUT_RE = /^([0-9]+)(\r\n|\r|\n)?$/;

function getNumericInput(
  key: Key,
): { digits: string; shouldCommit: boolean } | null {
  if (key.ctrl || key.alt || key.cmd) {
    return null;
  }

  const match = COALESCED_NUMERIC_INPUT_RE.exec(key.sequence);
  if (!match) {
    return null;
  }

  return {
    digits: match[1],
    shouldCommit: match[2] !== undefined,
  };
}

/**
 * Helper function to find the next enabled index in a given direction, supporting wrapping.
 */
const findNextValidIndex = (
  currentIndex: number,
  direction: 'up' | 'down',
  items: BaseSelectionItem[],
  wrapAround = true,
): number => {
  const len = items.length;
  if (len === 0) return currentIndex;

  let nextIndex = currentIndex;
  const step = direction === 'down' ? 1 : -1;

  for (let i = 0; i < len; i++) {
    const candidateIndex = nextIndex + step;

    if (wrapAround) {
      // Calculate the next index, wrapping around if necessary.
      // We add `len` before the modulo to ensure a positive result in JS for negative steps.
      nextIndex = (candidateIndex + len) % len;
    } else {
      if (candidateIndex < 0 || candidateIndex >= len) {
        // Out of bounds and wrapping is disabled
        return currentIndex;
      }
      nextIndex = candidateIndex;
    }

    if (!items[nextIndex]?.disabled) {
      return nextIndex;
    }

    if (!wrapAround) {
      // If the item is disabled and we're not wrapping, we continue searching
      // in the same direction, but we must stop if we hit the bounds.
      if (
        (direction === 'down' && nextIndex === len - 1) ||
        (direction === 'up' && nextIndex === 0)
      ) {
        return currentIndex;
      }
    }
  }

  // If all items are disabled, return the original index
  return currentIndex;
};

const computeInitialIndex = (
  initialIndex: number,
  items: BaseSelectionItem[],
  initialKey?: string,
): number => {
  if (items.length === 0) {
    return 0;
  }

  if (initialKey !== undefined) {
    for (let i = 0; i < items.length; i++) {
      if (items[i].key === initialKey && !items[i].disabled) {
        return i;
      }
    }
  }

  let targetIndex = initialIndex;

  if (targetIndex < 0 || targetIndex >= items.length) {
    targetIndex = 0;
  }

  if (items[targetIndex]?.disabled) {
    const nextValid = findNextValidIndex(targetIndex, 'down', items, true);
    targetIndex = nextValid;
  }

  return targetIndex;
};

function selectionListReducer(
  state: SelectionListState,
  action: SelectionListAction,
): SelectionListState {
  switch (action.type) {
    case 'SET_ACTIVE_INDEX': {
      const { index } = action.payload;
      const { items } = state;

      // Only update if index actually changed and is valid
      if (index === state.activeIndex) {
        return state;
      }

      if (index >= 0 && index < items.length) {
        return { ...state, activeIndex: index, pendingHighlight: true };
      }
      return state;
    }

    case 'MOVE_UP': {
      const { items, wrapAround } = state;
      const newIndex = findNextValidIndex(
        state.activeIndex,
        'up',
        items,
        wrapAround,
      );
      if (newIndex !== state.activeIndex) {
        return { ...state, activeIndex: newIndex, pendingHighlight: true };
      }
      return state;
    }

    case 'MOVE_DOWN': {
      const { items, wrapAround } = state;
      const newIndex = findNextValidIndex(
        state.activeIndex,
        'down',
        items,
        wrapAround,
      );
      if (newIndex !== state.activeIndex) {
        return { ...state, activeIndex: newIndex, pendingHighlight: true };
      }
      return state;
    }

    case 'SELECT_CURRENT': {
      return { ...state, pendingSelect: true };
    }

    case 'INITIALIZE': {
      const { initialIndex, items, wrapAround } = action.payload;
      const activeKey =
        initialIndex === state.initialIndex
          ? state.items[state.activeIndex]?.key
          : undefined;

      // We don't need to check for equality here anymore as it is handled in the effect
      const targetIndex = computeInitialIndex(initialIndex, items, activeKey);

      return {
        ...state,
        items,
        initialIndex,
        activeIndex: targetIndex,
        pendingHighlight: false,
        wrapAround,
      };
    }

    case 'CLEAR_PENDING_FLAGS': {
      return {
        ...state,
        pendingHighlight: false,
        pendingSelect: false,
      };
    }

    default: {
      const exhaustiveCheck: never = action;
      runLogger.warn(`Unknown selection list action: ${exhaustiveCheck}`);
      return state;
    }
  }
}

function areBaseItemsEqual(
  a: BaseSelectionItem[],
  b: BaseSelectionItem[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;

  for (let i = 0; i < a.length; i++) {
    if (a[i].key !== b[i].key || a[i].disabled !== b[i].disabled) {
      return false;
    }
  }

  return true;
}

function toBaseItems<T>(
  items: Array<SelectionListItem<T>>,
): BaseSelectionItem[] {
  return items.map(({ key, disabled, hideNumber }) => ({
    key,
    disabled,
    hideNumber,
  }));
}

/**
 * A headless hook that provides keyboard navigation and selection logic
 * for list-based selection components like radio buttons and menus.
 *
 * Features:
 * - Keyboard navigation with arrow keys
 * - Selection with Enter key
 * - Numeric quick selection (when showNumbers is true)
 * - Handles disabled items (skips them during navigation)
 * - Hard-stop navigation by default (stops at first/last items)
 * - Optional wrap-around navigation (opt-in via wrapAround=true)
 */
export function useSelectionList<T>({
  orientation = 'vertical',
  items,
  initialIndex = 0,
  onSelect,
  onCancel,
  onHighlight,
  isFocused = true,
  showNumbers = false,
  enableNumericSelection = true,
  selectOnNumericInput = true,
  wrapAround = false,
  focusKey,
  suppressAccept = false,
}: UseSelectionListOptions<T>): UseSelectionListResult {
  const match = useKeyMatchers();
  const baseItems = toBaseItems(items);

  const [state, dispatch] = useReducer(selectionListReducer, {
    activeIndex: computeInitialIndex(initialIndex, baseItems),
    initialIndex,
    pendingHighlight: false,
    pendingSelect: false,
    items: baseItems,
    wrapAround,
  });
  const numberInputRef = useRef('');
  const numberInputTimer = useRef<NodeJS.Timeout | null>(null);

  const prevBaseItemsRef = useRef(baseItems);
  const prevInitialIndexRef = useRef(initialIndex);
  const prevWrapAroundRef = useRef(wrapAround);
  const lastProcessedFocusKeyRef = useRef<string | undefined>(undefined);

  // Handle programmatic focus changes via focusKey
  useEffect(() => {
    if (focusKey === undefined) {
      lastProcessedFocusKeyRef.current = undefined;
      return;
    }

    if (focusKey === lastProcessedFocusKeyRef.current) return;

    const index = items.findIndex(
      (item) => item.key === focusKey && !item.disabled,
    );
    if (index !== -1) {
      lastProcessedFocusKeyRef.current = focusKey;
      dispatch({ type: 'SET_ACTIVE_INDEX', payload: { index } });
    }
  }, [focusKey, items]);

  // Initialize/synchronize state when initialIndex or items change.
  // Intentionally runs every render: the ref comparisons below are the guard,
  // so a dependency array would duplicate that logic.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const baseItemsChanged = !areBaseItemsEqual(
      prevBaseItemsRef.current,
      baseItems,
    );
    const initialIndexChanged = prevInitialIndexRef.current !== initialIndex;
    const wrapAroundChanged = prevWrapAroundRef.current !== wrapAround;

    if (baseItemsChanged || initialIndexChanged || wrapAroundChanged) {
      dispatch({
        type: 'INITIALIZE',
        payload: { initialIndex, items: baseItems, wrapAround },
      });
      prevBaseItemsRef.current = baseItems;
      prevInitialIndexRef.current = initialIndex;
      prevWrapAroundRef.current = wrapAround;
    }
  });

  // Handle side effects based on state changes
  useEffect(() => {
    let needsClear = false;

    if (state.pendingHighlight && items[state.activeIndex]) {
      onHighlight?.(items[state.activeIndex].value);
      needsClear = true;
    }

    if (state.pendingSelect && items[state.activeIndex]) {
      const currentItem = items[state.activeIndex];
      if (currentItem && !currentItem.disabled) {
        onSelect(currentItem.value);
      }
      needsClear = true;
    }

    if (needsClear) {
      dispatch({ type: 'CLEAR_PENDING_FLAGS' });
    }
  }, [
    state.pendingHighlight,
    state.pendingSelect,
    state.activeIndex,
    items,
    onHighlight,
    onSelect,
  ]);

  useEffect(
    () => () => {
      if (numberInputTimer.current) {
        clearTimeout(numberInputTimer.current);
      }
    },
    [],
  );

  const itemsLength = items.length;

  // Build a mapping from display number (1-based) to actual array index,
  // skipping items with hideNumber. This keeps numeric quick-selection
  // consistent with the visible numbering.
  const displayNumberToIndex = useRef(new Map<number, number>());
  const numberedItemCount = useRef(0);
  {
    const map = new Map<number, number>();
    let count = 0;
    for (let i = 0; i < items.length; i++) {
      if (!items[i].hideNumber) {
        count++;
        map.set(count, i);
      }
    }
    displayNumberToIndex.current = map;
    numberedItemCount.current = count;
  }

  // Numeric quick-selection: type a number to jump directly to that item.
  // Movement (UP/DOWN) and selection (ENTER) are handled by Select context
  // action handlers above; this fallback handler processes numeric input
  // that doesn't match any action.
  const handleNumericKeypress = useCallback(
    (key: Key) => {
      const numericInput =
        enableNumericSelection && showNumbers ? getNumericInput(key) : null;
      const isNumeric = numericInput !== null;

      // Clear number input buffer on non-numeric key press
      if (!isNumeric && numberInputTimer.current) {
        clearTimeout(numberInputTimer.current);
        numberInputRef.current = '';
      }

      // Handle numeric input for quick selection
      if (isNumeric) {
        if (numberInputTimer.current) {
          clearTimeout(numberInputTimer.current);
        }

        const newNumberInput = numberInputRef.current + numericInput.digits;
        numberInputRef.current = newNumberInput;

        const displayNumber = Number.parseInt(newNumberInput, 10);
        const maxDisplayNumber = numberedItemCount.current;

        // Single '0' is invalid (1-indexed)
        if (newNumberInput === '0') {
          numberInputTimer.current = setTimeout(() => {
            numberInputRef.current = '';
          }, NUMBER_INPUT_TIMEOUT_MS);
          return true;
        }

        const targetIndex = displayNumberToIndex.current.get(displayNumber);

        if (targetIndex !== undefined) {
          dispatch({
            type: 'SET_ACTIVE_INDEX',
            payload: { index: targetIndex },
          });

          if (!selectOnNumericInput && !numericInput.shouldCommit) {
            numberInputRef.current = '';
            return true;
          }

          // If the number can't be a prefix for another valid number, select immediately
          const potentialNextNumber = Number.parseInt(newNumberInput + '0', 10);
          if (
            numericInput.shouldCommit ||
            potentialNextNumber > maxDisplayNumber
          ) {
            dispatch({
              type: 'SELECT_CURRENT',
            });
            numberInputRef.current = '';
          } else {
            // Otherwise wait for more input or timeout
            numberInputTimer.current = setTimeout(() => {
              dispatch({
                type: 'SELECT_CURRENT',
              });
              numberInputRef.current = '';
            }, NUMBER_INPUT_TIMEOUT_MS);
          }
        } else if (displayNumber > maxDisplayNumber) {
          // Number is out of bounds
          numberInputRef.current = '';
        } else {
          // Partial input that might become valid with more digits
          numberInputTimer.current = setTimeout(() => {
            numberInputRef.current = '';
          }, NUMBER_INPUT_TIMEOUT_MS);
        }
        return true;
      }
      return false;
    },
    [dispatch, enableNumericSelection, selectOnNumericInput, showNumbers],
  );

  // ─── Keyboard Context Registration (Phase 1) ───
  useRegisterKeyboardContext('Select', !!(isFocused && itemsLength > 0));

  // ─── Select Action Handlers (Phase 2, Step 2.9) ───
  // Action handlers clear the numeric input buffer because navigation/selection
  // keys now bypass handleNumericKeypress (which previously saw ALL keys and
  // cleared the buffer on non-numeric input).
  const clearNumberInput = () => {
    if (numberInputTimer.current) {
      clearTimeout(numberInputTimer.current);
      numberInputTimer.current = null;
    }
    numberInputRef.current = '';
  };

  useRegisterActionHandlers(
    'Select',
    {
      'select:previous': () => {
        if (orientation === 'horizontal') return true;
        clearNumberInput();
        dispatch({ type: 'MOVE_UP' });
        return true;
      },
      'select:next': () => {
        if (orientation === 'horizontal') return true;
        clearNumberInput();
        dispatch({ type: 'MOVE_DOWN' });
        return true;
      },
      'select:accept': () => {
        if (suppressAccept) return false;
        clearNumberInput();
        dispatch({ type: 'SELECT_CURRENT' });
        return true;
      },
      'select:cancel': () => {
        if (!onCancel) {
          return false;
        }
        onCancel();
        return true;
      },
    },
    !!(isFocused && itemsLength > 0),
  );

  // Numeric quick-selection: handled as Select context fallback so that
  // action handlers (UP/DOWN/ENTER) run first and only unhandled keys
  // fall through to the numeric input path.
  useRegisterFallbackHandler(
    'Select',
    (key) => {
      if (orientation === 'horizontal') {
        const previous = match[Command.MOVE_LEFT](key);
        const next = match[Command.MOVE_RIGHT](key);
        if (previous || next) {
          clearNumberInput();
          dispatch({ type: previous ? 'MOVE_UP' : 'MOVE_DOWN' });
          return true;
        }
      }
      return handleNumericKeypress(key);
    },
    !!(isFocused && itemsLength > 0),
  );

  const setActiveIndex = (index: number) => {
    dispatch({
      type: 'SET_ACTIVE_INDEX',
      payload: { index },
    });
  };

  return {
    activeIndex: state.activeIndex,
    setActiveIndex,
  };
}
