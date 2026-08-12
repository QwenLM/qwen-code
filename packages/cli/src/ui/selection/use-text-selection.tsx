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
import {
  SelectionState,
  type NormalizedSelection,
  type SelectionMode,
} from './selection-state.js';
import { getSelectedText } from './selection-text.js';
import { spanAtForMode } from './selection-span.js';
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
 * Headless controller that turns mouse press/drag/release in the VP history
 * viewport into a text selection: it maps terminal coordinates to the
 * composited frame, drives the {@link SelectionState}, highlights the range
 * through the frame controller, and copies on release. Double/triple click
 * select a word/line. B1 scope: visible-region only, cleared on any scroll,
 * resize, or streaming content change.
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
  const baselineViewportRectRef = useRef<ViewportRect | null>(null);
  const lastClickRef = useRef<ClickRecord | null>(null);
  // Anchor span and mode of an active word/line drag; null for char drags.
  const anchorSpanRef = useRef<{
    span: NormalizedSelection;
    mode: Exclude<SelectionMode, 'char'>;
  } | null>(null);
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
    const selection = selectionRef.current;
    anchorSpanRef.current = null;
    if (selection.isEmpty) {
      return;
    }
    selection.clear();
    getBuffer()?.setSelection(null);
  }, [getBuffer]);

  const applyHighlight = useCallback(() => {
    const selection = selectionRef.current;
    const normalized = selection.normalized();
    getBuffer()?.setSelection(
      normalized && !selection.isBareClick ? normalized : null,
    );
  }, [getBuffer]);

  const recordBaseline = useCallback(() => {
    const scrollState = propsRef.current.getScrollState();
    baselineScrollTopRef.current = scrollState.scrollTop;
    baselineScrollHeightRef.current = scrollState.scrollHeight;
    baselineFrameRef.current = getBuffer()?.frame ?? null;
    baselineViewportRectRef.current = propsRef.current.getViewportRect();
  }, [getBuffer]);

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
    (
      event: MouseEvent,
    ): {
      point: ReturnType<typeof terminalToGrid>;
      rect: ViewportRect;
    } | null => {
      const buffer = getBuffer();
      const rect = propsRef.current.getViewportRect();
      if (!buffer || !rect) {
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
      return { point: snappedPoint, rect };
    },
    [getBuffer, stdout],
  );

  // Extend an active word/line drag so the range spans from the original
  // multi-click span to the word/line boundary at the current point (issue
  // #8738). Falls back to a single cell when the cursor is over whitespace.
  const extendSpanDrag = useCallback(
    (point: { x: number; y: number }) => {
      const anchor = anchorSpanRef.current;
      if (!anchor) return;
      const { span, mode } = anchor;
      const selection = selectionRef.current;
      const frame = getBuffer()?.frame ?? null;
      const current = spanAtForMode(frame, mode, point) ?? {
        sx: point.x,
        sy: point.y,
        ex: point.x,
        ey: point.y,
      };
      const cursorAfter =
        point.y > span.ey || (point.y === span.ey && point.x >= span.ex);
      selection.anchor = cursorAfter
        ? { x: span.sx, y: span.sy }
        : { x: span.ex, y: span.ey };
      selection.focus = cursorAfter
        ? { x: current.ex, y: current.ey }
        : { x: current.sx, y: current.sy };
    },
    [getBuffer],
  );

  const extendActiveDrag = useCallback(
    (point: { x: number; y: number }) => {
      if (anchorSpanRef.current) {
        extendSpanDrag(point);
      } else {
        selectionRef.current.extend(point);
      }
    },
    [extendSpanDrag],
  );

  const handleMouse = useCallback(
    (event: MouseEvent) => {
      const selection = selectionRef.current;

      // Any scroll drops the selection (B1: visible-region only).
      if (event.name.startsWith('scroll-')) {
        clearSelection();
        return;
      }

      if (event.name === 'left-press') {
        if (
          propsRef.current.hitTestScrollbar({ col: event.col, row: event.row })
        ) {
          clearSelection();
          return;
        }
        const mapped = mapEvent(event);
        if (!mapped || !pointInViewport(mapped.point, mapped.rect)) {
          clearSelection();
          return;
        }
        const { point } = mapped;

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
          const mode = count === 2 ? 'word' : 'line';
          const span = spanAtForMode(frame, mode, point);
          if (span) {
            // Enter a drag-capable word/line selection so a held double/triple
            // click can extend by word/line on move (issue #8738). Copy at
            // press too: a streaming repaint before release clears the
            // selection, skipping the release copy. Release copies again when
            // the drag grew the range.
            selection.start({ x: span.sx, y: span.sy }, mode);
            selection.extend({ x: span.ex, y: span.ey });
            anchorSpanRef.current = { span, mode };
            dragScrollTopRef.current =
              propsRef.current.getScrollState().scrollTop;
            recordBaseline();
            applyHighlight();
            copySelection();
            return;
          }
        }

        anchorSpanRef.current = null;
        selection.start(point);
        dragScrollTopRef.current = propsRef.current.getScrollState().scrollTop;
        recordBaseline();
        applyHighlight();
        return;
      }

      if (event.name === 'move') {
        if (!selection.dragging) {
          return;
        }
        // A held multi-click keeps its click record so pointer drift cannot
        // break a triple-click; char drags still break the chain.
        if (!anchorSpanRef.current) {
          lastClickRef.current = null;
        }
        // A scroll under the drag invalidates coordinates in B1.
        if (
          propsRef.current.getScrollState().scrollTop !==
          dragScrollTopRef.current
        ) {
          clearSelection();
          return;
        }
        const mapped = mapEvent(event);
        if (!mapped) {
          return;
        }
        extendActiveDrag(clampToViewport(mapped.point, mapped.rect));
        applyHighlight();
        return;
      }

      if (event.name === 'left-release') {
        if (!selection.dragging) {
          return;
        }
        const mapped = mapEvent(event);
        if (mapped) {
          extendActiveDrag(clampToViewport(mapped.point, mapped.rect));
        }
        // Clear the span drag only after extending, so the release cell still
        // applies to a word/line drag when no move covered it.
        anchorSpanRef.current = null;
        selection.finish();
        if (selection.isEmpty || selection.isBareClick) {
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
      extendActiveDrag,
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
      const viewportRect = propsRef.current.getViewportRect();
      if (
        scrollTop !== baselineScrollTopRef.current ||
        scrollHeight !== baselineScrollHeightRef.current ||
        !sameViewportRect(baselineViewportRectRef.current, viewportRect) ||
        !sameViewportContent(baselineFrameRef.current, frame, viewportRect)
      ) {
        clearSelection();
      }
    });
  }, [getBuffer, clearSelection]);

  useEffect(() => {
    if (!props.isActive) {
      clearSelection();
    }
  }, [props.isActive, clearSelection]);

  return null;
}
