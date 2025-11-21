/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState, useCallback, useRef } from 'react';

const TERMINAL_PADDING_X = 8;
const DEFAULT_COLUMNS = 60;
const DEFAULT_ROWS = 20;

// Debounce function to prevent too frequent updates
function debounce<T extends (...args: Parameters<T>) => void>(
  func: T,
  wait: number,
): (...args: Parameters<T>) => void {
  let timeout: NodeJS.Timeout;
  return function executedFunction(...args: Parameters<T>): void {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

export function useTerminalSize(): { columns: number; rows: number } {
  const [size, setSize] = useState({
    columns: (process.stdout.columns || DEFAULT_COLUMNS) - TERMINAL_PADDING_X,
    rows: process.stdout.rows || DEFAULT_ROWS,
  });

  const updateSize = useCallback(() => {
    const newColumns =
      (process.stdout.columns || DEFAULT_COLUMNS) - TERMINAL_PADDING_X;
    const newRows = process.stdout.rows || DEFAULT_ROWS;

    // Only update if the size actually changed to prevent unnecessary re-renders
    if (size.columns !== newColumns || size.rows !== newRows) {
      setSize({
        columns: newColumns,
        rows: newRows,
      });
    }
  }, [size.columns, size.rows]);

  // Use useRef to hold the debounced function and update it when updateSize changes
  const debouncedUpdateSizeRef = useRef<
    ((...args: Parameters<typeof updateSize>) => void) | null
  >(null);

  // Update the debounced function when updateSize changes
  useEffect(() => {
    debouncedUpdateSizeRef.current = debounce(updateSize, 100);
  }, [updateSize]);

  // Create a stable callback that always calls the current debounced function
  const handleResize = useCallback(() => {
    debouncedUpdateSizeRef.current?.();
  }, []);

  useEffect(() => {
    process.stdout.on('resize', handleResize);
    return () => {
      process.stdout.off('resize', handleResize);
    };
  }, [handleResize]);

  return size;
}
