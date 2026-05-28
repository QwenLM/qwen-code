/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useRef } from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { act } from '@testing-library/react';
import { Text } from 'ink';
import {
  VirtualizedList,
  type VirtualizedListRef,
  SCROLL_TO_ITEM_END,
} from './VirtualizedList.js';

type Item = { id: number; label: string };

const makeItems = (n: number): Item[] =>
  Array.from({ length: n }, (_, i) => ({ id: i, label: `item-${i}` }));

const keyExtractor = (item: Item) => `k-${item.id}`;
const renderItem = ({ item }: { item: Item }) => <Text>{item.label}</Text>;
const estimatedItemHeight = () => 1;

describe('<VirtualizedList />', () => {
  it('renders nothing visible when data is empty', () => {
    const { lastFrame } = render(
      <VirtualizedList<Item>
        data={[]}
        renderItem={renderItem}
        estimatedItemHeight={estimatedItemHeight}
        keyExtractor={keyExtractor}
        containerHeight={10}
        width={40}
        showScrollbar={false}
      />,
    );
    // No items, no crash. lastFrame may be empty string or whitespace.
    const frame = lastFrame() ?? '';
    expect(frame).not.toMatch(/item-/);
  });

  it('renders all items when renderStatic is true (full list, no virtualization)', () => {
    const { lastFrame } = render(
      <VirtualizedList<Item>
        data={makeItems(5)}
        renderItem={renderItem}
        estimatedItemHeight={estimatedItemHeight}
        keyExtractor={keyExtractor}
        renderStatic
        containerHeight={20}
        width={40}
        showScrollbar={false}
      />,
    );
    const frame = lastFrame() ?? '';
    // All five items must render regardless of viewport size when renderStatic is on
    for (let i = 0; i < 5; i++) {
      expect(frame).toContain(`item-${i}`);
    }
  });

  it('with SCROLL_TO_ITEM_END as initialScrollIndex, anchors at the last item', () => {
    type RefShape = VirtualizedListRef<Item>;
    let listRef: RefShape | null = null;

    function Wrapper() {
      const ref = useRef<RefShape>(null);
      // Capture for assertions after render
      if (ref.current) listRef = ref.current;
      return (
        <VirtualizedList<Item>
          ref={ref}
          data={makeItems(20)}
          renderItem={renderItem}
          estimatedItemHeight={estimatedItemHeight}
          keyExtractor={keyExtractor}
          initialScrollIndex={SCROLL_TO_ITEM_END}
          containerHeight={5}
          width={40}
          showScrollbar={false}
        />
      );
    }

    const { rerender } = render(<Wrapper />);
    // Force commit so ref.current is populated
    rerender(<Wrapper />);
    expect(listRef).not.toBeNull();
    expect(listRef!.getScrollIndex()).toBe(19);
  });

  it('targetScrollIndex anchors to that index on first usable render', () => {
    type RefShape = VirtualizedListRef<Item>;
    let listRef: RefShape | null = null;

    function Wrapper() {
      const ref = useRef<RefShape>(null);
      if (ref.current) listRef = ref.current;
      return (
        <VirtualizedList<Item>
          ref={ref}
          data={makeItems(10)}
          renderItem={renderItem}
          estimatedItemHeight={estimatedItemHeight}
          keyExtractor={keyExtractor}
          targetScrollIndex={5}
          containerHeight={4}
          width={40}
          showScrollbar={false}
        />
      );
    }

    const { rerender } = render(<Wrapper />);
    rerender(<Wrapper />);
    expect(listRef).not.toBeNull();
    expect(listRef!.getScrollIndex()).toBe(5);
  });

  it('exposes scrollToEnd via imperative ref and snaps to the last item', () => {
    type RefShape = VirtualizedListRef<Item>;
    let listRef: RefShape | null = null;

    function Wrapper() {
      const ref = useRef<RefShape>(null);
      if (ref.current) listRef = ref.current;
      return (
        <VirtualizedList<Item>
          ref={ref}
          data={makeItems(30)}
          renderItem={renderItem}
          estimatedItemHeight={estimatedItemHeight}
          keyExtractor={keyExtractor}
          initialScrollIndex={0}
          containerHeight={5}
          width={40}
          showScrollbar={false}
        />
      );
    }

    const { rerender } = render(<Wrapper />);
    rerender(<Wrapper />);
    expect(listRef).not.toBeNull();
    expect(listRef!.getScrollIndex()).toBe(0);
    act(() => {
      listRef!.scrollToEnd();
    });
    rerender(<Wrapper />);
    expect(listRef!.getScrollIndex()).toBe(29);
  });

  it('scrollToIndex moves scroll anchor to the requested index', () => {
    type RefShape = VirtualizedListRef<Item>;
    let listRef: RefShape | null = null;

    function Wrapper() {
      const ref = useRef<RefShape>(null);
      if (ref.current) listRef = ref.current;
      return (
        <VirtualizedList<Item>
          ref={ref}
          data={makeItems(50)}
          renderItem={renderItem}
          estimatedItemHeight={estimatedItemHeight}
          keyExtractor={keyExtractor}
          initialScrollIndex={0}
          containerHeight={5}
          width={40}
          showScrollbar={false}
        />
      );
    }

    const { rerender } = render(<Wrapper />);
    rerender(<Wrapper />);
    expect(listRef).not.toBeNull();
    act(() => {
      listRef!.scrollToIndex({ index: 12 });
    });
    rerender(<Wrapper />);
    expect(listRef!.getScrollIndex()).toBe(12);
  });

  it('survives a renderItem that throws (isolates per-item errors)', () => {
    const data = makeItems(3);
    const renderWithBomb = ({ item }: { item: Item }) => {
      if (item.id === 1) {
        throw new Error('boom');
      }
      return <Text>{item.label}</Text>;
    };

    // Must not crash the test; a fallback row should be in the frame.
    expect(() =>
      render(
        <VirtualizedList<Item>
          data={data}
          renderItem={renderWithBomb}
          estimatedItemHeight={estimatedItemHeight}
          keyExtractor={keyExtractor}
          renderStatic
          containerHeight={5}
          width={40}
          showScrollbar={false}
        />,
      ),
    ).not.toThrow();
  });

  it('estimator returning NaN/negative is coerced to 0 (no scroll-math poison)', () => {
    type RefShape = VirtualizedListRef<Item>;
    let listRef: RefShape | null = null;

    const badEstimator = (i: number) => {
      if (i === 1) return Number.NaN;
      if (i === 2) return -10;
      return 1;
    };

    function Wrapper() {
      const ref = useRef<RefShape>(null);
      if (ref.current) listRef = ref.current;
      return (
        <VirtualizedList<Item>
          ref={ref}
          data={makeItems(4)}
          renderItem={renderItem}
          estimatedItemHeight={badEstimator}
          keyExtractor={keyExtractor}
          containerHeight={5}
          width={40}
          showScrollbar={false}
        />
      );
    }

    expect(() => {
      const { rerender } = render(<Wrapper />);
      rerender(<Wrapper />);
    }).not.toThrow();

    // scrollHeight must be a finite, non-NaN number even with bad estimator
    expect(listRef).not.toBeNull();
    const state = listRef!.getScrollState();
    expect(Number.isFinite(state.scrollHeight)).toBe(true);
    expect(state.scrollHeight).toBeGreaterThanOrEqual(0);
  });

  it('handles initialScrollIndex pointing past the end gracefully', () => {
    type RefShape = VirtualizedListRef<Item>;
    let listRef: RefShape | null = null;

    function Wrapper() {
      const ref = useRef<RefShape>(null);
      if (ref.current) listRef = ref.current;
      return (
        <VirtualizedList<Item>
          ref={ref}
          data={makeItems(5)}
          renderItem={renderItem}
          estimatedItemHeight={estimatedItemHeight}
          keyExtractor={keyExtractor}
          initialScrollIndex={9999}
          containerHeight={5}
          width={40}
          showScrollbar={false}
        />
      );
    }

    const { rerender } = render(<Wrapper />);
    rerender(<Wrapper />);
    expect(listRef).not.toBeNull();
    // Clamped to the last valid index (4)
    expect(listRef!.getScrollIndex()).toBeLessThanOrEqual(4);
    expect(listRef!.getScrollIndex()).toBeGreaterThanOrEqual(0);
  });

  describe('scrollBy', () => {
    it('scrollBy positive moves the viewport down', () => {
      type RefShape = VirtualizedListRef<Item>;
      let listRef: RefShape | null = null;

      function Wrapper() {
        const ref = useRef<RefShape>(null);
        if (ref.current) listRef = ref.current;
        return (
          <VirtualizedList<Item>
            ref={ref}
            data={makeItems(30)}
            renderItem={renderItem}
            estimatedItemHeight={estimatedItemHeight}
            keyExtractor={keyExtractor}
            initialScrollIndex={0}
            containerHeight={5}
            width={40}
            showScrollbar={false}
          />
        );
      }

      const { rerender } = render(<Wrapper />);
      rerender(<Wrapper />);
      expect(listRef).not.toBeNull();
      expect(listRef!.getScrollState().scrollTop).toBe(0);

      act(() => {
        listRef!.scrollBy(3);
      });
      rerender(<Wrapper />);
      expect(listRef!.getScrollState().scrollTop).toBe(3);
    });

    it('scrollBy negative moves the viewport up and clears sticking-to-bottom', () => {
      type RefShape = VirtualizedListRef<Item>;
      let listRef: RefShape | null = null;

      function Wrapper() {
        const ref = useRef<RefShape>(null);
        if (ref.current) listRef = ref.current;
        return (
          <VirtualizedList<Item>
            ref={ref}
            data={makeItems(30)}
            renderItem={renderItem}
            estimatedItemHeight={estimatedItemHeight}
            keyExtractor={keyExtractor}
            initialScrollIndex={SCROLL_TO_ITEM_END}
            containerHeight={5}
            width={40}
            showScrollbar={false}
          />
        );
      }

      const { rerender } = render(<Wrapper />);
      rerender(<Wrapper />);
      expect(listRef).not.toBeNull();

      act(() => {
        listRef!.scrollBy(-5);
      });
      rerender(<Wrapper />);
      // After scrolling up, scrollTop should be less than maxScroll
      const state = listRef!.getScrollState();
      expect(state.scrollTop).toBe(state.scrollHeight - state.innerHeight - 5);
    });

    it('scrollBy past bottom re-engages sticking-to-bottom with live end anchor', () => {
      type RefShape = VirtualizedListRef<Item>;
      let listRef: RefShape | null = null;

      function Wrapper() {
        const ref = useRef<RefShape>(null);
        if (ref.current) listRef = ref.current;
        return (
          <VirtualizedList<Item>
            ref={ref}
            data={makeItems(30)}
            renderItem={renderItem}
            estimatedItemHeight={estimatedItemHeight}
            keyExtractor={keyExtractor}
            initialScrollIndex={0}
            containerHeight={5}
            width={40}
            showScrollbar={false}
          />
        );
      }

      const { rerender } = render(<Wrapper />);
      rerender(<Wrapper />);
      expect(listRef).not.toBeNull();

      act(() => {
        listRef!.scrollBy(9999);
      });
      rerender(<Wrapper />);
      // Should be at the very end
      expect(listRef!.getScrollIndex()).toBe(29);
      const state = listRef!.getScrollState();
      expect(state.scrollTop).toBe(state.scrollHeight - state.innerHeight);
    });

    it('scrollBy clamps to 0 when scrolling past the top', () => {
      type RefShape = VirtualizedListRef<Item>;
      let listRef: RefShape | null = null;

      function Wrapper() {
        const ref = useRef<RefShape>(null);
        if (ref.current) listRef = ref.current;
        return (
          <VirtualizedList<Item>
            ref={ref}
            data={makeItems(30)}
            renderItem={renderItem}
            estimatedItemHeight={estimatedItemHeight}
            keyExtractor={keyExtractor}
            initialScrollIndex={2}
            containerHeight={5}
            width={40}
            showScrollbar={false}
          />
        );
      }

      const { rerender } = render(<Wrapper />);
      rerender(<Wrapper />);
      expect(listRef).not.toBeNull();

      act(() => {
        listRef!.scrollBy(-9999);
      });
      rerender(<Wrapper />);
      expect(listRef!.getScrollState().scrollTop).toBe(0);
    });
  });

  describe('scrollTo', () => {
    it('scrollTo middle offset positions correctly', () => {
      type RefShape = VirtualizedListRef<Item>;
      let listRef: RefShape | null = null;

      function Wrapper() {
        const ref = useRef<RefShape>(null);
        if (ref.current) listRef = ref.current;
        return (
          <VirtualizedList<Item>
            ref={ref}
            data={makeItems(30)}
            renderItem={renderItem}
            estimatedItemHeight={estimatedItemHeight}
            keyExtractor={keyExtractor}
            initialScrollIndex={0}
            containerHeight={5}
            width={40}
            showScrollbar={false}
          />
        );
      }

      const { rerender } = render(<Wrapper />);
      rerender(<Wrapper />);
      expect(listRef).not.toBeNull();

      act(() => {
        listRef!.scrollTo(10);
      });
      rerender(<Wrapper />);
      expect(listRef!.getScrollState().scrollTop).toBe(10);
    });

    it('scrollTo 0 moves to the beginning', () => {
      type RefShape = VirtualizedListRef<Item>;
      let listRef: RefShape | null = null;

      function Wrapper() {
        const ref = useRef<RefShape>(null);
        if (ref.current) listRef = ref.current;
        return (
          <VirtualizedList<Item>
            ref={ref}
            data={makeItems(30)}
            renderItem={renderItem}
            estimatedItemHeight={estimatedItemHeight}
            keyExtractor={keyExtractor}
            initialScrollIndex={SCROLL_TO_ITEM_END}
            containerHeight={5}
            width={40}
            showScrollbar={false}
          />
        );
      }

      const { rerender } = render(<Wrapper />);
      rerender(<Wrapper />);
      expect(listRef).not.toBeNull();

      act(() => {
        listRef!.scrollTo(0);
      });
      rerender(<Wrapper />);
      expect(listRef!.getScrollState().scrollTop).toBe(0);
    });

    it('scrollTo past maxScroll re-engages sticking-to-bottom', () => {
      type RefShape = VirtualizedListRef<Item>;
      let listRef: RefShape | null = null;

      function Wrapper() {
        const ref = useRef<RefShape>(null);
        if (ref.current) listRef = ref.current;
        return (
          <VirtualizedList<Item>
            ref={ref}
            data={makeItems(30)}
            renderItem={renderItem}
            estimatedItemHeight={estimatedItemHeight}
            keyExtractor={keyExtractor}
            initialScrollIndex={0}
            containerHeight={5}
            width={40}
            showScrollbar={false}
          />
        );
      }

      const { rerender } = render(<Wrapper />);
      rerender(<Wrapper />);
      expect(listRef).not.toBeNull();

      act(() => {
        listRef!.scrollTo(9999);
      });
      rerender(<Wrapper />);
      expect(listRef!.getScrollIndex()).toBe(29);
      const state = listRef!.getScrollState();
      expect(state.scrollTop).toBe(state.scrollHeight - state.innerHeight);
    });

    it('scrollTo negative is clamped to 0', () => {
      type RefShape = VirtualizedListRef<Item>;
      let listRef: RefShape | null = null;

      function Wrapper() {
        const ref = useRef<RefShape>(null);
        if (ref.current) listRef = ref.current;
        return (
          <VirtualizedList<Item>
            ref={ref}
            data={makeItems(30)}
            renderItem={renderItem}
            estimatedItemHeight={estimatedItemHeight}
            keyExtractor={keyExtractor}
            initialScrollIndex={10}
            containerHeight={5}
            width={40}
            showScrollbar={false}
          />
        );
      }

      const { rerender } = render(<Wrapper />);
      rerender(<Wrapper />);
      expect(listRef).not.toBeNull();

      act(() => {
        listRef!.scrollTo(-100);
      });
      rerender(<Wrapper />);
      expect(listRef!.getScrollState().scrollTop).toBe(0);
    });
  });

  describe('auto-scroll during streaming', () => {
    it('auto-scrolls when at bottom and data grows', () => {
      type RefShape = VirtualizedListRef<Item>;
      let listRef: RefShape | null = null;
      let items = makeItems(10);

      function Wrapper() {
        const ref = useRef<RefShape>(null);
        if (ref.current) listRef = ref.current;
        return (
          <VirtualizedList<Item>
            ref={ref}
            data={items}
            renderItem={renderItem}
            estimatedItemHeight={estimatedItemHeight}
            keyExtractor={keyExtractor}
            initialScrollIndex={SCROLL_TO_ITEM_END}
            containerHeight={5}
            width={40}
            showScrollbar={false}
          />
        );
      }

      const { rerender } = render(<Wrapper />);
      rerender(<Wrapper />);
      expect(listRef).not.toBeNull();
      expect(listRef!.getScrollIndex()).toBe(9);

      // Simulate streaming: add new items
      items = makeItems(15);
      rerender(<Wrapper />);
      rerender(<Wrapper />);
      // Should auto-scroll to the new last item
      expect(listRef!.getScrollIndex()).toBe(14);
    });

    it('does NOT auto-scroll when user has scrolled away from bottom', () => {
      type RefShape = VirtualizedListRef<Item>;
      let listRef: RefShape | null = null;
      let items = makeItems(20);

      function Wrapper() {
        const ref = useRef<RefShape>(null);
        if (ref.current) listRef = ref.current;
        return (
          <VirtualizedList<Item>
            ref={ref}
            data={items}
            renderItem={renderItem}
            estimatedItemHeight={estimatedItemHeight}
            keyExtractor={keyExtractor}
            initialScrollIndex={SCROLL_TO_ITEM_END}
            containerHeight={5}
            width={40}
            showScrollbar={false}
          />
        );
      }

      const { rerender } = render(<Wrapper />);
      rerender(<Wrapper />);
      expect(listRef).not.toBeNull();

      // User scrolls up
      act(() => {
        listRef!.scrollTo(0);
      });
      rerender(<Wrapper />);
      expect(listRef!.getScrollState().scrollTop).toBe(0);

      // New data arrives
      items = makeItems(25);
      rerender(<Wrapper />);
      rerender(<Wrapper />);
      // Should NOT auto-scroll — user explicitly scrolled away
      expect(listRef!.getScrollState().scrollTop).toBe(0);
    });

    it('re-engages auto-scroll when user scrolls back to bottom', () => {
      type RefShape = VirtualizedListRef<Item>;
      let listRef: RefShape | null = null;
      let items = makeItems(20);

      function Wrapper() {
        const ref = useRef<RefShape>(null);
        if (ref.current) listRef = ref.current;
        return (
          <VirtualizedList<Item>
            ref={ref}
            data={items}
            renderItem={renderItem}
            estimatedItemHeight={estimatedItemHeight}
            keyExtractor={keyExtractor}
            initialScrollIndex={SCROLL_TO_ITEM_END}
            containerHeight={5}
            width={40}
            showScrollbar={false}
          />
        );
      }

      const { rerender } = render(<Wrapper />);
      rerender(<Wrapper />);
      expect(listRef).not.toBeNull();

      // User scrolls up
      act(() => {
        listRef!.scrollTo(0);
      });
      rerender(<Wrapper />);

      // User scrolls back to bottom
      act(() => {
        listRef!.scrollToEnd();
      });
      rerender(<Wrapper />);
      expect(listRef!.getScrollIndex()).toBe(19);

      // New data arrives — should auto-scroll again
      items = makeItems(25);
      rerender(<Wrapper />);
      rerender(<Wrapper />);
      expect(listRef!.getScrollIndex()).toBe(24);
    });
  });
});
