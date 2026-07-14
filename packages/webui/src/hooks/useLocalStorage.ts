/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';

export const useLocalStorage = <T>(key: string, initialValue: T) => {
  // Get value from localStorage or use initial value
  const [storedValue, setStoredValue] = useState<T>(() => {
    try {
      const item = window.localStorage.getItem(key);
      return item ? JSON.parse(item) : initialValue;
    } catch (_error) {
      return initialValue;
    }
  });

  // Route updates through React's previous state rather than the closed-over
  // `storedValue`, so two functional updates batched in one render each derive
  // from the correct base instead of the same stale value. A throwing updater
  // is caught and leaves state unchanged, matching the hook's prior contract.
  const setValue = (value: T | ((val: T) => T)) => {
    setStoredValue((prev) => {
      try {
        return value instanceof Function ? value(prev) : value;
      } catch (error) {
        console.error(error);
        return prev;
      }
    });
  };

  // Persist on change, never on mount. The ref adopts the current value as a
  // baseline on the first effect run (writing nothing), so the hook keeps its
  // write-on-setValue-only behavior and stays correct under StrictMode's
  // double-invoked effects.
  const persistedRef = useRef<string | null>(null);
  useEffect(() => {
    const serialized = JSON.stringify(storedValue);
    if (persistedRef.current === serialized) {
      return;
    }
    const isBaseline = persistedRef.current === null;
    persistedRef.current = serialized;
    if (isBaseline) {
      return;
    }
    try {
      window.localStorage.setItem(key, serialized);
    } catch (error) {
      console.error(error);
    }
  }, [key, storedValue]);

  return [storedValue, setValue] as const;
};
