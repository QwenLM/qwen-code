/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef } from 'react';

// Window during which an Enter following a paste is treated as a
// pasted newline rather than a submit. 40ms is faster than a typical human can
// go from pressing paste to pressing Enter.
const UNSAFE_PASTE_WINDOW_MS = 40;

export interface UsePasteExpansionReturn {
  /**
   * Synchronous check: returns true when inside the paste guard window.
   * Uses a ref so the value is available immediately in the same
   * React discreteUpdates batch — unlike useState, which defers until
   * the next render.
   */
  isRecentPaste: () => boolean;
  /** Marks a paste event; auto-clears after UNSAFE_PASTE_WINDOW_MS. */
  markUnsafePaste: () => void;
}

/**
 * Owns the paste guard window for InputPrompt. When a paste event fires,
 * any Enter keypress within 40ms is converted to a newline instead of
 * triggering submission. This prevents accidental auto-submission when
 * the PASTE_END marker and the user's Enter arrive in the same stdin chunk
 * and are processed within a single React discreteUpdates batch.
 *
 * Uses useRef (not useState) so the guard is visible synchronously within
 * the same batch — state updates are deferred until the next render,
 * which is too late when paste + Enter land in one processKeysInBatch call.
 */
export function usePasteExpansion(): UsePasteExpansionReturn {
  const pasteTimeRef = useRef<number | null>(null);
  const pasteTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(
    () => () => {
      if (pasteTimeoutRef.current) {
        clearTimeout(pasteTimeoutRef.current);
        pasteTimeoutRef.current = null;
      }
    },
    [],
  );

  const markUnsafePaste = useCallback(() => {
    pasteTimeRef.current = Date.now();
    if (pasteTimeoutRef.current) {
      clearTimeout(pasteTimeoutRef.current);
    }
    pasteTimeoutRef.current = setTimeout(() => {
      pasteTimeRef.current = null;
      pasteTimeoutRef.current = null;
    }, UNSAFE_PASTE_WINDOW_MS);
  }, []);

  const isRecentPaste = useCallback(() => pasteTimeRef.current !== null, []);

  return { isRecentPaste, markUnsafePaste };
}
