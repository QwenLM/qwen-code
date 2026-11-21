/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useRef,
  forwardRef,
  useImperativeHandle,
  useCallback,
  useEffect,
} from 'react';
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

  const getScrollState = useCallback(
    () =>
      virtualizedListRef.current?.getScrollState() ?? {
        scrollTop: 0,
        scrollHeight: 0,
        innerHeight: 0,
      },
    [],
  );

  // Warp already reports three events per wheel notch. Multiplying every
  // reported event by three made gentle gestures jump nine rows.
  const pendingWheelDelta = useRef(0);
  const pendingDragRow = useRef<number | null>(null);
  const wheelSinceFlush = useRef(false);
  const coastSpent = useRef(0);

  const applyPendingScroll = useCallback(() => {
    const list = virtualizedListRef.current;
    const dragRow = pendingDragRow.current;
    const wheelDelta = pendingWheelDelta.current;
    pendingDragRow.current = null;
    if (!list) return false;
    if (dragRow !== null) {
      pendingWheelDelta.current = 0;
      list.scrollToScrollbarRow(dragRow);
      return false;
    }
    if (wheelDelta !== 0) {
      const state = list.getScrollState();
      const limit = Math.max(1, Math.floor(state.innerHeight / 2));
      const coasting = !wheelSinceFlush.current;
      wheelSinceFlush.current = false;
      const budget = coasting ? Math.max(0, limit - coastSpent.current) : limit;
      const delta =
        Math.sign(wheelDelta) * Math.min(Math.abs(wheelDelta), budget);
      pendingWheelDelta.current -= delta;
      if (coasting) {
        coastSpent.current += Math.abs(delta);
        // Do not replay a flooded input buffer for seconds after release.
        if (coastSpent.current >= limit) pendingWheelDelta.current = 0;
      }
      list.scrollBy(delta);
      const next = list.getScrollState();
      if (
        next.scrollTop === 0 ||
        next.scrollTop >= next.scrollHeight - next.innerHeight
      ) {
        pendingWheelDelta.current = 0;
      }
    }
    return pendingWheelDelta.current !== 0;
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
    wheelSinceFlush.current = false;
    coastSpent.current = 0;
    cancelScrollFlush();
  }, [cancelScrollFlush]);

  useImperativeHandle(
    ref,
    () => ({
      scrollBy: (delta) => {
        cancelPendingScroll();
        virtualizedListRef.current?.scrollBy(delta);
      },
      scrollTo: (offset) => {
        cancelPendingScroll();
        virtualizedListRef.current?.scrollTo(offset);
      },
      scrollToEnd: () => {
        cancelPendingScroll();
        virtualizedListRef.current?.scrollToEnd();
      },
      scrollToIndex: (params) => {
        cancelPendingScroll();
        virtualizedListRef.current?.scrollToIndex(params);
      },
      scrollToItem: (params) => {
        cancelPendingScroll();
        virtualizedListRef.current?.scrollToItem(params);
      },
      hitTestScrollbar: (location) =>
        virtualizedListRef.current?.hitTestScrollbar(location) ?? false,
      scrollToScrollbarRow: (row) => {
        cancelPendingScroll();
        virtualizedListRef.current?.scrollToScrollbarRow(row);
      },
      getScrollIndex: () => virtualizedListRef.current?.getScrollIndex() ?? 0,
      getScrollState: () =>
        virtualizedListRef.current?.getScrollState() ?? {
          scrollTop: 0,
          scrollHeight: 0,
          innerHeight: 0,
        },
      getViewportRect: () =>
        virtualizedListRef.current?.getViewportRect() ?? null,
    }),
    [cancelPendingScroll],
  );

  useKeypress(
    useCallback(
      (key: Key) => {
        const commands = [
          Command.SCROLL_UP,
          Command.SCROLL_DOWN,
          Command.PAGE_UP,
          Command.PAGE_DOWN,
          Command.SCROLL_HOME,
          Command.SCROLL_END,
        ];
        if (!commands.some((command) => keyMatchers[command](key))) return;
        cancelPendingScroll();
        if (keyMatchers[Command.SCROLL_UP](key)) {
          virtualizedListRef.current?.scrollBy(-1);
        } else if (keyMatchers[Command.SCROLL_DOWN](key)) {
          virtualizedListRef.current?.scrollBy(1);
        } else if (keyMatchers[Command.PAGE_UP](key)) {
          const state = getScrollState();
          virtualizedListRef.current?.scrollBy(-(state.innerHeight || 20));
        } else if (keyMatchers[Command.PAGE_DOWN](key)) {
          const state = getScrollState();
          virtualizedListRef.current?.scrollBy(state.innerHeight || 20);
        } else if (keyMatchers[Command.SCROLL_HOME](key)) {
          virtualizedListRef.current?.scrollTo(0);
        } else if (keyMatchers[Command.SCROLL_END](key)) {
          virtualizedListRef.current?.scrollToEnd();
        }
      },
      [getScrollState, cancelPendingScroll],
    ),
    { isActive: hasFocus },
  );

  // Losing focus unsubscribes the keypress and mouse handlers, so a still-armed
  // flush belongs to a gesture the user can no longer steer. Letting it fire
  // after the flip scrolls the surface out from under whatever took focus.
  useEffect(() => {
    if (!hasFocus) {
      isDraggingScrollbar.current = false;
      cancelPendingScroll();
    }
  }, [hasFocus, cancelPendingScroll]);

  const handleMouseEvent = useCallback(
    (event: MouseEvent) => {
      if (!virtualizedListRef.current) return;
      if (event.name === 'left-release') {
        isDraggingScrollbar.current = false;
        return;
      }
      if (event.name === 'left-press') {
        cancelPendingScroll();
        isDraggingScrollbar.current =
          virtualizedListRef.current.hitTestScrollbar(event);
        if (isDraggingScrollbar.current) {
          virtualizedListRef.current.scrollToScrollbarRow(event.row);
        }
        return;
      }
      if (event.name === 'move' && isDraggingScrollbar.current) {
        pendingDragRow.current = event.row;
        scheduleScrollFlush();
        return;
      }
      if (event.name === 'right-press' || event.name === 'middle-press') {
        cancelPendingScroll();
      }
      if (event.name === 'scroll-up' || event.name === 'scroll-down') {
        const delta = event.name === 'scroll-up' ? -1 : 1;
        if (pendingWheelDelta.current * delta < 0) {
          cancelPendingScroll();
        }
        pendingWheelDelta.current += delta;
        wheelSinceFlush.current = true;
        coastSpent.current = 0;
        scheduleScrollFlush();
      }
    },
    [scheduleScrollFlush, cancelPendingScroll],
  );

  // The VP viewport owns the wheel (this IS the in-app scroller), so opt out
  // of the VP gate — though in practice ScrollableList only mounts in VP mode.
  useMouseEvents(handleMouseEvent, { isActive: hasFocus, bypassVpGate: true });

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
