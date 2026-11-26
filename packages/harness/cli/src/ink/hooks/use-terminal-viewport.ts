/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import { useCallback, useContext, useLayoutEffect, useRef } from 'react';
import {
  TerminalSizeContext,
  type TerminalSize,
} from '../components/TerminalSizeContext.js';
import type { DOMElement } from '../dom.js';

export type TerminalViewportEntry = {
  isVisible: boolean;
};

export type TerminalViewportResult = [
  ref: (element: DOMElement | null) => void,
  entry: TerminalViewportEntry,
  readVisibility: () => boolean,
  measureNow: () => boolean | null,
];

export function computeTerminalViewportVisibility(
  element: DOMElement | null,
  terminalSize: TerminalSize | null,
): boolean | null {
  if (!element?.yogaNode || !terminalSize) {
    return null;
  }

  const height = element.yogaNode.getComputedHeight();
  const rows = terminalSize.rows;
  let absoluteTop = element.yogaNode.getComputedTop();
  let parent = element.parentNode;
  let root = element.yogaNode;

  while (parent) {
    if (parent.yogaNode) {
      absoluteTop += parent.yogaNode.getComputedTop();
      root = parent.yogaNode;
    }
    if (parent.scrollTop) {
      absoluteTop -= parent.scrollTop;
    }
    parent = parent.parentNode;
  }

  const screenHeight = root.getComputedHeight();
  const cursorRestoreScroll = screenHeight > rows ? 1 : 0;
  const viewportTop = Math.max(0, screenHeight - rows) + cursorRestoreScroll;
  const viewportBottom = viewportTop + rows;

  if (height === 0) {
    return absoluteTop >= viewportTop && absoluteTop < viewportBottom;
  }

  const bottom = absoluteTop + height;
  return bottom > viewportTop && absoluteTop < viewportBottom;
}

/**
 * Reads whether an Ink element intersects the terminal's active viewport.
 * Visibility is stored in refs so Yoga layout effects never trigger another
 * React render. Callers naturally observe changes on their next render.
 */
export function useTerminalViewport(): TerminalViewportResult {
  const terminalSize = useContext(TerminalSizeContext);
  const elementRef = useRef<DOMElement | null>(null);
  const entryRef = useRef<TerminalViewportEntry>({ isVisible: true });

  const setElement = useCallback((element: DOMElement | null) => {
    elementRef.current = element;
  }, []);

  const computeAndCache = (): boolean => {
    const visible = computeTerminalViewportVisibility(
      elementRef.current,
      terminalSize,
    );
    if (visible === null) {
      return entryRef.current.isVisible;
    }
    if (visible !== entryRef.current.isVisible) {
      entryRef.current = { isVisible: visible };
    }
    return visible;
  };

  const computeRef = useRef(computeAndCache);
  computeRef.current = computeAndCache;
  const readVisibility = useCallback(() => computeRef.current(), []);

  const terminalSizeRef = useRef(terminalSize);
  terminalSizeRef.current = terminalSize;
  const measureNow = useCallback(
    () =>
      computeTerminalViewportVisibility(
        elementRef.current,
        terminalSizeRef.current,
      ),
    [],
  );

  useLayoutEffect(() => {
    computeAndCache();
  });

  return [setElement, entryRef.current, readVisibility, measureNow];
}
