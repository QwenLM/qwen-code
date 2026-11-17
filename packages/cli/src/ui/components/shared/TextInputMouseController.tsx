/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { type MutableRefObject, useCallback, useEffect, useRef } from 'react';
import { type DOMElement } from 'ink';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { useMouseEvents } from '../../hooks/useMouseEvents.js';
import { useContextMenu } from '../../context-menu/ContextMenuContext.js';
import { type MouseEvent } from '../../utils/mouse.js';
import {
  measureElementPosition,
  layoutRowForEvent,
} from '../../utils/measure-element-position.js';
import {
  visualClickToOffset,
  type ClickableBufferState,
} from '../../utils/input-mouse.js';
import {
  TextSelectionController,
  type SelectionQuery,
} from '../../selection/use-text-selection.js';
import { cpSlice } from '../../utils/textUtils.js';
import type { NormalizedSelection } from '../../selection/selection-state.js';

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
 * Headless mouse layer for the prompt input: a click positions the cursor on
 * release, while a drag selects and copies text. Rendered only while mouse input is enabled, so its
 * provider dependencies (KeypressProvider, via useMouseEvents) are only
 * required then.
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
}: TextInputMouseControllerProps) {
  const { rows: terminalHeight } = useTerminalSize();
  // Quiet while the context menu owns the pointer so a click on the menu
  // overlay can't also move the composer cursor underneath it.
  const { menu: contextMenu } = useContextMenu();
  const selectionQueryRef = useRef<SelectionQuery | null>(null);
  const pressRef = useRef<{
    col: number;
    row: number;
    offset: number;
    dragged: boolean;
    lines: string[];
    scrollRow: number;
  } | null>(null);
  useEffect(() => {
    if (contextMenu !== null) pressRef.current = null;
  }, [contextMenu]);

  const getViewportRect = useCallback(() => {
    const node = linesRef.current;
    if (!node) return null;
    const rect = measureElementPosition(node);
    return { ...rect, height: Math.min(rect.height, visibleLineCount) };
  }, [linesRef, visibleLineCount]);

  const getSelectionText = useCallback(
    (selection: NormalizedSelection) => {
      const rect = getViewportRect();
      if (!rect) return '';
      const start = visualClickToOffset(
        buffer,
        buffer.visualScrollRow + selection.sy - rect.y,
        Math.max(0, selection.sx - rect.x),
      );
      const end = visualClickToOffset(
        buffer,
        buffer.visualScrollRow + selection.ey - rect.y,
        Math.max(0, selection.ex - rect.x + 1),
      );
      return start !== null && end !== null
        ? cpSlice(buffer.lines.join('\n'), start, end)
        : '';
    },
    [buffer, getViewportRect],
  );

  const handleMouse = useCallback(
    (event: MouseEvent) => {
      if (event.name === 'move') {
        const press = pressRef.current;
        if (press && (event.col !== press.col || event.row !== press.row)) {
          press.dragged = true;
        }
        return;
      }
      if (event.name === 'left-release') {
        const press = pressRef.current;
        pressRef.current = null;
        if (
          press &&
          !press.dragged &&
          event.col === press.col &&
          event.row === press.row &&
          buffer.lines === press.lines &&
          buffer.visualScrollRow === press.scrollRow &&
          !selectionQueryRef.current?.getRange()
        ) {
          buffer.moveToOffset(press.offset);
        }
        return;
      }
      if (event.name !== 'left-press') return;
      pressRef.current = null;

      const lines = linesRef.current;
      if (!lines) return;

      const rect = measureElementPosition(lines);
      if (rect.height <= 0) return;

      const clickVisualRow =
        layoutRowForEvent(lines, event.row, terminalHeight) - rect.y;
      if (clickVisualRow < 0 || clickVisualRow >= visibleLineCount) return;

      const clickVisualCol = Math.max(0, event.col - 1 - rect.x);
      const absoluteVisualRow = buffer.visualScrollRow + clickVisualRow;
      const offset = visualClickToOffset(
        buffer,
        absoluteVisualRow,
        clickVisualCol,
      );
      if (offset !== null) {
        pressRef.current = {
          col: event.col,
          row: event.row,
          offset,
          dragged: false,
          lines: buffer.lines,
          scrollRow: buffer.visualScrollRow,
        };
      }
    },
    [linesRef, buffer, visibleLineCount, terminalHeight],
  );

  useMouseEvents(handleMouse, {
    isActive: contextMenu === null,
    tracking: 'button',
  });

  return (
    <TextSelectionController
      isActive={buffer.lines.some((line) => line.length > 0)}
      eventsPaused={contextMenu !== null}
      getViewportRect={getViewportRect}
      getScrollState={() => ({
        scrollTop: buffer.visualScrollRow,
        scrollHeight: buffer.allVisualLines.length,
        innerHeight: visibleLineCount,
      })}
      hitTestScrollbar={() => false}
      selectionQueryRef={selectionQueryRef}
      getSelectionText={getSelectionText}
    />
  );
}
