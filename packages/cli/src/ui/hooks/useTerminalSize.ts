/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';

// Coalesce bursts of 'resize' events (drag-resize fires many per second)
// into a single React update. Keeps Ink/Yoga from chasing a moving width
// mid-frame, which at narrow widths can leave orphan rows from incorrect
// erase-and-redraw math.
const RESIZE_DEBOUNCE_MS = 60;

/**
 * Returns the actual terminal size without any padding adjustments.
 * Components should handle their own margins/padding as needed.
 */
export function useTerminalSize(): { columns: number; rows: number } {
  const [size, setSize] = useState({
    columns: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  });

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    function updateSize() {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = undefined;
        setSize({
          columns: process.stdout.columns || 80,
          rows: process.stdout.rows || 24,
        });
      }, RESIZE_DEBOUNCE_MS);
    }

    process.stdout.on('resize', updateSize);
    return () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      process.stdout.off('resize', updateSize);
    };
  }, []);

  return size;
}
