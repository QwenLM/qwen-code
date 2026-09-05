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
import { useAnimatedScrollbar } from '../../hooks/useAnimatedScrollbar.js';
import { StaticRender } from './StaticRender.js';
import { type DOMElement, Box, Text, useBoxMetrics } from 'ink';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import { measureElementPosition } from '../../utils/measure-element-position.js';

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
  measureAtFullHeight?: boolean;
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
  hitTestScrollbar: (location: { col: number; row: number }) => boolean;
  scrollToScrollbarRow: (row: number) => void;
  getScrollState: () => {
    scrollTop: number;
    scrollHeight: number;
    innerHeight: number;
  };
  getViewportRect: () => {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
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

// First index of the run of coincident offsets containing `index`.
// Cached zero heights make adjacent offsets equal, and findLastLE resolves
// such a run to its LAST item; the scroll anchor and the render window
// start must both resolve to the run's FIRST item, or they desynchronize
// when the cached zeros heal (blank gap / scroll jump on re-expand).
function firstIndexOfOffsetRun(offsets: number[], index: number): number {
  let i = index;
  while (i > 0 && offsets[i - 1] === offsets[i]) {
    i--;
  }
  return i;
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
      // Report zero heights too: a collapsed thought continuation renders
      // nothing (height 0), and skipping the report would leave the cached
      // expanded height in `heights`, inflating totalHeight with a blank gap.
      // Only mounted (in-window) items report, so collapse-all leaves
      // off-screen items' cached heights stale until they scroll back into
      // the window (same as the grow direction).
      const measuredHeight =
        itemRef.current?.yogaNode?.getComputedHeight() ?? height;
      if (hasMeasured) {
        onHeightChangeRef.current(itemKey, measuredHeight);
      }
    }, [itemKey, height, hasMeasured, content]);

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
  const rootRef = useRef<DOMElement>(null);

  const { width: measuredContainerWidth, height: measuredContainerHeight } =
    useBoxMetrics(containerRef as React.RefObject<DOMElement>);

  const containerHeight = props.containerHeight ?? measuredContainerHeight;
  const containerWidth = measuredContainerWidth;

  const [heights, setHeights] = useState<Record<string, number>>({});
  const measureAtFullHeight = props.measureAtFullHeight === true;
  const [fullHeightMeasurementPending, setFullHeightMeasurementPending] =
    useState(measureAtFullHeight);
  const [previousMeasurementInputs, setPreviousMeasurementInputs] = useState({
    enabled: measureAtFullHeight,
    data,
    renderItem,
  });
  if (
    previousMeasurementInputs.enabled !== measureAtFullHeight ||
    (measureAtFullHeight &&
      (previousMeasurementInputs.data !== data ||
        previousMeasurementInputs.renderItem !== renderItem))
  ) {
    setPreviousMeasurementInputs({
      enabled: measureAtFullHeight,
      data,
      renderItem,
    });
    setFullHeightMeasurementPending(measureAtFullHeight);
  }
  const isInitialScrollSet = useRef(false);

  const onHeightChange = useCallback((key: string, height: number) => {
    setHeights((prev) => {
      if (prev[key] === height) return prev;
      return { ...prev, [key]: height };
    });
    setFullHeightMeasurementPending(false);
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
      const found = findLastLE(offsets, scrollTop);
      if (found === -1) {
        return { index: 0, offset: 0 };
      }
      const index = firstIndexOfOffsetRun(offsets, found);
      return { index, offset: scrollTop - offsets[index] };
    },
    [],
  );

  const [prevTargetScrollIndex, setPrevTargetScrollIndex] = useState(
    props.targetScrollIndex,
  );
  // Seeded unusable so the first render with usable offsets re-walks the
  // mount-time targetScrollIndex anchor like every other anchor path;
  // seeding with offsets.length would leave an initial anchor inside a
  // coincident-offset run uncorrected.
  const prevOffsetsLength = useRef(1);

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
      // Clamp before the walk-back: for an out-of-range index both sides
      // of the comparison read undefined (undefined === undefined), so the
      // walk would decrement through the whole hole — a render-phase
      // freeze when target is the SCROLL_TO_ITEM_END sentinel.
      const anchoredIndex = firstIndexOfOffsetRun(
        offsets,
        Math.max(0, Math.min(data.length - 1, target)),
      );
      if (scrollAnchor.index !== anchoredIndex || scrollAnchor.offset !== 0) {
        setScrollAnchor({ index: anchoredIndex, offset: 0 });
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
  // Set by the re-anchor branch when it clamps a scrolled-away viewport to
  // the new bottom, holding the anchor the clamp installed. While the
  // current anchor still sits where the clamp parked it, that position is
  // content-driven, so the re-stick gate must not read it as the user
  // having scrolled to the bottom. Any scroll moves the anchor, and the
  // mismatch clears the mark. The mark deliberately carries no item key:
  // pending items re-key on commit and the banner key is constant, so a
  // key comparison cleared (or kept) the mark for the wrong reasons while
  // the user still sat at the parked position (#9305 review R18-1).
  // Dataset swaps (/clear, /resume) never reach the mark because
  // MainContent keys the list by session and remounts it. `allowFollow`
  // records whether the park landed in a live multi-item conversation,
  // where growth may re-engage follow from a live-bottom park; a
  // banner-only remnant must stay released (#9305 reviews R6-2, R17-1).
  const reAnchorClampMark = useRef<{
    index: number;
    offset: number;
    allowFollow: boolean;
  } | null>(null);

  useLayoutEffect(() => {
    const contentPreviouslyFit =
      prevTotalHeight.current <= prevContainerHeight.current;
    const prevMaxScroll = prevTotalHeight.current - prevContainerHeight.current;
    // The -1 tolerance must not span the whole scroll range: a viewport
    // parked at the TOP of a one-row range would otherwise read as "at the
    // bottom pixels" and yank the first growth to END (#9305 review R11-4).
    const wasScrolledToBottomPixels =
      prevMaxScroll > 1 && prevScrollTop.current >= prevMaxScroll - 1;
    const wasAtBottom = contentPreviouslyFit || wasScrolledToBottomPixels;

    // Fitting alone is not a bottom signal for re-sticking: a top-anchored
    // mount (initialScrollIndex 0, e.g. the banner-only VP session) fits
    // too, and flipping sticking there would let `bottomAlignGap`
    // bottom-align content the host anchored to the top (#9300). Re-stick
    // only from a real bottom position: previously overflowing with the
    // viewport at the bottom pixels. A position installed by the re-anchor
    // clamp is not a user-driven bottom either (#9305): suppress the flip
    // while the anchor still matches the clamp mark.
    const clampMark = reAnchorClampMark.current;
    const clampParked =
      clampMark !== null &&
      data[clampMark.index] !== undefined &&
      scrollAnchor.index === clampMark.index &&
      scrollAnchor.offset === clampMark.offset;
    if (clampMark !== null && !clampParked) {
      reAnchorClampMark.current = null;
    }
    if (
      !clampParked &&
      !contentPreviouslyFit &&
      wasScrolledToBottomPixels &&
      actualScrollTop >= prevScrollTop.current
    ) {
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
      // The clamp-parked position is content-driven, not the user being at
      // the bottom, so growth must not auto-follow from it (#9305 review
      // R6-2) — except a parked state that previously fit crossing into
      // overflow by any shape: length growth, in-place height growth, or a
      // container shrink. While the content fit, the user could see
      // everything, so follow must come back once it overflows instead of
      // content rendering below the fold (#9305 reviews R11-6, R14-1). A
      // park at the live bottom of a multi-item remnant re-engages on
      // growth too: it IS the bottom of a live conversation, and the mark
      // would otherwise suppress follow forever (#9305 review R18-1).
      // Banner-only remnants never cross back: there is no conversation to
      // follow (#9305 review R17-1).
      ((listGrew && (isStickingToBottom || (wasAtBottom && !clampParked))) ||
        (clampParked &&
          contentPreviouslyFit &&
          data.length > 1 &&
          totalHeight > scrollableContainerHeight) ||
        (clampMark !== null &&
          clampParked &&
          clampMark.allowFollow &&
          wasScrolledToBottomPixels &&
          totalHeight > prevTotalHeight.current) ||
        // A shrink landing in the same render must reach the drop/re-anchor
        // branch below, not be preempted here on the stale render-time
        // sticking flag (#9305 review R11-1).
        (isStickingToBottom &&
          containerChanged &&
          data.length >= prevDataLength.current))
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
      const droppingSticking = data.length <= 1 && isStickingToBottom;
      if (droppingSticking) {
        // Collapse to the host's non-end-anchored state (MainContent mounts
        // banner-only data with initialScrollIndex 0, e.g. after /clear):
        // the followed conversation is gone, so drop the carried sticking
        // instead of bottom-aligning the remnant under a blank viewport.
        setIsStickingToBottom(false);
      }
      const newScrollTop = Math.max(0, totalHeight - scrollableContainerHeight);
      const newAnchor = getAnchorForScrollTop(newScrollTop, offsets);
      if (
        scrollAnchor.index !== newAnchor.index ||
        scrollAnchor.offset !== newAnchor.offset
      ) {
        // Install the mark on the drop render too: isStickingToBottom is the
        // stale render-time flag (the drop only queued its update), and
        // without the mark the next effect trigger re-sticks from the parked
        // position before the release is visible here (#9305 review R6-1).
        // While the remnant overflows, always install it — a scroll can move
        // the anchor off the mark and end the suppression. A fitting remnant
        // keeps it only through the released arm and only when real content
        // remains: that park must not re-stick on the next trigger (#9305
        // review R5-3). A fitting banner-only remnant gets no mark on either
        // arm: while content fits, nothing can move the anchor off a mark,
        // so one installed at rest reads as clampParked forever and kills
        // growth auto-follow, defending nothing — the re-stick gate is
        // already blocked by `!contentPreviouslyFit` (#9305 reviews R8-1,
        // R10-1). An out-of-range carried anchor with a multi-item remnant
        // is a truncation below the anchor (dataset swaps remount the list
        // by session key, #9305 review R18-1): the park lands on content
        // the user never scrolled, and a mark there would keep follow dead;
        // the banner-only collapse keeps its mark (#9305 review R17-2).
        const swapEntry = scrollAnchor.index >= data.length && data.length > 1;
        const markItem = data[newAnchor.index];
        if (
          markItem !== undefined &&
          ((newScrollTop > 0 && !swapEntry) ||
            (newScrollTop === 0 && !isStickingToBottom && data.length > 1))
        ) {
          reAnchorClampMark.current = {
            index: newAnchor.index,
            offset: newAnchor.offset,
            allowFollow: data.length > 1,
          };
        }
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
    data,
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

  // Clamp for marginTop: can't be negative or exceed total - container
  const maxScroll = Math.max(0, totalHeight - scrollableContainerHeight);
  const clampedScrollTop = Math.min(
    Math.max(0, isStickingToBottom ? maxScroll : actualScrollTop),
    maxScroll,
  );

  // Bottom-align short content while stuck to the bottom (#9300): when the
  // whole conversation fits in the viewport, push it down so the latest
  // message sits directly above the composer and any blank space is at the
  // TOP (standard chat-TUI behavior), instead of top-aligning and leaving a
  // gap between the last message and the composer. Zero whenever content
  // overflows (maxScroll > 0) or the user has scrolled away from the bottom.
  const bottomAlignGap =
    isStickingToBottom && maxScroll === 0
      ? Math.max(0, scrollableContainerHeight - totalHeight)
      : 0;

  // The render window must cover what the viewport actually paints, so
  // it is computed from clampedScrollTop, not the anchor-based
  // actualScrollTop. While bottom-stuck the viewport pins to maxScroll,
  // but the anchor can sit far above it (e.g. {0, 0} after a collapse
  // cascade shrank the content and re-engaged sticking); windowing
  // around the anchor then leaves the visible bottom rows unmounted and
  // paints a fully blank frame that only a scroll heals.
  const startIndex = firstIndexOfOffsetRun(
    offsets,
    Math.max(0, findLastLE(offsets, clampedScrollTop) - 1),
  );
  const viewHeightForEndIndex =
    scrollableContainerHeight > 0 ? scrollableContainerHeight : 50;
  const endIndexOffsetRaw = upperBound(
    offsets,
    clampedScrollTop + viewHeightForEndIndex,
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

  // Surface the "blank viewport because not ready" failure mode in the
  // debug log so users with `--debug` can diagnose tiny-terminal or
  // resize-race blank screens instead of seeing nothing. The guard
  // above intentionally returns []; the warning is the only signal.
  if (!isReady) {
    debugLogger.debug(
      `viewport not ready (containerHeight=${containerHeight}, width=${String(width)}); rendering empty until measurement settles`,
    );
  }

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

  const getScrollbarGeometry = useCallback(() => {
    const shouldShowScrollbar = (props.showScrollbar ?? true) && maxScroll > 0;
    if (
      !shouldShowScrollbar ||
      !rootRef.current ||
      scrollableContainerHeight <= 0
    ) {
      return null;
    }

    const metrics = measureElementPosition(rootRef.current);
    if (metrics.width <= 0 || metrics.height <= 0) return null;

    return {
      col: metrics.x + metrics.width - 1,
      top: metrics.y,
      height: scrollableContainerHeight,
    };
  }, [props.showScrollbar, maxScroll, scrollableContainerHeight]);

  const hitTestScrollbar = useCallback(
    ({ col, row }: { col: number; row: number }) => {
      const geometry = getScrollbarGeometry();
      if (!geometry) return false;

      const zeroBasedCol = col - 1;
      const zeroBasedRow = row - 1;
      return (
        zeroBasedCol === geometry.col &&
        zeroBasedRow >= geometry.top &&
        zeroBasedRow < geometry.top + geometry.height
      );
    },
    [getScrollbarGeometry],
  );

  const scrollToScrollbarRow = useCallback(
    (row: number) => {
      const geometry = getScrollbarGeometry();
      if (!geometry) return;

      const zeroBasedRow = row - 1;
      const rowInTrack = Math.max(
        0,
        Math.min(geometry.height - 1, zeroBasedRow - geometry.top),
      );
      const scrollRatio = rowInTrack / Math.max(1, geometry.height - 1);
      const newScrollTop = Math.round(scrollRatio * maxScroll);
      if (newScrollTop >= maxScroll) {
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
        setPendingScrollTop(newScrollTop);
        setScrollAnchor(getAnchorForScrollTop(newScrollTop, offsets));
      }
    },
    [
      data.length,
      getAnchorForScrollTop,
      getScrollbarGeometry,
      maxScroll,
      offsets,
      setPendingScrollTop,
    ],
  );

  useImperativeHandle(
    ref,
    () => ({
      scrollBy: (delta: number) => {
        const maxScroll = Math.max(0, totalHeight - scrollableContainerHeight);
        if (maxScroll === 0) {
          // Nothing to scroll: the attempt is positionally a no-op and must
          // not flip sticking either way. Engaging it would bottom-align a
          // top-anchored list whose content fits; releasing it would drop a
          // stuck conversation's auto-follow.
          return;
        }
        if (delta < 0) {
          setIsStickingToBottom(false);
        }
        const currentScrollTop = getScrollTop();
        const actualCurrent = Math.min(currentScrollTop, maxScroll);
        const newScrollTop = Math.max(0, actualCurrent + delta);
        // Reaching the bottom must use the same live-recomputing end anchor as
        // scrollTo/scrollToEnd ({ index: last, offset: SCROLL_TO_ITEM_END }).
        // A fixed getAnchorForScrollTop(maxScroll) anchor would not track the
        // last item growing during streaming, so keyboard scroll-to-bottom
        // would lag behind new tokens.
        if (newScrollTop >= maxScroll) {
          setIsStickingToBottom(true);
          setPendingScrollTop(Number.MAX_SAFE_INTEGER);
          if (data.length > 0) {
            setScrollAnchor({
              index: data.length - 1,
              offset: SCROLL_TO_ITEM_END,
            });
          }
          return;
        }
        setPendingScrollTop(newScrollTop);
        setScrollAnchor(getAnchorForScrollTop(newScrollTop, offsets));
      },
      scrollTo: (offset: number) => {
        const maxScroll = Math.max(0, totalHeight - scrollableContainerHeight);
        if (maxScroll === 0) {
          // Same no-op rule as scrollBy: a scroll attempt on fitting content
          // must not flip sticking either way.
          return;
        }
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
        const maxScroll = Math.max(0, totalHeight - scrollableContainerHeight);
        if (maxScroll === 0) {
          // Same no-op rule as scrollBy/scrollTo: a scroll attempt on
          // fitting content must not flip sticking either way.
          return;
        }
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
      hitTestScrollbar,
      scrollToScrollbarRow,
      getScrollIndex: () => scrollAnchor.index,
      getScrollState: () => {
        const maxScroll = Math.max(0, totalHeight - scrollableContainerHeight);
        return {
          scrollTop: Math.min(getScrollTop(), maxScroll),
          scrollHeight: totalHeight,
          innerHeight: scrollableContainerHeight,
        };
      },
      getViewportRect: () =>
        rootRef.current ? measureElementPosition(rootRef.current) : null,
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
      hitTestScrollbar,
      scrollToScrollbarRow,
    ],
  );

  const showScrollbar = (props.showScrollbar ?? true) && maxScroll > 0;

  // Animated scrollbar: the thumb glyph pops bright on scroll, then
  // fades back into the dim track after a short idle. The track column
  // itself stays in the layout regardless, so the viewport width never
  // reflows (which would force per-item re-measure + a visible jitter).
  const { isVisible: scrollbarThumbActive, flashScrollbar } =
    useAnimatedScrollbar();

  // `clampedScrollTop` updates on every scroll-driven recompute, so a
  // layout-effect keyed on it is the cheapest "the user just scrolled"
  // signal we have. Skip the very first commit (no scroll happened) so
  // we don't paint a flash on initial mount.
  const isInitialScrollFlash = useRef(true);
  useLayoutEffect(() => {
    if (isInitialScrollFlash.current) {
      isInitialScrollFlash.current = false;
      return;
    }
    flashScrollbar();
  }, [clampedScrollTop, flashScrollbar]);

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
          // Overlay-style auto-hide: while idle (no recent scroll) the whole
          // bar renders as blank cells so it doesn't sit permanently in the
          // gutter competing with the conversation. On scroll it pops in —
          // bright `█` thumb over a dim `│` track — then fades back to blank
          // after the idle window. The column keeps width 1 in all states, so
          // the viewport never reflows (which would force a per-item
          // re-measure + visible jitter).
          if (!scrollbarThumbActive) {
            return (
              <Text key={i} selectable={false}>
                {' '}
              </Text>
            );
          }
          return (
            <Text key={i} dimColor={!inThumb} selectable={false}>
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
    scrollbarThumbActive,
  ]);

  // The host passes `containerHeight` as the *maximum* viewport height (the
  // room available between the header and the composer). While the list is
  // not bottom-aligned, collapse to `totalHeight` whenever the content fits:
  // pinning the root box to the full height unconditionally would leave a
  // tall empty gap below short content and push the composer far down the
  // screen, while the legacy <Static> path grows with its content. While a
  // bottom-stuck conversation has room to spare (#9300), keep the full
  // `containerHeight` instead so `bottomAlignGap` can push it down: the
  // blank rows render ABOVE the content and the latest message sits right
  // above the composer. A caller can request one full-height measurement
  // pass while content changes shape under a stable item key; otherwise a
  // stale cached total can clip the new content before it is measured. The
  // collapse/bottom-align rule above applies again after the measurement.
  // `scrollableContainerHeight` (the scroll math) still uses the full
  // `containerHeight`, so scrolling is unaffected.
  const rootHeight =
    props.containerHeight !== undefined
      ? fullHeightMeasurementPending || bottomAlignGap > 0
        ? props.containerHeight
        : Math.min(props.containerHeight, totalHeight)
      : '100%';

  return (
    <Box ref={rootRef} width="100%" height={rootHeight} flexDirection="row">
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
          <Box height={bottomAlignGap} flexShrink={0} />
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
