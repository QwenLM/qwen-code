/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { type DOMElement } from 'ink';
import { type MouseEvent } from './mouse.js';
import {
  layoutRowForEvent,
  measureElementPosition,
  type ElementMetrics,
} from './measure-element-position.js';
import { findItemAtLayoutRow, type VisibleItemRect } from './list-mouse.js';

type ElementHitMode = 'rect' | 'row';

function containsPoint(
  rect: ElementMetrics,
  point: { x: number; y: number },
): boolean {
  const containsRow = point.y >= rect.y && point.y < rect.y + rect.height;
  return containsRow && point.x >= rect.x && point.x < rect.x + rect.width;
}

/**
 * Resolve a terminal mouse event to the measured child element it hits.
 *
 * Both completion rows and their category tabs live in the same alternate-
 * screen layout, so they must share the SGR coordinate conversion, container
 * column bound, frame-anchor correction, and degenerate-rectangle handling.
 * Row lists use the child's vertical span after the container column check;
 * tabs use the child's full rectangle.
 */
export function findElementAtMouseEvent(
  container: DOMElement | null,
  elements: ReadonlyArray<DOMElement | null>,
  event: Pick<MouseEvent, 'col' | 'row'>,
  terminalHeight: number,
  mode: ElementHitMode,
  indexOffset = 0,
): number | null {
  if (!container) return null;

  const point = {
    x: event.col - 1,
    y: layoutRowForEvent(container, event.row, terminalHeight),
  };
  const containerRect = measureElementPosition(container);
  if (
    containerRect.width > 0 &&
    (point.x < containerRect.x ||
      point.x >= containerRect.x + containerRect.width)
  ) {
    return null;
  }

  if (mode === 'row') {
    const rects: VisibleItemRect[] = [];
    for (let index = 0; index < elements.length; index++) {
      const element = elements[index];
      if (!element) continue;
      const rect = measureElementPosition(element);
      if (rect.height <= 0) continue;
      rects.push({
        index: indexOffset + index,
        top: rect.y,
        height: rect.height,
      });
    }
    return findItemAtLayoutRow(rects, point.y);
  }

  for (let index = 0; index < elements.length; index++) {
    const element = elements[index];
    if (!element) continue;
    const rect = measureElementPosition(element);
    if (rect.height <= 0 || rect.width <= 0) continue;
    if (containsPoint(rect, point)) return index;
  }

  return null;
}
