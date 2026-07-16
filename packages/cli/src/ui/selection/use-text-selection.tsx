/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef } from 'react';
import { useStdout } from 'ink';
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

export interface TextSelectionControllerProps {
  /** Selection is only handled while active (VP mode, no dialog, focused). */
  isActive: boolean;
  /** Copy the selection to the clipboard on release (iTerm2-style). */
  copyOnSelect: boolean;
  /** Reads from the history viewport; called at event time (may be null early). */
  getViewportRect: () => ViewportRect | null;
  getScrollState: () => ScrollState;
  hitTestScrollbar: (location: { col: number; row: number }) => boolean;
}

/** Max gap between clicks (ms) to count as a double/triple click. */
const MULTI_CLICK_MS = 400;

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
  const baselineScrollHeightRef = useRef<number>(0);
  const baselineFrameHeightRef = useRef<number>(0);
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

  const recordBaseline = useCallback(() => {
    baselineScrollHeightRef.current =
      propsRef.current.getScrollState().scrollHeight;
    baselineFrameHeightRef.current = getBuffer()?.dimensions.height ?? 0;
  }, [getBuffer]);

  const copyIfEnabled = useCallback(() => {
    if (!propsRef.current.copyOnSelect) {
      return;
    }
    const normalized = selectionRef.current.normalized();
    const text = normalized
      ? getSelectedText(getBuffer()?.frame ?? null, normalized)
      : '';
    if (text) {
      void copyToClipboard(text).catch(() => {
        // Copy-failure feedback is a follow-up.
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
      return { point, rect };
    },
    [getBuffer, stdout],
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
          const span =
            count === 2
              ? wordSpanAt(frame, point.x, point.y)
              : lineSpanAt(frame, point.y);
          if (span) {
            selection.selectSpan(span, count === 2 ? 'word' : 'line');
            recordBaseline();
            applyHighlight();
            copyIfEnabled();
            return;
          }
        }

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
        selection.extend(clampToViewport(mapped.point, mapped.rect));
        applyHighlight();
        return;
      }

      if (event.name === 'left-release') {
        // Word/line click-selects are not drags; leave them intact.
        if (!selection.dragging) {
          return;
        }
        selection.finish();
        if (selection.isCollapsed || selection.isEmpty) {
          clearSelection();
          return;
        }
        applyHighlight();
        copyIfEnabled();
        return;
      }
    },
    [
      clearSelection,
      applyHighlight,
      copyIfEnabled,
      recordBaseline,
      mapEvent,
      getBuffer,
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
  // both heights unchanged, so this does not feed back into a render loop.
  useEffect(() => {
    const buffer = getBuffer();
    if (!buffer) {
      return;
    }
    return buffer.subscribe(() => {
      if (selectionRef.current.isEmpty) {
        return;
      }
      const scrollHeight = propsRef.current.getScrollState().scrollHeight;
      const frameHeight = buffer.frame?.height ?? 0;
      if (
        scrollHeight !== baselineScrollHeightRef.current ||
        frameHeight !== baselineFrameHeightRef.current
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
