/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * State that key handlers can read synchronously.
 *
 * The renderer hands a burst of keys — a held arrow, or arrows followed by
 * Enter — to the handler registered by the last render. A handler reading the
 * state value acts on the pre-burst value for every key in it: the highlight
 * moves once for the whole burst, Enter commits the row the arrows had not
 * reached yet, and a text buffer submits what it held before the burst typed
 * into it. Handlers read the ref; JSX renders the value.
 */

import { useCallback, useRef, useState } from 'react';

export function useBatchSafeCursor(initial: number | (() => number) = 0) {
  const [cursor, setCursorState] = useState(initial);
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const setCursor = useCallback((index: number) => {
    cursorRef.current = index;
    setCursorState(index);
  }, []);
  return { cursor, cursorRef, setCursor };
}

/** The same double write for non-numeric state: view modes, check sets, text. */
export function useBatchSafeState<T>(initial: T | (() => T)) {
  const [value, setValueState] = useState<T>(initial);
  const ref = useRef(value);
  ref.current = value;
  const setValue = useCallback((next: T) => {
    ref.current = next;
    setValueState(next);
  }, []);
  return { value, ref, setValue };
}
