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

/**
 * Headless controller that turns mouse press/drag/release in the VP history
 * viewport into a text selection: it maps terminal coordinates to the
 * composited frame, drives the {@link SelectionState}, highlights the range
 * through the frame controller, and copies on release. B1 scope: visible-region
 * only, cleared on any scroll.
 */
export function TextSelectionController(
  props: TextSelectionControllerProps,
): null {
  const { stdout } = useStdout();
  const selectionRef = useRef(new SelectionState());
  const dragScrollTopRef = useRef<number | null>(null);
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
    getBuffer()?.setSelection(
      normalized && !selection.isCollapsed ? normalized : null,
    );
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
        selection.start(mapped.point);
        dragScrollTopRef.current = propsRef.current.getScrollState().scrollTop;
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
        if (!selection.dragging) {
          return;
        }
        selection.finish();
        if (selection.isCollapsed || selection.isEmpty) {
          clearSelection();
          return;
        }
        applyHighlight();
        if (propsRef.current.copyOnSelect) {
          const normalized = selection.normalized();
          const text = normalized
            ? getSelectedText(getBuffer()?.frame ?? null, normalized)
            : '';
          if (text) {
            void copyToClipboard(text).catch(() => {
              // Copy failure feedback is handled in M3.
            });
          }
        }
        return;
      }
    },
    [clearSelection, applyHighlight, mapEvent, getBuffer],
  );

  useMouseEvents(handleMouse, {
    isActive: props.isActive,
    tracking: 'button',
  });

  useEffect(() => {
    if (!props.isActive) {
      clearSelection();
    }
  }, [props.isActive, clearSelection]);

  return null;
}
