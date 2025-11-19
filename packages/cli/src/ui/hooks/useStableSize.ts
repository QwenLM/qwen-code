/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from 'react';
import { useTerminalSize } from './useTerminalSize.js';

/**
 * Stable terminal size hook that prevents unnecessary re-renders when terminal size
 * changes only slightly, which can happen with some terminals
 */
export function useStableTerminalSize(minChangeThreshold: number = 2) {
  const { columns: rawColumns, rows: rawRows } = useTerminalSize();
  const [stableSize, setStableSize] = useState({
    columns: rawColumns,
    rows: rawRows,
  });

  useEffect(() => {
    // Only update if the change is significant enough to warrant a re-render
    const colDiff = Math.abs(rawColumns - stableSize.columns);
    const rowDiff = Math.abs(rawRows - stableSize.rows);

    if (colDiff >= minChangeThreshold || rowDiff >= minChangeThreshold) {
      setStableSize({
        columns: rawColumns,
        rows: rawRows,
      });
    }
  }, [
    rawColumns,
    rawRows,
    stableSize.columns,
    stableSize.rows,
    minChangeThreshold,
  ]);

  return stableSize;
}
