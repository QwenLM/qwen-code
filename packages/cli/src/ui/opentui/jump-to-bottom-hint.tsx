/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type { ScrollBoxRenderable } from '@opentui/core';
import { MouseButton } from '@opentui/core';
import { t } from '../../i18n/index.js';
import { C } from './theme.js';

/** Whether a scroll box is close enough to its maximum offset to count as at
 *  the tail. A half-cell tolerance absorbs fractional Yoga row heights. */
export function isAtScrollTail(
  scrollTop: number,
  scrollHeight: number,
  viewportHeight: number,
): boolean {
  const max = Math.max(0, scrollHeight - viewportHeight);
  return scrollTop >= max - 0.5;
}

export interface JumpToBottomHintProps {
  scrollRef: RefObject<ScrollBoxRenderable | null>;
  /** Root-bottom offset, normally the composer chrome height. */
  bottom: number;
  /** Lets the shell stack other bottom-right chrome above the hint. */
  onVisibilityChange?: (visible: boolean) => void;
}

/**
 * Claude Code-style "Jump to bottom" affordance: visible only while the
 * transcript is away from its tail. It listens to the scrollbar's own change
 * event and re-checks after every render so streaming content growth is
 * covered too. Clicking it scrolls back to the tail.
 */
export function JumpToBottomHint({
  scrollRef,
  bottom,
  onVisibilityChange,
}: JumpToBottomHintProps) {
  const [atBottom, setAtBottom] = useState(true);
  const onVisibilityChangeRef = useRef(onVisibilityChange);
  onVisibilityChangeRef.current = onVisibilityChange;

  const check = useCallback(() => {
    const box = scrollRef.current;
    // The app-shell tests use a DOM stand-in for the scrollbox; a real one
    // always has the viewport wrapper.
    if (!box?.viewport) return;
    const next = isAtScrollTail(
      box.scrollTop,
      box.scrollHeight,
      box.viewport.height,
    );
    setAtBottom((previous) => (previous === next ? previous : next));
  }, [scrollRef]);

  useEffect(() => {
    check();
    const bar = scrollRef.current?.verticalScrollBar;
    bar?.on('change', check);
    return () => {
      bar?.off('change', check);
    };
  }, [check, scrollRef]);

  // Content growth (streaming, tool cards) changes scrollHeight without a
  // scroll event; re-check after every render.
  useEffect(() => {
    check();
  });

  useEffect(() => {
    onVisibilityChangeRef.current?.(!atBottom);
  }, [atBottom]);

  if (atBottom) return null;

  return (
    <box
      position="absolute"
      right={2}
      bottom={bottom}
      zIndex={700}
      backgroundColor={C.bg ?? C.hover}
      onMouseUp={(event) => {
        if (event.button !== MouseButton.LEFT) return;
        const box = scrollRef.current;
        if (!box) return;
        box.scrollTo(box.scrollHeight);
        check();
      }}
    >
      <text fg={C.dim}>{` ${t('Jump to bottom (ctrl+End)')} `}</text>
    </box>
  );
}
