/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useState,
  useRef,
  useLayoutEffect,
  forwardRef,
  useImperativeHandle,
  useMemo,
  useCallback,
  memo,
} from 'react';
import type React from 'react';
import { useBatchedScroll } from '../../hooks/useBatchedScroll.js';
import { StaticRender } from './StaticRender.js';
import { type DOMElement, Box, Text, useBoxMetrics } from 'ink';
import { createDebugLogger } from '@qwen-code/qwen-code-core';

const debugLogger = createDebugLogger('VIRTUALIZED_LIST');

export const SCROLL_TO_ITEM_END = Number.MAX_SAFE_INTEGER;

export type VirtualizedListProps<T> = {
  data: T[];
  renderItem: (info: { item: T; index: number }) => React.ReactElement;
  estimatedItemHeight: (index: number) => number;
  keyExtractor: (item: T, index: number) => string;
  initialScrollIndex?: number;
  initialScrollOffsetInIndex?: number;
  targetScrollIndex?: number;
  renderStatic?: boolean;
  isStaticItem?: (item: T, index: number) => boolean;
  width?: number | string;
  containerHeight?: number;
  showScrollbar?: boolean;
};

export type VirtualizedListRef<T> = {
  scrollBy: (delta: number) => void;
  scrollTo: (offset: number) => void;
  scrollToEnd: () => void;
  scrollToIndex: (params: {
    index: number;
    viewOffset?: number;
    viewPosition?: number;
  }) => void;
  scrollToItem: (params: {
    item: T;
    viewOffset?: number;
    viewPosition?: number;
  }) => void;
  getScrollIndex: () => number;
  getScrollState: () => {
    scrollTop: number;
    scrollHeight: number;
    innerHeight: number;
  };
};

// Returns the smallest index i such that arr[i] > target. If every entry is
// <= target, returns arr.length. Assumes arr is monotonically non-decreasing.
function upperBound(arr: number[], target: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Largest index i such that arr[i] <= target, or -1 if none. Used in the
// hot render path on the offsets array (which is monotonic by construction);
// O(log n) replaces the previous O(n) linear scan.
function findLastLE(arr: number[], target: number): number {
  return upperBound(arr, target) - 1;
}

const VirtualizedListItem = memo(
  ({
    content,
    shouldBeStatic,
    width,
    containerWidth,
    itemKey,
    onHeightChange,
  }: {
    content: React.ReactElement;
    shouldBeStatic: boolean;
    width: number | string | undefined;
    containerWidth: number;
    itemKey: string;
    onHeightChange: (key: string, height: number) => void;
  }) => {
    const itemRef = useRef<DOMElement>(null);

    const { height, hasMeasured } = useBoxMetrics(
      itemRef as React.RefObject<DOMElement>,
    );

    const onHeightChangeRef = useRef(onHeightChange);
    onHeightChangeRef.current = onHeightChange;

    useLayoutEffect(() => {
      if (hasMeasured && height > 0) {
        onHeightChangeRef.current(itemKey, height);
      }
    }, [itemKey, height, hasMeasured]);

    return (
      <Box width="100%" flexDirection="column" flexShrink={0} ref={itemRef}>
        {shouldBeStatic ? (
          <StaticRender
            width={typeof width === 'number' ? width : containerWidth}
            key={
              itemKey +
              '-static-' +
              (typeof width === 'number' ? width : containerWidth)
            }
          >
            {content}
          </StaticRender>
        ) : (
          content
        )}
      </Box>
    );
  },
);

VirtualizedListItem.displayName = 'VirtualizedListItem';

function VirtualizedList<T>(
  props: VirtualizedListProps<T>,
  ref: React.Ref<VirtualizedListRef<T>>,
) {
  const {
    data,
    renderItem,
    estimatedItemHeight,
    keyExtractor,
    initialScrollIndex,
    initialScrollOffsetInIndex,
    renderStatic,
    isStaticItem,
    width,
  } = props;

  const [scrollAnchor, setScrollAnchor] = useState(() => {
    const scrollToEnd =
      initialScrollIndex === SCROLL_TO_ITEM_END ||
      (typeof initialScrollIndex === 'number' &&
        initialScrollIndex >= data.length - 1 &&
        initialScrollOffsetInIndex === SCROLL_TO_ITEM_END);

    if (scrollToEnd) {
      return {
        index: data.length > 0 ? data.length - 1 : 0,
        offset: SCROLL_TO_ITEM_END,
      };
    }

    if (typeof initialScrollIndex === 'number') {
      return {
        index: Math.max(0, Math.min(data.length - 1, initialScrollIndex)),
        offset: initialScrollOffsetInIndex ?? 0,
      };
    }

    if (typeof props.targetScrollIndex === 'number') {
      return {
        index: props.targetScrollIndex,
        offset: 0,
      };
    }

    return { index: 0, offset: 0 };
  });

  const [isStickingToBottom, setIsStickingToBottom] = useState(() => {
    const scrollToEnd =
      initialScrollIndex === SCROLL_TO_ITEM_END ||
      (typeof initialScrollIndex === 'number' &&
        initialScrollIndex >= data.length - 1 &&
        initialScrollOffsetInIndex === SCROLL_TO_ITEM_END);
    return scrollToEnd;
  });

  const containerRef = useRef<DOMElement>(null);

  const { width: measuredContainerWidth, height: measuredContainerHeight } =
    useBoxMetrics(containerRef as React.RefObject<DOMElement>);

  const containerHeight = props.containerHeight ?? measuredContainerHeight;
  const containerWidth = measuredContainerWidth;

  const [heights, setHeights] = useState<Record<string, number>>({});
  const isInitialScrollSet = useRef(false);

  const onHeightChange = useCallback((key: string, height: number) => {
    setHeights((prev) => {
      if (prev[key] === height) return prev;
      return { ...prev, [key]: height };
    });
  }, []);

  // Prune stale height entries when the data set shrinks (`/clear`, history
  // reset) or when item keys change (pending → completed key transition).
  // Without this the heights record grows unbounded across long sessions —
  // every `p-N` from a turn that finalized is left behind, every cleared
  // turn's `h-N` lingers.
  //
  // Gated so we don't pay O(N) every streaming tick: only run when the
  // heights record has clearly outpaced the live data (size > 2× data.length,
  // a heuristic that fires after any `/clear` or after enough pending→
  // completed transitions). Steady-state streaming sees no work here. Use
  // useLayoutEffect so the prune commits in the same paint as the data
  // change, avoiding one frame of stale offsets.
  useLayoutEffect(() => {
    setHeights((prev) => {
      const prevKeys = Object.keys(prev);
      if (prevKeys.length <= Math.max(8, 2 * data.length)) return prev;
      const currentKeys = new Set<string>();
      for (let i = 0; i < data.length; i++) {
        currentKeys.add(keyExtractor(data[i], i));
      }
      let staleSeen = false;
      for (const k of prevKeys) {
        if (!currentKeys.has(k)) {
          staleSeen = true;
          break;
        }
      }
      if (!staleSeen) return prev;
      const next: Record<string, number> = {};
      for (const k of prevKeys) {
        if (currentKeys.has(k)) next[k] = prev[k];
      }
      return next;
    });
  }, [data, keyExtractor]);

  const { totalHeight, offsets } = useMemo(() => {
    const offsets: number[] = [0];
    let totalHeight = 0;
    for (let i = 0; i < data.length; i++) {
      const key = keyExtractor(data[i], i);
      const raw = heights[key] ?? estimatedItemHeight(i);
      // Defensive coerce: a buggy estimator returning NaN / negative /
      // Infinity would poison every downstream scroll-math read (binary
      // search assumes monotonic offsets). Clamp at 0 and fall through.
      const height = Number.isFinite(raw) && raw > 0 ? raw : 0;
      totalHeight += height;
      offsets.push(totalHeight);
    }
    return { totalHeight, offsets };
  }, [heights, data, estimatedItemHeight, keyExtractor]);

  const scrollableContainerHeight = containerHeight;

  const getAnchorForScrollTop = useCallback(
    (
      scrollTop: number,
      offsets: number[],
    ): { index: number; offset: number } => {
      const index = findLastLE(offsets, scrollTop);
      if (index === -1) {
        return { index: 0, offset: 0 };
      }
      return { index, offset: scrollTop - offsets[index] };
    },
    [],
  );

  const [prevTargetScrollIndex, setPrevTargetScrollIndex] = useState(
    props.targetScrollIndex,
  );
  const prevOffsetsLength = useRef(offsets.length);

  // Render-phase state update — React-endorsed pattern for adjusting state
  // based on previous-render information (see React docs: "Adjusting state
  // while rendering"). This must run synchronously with the offsets memo so
  // the very first paint after a targetScrollIndex change shows the anchored
  // row instead of a one-frame flash at the previous position. Each setter
  // is guarded by an equality check so React bails out of repeat renders
  // when the value is unchanged.
  const target = props.targetScrollIndex;
  if (target !== undefined && offsets.length > 1) {
    const targetChanged = target !== prevTargetScrollIndex;
    const offsetsJustBecameUsable = prevOffsetsLength.current <= 1;
    if (targetChanged || offsetsJustBecameUsable) {
      if (targetChanged) {
        setPrevTargetScrollIndex(target);
      }
      if (isStickingToBottom) {
        setIsStickingToBottom(false);
      }
      if (scrollAnchor.index !== target || scrollAnchor.offset !== 0) {
        setScrollAnchor({ index: target, offset: 0 });
      }
    }
  }
  prevOffsetsLength.current = offsets.length;

  const actualScrollTop = useMemo(() => {
    const offset = offsets[scrollAnchor.index];
    if (typeof offset !== 'number') {
      return 0;
    }

    if (scrollAnchor.offset === SCROLL_TO_ITEM_END) {
      const item = data[scrollAnchor.index];
      const key = item ? keyExtractor(item, scrollAnchor.index) : '';
      const itemHeight = heights[key] ?? 0;
      return offset + itemHeight - scrollableContainerHeight;
    }

    return offset + scrollAnchor.offset;
  }, [
    scrollAnchor,
    offsets,
    heights,
    scrollableContainerHeight,
    data,
    keyExtractor,
  ]);

  const scrollTop = isStickingToBottom
    ? Number.MAX_SAFE_INTEGER
    : actualScrollTop;

  const prevDataLength = useRef(data.length);
  const prevTotalHeight = useRef(totalHeight);
  const prevScrollTop = useRef(actualScrollTop);
  const prevContainerHeight = useRef(scrollableContainerHeight);

  useLayoutEffect(() => {
    const contentPreviouslyFit =
      prevTotalHeight.current <= prevContainerHeight.current;
    const wasScrolledToBottomPixels =
      prevScrollTop.current >=
      prevTotalHeight.current - prevContainerHeight.current - 1;
    const wasAtBottom = contentPreviouslyFit || wasScrolledToBottomPixels;

    if (wasAtBottom && actualScrollTop >= prevScrollTop.current) {
      if (!isStickingToBottom) {
        setIsStickingToBottom(true);
      }
    }

    const listGrew = data.length > prevDataLength.current;
    const containerChanged =
      prevContainerHeight.current !== scrollableContainerHeight;

    const shouldAutoScroll = props.targetScrollIndex === undefined;

    if (
      shouldAutoScroll &&
      ((listGrew && (isStickingToBottom || wasAtBottom)) ||
        (isStickingToBottom && containerChanged))
    ) {
      const newIndex = data.length > 0 ? data.length - 1 : 0;
      if (
        scrollAnchor.index !== newIndex ||
        scrollAnchor.offset !== SCROLL_TO_ITEM_END
      ) {
        setScrollAnchor({
          index: newIndex,
          offset: SCROLL_TO_ITEM_END,
        });
      }
      if (!isStickingToBottom) {
        setIsStickingToBottom(true);
      }
    } else if (
      (scrollAnchor.index >= data.length ||
        actualScrollTop > totalHeight - scrollableContainerHeight) &&
      data.length > 0
    ) {
      const newScrollTop = Math.max(0, totalHeight - scrollableContainerHeight);
      const newAnchor = getAnchorForScrollTop(newScrollTop, offsets);
      if (
        scrollAnchor.index !== newAnchor.index ||
        scrollAnchor.offset !== newAnchor.offset
      ) {
        setScrollAnchor(newAnchor);
      }
    } else if (data.length === 0) {
      if (scrollAnchor.index !== 0 || scrollAnchor.offset !== 0) {
        setScrollAnchor({ index: 0, offset: 0 });
      }
    }

    prevDataLength.current = data.length;
    prevTotalHeight.current = totalHeight;
    prevScrollTop.current = actualScrollTop;
    prevContainerHeight.current = scrollableContainerHeight;
  }, [
    data.length,
    totalHeight,
    actualScrollTop,
    scrollableContainerHeight,
    scrollAnchor.index,
    scrollAnchor.offset,
    getAnchorForScrollTop,
    offsets,
    isStickingToBottom,
    props.targetScrollIndex,
  ]);

  useLayoutEffect(() => {
    if (
      isInitialScrollSet.current ||
      offsets.length <= 1 ||
      totalHeight <= 0 ||
      scrollableContainerHeight <= 0
    ) {
      return;
    }

    if (props.targetScrollIndex !== undefined) {
      isInitialScrollSet.current = true;
      return;
    }

    if (typeof initialScrollIndex === 'number') {
      const scrollToEnd =
        initialScrollIndex === SCROLL_TO_ITEM_END ||
        (initialScrollIndex >= data.length - 1 &&
          initialScrollOffsetInIndex === SCROLL_TO_ITEM_END);

      if (scrollToEnd) {
        setScrollAnchor({
          index: data.length - 1,
          offset: SCROLL_TO_ITEM_END,
        });
        setIsStickingToBottom(true);
        isInitialScrollSet.current = true;
        return;
      }

      const index = Math.max(0, Math.min(data.length - 1, initialScrollIndex));
      const offset = initialScrollOffsetInIndex ?? 0;
      const newScrollTop = (offsets[index] ?? 0) + offset;

      const clampedScrollTop = Math.max(
        0,
        Math.min(totalHeight - scrollableContainerHeight, newScrollTop),
      );

      setScrollAnchor(getAnchorForScrollTop(clampedScrollTop, offsets));
      isInitialScrollSet.current = true;
    }
  }, [
    initialScrollIndex,
    initialScrollOffsetInIndex,
    offsets,
    totalHeight,
    scrollableContainerHeight,
    getAnchorForScrollTop,
    data.length,
    heights,
    props.targetScrollIndex,
  ]);

  const startIndex = Math.max(0, findLastLE(offsets, actualScrollTop) - 1);
  const viewHeightForEndIndex =
    scrollableContainerHeight > 0 ? scrollableContainerHeight : 50;
  const endIndexOffsetRaw = upperBound(
    offsets,
    actualScrollTop + viewHeightForEndIndex,
  );
  const endIndex =
    endIndexOffsetRaw >= offsets.length
      ? data.length - 1
      : Math.min(data.length - 1, endIndexOffsetRaw);

  const topSpacerHeight =
    renderStatic === true ? 0 : (offsets[startIndex] ?? 0);
  const bottomSpacerHeight = renderStatic
    ? 0
    : totalHeight - (offsets[endIndex + 1] ?? totalHeight);

  const isReady =
    containerHeight > 0 ||
    process.env['NODE_ENV'] === 'test' ||
    (width !== undefined && typeof width === 'number');

  const renderRangeStart = renderStatic ? 0 : startIndex;
  const renderRangeEnd = renderStatic ? data.length - 1 : endIndex;

  const renderedItems = useMemo(() => {
    if (!isReady) {
      return [];
    }

    const items = [];
    for (let i = renderRangeStart; i <= renderRangeEnd; i++) {
      const item = data[i];
      if (item) {
        const isOutsideViewport = i < startIndex || i > endIndex;
        const shouldBeStatic =
          (renderStatic === true && isOutsideViewport) ||
          isStaticItem?.(item, i) === true;

        // Isolate per-item render failures so one buggy history record
        // can't take down the whole VP tree. Without this, a thrown
        // renderItem propagates through React's commit phase and Ink
        // tears down the entire UI. The fallback keeps the row in the
        // viewport so the user can scroll past it instead of losing the
        // session. The full error goes to the debug log; the visible
        // marker stays generic so paths / partial tool state can't leak
        // to scrollback or screen-scrapers.
        let content: React.ReactElement;
        try {
          content = renderItem({ item, index: i });
        } catch (err) {
          debugLogger.debug(`renderItem threw at index ${i}`, err);
          content = (
            <Box flexDirection="column" flexShrink={0}>
              <Text color="red">[render error]</Text>
            </Box>
          );
        }
        const key = keyExtractor(item, i);

        items.push(
          <VirtualizedListItem
            key={key}
            itemKey={key}
            content={content}
            shouldBeStatic={shouldBeStatic}
            width={width}
            containerWidth={containerWidth}
            onHeightChange={onHeightChange}
          />,
        );
      }
    }
    return items;
  }, [
    isReady,
    renderRangeStart,
    renderRangeEnd,
    data,
    startIndex,
    endIndex,
    renderStatic,
    isStaticItem,
    renderItem,
    keyExtractor,
    width,
    containerWidth,
    onHeightChange,
  ]);

  const { getScrollTop, setPendingScrollTop } = useBatchedScroll(scrollTop);

  // Clamp for marginTop: can't be negative or exceed total - container
  const maxScroll = Math.max(0, totalHeight - scrollableContainerHeight);
  const clampedScrollTop = Math.min(
    Math.max(0, isStickingToBottom ? maxScroll : actualScrollTop),
    maxScroll,
  );

  useImperativeHandle(
    ref,
    () => ({
      scrollBy: (delta: number) => {
        if (delta < 0) {
          setIsStickingToBottom(false);
        }
        const currentScrollTop = getScrollTop();
        const maxScroll = Math.max(0, totalHeight - scrollableContainerHeight);
        const actualCurrent = Math.min(currentScrollTop, maxScroll);
        let newScrollTop = Math.max(0, actualCurrent + delta);
        if (newScrollTop >= maxScroll) {
          setIsStickingToBottom(true);
          newScrollTop = Number.MAX_SAFE_INTEGER;
        }
        setPendingScrollTop(newScrollTop);
        setScrollAnchor(
          getAnchorForScrollTop(Math.min(newScrollTop, maxScroll), offsets),
        );
      },
      scrollTo: (offset: number) => {
        const maxScroll = Math.max(0, totalHeight - scrollableContainerHeight);
        if (offset >= maxScroll || offset === SCROLL_TO_ITEM_END) {
          setIsStickingToBottom(true);
          setPendingScrollTop(Number.MAX_SAFE_INTEGER);
          if (data.length > 0) {
            setScrollAnchor({
              index: data.length - 1,
              offset: SCROLL_TO_ITEM_END,
            });
          }
        } else {
          setIsStickingToBottom(false);
          const newScrollTop = Math.max(0, offset);
          setPendingScrollTop(newScrollTop);
          setScrollAnchor(getAnchorForScrollTop(newScrollTop, offsets));
        }
      },
      scrollToEnd: () => {
        setIsStickingToBottom(true);
        setPendingScrollTop(Number.MAX_SAFE_INTEGER);
        if (data.length > 0) {
          setScrollAnchor({
            index: data.length - 1,
            offset: SCROLL_TO_ITEM_END,
          });
        }
      },
      scrollToIndex: ({
        index,
        viewOffset = 0,
        viewPosition = 0,
      }: {
        index: number;
        viewOffset?: number;
        viewPosition?: number;
      }) => {
        setIsStickingToBottom(false);
        const offset = offsets[index];
        if (offset !== undefined) {
          const maxScroll = Math.max(
            0,
            totalHeight - scrollableContainerHeight,
          );
          const newScrollTop = Math.max(
            0,
            Math.min(
              maxScroll,
              offset - viewPosition * scrollableContainerHeight + viewOffset,
            ),
          );
          setPendingScrollTop(newScrollTop);
          setScrollAnchor(getAnchorForScrollTop(newScrollTop, offsets));
        }
      },
      scrollToItem: ({
        item,
        viewOffset = 0,
        viewPosition = 0,
      }: {
        item: T;
        viewOffset?: number;
        viewPosition?: number;
      }) => {
        setIsStickingToBottom(false);
        const index = data.indexOf(item);
        if (index !== -1) {
          const offset = offsets[index];
          if (offset !== undefined) {
            const maxScroll = Math.max(
              0,
              totalHeight - scrollableContainerHeight,
            );
            const newScrollTop = Math.max(
              0,
              Math.min(
                maxScroll,
                offset - viewPosition * scrollableContainerHeight + viewOffset,
              ),
            );
            setPendingScrollTop(newScrollTop);
            setScrollAnchor(getAnchorForScrollTop(newScrollTop, offsets));
          }
        }
      },
      getScrollIndex: () => scrollAnchor.index,
      getScrollState: () => {
        const maxScroll = Math.max(0, totalHeight - scrollableContainerHeight);
        return {
          scrollTop: Math.min(getScrollTop(), maxScroll),
          scrollHeight: totalHeight,
          innerHeight: scrollableContainerHeight,
        };
      },
    }),
    [
      offsets,
      scrollAnchor,
      totalHeight,
      getAnchorForScrollTop,
      data,
      scrollableContainerHeight,
      getScrollTop,
      setPendingScrollTop,
    ],
  );

  const showScrollbar = (props.showScrollbar ?? true) && maxScroll > 0;

  const scrollbarContent = useMemo(() => {
    if (!showScrollbar || scrollableContainerHeight <= 0) return null;
    const trackLen = scrollableContainerHeight;
    const thumbLen = Math.max(
      1,
      Math.round((trackLen * trackLen) / totalHeight),
    );
    const thumbTop = Math.round(
      (clampedScrollTop / maxScroll) * (trackLen - thumbLen),
    );
    return (
      <Box width={1} flexDirection="column" flexShrink={0}>
        {Array.from({ length: trackLen }, (_, i) => {
          const inThumb = i >= thumbTop && i < thumbTop + thumbLen;
          return (
            <Text key={i} dimColor={!inThumb}>
              {inThumb ? '█' : '│'}
            </Text>
          );
        })}
      </Box>
    );
  }, [
    showScrollbar,
    scrollableContainerHeight,
    totalHeight,
    clampedScrollTop,
    maxScroll,
  ]);

  return (
    <Box
      width="100%"
      height={
        props.containerHeight !== undefined ? props.containerHeight : '100%'
      }
      flexDirection="row"
    >
      <Box
        ref={containerRef}
        overflowY="hidden"
        overflowX="hidden"
        flexGrow={1}
        flexDirection="column"
      >
        <Box
          flexShrink={0}
          width="100%"
          flexDirection="column"
          marginTop={-clampedScrollTop}
        >
          <Box height={topSpacerHeight} flexShrink={0} />
          {renderedItems}
          <Box height={bottomSpacerHeight} flexShrink={0} />
        </Box>
      </Box>
      {scrollbarContent}
    </Box>
  );
}

const VirtualizedListWithForwardRef = forwardRef(VirtualizedList) as <T>(
  props: VirtualizedListProps<T> & { ref?: React.Ref<VirtualizedListRef<T>> },
) => React.ReactElement;

export { VirtualizedListWithForwardRef as VirtualizedList };

VirtualizedList.displayName = 'VirtualizedList';
