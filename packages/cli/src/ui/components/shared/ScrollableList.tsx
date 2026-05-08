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
import { Box, type DOMElement } from 'ink';
import { useKeypress, type Key } from '../../hooks/useKeypress.js';
import { keyMatchers, Command } from '../../keyMatchers.js';

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
  const { hasFocus, width } = props;
  const virtualizedListRef = useRef<VirtualizedListRef<T>>(null);
  const containerRef = useRef<DOMElement>(null);

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

  return (
    <Box ref={containerRef} flexGrow={1} flexDirection="column" width={width}>
      <VirtualizedList ref={virtualizedListRef} {...props} />
    </Box>
  );
}

 
const ScrollableListWithForwardRef = forwardRef(ScrollableList) as <T>(
  props: ScrollableListProps<T> & { ref?: React.Ref<ScrollableListRef<T>> },
) => React.ReactElement;

export { ScrollableListWithForwardRef as ScrollableList };
