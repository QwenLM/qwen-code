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
  layoutRowForEvent,
} from '../../utils/measure-element-position.js';
import {
  findItemAtLayoutRow,
  type VisibleItemRect,
} from '../../utils/list-mouse.js';

export interface RowMouseControllerProps {
  /** Outer list container node — bounds interactions horizontally. */
  containerRef: MutableRefObject<DOMElement | null>;
  /** Visible item nodes, indexed by visible position (0..visibleCount-1). */
  itemRefs: MutableRefObject<Array<DOMElement | null>>;
  /** Index of the first visible item within the full list. */
  scrollOffset: number;
  /** Optional: indices that are non-interactive (skipped for hover/select). */
  isDisabled?: (index: number) => boolean;
  /** Highlight the row under the pointer (hover). */
  onHoverIndex: (index: number) => void;
  /** Select the row under the pointer (click). */
  onSelectIndex: (index: number) => void;
}

/**
 * Headless mouse layer for a vertical list of rows — shared by select menus
 * (BaseSelectionList) and completion suggestions (SuggestionsDisplay). Rendered
 * only while mouse input is enabled, so the providers it depends on
 * (KeypressProvider, via useMouseEvents) are only required when the feature is
 * on.
 *
 * Subscribes at the `'any'` tracking level so bare pointer motion (hover, no
 * button held) is reported. `move` highlights the row under the pointer;
 * `left-press` selects it. Disabled rows and interactions outside the list's
 * columns are ignored.
 *
 * Coordinates assume alternate-screen mode. When the frame fits within the
 * terminal (`frameHeight <= terminalHeight`) the anchor is 0 and the layout row
 * is just `event.row - 1`. When the frame overflows, Ink bottom-pins it and the
 * top rows scroll off-screen; the frame anchor (`terminalHeight - frameHeight`,
 * negative) corrects terminal rows back into layout space. This is why the code
 * below routes through `frameAnchor`/`terminalRowToLayoutRow` rather than a bare
 * `event.row - 1`. VirtualizedList.hitTestScrollbar does not apply this
 * correction (it operates only on the scrollbar track, which is always in the
 * visible region); list-item hit-testing needs it. The owning component only
 * mounts this layer in alternate-screen mode; inline mode, where the live region
 * floats, is intentionally unsupported here.
 */
export function RowMouseController({
  containerRef,
  itemRefs,
  scrollOffset,
  isDisabled,
  onHoverIndex,
  onSelectIndex,
}: RowMouseControllerProps): null {
  const { rows: terminalHeight } = useTerminalSize();

  const resolveIndex = useCallback(
    (event: MouseEvent): number | null => {
      const container = containerRef.current;
      if (!container) return null;

      // Ignore interactions outside the list's columns so a click elsewhere on
      // the same terminal row doesn't hijack a selection.
      const containerRect = measureElementPosition(container);
      const col0 = event.col - 1;
      if (
        containerRect.width > 0 &&
        (col0 < containerRect.x ||
          col0 >= containerRect.x + containerRect.width)
      ) {
        return null;
      }

      const layoutRow = layoutRowForEvent(container, event.row, terminalHeight);

      const rects: VisibleItemRect[] = [];
      const nodes = itemRefs.current;
      for (let visiblePos = 0; visiblePos < nodes.length; visiblePos++) {
        const node = nodes[visiblePos];
        if (!node) continue;
        const rect = measureElementPosition(node);
        if (rect.height <= 0) continue;
        rects.push({
          index: scrollOffset + visiblePos,
          top: rect.y,
          height: rect.height,
        });
      }

      return findItemAtLayoutRow(rects, layoutRow);
    },
    [containerRef, itemRefs, scrollOffset, terminalHeight],
  );

  const handleMouse = useCallback(
    (event: MouseEvent) => {
      if (event.name !== 'move' && event.name !== 'left-press') return;

      const index = resolveIndex(event);
      if (index === null || isDisabled?.(index)) return;

      if (event.name === 'move') {
        onHoverIndex(index);
      } else {
        onSelectIndex(index);
      }
    },
    [resolveIndex, isDisabled, onHoverIndex, onSelectIndex],
  );

  useMouseEvents(handleMouse, { isActive: true, tracking: 'any' });

  return null;
}
