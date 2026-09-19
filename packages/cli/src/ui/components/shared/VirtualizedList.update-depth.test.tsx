/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, createContext, Profiler, useContext, useState } from 'react';
import type { RefObject } from 'react';
import { render } from 'ink-testing-library';
import { Box, Text } from 'ink';
import { describe, expect, it, vi } from 'vitest';
import { VirtualizedList, type VirtualizedListRef } from './VirtualizedList.js';

const item = { id: 1 };
const data = [item];
const HeightContext = createContext(1);
const estimatedItemHeight = () => 1;
const keyExtractor = (item: { id: number }) => `item-${item.id}`;

const GrowingItem = () => {
  const height = useContext(HeightContext);

  return (
    <Box flexDirection="column">
      {Array.from({ length: height }, (_, index) => (
        <Text key={index}>{index}</Text>
      ))}
    </Box>
  );
};

const renderItem = () => <GrowingItem />;
const renderStressItem = ({ item }: { item: { id: number } }) =>
  item.id === 0 ? <GrowingItem /> : <Text>{item.id}</Text>;

describe('<VirtualizedList /> layout updates', () => {
  it('defers row-height updates across commit boundaries', async () => {
    const listRef: RefObject<VirtualizedListRef<typeof item> | null> = {
      current: null,
    };

    const Wrapper = () => {
      const [height, setHeight] = useState(1);

      return (
        <Profiler
          id="list"
          onRender={() => {
            // Deterministically advance content after the list caches each
            // height. Before the fix, the uniquely keyed row and container
            // listeners turned these commits into one nested update chain.
            if (
              height < 60 &&
              listRef.current?.getScrollState().scrollHeight === height
            ) {
              setHeight(height + 1);
            }
          }}
        >
          <HeightContext.Provider value={height}>
            <VirtualizedList
              ref={listRef}
              data={data}
              renderItem={renderItem}
              estimatedItemHeight={estimatedItemHeight}
              keyExtractor={keyExtractor}
              containerHeight={80}
              width={80}
              showScrollbar={false}
            />
          </HeightContext.Provider>
        </Profiler>
      );
    };

    const view = render(<Wrapper />);

    try {
      for (let index = 0; index < 65; index++) {
        await act(() => new Promise<void>((resolve) => setImmediate(resolve)));
      }
      expect(listRef.current?.getScrollState().scrollHeight).toBe(60);
    } finally {
      view.unmount();
    }
  });

  it('queues reports only for rows whose height changed', async () => {
    const items = Array.from({ length: 60 }, (_, id) => ({ id }));
    const listRef: RefObject<VirtualizedListRef<
      (typeof items)[number]
    > | null> = { current: null };
    let setHeight: (height: number) => void = () => {};

    const Wrapper = () => {
      const [height, setHeightState] = useState(1);
      setHeight = setHeightState;

      return (
        <HeightContext.Provider value={height}>
          <VirtualizedList
            ref={listRef}
            data={items}
            renderItem={renderStressItem}
            estimatedItemHeight={estimatedItemHeight}
            keyExtractor={(item) => `item-${item.id}`}
            renderStatic
            containerHeight={300}
            width={80}
            showScrollbar={false}
          />
        </HeightContext.Provider>
      );
    };

    const queueMicrotaskSpy = vi.spyOn(globalThis, 'queueMicrotask');
    const view = render(<Wrapper />);

    try {
      await act(() => new Promise<void>((resolve) => setImmediate(resolve)));
      queueMicrotaskSpy.mockClear();

      for (let height = 2; height <= 200; height++) {
        act(() => setHeight(height));
        await act(() => new Promise<void>((resolve) => setImmediate(resolve)));
      }

      expect(listRef.current?.getScrollState().scrollHeight).toBe(259);
      const heightReportCount = queueMicrotaskSpy.mock.calls.filter(
        ([callback]) => callback.name === 'flushHeightReport',
      ).length;
      expect(heightReportCount).toBe(199);
    } finally {
      view.unmount();
      queueMicrotaskSpy.mockRestore();
    }
  });
});
