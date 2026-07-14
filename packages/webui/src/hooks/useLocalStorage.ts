/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';

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

  // Update localStorage when state changes.
  const setValue = (value: T | ((val: T) => T)) => {
    // Route the update through React's previous state rather than the
    // closed-over `storedValue`. Otherwise a functional update reads a stale
    // value, so two setValue(fn) calls batched in one render both derive from
    // the same base — the first update is lost, and the stale-derived value is
    // persisted. Persisting inside the updater keeps localStorage in sync with
    // the value that actually becomes state (the write is idempotent).
    setStoredValue((prev) => {
      const valueToStore = value instanceof Function ? value(prev) : value;
      try {
        window.localStorage.setItem(key, JSON.stringify(valueToStore));
      } catch (error) {
        console.error(error);
      }
      return valueToStore;
    });
  };

  return [storedValue, setValue] as const;
};
