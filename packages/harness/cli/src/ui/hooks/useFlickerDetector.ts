/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AFTER_LAYOUT_PRIORITY,
  type DOMElement,
  measureElement,
  useAfterLayout,
} from 'ink';
import { appEvents, AppEvent } from '../../utils/events.js';
import { useUIState } from '../contexts/UIStateContext.js';

/**
 * A hook that detects when the UI flickers (renders taller than the terminal).
 * This is a sign of a rendering bug that should be fixed.
 *
 * @param rootUiRef A ref to the root UI element.
 * @param terminalHeight The height of the terminal.
 */
export function useFlickerDetector(
  rootUiRef: React.RefObject<DOMElement | null>,
  terminalHeight: number,
) {
  const { constrainHeight } = useUIState();

  // Runs after the frame's layout rather than after every commit: as a
  // dependency-less effect calling measureElement it would force a Yoga pass
  // per commit, which is exactly what per-frame layout exists to avoid.
  useAfterLayout(() => {
    if (rootUiRef.current) {
      const measurement = measureElement(rootUiRef.current);
      if (measurement.height > terminalHeight) {
        // If we are not constraining the height, we are intentionally
        // overflowing the screen.
        if (!constrainHeight) {
          return;
        }

        appEvents.emit(AppEvent.Flicker);
      }
    }
  }, AFTER_LAYOUT_PRIORITY.diagnostics);
}
