/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from 'react';
import type { RefObject } from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { act } from '@testing-library/react';
import { Box, Text } from 'ink';
import {
  VirtualizedList,
  type VirtualizedListRef,
  SCROLL_TO_ITEM_END,
} from './VirtualizedList.js';
import { HistoryItemDisplay } from '../HistoryItemDisplay.js';
import { buildThoughtHeadIdMap } from '../../utils/historyUtils.js';
import { SettingsContext } from '../../contexts/SettingsContext.js';
import { VirtualViewportContext } from '../../contexts/VirtualViewportContext.js';
import { KeypressProvider } from '../../contexts/KeypressContext.js';
import { ThoughtExpandedProvider } from '../../contexts/ThoughtExpandedContext.js';
import type { LoadedSettings } from '../../../config/settings.js';
import type { HistoryItem } from '../../types.js';

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

  it('collapses bottom-stuck viewport to measured rows when estimates are too tall', async () => {
    const tallEstimate = () => 4;

    const { lastFrame, rerender } = render(
      <VirtualizedList<Item>
        data={makeItems(20)}
        renderItem={renderItem}
        estimatedItemHeight={tallEstimate}
        keyExtractor={keyExtractor}
        initialScrollIndex={SCROLL_TO_ITEM_END}
        containerHeight={20}
        width={40}
        showScrollbar={false}
      />,
    );

    for (let i = 0; i < 2; i++) {
      rerender(
        <VirtualizedList<Item>
          data={makeItems(20)}
          renderItem={renderItem}
          estimatedItemHeight={tallEstimate}
          keyExtractor={keyExtractor}
          initialScrollIndex={SCROLL_TO_ITEM_END}
          containerHeight={20}
          width={40}
          showScrollbar={false}
        />,
      );
      await act(async () => {});
    }

    const frame = lastFrame() ?? '';
    expect(frame).toContain('item-0');
    expect(frame).toContain('item-19');
    expect(frame.endsWith('item-19')).toBe(true);
  });

  it('collapses a short bottom-stuck list below the container height', async () => {
    const { lastFrame, rerender } = render(
      <VirtualizedList<Item>
        data={makeItems(5)}
        renderItem={renderItem}
        estimatedItemHeight={estimatedItemHeight}
        keyExtractor={keyExtractor}
        initialScrollIndex={SCROLL_TO_ITEM_END}
        containerHeight={20}
        width={40}
        showScrollbar={false}
      />,
    );

    rerender(
      <VirtualizedList<Item>
        data={makeItems(5)}
        renderItem={renderItem}
        estimatedItemHeight={estimatedItemHeight}
        keyExtractor={keyExtractor}
        initialScrollIndex={SCROLL_TO_ITEM_END}
        containerHeight={20}
        width={40}
        showScrollbar={false}
      />,
    );
    await act(async () => {});

    const frame = lastFrame() ?? '';
    expect(frame.split('\n')).toEqual([
      'item-0',
      'item-1',
      'item-2',
      'item-3',
      'item-4',
    ]);
  });

  it('reports zero-height shrink so collapsed items leave no blank gap', async () => {
    // Mirrors VP thought groups: the head renders a 1-line summary when
    // collapsed while continuations render nothing (zero height). The zero
    // height must be reported, otherwise the cached expanded height keeps
    // inflating totalHeight and the viewport shows a blank gap.
    const ExpandedContext = createContext({ expanded: true });

    const BodyWhenExpanded = () => {
      const { expanded } = useContext(ExpandedContext);
      if (!expanded) return null;
      return (
        <Box flexDirection="column">
          {Array.from({ length: 30 }, (_, i) => (
            <Text key={i}>{`thinking line ${i}`}</Text>
          ))}
        </Box>
      );
    };

    type ToggleItem = { id: number; kind: 'head' | 'body' };
    const items: ToggleItem[] = [
      { id: 0, kind: 'head' },
      { id: 1, kind: 'body' },
    ];

    // Ref-style capture: Wrapper assigns the real setter during render.
    let setExpanded: (v: boolean) => void = () => {};

    function Wrapper() {
      const [expanded, setState] = useState(true);
      setExpanded = setState;
      const renderItem = useCallback(
        ({ item }: { item: ToggleItem }) =>
          item.kind === 'head' ? (
            <Text>thought head</Text>
          ) : (
            <BodyWhenExpanded />
          ),
        [],
      );
      return (
        <ExpandedContext.Provider value={{ expanded }}>
          <Box flexDirection="column">
            <VirtualizedList<ToggleItem>
              data={items}
              renderItem={renderItem}
              estimatedItemHeight={() => 3}
              keyExtractor={(item) => `t-${item.id}`}
              initialScrollIndex={SCROLL_TO_ITEM_END}
              isStaticItem={() => true}
              containerHeight={40}
              width={40}
              showScrollbar={false}
            />
            <Text>FOOTER</Text>
          </Box>
        </ExpandedContext.Provider>
      );
    }

    const { lastFrame } = render(<Wrapper />);
    await act(async () => {});

    const expandedFrame = lastFrame() ?? '';
    expect(expandedFrame).toContain('thinking line 29');

    act(() => setExpanded(false));
    await act(async () => {});

    const lines = (lastFrame() ?? '').split('\n');
    const headIdx = lines.findIndex((l) => l.includes('thought head'));
    const footerIdx = lines.findIndex((l) => l.includes('FOOTER'));
    expect(headIdx).toBeGreaterThan(-1);
    // Exact adjacency, no slack: a mutant clamping reported heights to
    // >= 1 would still leave one blank row per zero-height item yet pass
    // any looser bound. A missing FOOTER (findIndex -1) fails it too.
    expect(footerIdx - headIdx).toBe(1);

    // Round trip: re-expand must overwrite the cached 0 with the real
    // height so an item can never get stuck at zero height.
    act(() => setExpanded(true));
    await act(async () => {});
    expect(lastFrame() ?? '').toContain('thinking line 29');
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

describe('<VirtualizedList /> VP collapsed thought groups', () => {
  const settings = {
    merged: { ui: { useTerminalBuffer: true, mouseTracking: false } },
  } as unknown as LoadedSettings;

  const line = (n: number) => `thought line ${n}`.padEnd(40, '.');
  const body = (seed: string, rows = 12) =>
    Array.from({ length: rows }, (_, i) => `${seed} ${line(i)}`).join('\n');

  const HEAD_ID = 1;
  const thoughtHistory = (rows: number, answerRows = 0): HistoryItem[] => [
    { id: 0, type: 'user', text: 'hello' },
    {
      id: HEAD_ID,
      type: 'gemini_thought',
      text: body('head', rows),
      durationMs: 101_000,
    } as HistoryItem,
    {
      id: 2,
      type: 'gemini_thought_content',
      text: body('c1', rows),
    } as HistoryItem,
    {
      id: 3,
      type: 'gemini_thought_content',
      text: body('c2', rows),
    } as HistoryItem,
    {
      id: 4,
      type: 'gemini_thought_content',
      text: body('c3', rows),
    } as HistoryItem,
    {
      id: 5,
      type: 'gemini',
      text: answerRows > 0 ? body('answer', answerRows) : 'final answer',
    },
  ];

  // Mirror production wiring (MainContent, AgentChatContent): derive the
  // group → head-id map from the fixture's own data instead of a
  // hardcoded lookup, so these tests validate the wiring production
  // actually produces.
  const renderThoughtItem = (data: HistoryItem[]) => {
    const headIdMap = buildThoughtHeadIdMap(data);
    const ThoughtItem = ({ item }: { item: HistoryItem }) => (
      <HistoryItemDisplay
        terminalWidth={80}
        mainAreaWidth={80}
        availableTerminalHeight={40}
        item={item}
        isPending={false}
        thoughtHeadId={headIdMap.get(item)}
      />
    );
    return ThoughtItem;
  };

  const thoughtTree = (
    expandedHeadIds: ReadonlySet<number>,
    ref: RefObject<VirtualizedListRef<HistoryItem> | null>,
    data: HistoryItem[],
    initialScrollIndex?: number,
  ) => (
    <SettingsContext.Provider value={settings}>
      <VirtualViewportContext.Provider value={true}>
        <KeypressProvider kittyProtocolEnabled={false}>
          <ThoughtExpandedProvider
            value={{ allExpanded: false, expandedHeadIds, toggle: () => {} }}
          >
            <VirtualizedList
              ref={ref}
              data={data}
              renderItem={renderThoughtItem(data)}
              estimatedItemHeight={() => 3}
              keyExtractor={(item) => `h-${item.id}`}
              isStaticItem={() => true}
              initialScrollIndex={initialScrollIndex}
              containerHeight={40}
              showScrollbar={false}
            />
          </ThoughtExpandedProvider>
        </KeypressProvider>
      </VirtualViewportContext.Provider>
    </SettingsContext.Provider>
  );

  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

  it('releases reserved height when a thought group collapses', async () => {
    const data = thoughtHistory(12);
    const ref: RefObject<VirtualizedListRef<HistoryItem> | null> = {
      current: null,
    };
    const harness = render(
      thoughtTree(new Set([HEAD_ID]), ref, data, SCROLL_TO_ITEM_END),
    );
    await tick();
    await tick();
    expect((harness.lastFrame() ?? '').includes('c3 thought line 0')).toBe(
      true,
    );

    harness.rerender(thoughtTree(new Set(), ref, data, SCROLL_TO_ITEM_END));
    await tick();
    await tick();
    const lines = (harness.lastFrame() ?? '').split('\n');
    expect(lines.some((l) => l.includes('c1 thought line 0'))).toBe(false);
    expect(lines.filter((l) => l.trim() !== '').length).toBeLessThanOrEqual(6);
    expect(lines.length).toBeLessThanOrEqual(8);
  });

  it('does not lock the render window when a tall thought collapses off-screen', async () => {
    // Tall trailing answer mirrors production's bottom-stuck shape: the
    // viewport sits below the thought group, so the group collapses
    // outside the render window and only re-mounting can release its
    // cached expanded heights.
    const data = thoughtHistory(60, 60);
    const ref: RefObject<VirtualizedListRef<HistoryItem> | null> = {
      current: null,
    };
    const harness = render(
      thoughtTree(new Set([HEAD_ID]), ref, data, SCROLL_TO_ITEM_END),
    );
    await tick();
    await tick();

    harness.rerender(thoughtTree(new Set(), ref, data, SCROLL_TO_ITEM_END));
    await tick();
    await tick();

    // Scroll back up to the collapsed group: it must remount,
    // re-measure, and release its stale heights instead of leaving a
    // locked blank gap.
    act(() => {
      ref.current?.scrollToIndex({ index: 1 });
    });
    await tick();
    for (let i = 0; i < 10; i++) {
      await tick();
    }

    const lines = (harness.lastFrame() ?? '').split('\n');
    expect(lines.some((l) => l.includes('Thought for 1m 41s'))).toBe(true);
    expect(lines.filter((l) => l.trim() === '').length).toBeLessThanOrEqual(4);
  });

  it('heals every cached-zero continuation at the viewport top in one pass', async () => {
    const data = thoughtHistory(12);
    const ref: RefObject<VirtualizedListRef<HistoryItem> | null> = {
      current: null,
    };
    const harness = render(
      thoughtTree(new Set([HEAD_ID]), ref, data, SCROLL_TO_ITEM_END),
    );
    await tick();
    await tick();

    // Collapse while the group is still mounted so all three
    // continuations measure 0 and cache it, then grow the answer: the
    // bottom-stuck viewport moves below the collapsed group and the
    // cached zeros persist off-screen.
    harness.rerender(thoughtTree(new Set(), ref, data, SCROLL_TO_ITEM_END));
    await tick();
    await tick();
    const tallData = thoughtHistory(12, 60);
    harness.rerender(thoughtTree(new Set(), ref, tallData, SCROLL_TO_ITEM_END));
    await tick();
    await tick();

    // Re-expand, then bring the viewport top to the group's offset. The
    // whole coincident-offset run must mount and re-measure in this one
    // pass; without the walk-back, only the run's last item mounts and
    // each further scroll pass heals just one more continuation.
    harness.rerender(
      thoughtTree(new Set([HEAD_ID]), ref, tallData, SCROLL_TO_ITEM_END),
    );
    await tick();
    await tick();
    act(() => {
      ref.current?.scrollTo(2);
    });
    for (let i = 0; i < 10; i++) {
      await tick();
    }

    // user(1) + head summary(collapsed height) + c1..c3(12 each) +
    // answer(60). One-per-pass healing would still be 12 rows short
    // here (c1 left at its cached 0).
    expect(ref.current!.getScrollState().scrollHeight).toBeGreaterThanOrEqual(
      90,
    );
  });
});
