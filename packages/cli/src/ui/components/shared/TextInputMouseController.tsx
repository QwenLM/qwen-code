/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { type MutableRefObject, useCallback } from 'react';
import { type DOMElement } from 'ink';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { useMouseEvents } from '../../hooks/useMouseEvents.js';
import { type MouseEvent } from '../../utils/mouse.js';
import {
  measureElementPosition,
  measureFrameHeight,
} from '../../utils/measure-element-position.js';
import { frameAnchor, terminalRowToLayoutRow } from '../../utils/list-mouse.js';
import {
  visualClickToOffset,
  type ClickableBufferState,
} from '../../utils/input-mouse.js';

export interface TextInputMouseControllerProps {
  /** The lines container node (the text area, positioned after the prefix). */
  linesRef: MutableRefObject<DOMElement | null>;
  /** Buffer visual state plus the cursor mover. */
  buffer: ClickableBufferState & {
    visualScrollRow: number;
    moveToOffset: (offset: number) => void;
  };
  /** Number of visual lines currently rendered (linesToRender.length). */
  visibleLineCount: number;
}

/**
 * Headless mouse layer for the prompt input: a left-click positions the text
 * cursor under the pointer. Rendered only while mouse input is enabled, so its
 * provider dependencies (KeypressProvider, via useMouseEvents) are only
 * required then.
 *
 * Only `left-press` is handled — the input has no hover behavior — so this
 * subscribes at the cheaper `'button'` tracking level (no bare-motion stream).
 *
 * Coordinates are taken relative to the measured lines container, so the input
 * border row and the prefix column are accounted for automatically. Like the
 * other mouse layers this assumes alternate-screen coordinates; the owning
 * component only mounts it in that mode.
 */
export function TextInputMouseController({
  linesRef,
  buffer,
  visibleLineCount,
}: TextInputMouseControllerProps): null {
  const { rows: terminalHeight } = useTerminalSize();

  const handleMouse = useCallback(
    (event: MouseEvent) => {
      if (event.name !== 'left-press') return;

      const lines = linesRef.current;
      if (!lines) return;

      const rect = measureElementPosition(lines);
      if (rect.height <= 0) return;

      const anchor = frameAnchor(terminalHeight, measureFrameHeight(lines));
      const clickVisualRow = terminalRowToLayoutRow(event.row, anchor) - rect.y;
      if (clickVisualRow < 0 || clickVisualRow >= visibleLineCount) return;

      const clickVisualCol = Math.max(0, event.col - 1 - rect.x);
      const absoluteVisualRow = buffer.visualScrollRow + clickVisualRow;
      const offset = visualClickToOffset(
        buffer,
        absoluteVisualRow,
        clickVisualCol,
      );
      if (offset !== null) buffer.moveToOffset(offset);
    },
    [linesRef, buffer, visibleLineCount, terminalHeight],
  );

  useMouseEvents(handleMouse, { isActive: true, tracking: 'button' });

  return null;
}
