/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import {
  useState,
  useRef,
  useCallback,
  useMemo,
  useLayoutEffect,
  useEffect,
  useId,
  useImperativeHandle,
  type MutableRefObject,
} from 'react';
import { Box, ResizeObserver, type DOMElement } from 'ink';
import {
  useRegisterActionHandlers,
  type ActionHandler,
} from '../../contexts/ActionHandlerRegistry.js';
import { useScrollable } from '../../contexts/ScrollProvider.js';
import { useAnimatedScrollbar } from '../../hooks/useAnimatedScrollbar.js';
import { useBatchedScroll } from '../../hooks/useBatchedScroll.js';
import { useOverflowActions } from '../../contexts/OverflowContext.js';

export interface ScrollableHandle {
  /** Scroll by a number of rows; negative scrolls up. Clamped to the content. */
  scrollBy: (delta: number) => void;
}

interface ScrollableProps {
  /** Imperative scrolling for bodies that map their own keys to scrolling. */
  scrollRef?: React.Ref<ScrollableHandle>;
  children?: React.ReactNode;
  width?: number;
  height?: number | string;
  maxWidth?: number;
  maxHeight?: number;
  hasFocus: boolean;
  scrollToBottom?: boolean;
  flexGrow?: number;
  reportOverflow?: boolean;
  overflowToBackbuffer?: boolean;
  scrollbar?: boolean;
  stableScrollback?: boolean;
  /** Fires when the content starts or stops overflowing the viewport. */
  onOverflowChange?: (overflowing: boolean) => void;
}

export const Scrollable: React.FC<ScrollableProps> = ({
  scrollRef,
  children,
  width,
  height,
  maxWidth,
  maxHeight,
  hasFocus,
  scrollToBottom,
  flexGrow,
  reportOverflow = false,
  overflowToBackbuffer,
  scrollbar = true,
  stableScrollback,
  onOverflowChange,
}) => {
  const [scrollTop, setScrollTop] = useState(0);
  const viewportRef = useRef<DOMElement | null>(null);
  const contentRef = useRef<DOMElement | null>(null);
  const overflowActions = useOverflowActions();
  const id = useId();
  const [size, setSize] = useState({
    innerHeight: typeof height === 'number' ? height : 0,
    scrollHeight: 0,
  });
  const sizeRef = useRef(size);
  const scrollTopRef = useRef(scrollTop);
  // Track scroll-to-bottom intent without nesting setScrollTop inside setSize.
  const needsScrollToBottomRef: MutableRefObject<boolean> = useRef(false);

  useLayoutEffect(() => {
    sizeRef.current = size;
  }, [size]);

  useLayoutEffect(() => {
    scrollTopRef.current = scrollTop;
  }, [scrollTop]);

  // Apply deferred scroll-to-bottom after size changes are committed.
  useLayoutEffect(() => {
    if (needsScrollToBottomRef.current) {
      needsScrollToBottomRef.current = false;
      setScrollTop(Number.MAX_SAFE_INTEGER);
    }
  }, [size]);

  useEffect(() => {
    if (reportOverflow && size.scrollHeight > size.innerHeight) {
      overflowActions?.addOverflowingId?.(id);
    } else {
      overflowActions?.removeOverflowingId?.(id);
    }
  }, [
    reportOverflow,
    size.scrollHeight,
    size.innerHeight,
    id,
    overflowActions,
  ]);

  useEffect(
    () => () => {
      overflowActions?.removeOverflowingId?.(id);
    },
    [id, overflowActions],
  );

  // An unmeasured viewport (innerHeight 0) is not overflowing: the content
  // observer can report before the viewport's does.
  const overflowing =
    size.innerHeight > 0 && size.scrollHeight > size.innerHeight;
  const onOverflowChangeRef = useRef(onOverflowChange);
  onOverflowChangeRef.current = onOverflowChange;
  useEffect(() => {
    onOverflowChangeRef.current?.(overflowing);
  }, [overflowing]);

  const viewportObserverRef = useRef<ResizeObserver | null>(null);
  const contentObserverRef = useRef<ResizeObserver | null>(null);

  useEffect(
    () => () => {
      viewportObserverRef.current?.disconnect();
      contentObserverRef.current?.disconnect();
    },
    [],
  );

  const viewportRefCallback = useCallback((node: DOMElement | null) => {
    viewportObserverRef.current?.disconnect();
    viewportRef.current = node;

    if (node) {
      const observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (entry) {
          const innerHeight = Math.round(entry.contentRect.height);
          setSize((prev) => {
            if (innerHeight === prev.innerHeight) return prev;
            const scrollHeight = prev.scrollHeight;
            const isAtBottom =
              scrollHeight > prev.innerHeight &&
              scrollTopRef.current >= scrollHeight - prev.innerHeight - 1;

            if (isAtBottom) {
              needsScrollToBottomRef.current = true;
            }
            return { ...prev, innerHeight };
          });
        }
      });
      observer.observe(node);
      viewportObserverRef.current = observer;
    }
  }, []);

  const contentRefCallback = useCallback(
    (node: DOMElement | null) => {
      contentObserverRef.current?.disconnect();
      contentRef.current = node;

      if (node) {
        const observer = new ResizeObserver((entries) => {
          const entry = entries[0];
          if (entry) {
            const scrollHeight = Math.round(entry.contentRect.height);
            setSize((prev) => {
              if (scrollHeight === prev.scrollHeight) return prev;
              const innerHeight = prev.innerHeight;
              const isAtBottom =
                prev.scrollHeight > innerHeight &&
                scrollTopRef.current >= prev.scrollHeight - innerHeight - 1;

              if (
                isAtBottom ||
                (scrollToBottom && scrollHeight > prev.scrollHeight)
              ) {
                needsScrollToBottomRef.current = true;
              }
              return { ...prev, scrollHeight };
            });
          }
        });
        observer.observe(node);
        contentObserverRef.current = observer;
      }
    },
    [scrollToBottom],
  );

  const { getScrollTop, setPendingScrollTop } = useBatchedScroll(scrollTop);

  const scrollBy = useCallback(
    (delta: number) => {
      const { scrollHeight, innerHeight } = sizeRef.current;
      const maxScroll = Math.max(0, scrollHeight - innerHeight);
      // Nothing to scroll (or not measured yet): leave scrollTop alone.
      // Without this, the bottom sentinel below would pin an unmeasured
      // viewport to MAX_SAFE_INTEGER on the first key press.
      if (maxScroll === 0) return;
      const current = Math.min(getScrollTop(), maxScroll);
      let next = Math.max(0, current + delta);
      if (next >= maxScroll) {
        next = Number.MAX_SAFE_INTEGER;
      }
      setPendingScrollTop(next);
      setScrollTop(next);
    },
    [getScrollTop, setPendingScrollTop],
  );

  useImperativeHandle(scrollRef, () => ({ scrollBy }), [scrollBy]);

  const { scrollbarColor, flashScrollbar, scrollByWithAnimation } =
    useAnimatedScrollbar(hasFocus, scrollBy);

  // Scroll behaviors - only handle if there's scrollable room
  const scrollHandlers = useMemo<Record<string, ActionHandler>>(
    () => ({
      'scroll:pageUp': () => {
        const { scrollHeight, innerHeight } = sizeRef.current;
        const maxScroll = Math.max(0, scrollHeight - innerHeight);
        const actualScrollTop = Math.min(getScrollTop(), maxScroll);
        if (actualScrollTop > 0) {
          scrollByWithAnimation(-innerHeight);
          return true;
        }
        return false;
      },
      'scroll:up': () => {
        const { scrollHeight, innerHeight } = sizeRef.current;
        const maxScroll = Math.max(0, scrollHeight - innerHeight);
        const actualScrollTop = Math.min(getScrollTop(), maxScroll);
        if (actualScrollTop > 0) {
          scrollByWithAnimation(-1);
          return true;
        }
        return false;
      },
      'scroll:pageDown': () => {
        const { scrollHeight, innerHeight } = sizeRef.current;
        const maxScroll = Math.max(0, scrollHeight - innerHeight);
        const actualScrollTop = Math.min(getScrollTop(), maxScroll);
        if (actualScrollTop < maxScroll) {
          scrollByWithAnimation(innerHeight);
          return true;
        }
        return false;
      },
      'scroll:down': () => {
        const { scrollHeight, innerHeight } = sizeRef.current;
        const maxScroll = Math.max(0, scrollHeight - innerHeight);
        const actualScrollTop = Math.min(getScrollTop(), maxScroll);
        if (actualScrollTop < maxScroll) {
          scrollByWithAnimation(1);
          return true;
        }
        return false;
      },
    }),
    [getScrollTop, scrollByWithAnimation],
  );

  useRegisterActionHandlers('Dialog', scrollHandlers, hasFocus);

  const getScrollState = useCallback(() => {
    const maxScroll = Math.max(0, size.scrollHeight - size.innerHeight);
    return {
      scrollTop: Math.min(getScrollTop(), maxScroll),
      scrollHeight: size.scrollHeight,
      innerHeight: size.innerHeight,
    };
  }, [getScrollTop, size.scrollHeight, size.innerHeight]);

  const hasFocusCallback = useCallback(() => hasFocus, [hasFocus]);

  const scrollableEntry = useMemo(
    () => ({
      ref: viewportRef as React.RefObject<DOMElement>,
      getScrollState,
      scrollBy: scrollByWithAnimation,
      hasFocus: hasFocusCallback,
      flashScrollbar,
    }),
    [getScrollState, scrollByWithAnimation, hasFocusCallback, flashScrollbar],
  );

  useScrollable(scrollableEntry, true);

  return (
    <Box
      ref={viewportRefCallback}
      maxHeight={maxHeight}
      width={width ?? maxWidth}
      height={height}
      flexDirection="column"
      overflowY="scroll"
      overflowX="hidden"
      scrollTop={scrollTop}
      flexGrow={flexGrow}
      scrollbarThumbColor={scrollbarColor}
      overflowToBackbuffer={overflowToBackbuffer}
      scrollbar={scrollbar}
      stableScrollback={stableScrollback}
    >
      {/*
        This inner box is necessary to prevent the parent from shrinking
        based on the children's content. It also adds a right padding to
        make room for the scrollbar.
      */}
      <Box
        ref={contentRefCallback}
        flexShrink={0}
        paddingRight={scrollbar ? 1 : 0}
        flexDirection="column"
      >
        {children}
      </Box>
    </Box>
  );
};
