/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useRef, forwardRef, useImperativeHandle, useCallback } from 'react';
import type React from 'react';
import {
  VirtualizedList,
  type VirtualizedListRef,
  type VirtualizedListProps,
} from './VirtualizedList.js';
import { useFrameCoalescedFlush } from '../../hooks/use-frame-coalesced-flush.js';
import { useKeypress, type Key } from '../../hooks/useKeypress.js';
import { keyMatchers, Command } from '../../keyMatchers.js';
import { useMouseEvents } from '../../hooks/useMouseEvents.js';
import type { MouseEvent } from '../../utils/mouse.js';

export { SCROLL_TO_ITEM_END } from './VirtualizedList.js';

interface ScrollableListProps<T> extends VirtualizedListProps<T> {
  hasFocus: boolean;
  width?: string | number;
  targetScrollIndex?: number;
  containerHeight?: number;
}

export type ScrollableListRef<T> = VirtualizedListRef<T>;

function ScrollableList<T>(
  props: ScrollableListProps<T>,
  ref: React.Ref<ScrollableListRef<T>>,
) {
  // Separate ScrollableList-only props from the ones we pass through to
  // VirtualizedList. Spreading the full props would silently forward
  // `hasFocus` (which VirtualizedList does not declare) and create a
  // latent name collision if VirtualizedList ever adds the same prop.
  const { hasFocus, ...virtualizedListProps } = props;
  const virtualizedListRef = useRef<VirtualizedListRef<T>>(null);
  const isDraggingScrollbar = useRef(false);

  useImperativeHandle(
    ref,
    () => ({
      scrollBy: (delta) => virtualizedListRef.current?.scrollBy(delta),
      scrollTo: (offset) => virtualizedListRef.current?.scrollTo(offset),
      scrollToEnd: () => virtualizedListRef.current?.scrollToEnd(),
      scrollToIndex: (params) =>
        virtualizedListRef.current?.scrollToIndex(params),
      scrollToItem: (params) =>
        virtualizedListRef.current?.scrollToItem(params),
      hitTestScrollbar: (location) =>
        virtualizedListRef.current?.hitTestScrollbar(location) ?? false,
      scrollToScrollbarRow: (row) =>
        virtualizedListRef.current?.scrollToScrollbarRow(row),
      getScrollIndex: () => virtualizedListRef.current?.getScrollIndex() ?? 0,
      getScrollState: () =>
        virtualizedListRef.current?.getScrollState() ?? {
          scrollTop: 0,
          scrollHeight: 0,
          innerHeight: 0,
        },
    }),
    [],
  );

  const getScrollState = useCallback(
    () =>
      virtualizedListRef.current?.getScrollState() ?? {
        scrollTop: 0,
        scrollHeight: 0,
        innerHeight: 0,
      },
    [],
  );

  useKeypress(
    useCallback(
      (key: Key) => {
        if (keyMatchers[Command.SCROLL_UP](key)) {
          virtualizedListRef.current?.scrollBy(-1);
        } else if (keyMatchers[Command.SCROLL_DOWN](key)) {
          virtualizedListRef.current?.scrollBy(1);
        } else if (keyMatchers[Command.PAGE_UP](key)) {
          const state = getScrollState();
          const delta = state.innerHeight > 0 ? state.innerHeight : 20;
          virtualizedListRef.current?.scrollBy(-delta);
        } else if (keyMatchers[Command.PAGE_DOWN](key)) {
          const state = getScrollState();
          const delta = state.innerHeight > 0 ? state.innerHeight : 20;
          virtualizedListRef.current?.scrollBy(delta);
        } else if (keyMatchers[Command.SCROLL_HOME](key)) {
          virtualizedListRef.current?.scrollTo(0);
        } else if (keyMatchers[Command.SCROLL_END](key)) {
          virtualizedListRef.current?.scrollToEnd();
        }
      },
      [getScrollState],
    ),
    { isActive: hasFocus },
  );

  // Mouse scrolling. Legacy `<Static>` mode let the host terminal scroll its
  // native scrollback. In VP mode the list owns the visible region, so route
  // wheel ticks and scrollbar drags to the virtualized viewport.
  const WHEEL_LINES_PER_TICK = 3;

  // Terminal mouse reporting emits one event per row the pointer crosses, so a
  // brisk wheel spin or scrollbar drag fires a rapid burst. Applying each event
  // synchronously forced one Ink reflow + terminal flush per event — the source
  // of the "一顿一顿" stutter. Accumulate the intent in refs and let
  // useFrameCoalescedFlush apply the latest at most once per frame. A drag is
  // absolute (snap to the newest row); a wheel burst is relative (sum the
  // ticks); a drag in the same window wins.
  const pendingWheelDelta = useRef(0);
  const pendingDragRow = useRef<number | null>(null);

  const applyPendingScroll = useCallback(() => {
    const list = virtualizedListRef.current;
    const dragRow = pendingDragRow.current;
    const wheelDelta = pendingWheelDelta.current;
    pendingDragRow.current = null;
    pendingWheelDelta.current = 0;
    if (!list) return;
    if (dragRow !== null) {
      list.scrollToScrollbarRow(dragRow);
      return;
    }
    if (wheelDelta !== 0) {
      list.scrollBy(wheelDelta);
    }
  }, []);

  const { schedule: scheduleScrollFlush, cancel: cancelScrollFlush } =
    useFrameCoalescedFlush(applyPendingScroll);

  // Discard any queued wheel/drag intent and cancel an in-flight flush. Used
  // when a scrollbar press takes over: without it, a wheel burst scheduled
  // moments earlier would still fire and `scrollBy` the view away from the row
  // the user just clicked.
  const cancelPendingScroll = useCallback(() => {
    pendingWheelDelta.current = 0;
    pendingDragRow.current = null;
    cancelScrollFlush();
  }, [cancelScrollFlush]);

  const handleMouseEvent = useCallback(
    (event: MouseEvent) => {
      if (!virtualizedListRef.current) return;
      if (event.name === 'left-release') {
        isDraggingScrollbar.current = false;
        return;
      }
      if (event.name === 'left-press') {
        isDraggingScrollbar.current =
          virtualizedListRef.current.hitTestScrollbar(event);
        if (isDraggingScrollbar.current) {
          // A press should feel instant — apply now and drop any queued
          // wheel/drag intent (and its timer) so a flush scheduled moments
          // earlier can't yank the view off the clicked row.
          cancelPendingScroll();
          virtualizedListRef.current.scrollToScrollbarRow(event.row);
        }
        return;
      }
      if (event.name === 'move' && isDraggingScrollbar.current) {
        pendingDragRow.current = event.row;
        scheduleScrollFlush();
        return;
      }
      if (event.name === 'scroll-up') {
        pendingWheelDelta.current -= WHEEL_LINES_PER_TICK;
        scheduleScrollFlush();
      } else if (event.name === 'scroll-down') {
        pendingWheelDelta.current += WHEEL_LINES_PER_TICK;
        scheduleScrollFlush();
      }
    },
    [scheduleScrollFlush, cancelPendingScroll],
  );

  useMouseEvents(handleMouseEvent, { isActive: hasFocus });

  // ScrollableList is a thin keyboard / mouse wrapper around VirtualizedList.
  // The previous outer <Box flexGrow={1}> wrapper carried a never-read
  // containerRef and collapsed to zero height in test renderers (no flex
  // parent). MainContent passes an explicit `containerHeight`, which
  // VirtualizedList's outermost Box honours, so the wrapper added nothing
  // beyond the dead ref.
  return <VirtualizedList ref={virtualizedListRef} {...virtualizedListProps} />;
}

const ScrollableListWithForwardRef = forwardRef(ScrollableList) as <T>(
  props: ScrollableListProps<T> & { ref?: React.Ref<ScrollableListRef<T>> },
) => React.ReactElement;

export { ScrollableListWithForwardRef as ScrollableList };
