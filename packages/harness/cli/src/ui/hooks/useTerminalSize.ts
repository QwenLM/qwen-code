/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useContext } from 'react';
import { TerminalSizeContext } from '../../ink/components/TerminalSizeContext.js';

/**
 * Returns current terminal dimensions.
 *
 * Reads from Ink's TerminalSizeContext (updated synchronously by Ink's
 * handleResize). This avoids a duplicate resize listener that would trigger
 * a second React render cycle, causing duplicate content on screen.
 */
export function useTerminalSize(): { columns: number; rows: number } {
  const size = useContext(TerminalSizeContext);
  if (size) {
    return size;
  }
  // Fallback for components rendered outside Ink's provider (e.g. tests)
  return {
    columns: process.stdout.columns || 60,
    rows: process.stdout.rows || 20,
  };
}
