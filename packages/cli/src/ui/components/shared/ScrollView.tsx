/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Box, Text } from 'ink';
import Yoga from 'yoga-layout';
import type { DOMElement } from 'ink';
import { theme } from '../../semantic-colors.js';

type ScrollStickMode = 'top' | 'bottom';

interface ScrollViewProps<T> {
  height: number;
  width?: number;
  data: readonly T[];
  renderItem: (item: T, index: number) => React.ReactElement;
  getItemKey?: (item: T, index: number) => React.Key;
  stickTo?: ScrollStickMode;
  /**
   * Optional renderer for the overflow indicator.
   * Receives the number of hidden items.
   */
  renderOverflowIndicator?: (hiddenCount: number) => React.ReactNode;
}

interface ScrollState {
  startIndex: number;
  hiddenCount: number;
}

const getClientHeight = (node: DOMElement | null): number => {
  const yogaNode = node?.yogaNode;
  if (!yogaNode) {
    return 0;
  }

  const height = yogaNode.getComputedHeight() ?? 0;
  const borderTop = yogaNode.getComputedBorder(Yoga.EDGE_TOP);
  const borderBottom = yogaNode.getComputedBorder(Yoga.EDGE_BOTTOM);
  return Math.max(0, height - borderTop - borderBottom);
};

const getScrollHeight = (node: DOMElement | null): number => {
  const yogaNode = node?.yogaNode;
  if (!yogaNode) {
    return 0;
  }

  const topBorder = yogaNode.getComputedBorder(Yoga.EDGE_TOP);
  let maxBottom = topBorder;

  for (let index = 0; index < yogaNode.getChildCount(); index++) {
    const child = yogaNode.getChild(index);
    const childBottom =
      child.getComputedTop() +
      child.getComputedHeight() +
      child.getComputedMargin(Yoga.EDGE_BOTTOM);
    if (childBottom > maxBottom) {
      maxBottom = childBottom;
    }
  }

  return maxBottom - topBorder + yogaNode.getComputedPadding(Yoga.EDGE_BOTTOM);
};

const collectChildBottoms = (node: DOMElement | null): number[] => {
  const yogaNode = node?.yogaNode;
  if (!yogaNode) {
    return [];
  }

  const bottoms: number[] = [];
  for (let index = 0; index < yogaNode.getChildCount(); index++) {
    const child = yogaNode.getChild(index);
    const bottom =
      child.getComputedTop() +
      child.getComputedHeight() +
      child.getComputedMargin(Yoga.EDGE_BOTTOM);
    bottoms.push(bottom);
  }
  return bottoms;
};

const defaultIndicator = (hiddenCount: number) => {
  if (hiddenCount <= 0) {
    return null;
  }

  return (
    <Box>
      <Text color={theme.text.secondary} wrap="truncate">
        ↑ {hiddenCount} hidden item{hiddenCount === 1 ? '' : 's'}
      </Text>
    </Box>
  );
};

export function ScrollView<T>({
  height,
  width,
  data,
  renderItem,
  getItemKey,
  stickTo = 'bottom',
  renderOverflowIndicator,
}: ScrollViewProps<T>) {
  const viewportRef = useRef<DOMElement>(null);
  const contentRef = useRef<DOMElement>(null);

  const [scrollState, setScrollState] = useState<ScrollState | null>(null);

  const indicatorRenderer = renderOverflowIndicator ?? defaultIndicator;

  useEffect(() => {
    // Reset scroll state whenever the data set or height changes so that we
    // re-measure with the full set of rows.
    setScrollState(null);
  }, [data, height]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;

    if (!viewport || !content) {
      if (scrollState !== null) {
        setScrollState(null);
      }
      return;
    }

    const clientHeight = getClientHeight(viewport);
    const scrollHeight = getScrollHeight(content);
    const childBottoms = collectChildBottoms(content);

    if (childBottoms.length === 0 || clientHeight <= 0) {
      if (scrollState !== null) {
        setScrollState(null);
      }
      return;
    }

    const hasOverflow = scrollHeight > clientHeight;

    if (!hasOverflow) {
      if (scrollState !== null) {
        setScrollState(null);
      }
      return;
    }

    const targetTop = Math.max(0, scrollHeight - clientHeight);

    let startIndex = 0;
    if (stickTo === 'bottom') {
      for (let index = 0; index < childBottoms.length; index++) {
        if (childBottoms[index] <= targetTop) {
          startIndex = index + 1;
        } else {
          break;
        }
      }
    }

    startIndex = Math.min(startIndex, data.length - 1);

    if (
      scrollState?.startIndex === startIndex &&
      scrollState.hiddenCount === startIndex
    ) {
      return;
    }

    setScrollState({
      startIndex,
      hiddenCount: startIndex,
    });
  }, [data, stickTo, scrollState, height]);

  const visibleItems = useMemo(() => {
    if (!scrollState) {
      return data;
    }

    return data.slice(scrollState.startIndex);
  }, [data, scrollState]);

  const renderedItems = useMemo(
    () =>
      visibleItems.map((item, index) => {
        const absoluteIndex = scrollState
          ? scrollState.startIndex + index
          : index;
        const key = getItemKey?.(item, absoluteIndex) ?? absoluteIndex;
        const element = renderItem(item, absoluteIndex);
        return React.cloneElement(element, { key });
      }),
    [visibleItems, renderItem, getItemKey, scrollState],
  );

  return (
    <Box
      ref={viewportRef}
      flexDirection="column"
      height={height}
      width={width}
      overflow="hidden"
    >
      {scrollState && indicatorRenderer(scrollState.hiddenCount)}
      <Box ref={contentRef} flexDirection="column">
        {renderedItems}
      </Box>
    </Box>
  );
}
