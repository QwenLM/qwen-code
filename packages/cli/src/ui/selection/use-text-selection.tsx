/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef } from 'react';
import { useStdout, type ReadonlyFrame } from 'ink';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import { useMouseEvents } from '../hooks/useMouseEvents.js';
import type { MouseEvent } from '../utils/mouse.js';
import { copyToClipboard } from '../utils/commandUtils.js';
import { getScreenBuffer, type ScreenBuffer } from './screen-buffer.js';
import { SelectionState } from './selection-state.js';
import { getSelectedText } from './selection-text.js';
import { wordSpanAt, lineSpanAt } from './selection-span.js';
import {
  terminalToGrid,
  pointInViewport,
  clampToViewport,
  type ViewportRect,
} from './selection-coords.js';

interface ScrollState {
  scrollTop: number;
  scrollHeight: number;
  innerHeight: number;
}

const sameViewportContent = (
  previous: ReadonlyFrame | null,
  current: ReadonlyFrame,
  rect: ViewportRect,
): boolean => {
  if (!previous) {
    return false;
  }
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      const cell = previous.cells[y]?.[x];
      const currentCell = current.cells[y]?.[x];
      if (
        cell?.value !== currentCell?.value ||
        cell?.fullWidth !== currentCell?.fullWidth
      ) {
        return false;
      }
    }
  }
  return true;
};

const sameViewportRect = (
  previous: ViewportRect | null,
  current: ViewportRect | null,
): current is ViewportRect =>
  previous !== null &&
  current !== null &&
  previous.x === current.x &&
  previous.y === current.y &&
  previous.width === current.width &&
  previous.height === current.height;

export interface TextSelectionControllerProps {
  /** Selection is only handled while active (VP mode, no dialog, focused). */
  isActive: boolean;
  /** Reads from the history viewport; called at event time (may be null early). */
  getViewportRect: () => ViewportRect | null;
  /** Additional selectable regions outside the history viewport. */
  getAdditionalSelectableRects?: () => readonly ViewportRect[];
  getScrollState: () => ScrollState;
  hitTestScrollbar: (location: { col: number; row: number }) => boolean;
}

/** Max gap between clicks (ms) to count as a double/triple click. */
const MULTI_CLICK_MS = 400;
const debugLogger = createDebugLogger('TEXT_SELECTION');

interface ClickRecord {
  x: number;
  y: number;
  time: number;
  count: number;
}

/**
 * Headless controller that turns mouse press/drag/release in selectable VP
 * regions into a text selection: it maps terminal coordinates to the
 * composited frame, drives the {@link SelectionState}, highlights the range
 * through the frame controller, and copies on release. Double/triple click
 * select a word/line. B1 scope: visible-region only; history selections clear
 * on scroll, while every selection clears when its owning content or layout
 * changes.
 */
export function TextSelectionController(
  props: TextSelectionControllerProps,
): null {
  const { stdout } = useStdout();
  const selectionRef = useRef(new SelectionState());
  const dragScrollTopRef = useRef<number | null>(null);
  const baselineScrollTopRef = useRef<number>(0);
  const baselineScrollHeightRef = useRef<number>(0);
  const baselineFrameRef = useRef<ReadonlyFrame | null>(null);
  const baselineRectRef = useRef<ViewportRect | null>(null);
  const activeRectIndexRef = useRef<number | null>(null);
  const selectionGenerationRef = useRef(0);
  const lastClickRef = useRef<ClickRecord | null>(null);
  const bufferRef = useRef<ScreenBuffer | undefined>(undefined);
  const propsRef = useRef(props);
  propsRef.current = props;

  const getBuffer = useCallback((): ScreenBuffer | undefined => {
    if (!bufferRef.current) {
      bufferRef.current = getScreenBuffer(stdout);
    }
    return bufferRef.current;
  }, [stdout]);

  const clearSelection = useCallback(() => {
    selectionGenerationRef.current += 1;
    activeRectIndexRef.current = null;
    const selection = selectionRef.current;
    if (selection.isEmpty) {
      return;
    }
    selection.clear();
    getBuffer()?.setSelection(null);
  }, [getBuffer]);

  const applyHighlight = useCallback(() => {
    const selection = selectionRef.current;
    const normalized = selection.normalized();
    // Highlight whenever there is a real range; a word/line span of a single
    // cell still highlights, but a bare char-mode click (collapsed) does not.
    const shouldHighlight =
      normalized && (!selection.isCollapsed || selection.mode !== 'char');
    getBuffer()?.setSelection(shouldHighlight ? normalized : null);
  }, [getBuffer]);

  const getSelectableRects = useCallback((): readonly ViewportRect[] => {
    const viewportRect = propsRef.current.getViewportRect();
    if (!viewportRect) {
      return [];
    }
    const additionalRects =
      propsRef.current.getAdditionalSelectableRects?.() ?? [];
    return [viewportRect, ...additionalRects];
  }, []);

  const getActiveRect = useCallback((): ViewportRect | null => {
    const index = activeRectIndexRef.current;
    return index === null ? null : (getSelectableRects()[index] ?? null);
  }, [getSelectableRects]);

  const recordBaseline = useCallback(
    (rect: ViewportRect) => {
      const scrollState = propsRef.current.getScrollState();
      baselineScrollTopRef.current = scrollState.scrollTop;
      baselineScrollHeightRef.current = scrollState.scrollHeight;
      baselineFrameRef.current = getBuffer()?.frame ?? null;
      baselineRectRef.current = rect;
    },
    [getBuffer],
  );

  const copySelection = useCallback(() => {
    const normalized = selectionRef.current.normalized();
    const text = normalized
      ? getSelectedText(getBuffer()?.frame ?? null, normalized)
      : '';
    if (text) {
      void copyToClipboard(text).catch((error: unknown) => {
        debugLogger.warn('Failed to copy selected text:', error);
      });
    }
  }, [getBuffer]);

  const mapEvent = useCallback(
    (event: MouseEvent): ReturnType<typeof terminalToGrid> | null => {
      const buffer = getBuffer();
      if (!buffer) {
        return null;
      }
      const frameHeight = buffer.dimensions.height;
      const terminalHeight =
        (stdout as unknown as { rows?: number }).rows ?? frameHeight;
      const point = terminalToGrid(
        event.col,
        event.row,
        terminalHeight,
        frameHeight,
      );
      const row = buffer.frame?.cells[point.y];
      const snappedPoint =
        point.x > 0 &&
        row?.[point.x]?.value === '' &&
        row[point.x - 1]?.fullWidth
          ? { ...point, x: point.x - 1 }
          : point;
      return snappedPoint;
    },
    [getBuffer, stdout],
  );

  const handleMouse = useCallback(
    (event: MouseEvent) => {
      const selection = selectionRef.current;

      // History scrolls invalidate history-owned selection coordinates. Footer
      // selections live outside the scrollable viewport and remain valid.
      if (event.name.startsWith('scroll-')) {
        if (activeRectIndexRef.current === 0) {
          clearSelection();
        }
        return;
      }

      if (event.name === 'left-press') {
        selectionGenerationRef.current += 1;
        if (
          propsRef.current.hitTestScrollbar({ col: event.col, row: event.row })
        ) {
          clearSelection();
          return;
        }
        const point = mapEvent(event);
        const rects = getSelectableRects();
        const rectIndex = point
          ? rects.findIndex((rect) => pointInViewport(point, rect))
          : -1;
        if (!point || rectIndex < 0) {
          clearSelection();
          return;
        }
        const rect = rects[rectIndex];
        activeRectIndexRef.current = rectIndex;

        // Multi-click detection (double = word, triple = line).
        const now = Date.now();
        const prev = lastClickRef.current;
        const near =
          prev != null &&
          prev.y === point.y &&
          Math.abs(prev.x - point.x) <= 1 &&
          now - prev.time < MULTI_CLICK_MS;
        const count = near ? Math.min(prev!.count + 1, 3) : 1;
        lastClickRef.current = { x: point.x, y: point.y, time: now, count };

        if (count >= 2) {
          const frame = getBuffer()?.frame ?? null;
          const span =
            count === 2
              ? wordSpanAt(frame, point.x, point.y)
              : lineSpanAt(frame, point.x, point.y);
          if (span) {
            selection.selectSpan(span, count === 2 ? 'word' : 'line');
            recordBaseline(rect);
            applyHighlight();
            copySelection();
            return;
          }
        }

        selection.start(point);
        dragScrollTopRef.current = propsRef.current.getScrollState().scrollTop;
        recordBaseline(rect);
        applyHighlight();
        return;
      }

      if (event.name === 'move') {
        if (!selection.dragging) {
          return;
        }
        lastClickRef.current = null;
        // A scroll under a history drag invalidates its viewport coordinates.
        if (
          activeRectIndexRef.current === 0 &&
          propsRef.current.getScrollState().scrollTop !==
            dragScrollTopRef.current
        ) {
          clearSelection();
          return;
        }
        const point = mapEvent(event);
        const rect = getActiveRect();
        if (!point || !rect) {
          clearSelection();
          return;
        }
        selection.extend(clampToViewport(point, rect));
        applyHighlight();
        return;
      }

      if (event.name === 'left-release') {
        // Word/line click-selects are not drags; leave them intact.
        if (!selection.dragging) {
          return;
        }
        const point = mapEvent(event);
        const rect = getActiveRect();
        if (point && rect) {
          selection.extend(clampToViewport(point, rect));
        }
        selection.finish();
        if (selection.isCollapsed || selection.isEmpty) {
          clearSelection();
          return;
        }
        applyHighlight();
        copySelection();
        return;
      }
    },
    [
      clearSelection,
      applyHighlight,
      copySelection,
      recordBaseline,
      mapEvent,
      getBuffer,
      getSelectableRects,
      getActiveRect,
    ],
  );

  useMouseEvents(handleMouse, {
    isActive: props.isActive,
    tracking: 'button',
  });

  // Invalidate the selection when the content scrolls, streams, or the terminal
  // resizes — anything that moves the composited frame under a fixed selection.
  // A resize reflows content, which changes the frame/scroll height, so the
  // frame subscription already covers it (no extra stdout 'resize' listener,
  // which would trip the max-listeners warning). Our own highlight renders keep
  // the frame's characters and dimensions unchanged, so this does not feed back
  // into a render loop.
  useEffect(() => {
    const buffer = getBuffer();
    if (!buffer) {
      return;
    }
    return buffer.subscribe((frame) => {
      if (selectionRef.current.isEmpty) {
        return;
      }
      const { scrollTop, scrollHeight } = propsRef.current.getScrollState();
      const activeRect = getActiveRect();
      const isViewportSelection = activeRectIndexRef.current === 0;
      if (
        (isViewportSelection &&
          (scrollTop !== baselineScrollTopRef.current ||
            scrollHeight !== baselineScrollHeightRef.current)) ||
        !sameViewportRect(baselineRectRef.current, activeRect) ||
        !sameViewportContent(baselineFrameRef.current, frame, activeRect)
      ) {
        const invalidatedGeneration = selectionGenerationRef.current;
        queueMicrotask(() => {
          if (selectionGenerationRef.current === invalidatedGeneration) {
            clearSelection();
          }
        });
      }
    });
  }, [getBuffer, getActiveRect, clearSelection]);

  useEffect(() => {
    if (!props.isActive) {
      clearSelection();
    }
  }, [props.isActive, clearSelection]);

  return null;
}
