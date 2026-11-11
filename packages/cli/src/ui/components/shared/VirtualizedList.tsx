/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
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
import { theme } from '../../semantic-colors.js';
import { useBatchedScroll } from '../../hooks/useBatchedScroll.js';

import { type DOMElement, Box, StaticRender,
  useAfterLayout,
  AFTER_LAYOUT_PRIORITY,
} from 'ink';

export const SCROLL_TO_ITEM_END = Number.MAX_SAFE_INTEGER;

export type VirtualizedListProps<T> = {
  data: T[];
  renderItem: (info: { item: T; index: number }) => React.ReactElement;
  estimatedItemHeight: (index: number) => number;
  keyExtractor: (item: T, index: number) => string;
  initialScrollIndex?: number;
  initialScrollOffsetInIndex?: number;
  targetScrollIndex?: number;
  backgroundColor?: string;
  scrollbarThumbColor?: string;
  renderStatic?: boolean;
  isStatic?: boolean;
  isStaticItem?: (item: T, index: number) => boolean;
  width?: number | string;
  overflowToBackbuffer?: boolean;
  scrollbar?: boolean;
  stableScrollback?: boolean;
  fixedItemHeight?: boolean;
  containerHeight?: number;
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

function findLastIndex<T>(
  array: T[],
  predicate: (value: T, index: number, obj: T[]) => unknown,
): number {
  for (let i = array.length - 1; i >= 0; i--) {
    if (predicate(array[i], i, array)) {
      return i;
    }
  }
  return -1;
}

const VirtualizedListItem = memo(
  ({
    content,
    shouldBeStatic,
    width,
    containerWidth,
    itemKey,
    index,
    onSetRef,
  }: {
    content: React.ReactElement;
    shouldBeStatic: boolean;
    width: number | string | undefined;
    containerWidth: number;
    itemKey: string;
    index: number;
    onSetRef: (index: number, el: DOMElement | null) => void;
  }) => {
    const itemRef = useCallback(
      (el: DOMElement | null) => {
        onSetRef(index, el);
      },
      [index, onSetRef],
    );

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
    isStatic,
    isStaticItem,
    width,
    overflowToBackbuffer,
    scrollbar = true,
    stableScrollback,
    fixedItemHeight = false,
  } = props;
  const dataRef = useRef(data);
  useLayoutEffect(() => {
    dataRef.current = data;
  }, [data]);

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
      // NOTE: When targetScrollIndex is specified, we rely on the component
      // correctly tracking targetScrollIndex instead of initialScrollIndex.
      // We set isInitialScrollSet.current = true inside the second layout effect
      // to avoid it overwriting the targetScrollIndex.
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

  const containerRef = useRef<DOMElement | null>(null);
  const itemRefs = useRef<Array<DOMElement | null>>([]);
  const isInitialScrollSet = useRef(false);

  // Phase 2: ref-based height measurement — no ResizeObserver, no cascading setState.
  // yogaNode heights are always fresh by the time useLayoutEffect fires
  // (resetAfterCommit → onComputeLayout() sync Yoga BEFORE commit effects).
  const containerHeightRef = useRef(0);
  const containerWidthRef = useRef(0);
  const heightCache = useRef(new Map<string, number>());
  const [measureVersion, setMeasureVersion] = useState(0);

  // Phase 3: resize cascade prevention
  const prevColumnsRef = useRef(0);
  const skipMeasurementRef = useRef(false);
  const freezeRendersRef = useRef(0);

  const onSetRef = useCallback((index: number, el: DOMElement | null) => {
    itemRefs.current[index] = el;
  }, []);

  const containerRefCallback = useCallback((node: DOMElement | null) => {
    containerRef.current = node;
  }, []);

  const { totalHeight, offsets } = useMemo(() => {
    const offsets: number[] = [0];
    let totalHeight = 0;
    for (let i = 0; i < data.length; i++) {
      const key = keyExtractor(data[i], i);
      const height = heightCache.current.get(key) ?? estimatedItemHeight(i);
      totalHeight += height;
      offsets.push(totalHeight);
    }
    return { totalHeight, offsets };
    // measureVersion ensures recalc when heightCache changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measureVersion, data, estimatedItemHeight, keyExtractor]);

  const containerWidth = containerWidthRef.current;
  const scrollableContainerHeight =
    props.containerHeight ?? containerHeightRef.current;

  const getAnchorForScrollTop = useCallback(
    (
      scrollTop: number,
      offsets: number[],
    ): { index: number; offset: number } => {
      const index = findLastIndex(offsets, (offset) => offset <= scrollTop);
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

  // NOTE: If targetScrollIndex is provided, and we haven't rendered items yet (offsets.length <= 1),
  // we do NOT set scrollAnchor yet, because actualScrollTop wouldn't know the real offset!
  // We wait until offsets populate.
  if (
    (props.targetScrollIndex !== undefined &&
      props.targetScrollIndex !== prevTargetScrollIndex &&
      offsets.length > 1) ||
    (props.targetScrollIndex !== undefined &&
      prevOffsetsLength.current <= 1 &&
      offsets.length > 1)
  ) {
    if (props.targetScrollIndex !== prevTargetScrollIndex) {
      setPrevTargetScrollIndex(props.targetScrollIndex);
    }
    prevOffsetsLength.current = offsets.length;
    setIsStickingToBottom(false);
    setScrollAnchor({ index: props.targetScrollIndex, offset: 0 });
  } else {
    prevOffsetsLength.current = offsets.length;
  }

  const actualScrollTop = useMemo(() => {
    const offset = offsets[scrollAnchor.index];
    if (typeof offset !== 'number') {
      return 0;
    }

    if (scrollAnchor.offset === SCROLL_TO_ITEM_END) {
      const item = data[scrollAnchor.index];
      const key = item ? keyExtractor(item, scrollAnchor.index) : '';
      const measuredHeight = heightCache.current.get(key);
      // If the item height hasn't been measured yet,
      // fall back to the estimated height instead of 0 to prevent
      // actualScrollTop from computing a large negative value (which gets
      // clamped to 0 and causes the view to jump to the top).
      const itemHeight =
        measuredHeight ?? estimatedItemHeight(scrollAnchor.index);
      return offset + itemHeight - scrollableContainerHeight;
    }

    return offset + scrollAnchor.offset;
    // measureVersion is intentionally included to recompute when heights change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    scrollAnchor,
    offsets,
    measureVersion,
    scrollableContainerHeight,
    data,
    keyExtractor,
    estimatedItemHeight,
  ]);

  const scrollTop = isStickingToBottom
    ? Number.MAX_SAFE_INTEGER
    : actualScrollTop;

  const prevDataLength = useRef(data.length);
  const prevTotalHeight = useRef(totalHeight);
  const prevScrollTop = useRef(actualScrollTop);
  const prevContainerHeight = useRef(scrollableContainerHeight);

  // Refs to read current scroll-anchor & sticking state *without* making
  // them useLayoutEffect dependencies.  The effect below writes both of
  // these — having them as deps caused a self-triggering loop:
  //   effect fires → setScrollAnchor → dep changes → effect fires → …
  const scrollAnchorRef = useRef(scrollAnchor);
  scrollAnchorRef.current = scrollAnchor;
  const isStickingToBottomRef = useRef(isStickingToBottom);
  isStickingToBottomRef.current = isStickingToBottom;

  useLayoutEffect(() => {
    const curAnchor = scrollAnchorRef.current;
    const curSticking = isStickingToBottomRef.current;
    const contentPreviouslyFit =
      prevTotalHeight.current <= prevContainerHeight.current;
    const maxScrollPrev = prevTotalHeight.current - prevContainerHeight.current;
    const wasScrolledToBottomPixels =
      maxScrollPrev <= 0 || prevScrollTop.current >= maxScrollPrev - 2;
    const wasAtBottom = contentPreviouslyFit || wasScrolledToBottomPixels;
    const listGrew = data.length > prevDataLength.current;

    // Only re-engage stickToBottom when content previously fit entirely
    // in the container or when new items were added. This prevents false
    // re-engagement when height measurement updates item heights (which would
    // cause the scroll position to jump to the bottom unexpectedly).
    if (
      wasAtBottom &&
      (contentPreviouslyFit || listGrew) &&
      actualScrollTop >= prevScrollTop.current
    ) {
      if (!curSticking) {
        setIsStickingToBottom(true);
      }
    }

    const containerChanged =
      prevContainerHeight.current !== scrollableContainerHeight;

    // If targetScrollIndex is provided, we NEVER auto-snap to the bottom
    // because the parent is explicitly managing the scroll position.
    const shouldAutoScroll = props.targetScrollIndex === undefined;

    if (
      shouldAutoScroll &&
      ((listGrew && (curSticking || wasAtBottom)) ||
        (curSticking && containerChanged))
    ) {
      const newIndex = data.length > 0 ? data.length - 1 : 0;
      if (
        curAnchor.index !== newIndex ||
        curAnchor.offset !== SCROLL_TO_ITEM_END
      ) {
        setScrollAnchor({
          index: newIndex,
          offset: SCROLL_TO_ITEM_END,
        });
      }
      if (!curSticking) {
        setIsStickingToBottom(true);
      }
    } else if (
      (curAnchor.index >= data.length ||
        actualScrollTop > totalHeight - scrollableContainerHeight) &&
      data.length > 0
    ) {
      // We still clamp the scroll top if it's completely out of bounds
      const newScrollTop = Math.max(0, totalHeight - scrollableContainerHeight);
      const newAnchor = getAnchorForScrollTop(newScrollTop, offsets);
      if (
        curAnchor.index !== newAnchor.index ||
        curAnchor.offset !== newAnchor.offset
      ) {
        setScrollAnchor(newAnchor);
      }
    } else if (data.length === 0) {
      if (curAnchor.index !== 0 || curAnchor.offset !== 0) {
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
    // REMOVED: scrollAnchor.index, scrollAnchor.offset, isStickingToBottom
    // — these are read via refs to break the self-triggering loop.
    getAnchorForScrollTop,
    offsets,
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
      // If we are strictly driving from targetScrollIndex, do not apply initialScrollIndex
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
    props.targetScrollIndex,
  ]);

  const startIndex = Math.max(
    0,
    findLastIndex(offsets, (offset) => offset <= actualScrollTop) - 1,
  );
  const viewHeightForEndIndex =
    scrollableContainerHeight > 0 ? scrollableContainerHeight : 50;
  const endIndexOffset = offsets.findIndex(
    (offset) => offset > actualScrollTop + viewHeightForEndIndex,
  );
  const endIndex =
    endIndexOffset === -1
      ? data.length - 1
      : Math.min(data.length - 1, endIndexOffset);

  const topSpacerHeight =
    renderStatic === true || overflowToBackbuffer === true
      ? 0
      : (offsets[startIndex] ?? 0);
  const bottomSpacerHeight = renderStatic
    ? 0
    : totalHeight - (offsets[endIndex + 1] ?? totalHeight);

  // Phase 3: detect column width change and scale cached heights proportionally
  // to prevent massive mount/unmount churn during terminal resize.
  const currentWidth = containerWidthRef.current;
  if (
    prevColumnsRef.current > 0 &&
    prevColumnsRef.current !== currentWidth &&
    currentWidth > 0
  ) {
    const ratio = prevColumnsRef.current / currentWidth;
    for (const [k, h] of heightCache.current) {
      heightCache.current.set(k, Math.max(1, Math.round(h * ratio)));
    }
    skipMeasurementRef.current = true;
    freezeRendersRef.current = 2;
  }
  prevColumnsRef.current = currentWidth;

  const renderRangeStart =
    renderStatic || overflowToBackbuffer ? 0 : startIndex;
  const renderRangeEnd = renderStatic ? data.length - 1 : endIndex;

  // Phase 2: every frame in which this list committed — read container +
  // item yogaNode heights directly, right after the frame's Yoga pass.
  // Priority 'items': depends on the container geometry measured before it.
  useAfterLayout(() => {
    // Container measurement
    const containerNode = containerRef.current;
    let containerChanged = false;
    if (containerNode?.yogaNode) {
      const h = containerNode.yogaNode.getComputedHeight();
      const w = containerNode.yogaNode.getComputedWidth();
      if (h > 0 && h !== containerHeightRef.current) {
        containerHeightRef.current = h;
        containerChanged = true;
      }
      if (w > 0 && w !== containerWidthRef.current) {
        containerWidthRef.current = w;
        containerChanged = true;
      }
    }

    // Item height measurement (skip if Phase 3 freeze is active)
    if (skipMeasurementRef.current) {
      skipMeasurementRef.current = false;
      if (containerChanged) {
        setMeasureVersion((v) => v + 1);
      }
      return;
    }

    if (isStatic || fixedItemHeight) {
      if (containerChanged) {
        setMeasureVersion((v) => v + 1);
      }
      return;
    }

    let anyItemChanged = false;
    const measureStart = renderStatic || overflowToBackbuffer ? 0 : startIndex;
    const measureEnd = renderStatic ? data.length - 1 : endIndex;

    for (let i = measureStart; i <= measureEnd; i++) {
      const node = itemRefs.current[i];
      if (!node?.yogaNode) continue;
      const h = node.yogaNode.getComputedHeight();
      const item = data[i];
      if (!item) continue;
      const key = keyExtractor(item, i);
      const prev = heightCache.current.get(key);
      if (h > 0 && prev !== h) {
        heightCache.current.set(key, h);
        anyItemChanged = true;
      } else if (
        h === 0 &&
        node.yogaNode.getComputedWidth() > 0 &&
        prev !== 0
      ) {
        heightCache.current.set(key, 0);
        anyItemChanged = true;
      }
    }

    if (containerChanged || anyItemChanged) {
      setMeasureVersion((v) => v + 1);
    }
  }, AFTER_LAYOUT_PRIORITY.items);

  // Phase 3: freeze mount range for 2 frames after resize to avoid churn
  if (freezeRendersRef.current > 0) {
    freezeRendersRef.current--;
  }

  // Always evaluate shouldBeStatic, width, etc. if we have a known width from the prop.
  // If containerHeight or containerWidth is 0 we defer rendering unless a static render or defined width overrides.
  // Wait, if it's not static and no width we need to wait for measure.
  // BUT the initial render MUST render *something* with a width if width prop is provided to avoid layout shifts.
  // We MUST wait for containerHeight > 0 before rendering, especially if renderStatic is true.
  // If containerHeight is 0, we will misclassify items as isOutsideViewport and permanently print them to StaticRender!
  const isReady =
    scrollableContainerHeight > 0 ||
    process.env['NODE_ENV'] === 'test' ||
    (width !== undefined && typeof width === 'number');

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

        const content = renderItem({ item, index: i });
        const key = keyExtractor(item, i);

        items.push(
          <VirtualizedListItem
            key={key}
            itemKey={key}
            content={content}
            shouldBeStatic={shouldBeStatic}
            width={width}
            containerWidth={containerWidth}
            index={i}
            onSetRef={onSetRef}
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
    onSetRef,
  ]);

  const { getScrollTop, setPendingScrollTop } = useBatchedScroll(scrollTop);

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

  return (
    <Box
      ref={containerRefCallback}
      overflowY="scroll"
      overflowX="hidden"
      scrollTop={scrollTop}
      scrollbarThumbColor={props.scrollbarThumbColor ?? theme.text.secondary}
      backgroundColor={props.backgroundColor}
      width="100%"
      height="100%"
      flexDirection="column"
      paddingRight={scrollbar ? 1 : 0}
      overflowToBackbuffer={overflowToBackbuffer}
      scrollbar={scrollbar}
      stableScrollback={stableScrollback}
    >
      <Box
        flexShrink={0}
        width="100%"
        flexDirection="column"
      >
        <Box height={topSpacerHeight} flexShrink={0} />
        {renderedItems}
        <Box height={bottomSpacerHeight} flexShrink={0} />
      </Box>
    </Box>
  );
}

const VirtualizedListWithForwardRef = forwardRef(VirtualizedList) as <T>(
  props: VirtualizedListProps<T> & { ref?: React.Ref<VirtualizedListRef<T>> },
) => React.ReactElement;

export { VirtualizedListWithForwardRef as VirtualizedList };

VirtualizedList.displayName = 'VirtualizedList';
