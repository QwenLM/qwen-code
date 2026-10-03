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

  it('bottom-aligns a short bottom-stuck list within the container height', async () => {
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
    // Short bottom-stuck content is bottom-aligned (#9300): blank rows at the
    // top, the five items pinned to the bottom of the 20-row container.
    const lines = frame.split('\n');
    expect(lines.length).toBe(20);
    expect(lines.slice(0, 15).every((l) => l.trim() === '')).toBe(true);
    expect(lines.slice(15)).toEqual([
      'item-0',
      'item-1',
      'item-2',
      'item-3',
      'item-4',
    ]);
  });

  it('keeps a fitting top-anchored mount (initialScrollIndex 0) top-aligned', async () => {
    // MainContent mounts the banner-only VP session with
    // `initialScrollIndex={0}` (top-anchored). The mount-time re-stick must
    // not override that explicit anchor and bottom-align the content:
    // bottom-alignment is reserved for bottom-stuck conversations (#9300).
    const { lastFrame, rerender } = render(
      <VirtualizedList<Item>
        data={makeItems(3)}
        renderItem={renderItem}
        estimatedItemHeight={estimatedItemHeight}
        keyExtractor={keyExtractor}
        initialScrollIndex={0}
        containerHeight={20}
        width={40}
        showScrollbar={false}
      />,
    );

    rerender(
      <VirtualizedList<Item>
        data={makeItems(3)}
        renderItem={renderItem}
        estimatedItemHeight={estimatedItemHeight}
        keyExtractor={keyExtractor}
        initialScrollIndex={0}
        containerHeight={20}
        width={40}
        showScrollbar={false}
      />,
    );
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual([
      'item-0',
      'item-1',
      'item-2',
    ]);
  });

  it('does not bottom-align a scrolled-away list when content shrinks to fit', async () => {
    // Discriminates the `isStickingToBottom` gate of `bottomAlignGap`: the
    // user scrolled away from the bottom, then content shrinks in place
    // below the viewport. The frame must collapse top-aligned around the
    // content the user is reading, not grow to the full container height
    // with blank rows above it (#9305 review R4-2).
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
          containerHeight={10}
          width={40}
          showScrollbar={false}
        />
      );
    }

    const { lastFrame, rerender } = render(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    act(() => {
      listRef!.scrollTo(0);
    });
    rerender(<Wrapper />);
    await act(async () => {});

    items = makeItems(3);
    rerender(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual([
      'item-0',
      'item-1',
      'item-2',
    ]);

    // A scroll attempt while everything fits is positionally a no-op and
    // must not flip sticking either way: engaging it would bottom-align
    // the fitting content (destroying the top-aligned state pinned above),
    // releasing it would drop auto-follow (#9305 review R5-2).
    for (const scroll of [
      () => listRef!.scrollBy(1),
      () => listRef!.scrollBy(-1),
      () => listRef!.scrollTo(0),
      () => listRef!.scrollToEnd(),
    ]) {
      act(scroll);
      rerender(<Wrapper />);
      await act(async () => {});
      expect((lastFrame() ?? '').split('\n')).toEqual([
        'item-0',
        'item-1',
        'item-2',
      ]);
    }
  });

  it('top-aligns the banner-only state when a stuck list collapses without remount', async () => {
    // /clear does not remount the list (no key on ScrollableList in
    // MainContent), so sticking from the bottom-stuck rest state is still
    // set when the data collapses to the banner alone. The host mounts that
    // state top-anchored (initialScrollIndex 0), so the in-place collapse
    // must render the same top-aligned frame instead of bottom-aligning the
    // banner under a blank viewport (#9305 review R5-1).
    let items = makeItems(20);

    const renderList = () => (
      <VirtualizedList<Item>
        data={items}
        renderItem={renderItem}
        estimatedItemHeight={estimatedItemHeight}
        keyExtractor={keyExtractor}
        initialScrollIndex={SCROLL_TO_ITEM_END}
        containerHeight={10}
        width={40}
        showScrollbar={false}
      />
    );

    const { lastFrame, rerender } = render(renderList());
    rerender(renderList());
    await act(async () => {});

    items = [{ id: 999, label: 'banner' }];
    rerender(renderList());
    rerender(renderList());
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual(['banner']);
  });

  it('keeps sticking released when an overflowing banner-only list is resized', async () => {
    // The collapse drop queues setIsStickingToBottom(false), but the
    // mark-install still reads the stale render-time flag on that render.
    // When the single remaining item overflows the container (a tall
    // banner in a small terminal), the missing clamp mark lets the next
    // effect trigger — here a terminal resize — read the parked position
    // as the user being at the bottom and re-engage sticking,
    // bottom-pinning the top-anchored banner (#9305 review R6-1). The
    // banner sits at index 0 like AppHeader so its height is cached
    // before the collapse, as in the real /clear lifecycle.
    const banner = Array.from({ length: 15 }, (_, i) => `b${i}`).join('\n');
    let items: Item[] = [{ id: 999, label: banner }, ...makeItems(5)];
    let height = 10;

    const renderList = () => (
      <VirtualizedList<Item>
        data={items}
        renderItem={renderItem}
        estimatedItemHeight={estimatedItemHeight}
        keyExtractor={keyExtractor}
        initialScrollIndex={SCROLL_TO_ITEM_END}
        containerHeight={height}
        width={40}
        showScrollbar={false}
      />
    );

    const { lastFrame, rerender } = render(renderList());
    rerender(renderList());
    await act(async () => {});

    items = [{ id: 999, label: banner }];
    rerender(renderList());
    rerender(renderList());
    await act(async () => {});

    // Collapse parks the viewport at the banner's bottom (top clipped).
    expect((lastFrame() ?? '').split('\n')).toEqual([
      'b5',
      'b6',
      'b7',
      'b8',
      'b9',
      'b10',
      'b11',
      'b12',
      'b13',
      'b14',
    ]);

    height = 8;
    rerender(renderList());
    rerender(renderList());
    await act(async () => {});

    // The resize must not re-engage sticking from the parked position:
    // the anchor holds and the frame is not bottom-pinned to b7..b14.
    expect((lastFrame() ?? '').split('\n')).toEqual([
      'b5',
      'b6',
      'b7',
      'b8',
      'b9',
      'b10',
      'b11',
      'b12',
    ]);
  });

  it('does not yank the viewport to the first post-clear message', async () => {
    // Combined R6-1 + R6-2: after the /clear-style collapse drops
    // sticking and parks the viewport inside an overflowing banner, the
    // first new message must not read that parked position as the user
    // being at the bottom: the growth branch would snap the anchor to
    // the end and latch auto-follow back on (#9305 reviews R6-1, R6-2).
    // The banner sits at index 0 like AppHeader so its height is cached
    // before the collapse, as in the real /clear lifecycle.
    const banner = Array.from({ length: 12 }, (_, i) => `b${i}`).join('\n');
    let items: Item[] = [{ id: 999, label: banner }, ...makeItems(5)];

    const renderList = () => (
      <VirtualizedList<Item>
        data={items}
        renderItem={renderItem}
        estimatedItemHeight={estimatedItemHeight}
        keyExtractor={keyExtractor}
        initialScrollIndex={SCROLL_TO_ITEM_END}
        containerHeight={10}
        width={40}
        showScrollbar={false}
      />
    );

    const { lastFrame, rerender } = render(renderList());
    rerender(renderList());
    await act(async () => {});

    items = [{ id: 999, label: banner }];
    rerender(renderList());
    rerender(renderList());
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual([
      'b2',
      'b3',
      'b4',
      'b5',
      'b6',
      'b7',
      'b8',
      'b9',
      'b10',
      'b11',
    ]);

    items = [
      { id: 999, label: banner },
      { id: 0, label: 'message' },
    ];
    rerender(renderList());
    rerender(renderList());
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual([
      'b2',
      'b3',
      'b4',
      'b5',
      'b6',
      'b7',
      'b8',
      'b9',
      'b10',
      'b11',
    ]);
  });

  it('re-engages auto-follow when a fitting top-anchored mount grows to overflow', async () => {
    // MainContent mounts the banner-only session top-anchored
    // (`length <= 1 ? 0 : SCROLL_TO_ITEM_END`). While the banner fits,
    // the re-anchor clamp moves nothing, so no clamp mark may be
    // installed: while content fits, nothing can move the anchor off a
    // mark, and `clampParked` would suppress the growth auto-follow
    // branch forever — the first streamed reply would then render below
    // the fold (#9305 review R8-1). Growth must re-engage sticking once
    // the conversation overflows the viewport.
    let items: Item[] = [{ id: 999, label: 'banner' }];

    const renderList = () => (
      <VirtualizedList<Item>
        data={items}
        renderItem={renderItem}
        estimatedItemHeight={estimatedItemHeight}
        keyExtractor={keyExtractor}
        initialScrollIndex={0}
        containerHeight={5}
        width={40}
        showScrollbar={false}
      />
    );

    const { lastFrame, rerender } = render(renderList());
    rerender(renderList());
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual(['banner']);

    items = [{ id: 999, label: 'banner' }, ...makeItems(8)];
    rerender(renderList());
    rerender(renderList());
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual([
      'item-3',
      'item-4',
      'item-5',
      'item-6',
      'item-7',
    ]);

    // Sticking stays engaged: further growth keeps following.
    items = [{ id: 999, label: 'banner' }, ...makeItems(14)];
    rerender(renderList());
    rerender(renderList());
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual([
      'item-9',
      'item-10',
      'item-11',
      'item-12',
      'item-13',
    ]);
  });

  it('re-engages auto-follow when the first post-clear message overflows a fitting banner', async () => {
    // Fitting-remnant counterpart of the R6 combined test above: the
    // /clear collapse drops sticking and re-anchors to {0,0}, but the
    // remnant FITS — the re-stick gate is already blocked by
    // `!contentPreviouslyFit`, so no clamp mark may be installed. A
    // mark here reads as `clampParked` on every later growth and
    // suppresses the auto-follow branch, killing follow for the first
    // conversation after /clear (#9305 review R8-1). The overflowing
    // remnant keeps its park (pinned by the R6 tests).
    let items = makeItems(20);

    const renderList = () => (
      <VirtualizedList<Item>
        data={items}
        renderItem={renderItem}
        estimatedItemHeight={estimatedItemHeight}
        keyExtractor={keyExtractor}
        initialScrollIndex={SCROLL_TO_ITEM_END}
        containerHeight={10}
        width={40}
        showScrollbar={false}
      />
    );

    const { lastFrame, rerender } = render(renderList());
    rerender(renderList());
    await act(async () => {});

    items = [{ id: 999, label: 'banner' }];
    rerender(renderList());
    rerender(renderList());
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual(['banner']);

    items = [{ id: 999, label: 'banner' }, ...makeItems(12)];
    rerender(renderList());
    rerender(renderList());
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual([
      'item-2',
      'item-3',
      'item-4',
      'item-5',
      'item-6',
      'item-7',
      'item-8',
      'item-9',
      'item-10',
      'item-11',
    ]);
  });

  it('re-engages auto-follow when a scrolled-away collapse to a fitting banner grows', async () => {
    // Scrolled-away counterpart of the post-clear re-follow test above:
    // sticking was already released before the collapse re-anchors, but the
    // fitting banner must not get a clamp mark through the released arm
    // either — while content fits, nothing can move the anchor off a mark,
    // so one installed here reads as `clampParked` on every later growth
    // and suppresses the auto-follow branch, leaving the first post-clear
    // reply below the fold (#9305 review R10-1).
    type RefShape = VirtualizedListRef<Item>;
    let listRef: RefShape | null = null;
    let items: Item[] = makeItems(20);

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
          containerHeight={10}
          width={40}
          showScrollbar={false}
        />
      );
    }

    const { lastFrame, rerender } = render(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    act(() => {
      listRef!.scrollBy(-5);
    });
    rerender(<Wrapper />);
    await act(async () => {});

    // Scrolled-away rest state: sticking released, viewport five rows up.
    expect((lastFrame() ?? '').split('\n')).toEqual([
      'item-5',
      'item-6',
      'item-7',
      'item-8',
      'item-9',
      'item-10',
      'item-11',
      'item-12',
      'item-13',
      'item-14',
    ]);

    items = [{ id: 999, label: 'banner' }];
    rerender(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual(['banner']);

    items = [{ id: 999, label: 'banner' }, ...makeItems(12)];
    rerender(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual([
      'item-2',
      'item-3',
      'item-4',
      'item-5',
      'item-6',
      'item-7',
      'item-8',
      'item-9',
      'item-10',
      'item-11',
    ]);
  });

  it('does not re-stick a scrolled-away list that shrinks to fit in two steps', async () => {
    // The first shrink re-anchors a scrolled-away viewport, parking it
    // exactly at the new bottom; the re-stick gate must not read that
    // content-driven clamp as the user being at the bottom and flip
    // sticking back on when the next shrink fits (#9305 review R5-3).
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
          containerHeight={10}
          width={40}
          showScrollbar={false}
        />
      );
    }

    const { lastFrame, rerender } = render(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    act(() => {
      listRef!.scrollBy(-5);
    });
    rerender(<Wrapper />);
    await act(async () => {});

    items = makeItems(12);
    rerender(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    items = makeItems(8);
    rerender(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual([
      'item-0',
      'item-1',
      'item-2',
      'item-3',
      'item-4',
      'item-5',
      'item-6',
      'item-7',
    ]);

    // The parked position must not read as the user being at the bottom
    // when the list grows either: the next message arriving must not yank
    // the anchor to the end and re-engage sticking (#9305 review R6-2).
    items = makeItems(9);
    rerender(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual([
      'item-0',
      'item-1',
      'item-2',
      'item-3',
      'item-4',
      'item-5',
      'item-6',
      'item-7',
      'item-8',
    ]);
  });

  it('does not preempt the sticking drop when a shrink and resize land in one render', async () => {
    // Ink coalesces rapid state updates, so a terminal resize can land in
    // the same render as the /clear-style shrink to the banner. The
    // container-change arm must not evaluate on the stale render-time
    // sticking flag and preempt the drop branch there: the END anchor it
    // would install makes the drop unreachable again, so the first
    // post-clear message yanks the viewport and re-latches follow — the
    // R6-2 regression this PR removes (#9305 review R11-1).
    const banner = Array.from({ length: 15 }, (_, i) => `b${i}`).join('\n');
    let items: Item[] = [{ id: 999, label: banner }, ...makeItems(5)];
    let height = 10;

    const renderList = () => (
      <VirtualizedList<Item>
        data={items}
        renderItem={renderItem}
        estimatedItemHeight={estimatedItemHeight}
        keyExtractor={keyExtractor}
        initialScrollIndex={SCROLL_TO_ITEM_END}
        containerHeight={height}
        width={40}
        showScrollbar={false}
      />
    );

    const { lastFrame, rerender } = render(renderList());
    rerender(renderList());
    await act(async () => {});

    // Shrink to the banner and resize the container in one batched render.
    items = [{ id: 999, label: banner }];
    height = 8;
    rerender(renderList());
    rerender(renderList());
    await act(async () => {});

    // The collapse parks the viewport at the banner's bottom, sticking
    // released.
    expect((lastFrame() ?? '').split('\n')).toEqual([
      'b7',
      'b8',
      'b9',
      'b10',
      'b11',
      'b12',
      'b13',
      'b14',
    ]);

    // The first post-clear message must not yank the viewport to the end
    // nor re-latch auto-follow.
    items = [
      { id: 999, label: banner },
      { id: 0, label: 'message' },
    ];
    rerender(renderList());
    rerender(renderList());
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual([
      'b7',
      'b8',
      'b9',
      'b10',
      'b11',
      'b12',
      'b13',
      'b14',
    ]);

    // Follow must stay off: once the content fits again the frame renders
    // top-aligned, not bottom-aligned under a stuck viewport.
    height = 20;
    rerender(renderList());
    rerender(renderList());
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual([
      ...Array.from({ length: 15 }, (_, i) => `b${i}`),
      'message',
    ]);
  });

  it('does not yank the first message after a resize overflows a fitting banner by one row', async () => {
    // After the /clear collapse a fitting banner installs no mark (R8-1 /
    // R10-1). Shrinking the terminal so the banner overflows by exactly
    // one row must not let the -1 bottom tolerance read the parked TOP of
    // that one-row scroll range as the bottom pixels: the first new
    // message would then snap the anchor to END and latch follow from a
    // position the user never scrolled to (#9305 review R11-4).
    const banner = Array.from({ length: 10 }, (_, i) => `b${i}`).join('\n');
    let items: Item[] = [{ id: 999, label: banner }, ...makeItems(5)];
    let height = 12;

    const renderList = () => (
      <VirtualizedList<Item>
        data={items}
        renderItem={renderItem}
        estimatedItemHeight={estimatedItemHeight}
        keyExtractor={keyExtractor}
        initialScrollIndex={SCROLL_TO_ITEM_END}
        containerHeight={height}
        width={40}
        showScrollbar={false}
      />
    );

    const { lastFrame, rerender } = render(renderList());
    rerender(renderList());
    await act(async () => {});

    // Collapse to the fitting banner: top-anchored, no mark.
    items = [{ id: 999, label: banner }];
    rerender(renderList());
    rerender(renderList());
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual([
      'b0',
      'b1',
      'b2',
      'b3',
      'b4',
      'b5',
      'b6',
      'b7',
      'b8',
      'b9',
    ]);

    // Resize so the banner overflows by exactly one row: the park stays
    // at the top with sticking off.
    height = 9;
    rerender(renderList());
    rerender(renderList());
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual([
      'b0',
      'b1',
      'b2',
      'b3',
      'b4',
      'b5',
      'b6',
      'b7',
      'b8',
    ]);

    // The first new message must not yank the viewport nor latch follow.
    items = [
      { id: 999, label: banner },
      { id: 0, label: 'message' },
    ];
    rerender(renderList());
    rerender(renderList());
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual([
      'b0',
      'b1',
      'b2',
      'b3',
      'b4',
      'b5',
      'b6',
      'b7',
      'b8',
    ]);
  });

  it('re-engages auto-follow when a scrolled-away resize-to-fit grows past the viewport', async () => {
    // Scrolled away in an overflowing conversation, then the terminal
    // grows until the content fits: the clamp parks at {0,0} and the
    // released arm installs the mark. While the content fits that park is
    // correct, but once growth crosses the fit boundary the user — who
    // could see everything while it fit — must get auto-follow back
    // instead of every new message rendering below the fold (#9305
    // review R11-6).
    type RefShape = VirtualizedListRef<Item>;
    let listRef: RefShape | null = null;
    let items = makeItems(20);
    let height = 10;

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
          containerHeight={height}
          width={40}
          showScrollbar={false}
        />
      );
    }

    const { lastFrame, rerender } = render(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    act(() => {
      listRef!.scrollBy(-5);
    });
    rerender(<Wrapper />);
    await act(async () => {});

    // Enlarge the terminal until the content fits: top-parked at {0,0}.
    height = 25;
    rerender(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual(
      Array.from({ length: 20 }, (_, i) => `item-${i}`),
    );

    // Growth past the viewport re-engages follow.
    items = makeItems(28);
    rerender(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual(
      Array.from({ length: 25 }, (_, i) => `item-${i + 3}`),
    );
  });

  it('re-engages auto-follow when a scrolled-away shrink-to-fit grows past the viewport', async () => {
    // Second entrance of the released-arm mark: the user scrolls away, the
    // list shrinks in place until it fits, and the park at {0,0} installs
    // the mark. Growth crossing the fit boundary must re-engage follow
    // (#9305 review R11-6). The still-fitting growth right after the park
    // stays suppressed (pinned by the R6-2 test above).
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
          containerHeight={10}
          width={40}
          showScrollbar={false}
        />
      );
    }

    const { lastFrame, rerender } = render(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    act(() => {
      listRef!.scrollBy(-5);
    });
    rerender(<Wrapper />);
    await act(async () => {});

    items = makeItems(8);
    rerender(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual(
      Array.from({ length: 8 }, (_, i) => `item-${i}`),
    );

    items = makeItems(14);
    rerender(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual(
      Array.from({ length: 10 }, (_, i) => `item-${i + 4}`),
    );
  });

  it('re-engages auto-follow across a wholesale dataset replacement', async () => {
    // /resume swaps the history in one batched commit and ScrollableList
    // carries no key, so the list state — including the clamp mark —
    // survives the swap. Switching into a short fitting session re-anchors
    // to {0,0} and the released arm installs the mark on the NEW dataset;
    // the mark must not kill growth follow there: the session's first
    // streaming reply past the viewport must follow, not render below the
    // fold (#9305 review R11-6).
    type RefShape = VirtualizedListRef<Item>;
    let listRef: RefShape | null = null;
    let items = makeItems(30);

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
          containerHeight={10}
          width={40}
          showScrollbar={false}
        />
      );
    }

    const { lastFrame, rerender } = render(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    act(() => {
      listRef!.scrollBy(-5);
    });
    rerender(<Wrapper />);
    await act(async () => {});

    // In-place session switch to a short fitting session (2+ items).
    items = Array.from({ length: 6 }, (_, i) => ({
      id: 100 + i,
      label: `it-${100 + i}`,
    }));
    rerender(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual(
      Array.from({ length: 6 }, (_, i) => `it-${100 + i}`),
    );

    // The new session streams past the viewport: follow must re-engage.
    items = Array.from({ length: 15 }, (_, i) => ({
      id: 100 + i,
      label: `it-${100 + i}`,
    }));
    rerender(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual(
      Array.from({ length: 10 }, (_, i) => `it-${105 + i}`),
    );
  });

  it('does not re-latch sticking when a banner-only remnant overflows after a fitting park', async () => {
    // The released shrink-to-fit park installs the mark keyed to the first
    // remnant item — the banner, which survives the /clear collapse at the
    // same {0,0} anchor, so the mark still validates and survives too. A
    // terminal shrink that then overflows the banner must not let the
    // fit→overflow crossing re-latch sticking on the banner-only remnant:
    // there is no conversation to follow, and the engaged flag would
    // bottom-align the banner under a blank viewport and yank the first
    // post-clear message (#9305 review R17-1).
    const banner = Array.from({ length: 3 }, (_, i) => `b${i}`).join('\n');
    let items: Item[] = [{ id: 999, label: banner }, ...makeItems(20)];
    let height = 12;
    type RefShape = VirtualizedListRef<Item>;
    let listRef: RefShape | null = null;

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
          containerHeight={height}
          width={40}
          showScrollbar={false}
        />
      );
    }

    const { lastFrame, rerender } = render(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    act(() => {
      listRef!.scrollBy(-5);
    });
    rerender(<Wrapper />);
    await act(async () => {});

    // Shrink in place until the remnant fits: the released park at {0,0}
    // installs the mark keyed to the banner.
    items = [{ id: 999, label: banner }, ...makeItems(8)];
    rerender(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual([
      'b0',
      'b1',
      'b2',
      ...Array.from({ length: 8 }, (_, i) => `item-${i}`),
    ]);

    // /clear collapses to the banner alone; it still fits.
    items = [{ id: 999, label: banner }];
    rerender(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual(['b0', 'b1', 'b2']);

    // Shrink the terminal past the banner height: sticking must stay
    // released and the frame stays top-aligned, not bottom-pinned b1..b2.
    height = 2;
    rerender(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual(['b0', 'b1']);

    // The first post-clear message must not yank the viewport nor latch
    // follow.
    items = [
      { id: 999, label: banner },
      { id: 0, label: 'message' },
    ];
    rerender(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual(['b0', 'b1']);
  });

  it('re-engages auto-follow when a released swap lands in an overflowing session', async () => {
    // /resume swaps the whole dataset in one commit and ScrollableList
    // carries no key, so the carried anchor lands out of range and the drop
    // branch parks the viewport at the new session's live bottom. That park
    // must not install the clamp mark: the user never scrolled there, and
    // the mark would suppress every re-follow path, leaving the new
    // session's first streamed messages below the fold until a manual
    // scroll (#9305 review R17-2).
    type RefShape = VirtualizedListRef<Item>;
    let listRef: RefShape | null = null;
    let items = makeItems(30);

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
          containerHeight={10}
          width={40}
          showScrollbar={false}
        />
      );
    }

    const { lastFrame, rerender } = render(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    act(() => {
      listRef!.scrollBy(-5);
    });
    rerender(<Wrapper />);
    await act(async () => {});

    // In-place session switch to an overflowing session: the carried
    // anchor is out of range, the drop branch parks at the new bottom.
    items = Array.from({ length: 12 }, (_, i) => ({
      id: 100 + i,
      label: `it-${100 + i}`,
    }));
    rerender(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual(
      Array.from({ length: 10 }, (_, i) => `it-${102 + i}`),
    );

    // The new session streams: follow must re-engage.
    items = Array.from({ length: 13 }, (_, i) => ({
      id: 100 + i,
      label: `it-${100 + i}`,
    }));
    rerender(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual(
      Array.from({ length: 10 }, (_, i) => `it-${103 + i}`),
    );

    items = Array.from({ length: 14 }, (_, i) => ({
      id: 100 + i,
      label: `it-${100 + i}`,
    }));
    rerender(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual(
      Array.from({ length: 10 }, (_, i) => `it-${104 + i}`),
    );
  });

  it('keeps follow alive when a replacement lands under the carried anchor', async () => {
    // A wholesale replacement whose items sit under the carried anchor
    // bypasses the drop branch entirely. In production this shape remounts
    // by session key (MainContent), but the component must still hold: the
    // park mark — now positional, no item key — must not suppress follow
    // in the replaced dataset; growth from a live-bottom park re-engages
    // (#9305 reviews R17-3, R18-1).
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
          containerHeight={10}
          width={40}
          showScrollbar={false}
        />
      );
    }

    const { lastFrame, rerender } = render(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    act(() => {
      listRef!.scrollBy(-5);
    });
    rerender(<Wrapper />);
    await act(async () => {});

    // Shrink in place: the drop branch parks at the new bottom and
    // installs the mark keyed to the parked item.
    items = makeItems(12);
    rerender(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual(
      Array.from({ length: 10 }, (_, i) => `item-${i + 2}`),
    );

    // Replacement whose items sit under the carried anchor: the anchor
    // stays in range, so no drop render fires. The park sat at the live
    // bottom of a multi-item remnant, so the arrival of the taller dataset
    // re-engages follow (not the old gate latch from a key-cleared mark).
    items = Array.from({ length: 20 }, (_, i) => ({
      id: 100 + i,
      label: `it-${100 + i}`,
    }));
    rerender(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual(
      Array.from({ length: 10 }, (_, i) => `it-${110 + i}`),
    );

    // The new session streams: follow must work.
    items = Array.from({ length: 21 }, (_, i) => ({
      id: 100 + i,
      label: `it-${100 + i}`,
    }));
    rerender(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual(
      Array.from({ length: 10 }, (_, i) => `it-${111 + i}`),
    );
  });

  it('re-engages auto-follow when parked fitting content grows taller in place', async () => {
    // Streaming reply shape: useGeminiStream updates one pending item per
    // chunk and MainContent maps it at a constant array position, so the
    // reply crosses the container height at constant data.length. The
    // fit-boundary crossing must re-engage follow from the clamp-parked,
    // previously-fitting state for any growth shape, not only data.length
    // increases (#9305 review R14-1).
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
          containerHeight={10}
          width={40}
          showScrollbar={false}
        />
      );
    }

    const { lastFrame, rerender } = render(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    act(() => {
      listRef!.scrollBy(-5);
    });
    rerender(<Wrapper />);
    await act(async () => {});

    // Shrink in place until the content fits: clamp-parked at {0,0}.
    items = makeItems(8);
    rerender(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual(
      Array.from({ length: 8 }, (_, i) => `item-${i}`),
    );

    // In-place height growth that still fits must not yank the park.
    items = [...makeItems(7), { id: 7, label: 'tok-0\ntok-1' }];
    rerender(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual([
      ...Array.from({ length: 7 }, (_, i) => `item-${i}`),
      'tok-0',
      'tok-1',
    ]);

    // The streamed reply crosses the container height at constant
    // data.length: follow must re-engage.
    items = [...makeItems(7), { id: 7, label: 'tok-0\ntok-1\ntok-2\ntok-3' }];
    rerender(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual([
      ...Array.from({ length: 6 }, (_, i) => `item-${i + 1}`),
      'tok-0',
      'tok-1',
      'tok-2',
      'tok-3',
    ]);
  });

  it('re-engages auto-follow when a container shrink overflows parked fitting content', async () => {
    // Second crossing shape: the resize-to-fit park at {0,0} carries the
    // mark, then the terminal shrinks back below the content height. The
    // previously-fitting state overflows without any data.length change;
    // afterwards contentPreviouslyFit is false and the parked scrollTop is
    // not near the grown max scroll, so no other gate can bring follow
    // back — the crossing must re-engage it (#9305 review R14-1).
    type RefShape = VirtualizedListRef<Item>;
    let listRef: RefShape | null = null;
    const items = makeItems(20);
    let height = 10;

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
          containerHeight={height}
          width={40}
          showScrollbar={false}
        />
      );
    }

    const { lastFrame, rerender } = render(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    act(() => {
      listRef!.scrollBy(-5);
    });
    rerender(<Wrapper />);
    await act(async () => {});

    // Enlarge the terminal until the content fits: top-parked at {0,0}.
    height = 25;
    rerender(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual(
      Array.from({ length: 20 }, (_, i) => `item-${i}`),
    );

    // Shrink the terminal back below the content height: follow must
    // re-engage.
    height = 10;
    rerender(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual(
      Array.from({ length: 10 }, (_, i) => `item-${i + 10}`),
    );
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

  it('bottom-aligns changed content after measuring it at full viewport height', async () => {
    const liveItems = [{ id: -1, label: 'live' }];

    const { frames, lastFrame, rerender } = render(
      <VirtualizedList<Item>
        data={liveItems}
        renderItem={renderItem}
        estimatedItemHeight={estimatedItemHeight}
        keyExtractor={keyExtractor}
        initialScrollIndex={SCROLL_TO_ITEM_END}
        isStaticItem={(item) => item.id >= 0}
        containerHeight={5}
        width={40}
        showScrollbar={false}
      />,
    );

    const shortConfirmationItems = [{ id: -1, label: 'confirm' }];
    rerender(
      <VirtualizedList<Item>
        data={shortConfirmationItems}
        renderItem={renderItem}
        estimatedItemHeight={estimatedItemHeight}
        keyExtractor={keyExtractor}
        initialScrollIndex={SCROLL_TO_ITEM_END}
        isStaticItem={(item) => item.id >= 0}
        containerHeight={5}
        measureAtFullHeight
        width={40}
        showScrollbar={false}
      />,
    );
    await act(async () => {});
    // Bottom-aligned (#9300): the single confirmation sits at the container
    // bottom with blank rows above.
    expect(lastFrame()?.split('\n')).toEqual(['', '', '', '', 'confirm']);

    const longConfirmationItems = [
      { id: -1, label: ['confirm', 'line 2', 'line 3'].join('\n') },
    ];
    const frameCountBeforeLongContent = frames.length;
    rerender(
      <VirtualizedList<Item>
        data={longConfirmationItems}
        renderItem={renderItem}
        estimatedItemHeight={estimatedItemHeight}
        keyExtractor={keyExtractor}
        initialScrollIndex={SCROLL_TO_ITEM_END}
        isStaticItem={(item) => item.id >= 0}
        containerHeight={5}
        measureAtFullHeight
        width={40}
        showScrollbar={false}
      />,
    );
    await act(async () => {});

    expect(
      frames.slice(frameCountBeforeLongContent).map((frame) => frame.trimEnd()),
    ).not.toContain('confirm');
    // Bottom-aligned (#9300): 3-line content pinned to the 5-row bottom.
    expect(lastFrame()?.split('\n')).toEqual([
      '',
      '',
      'confirm',
      'line 2',
      'line 3',
    ]);
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

  it('clamps an out-of-range targetScrollIndex instead of freezing the walk-back', () => {
    const ref: RefObject<VirtualizedListRef<Item> | null> = { current: null };

    function Wrapper({ target }: { target: number }) {
      return (
        <VirtualizedList<Item>
          ref={ref}
          data={makeItems(10)}
          renderItem={renderItem}
          estimatedItemHeight={estimatedItemHeight}
          keyExtractor={keyExtractor}
          targetScrollIndex={target}
          containerHeight={4}
          width={40}
          showScrollbar={false}
        />
      );
    }

    const { rerender } = render(<Wrapper target={5} />);
    expect(ref.current).not.toBeNull();
    expect(ref.current!.getScrollIndex()).toBe(5);

    // SCROLL_TO_ITEM_END is Number.MAX_SAFE_INTEGER: unclamped, the
    // walk-back would compare undefined offsets ~9e15 times and freeze
    // the render phase instead of anchoring. Clamped to the last item,
    // its offset exceeds maxScroll, so the clamp effect re-anchors to the
    // bottom pixel — the same anchor scrollToIndex({ index: 9 }) resolves
    // to here.
    rerender(<Wrapper target={SCROLL_TO_ITEM_END} />);
    expect(ref.current!.getScrollIndex()).toBe(6);

    rerender(<Wrapper target={-5} />);
    expect(ref.current!.getScrollIndex()).toBe(0);
  });

  it('walks a mount-time targetScrollIndex anchor back to the run start', () => {
    const ref: RefObject<VirtualizedListRef<Item> | null> = { current: null };
    // Items 2..5 estimate 0, so their offsets coincide and index 4 sits
    // mid-run; the run's first item is index 2.
    const zeroRunEstimate = (i: number) => (i >= 2 && i <= 5 ? 0 : 2);

    function Wrapper() {
      return (
        <VirtualizedList<Item>
          ref={ref}
          data={makeItems(10)}
          renderItem={renderItem}
          estimatedItemHeight={zeroRunEstimate}
          keyExtractor={keyExtractor}
          targetScrollIndex={4}
          containerHeight={5}
          width={40}
          showScrollbar={false}
        />
      );
    }

    render(<Wrapper />);
    expect(ref.current).not.toBeNull();
    expect(ref.current!.getScrollIndex()).toBe(2);
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

  it('keeps the park mark across a re-key of the parked item (R18-1 F2)', async () => {
    // The park mark must survive a key transition of the item it sits on:
    // pending items re-key on commit (p-N → h-N), and the old key-based
    // validation cleared the mark while the user still sat at the parked
    // position. With the mark gone, the fit→overflow crossing arm (which
    // requires the parked signal) dies and the shrunken content clips
    // instead of re-engaging follow (#9305 review R18-1).
    type RefShape = VirtualizedListRef<Item>;
    let listRef: RefShape | null = null;
    let items = makeItems(20);
    let height = 10;

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
          containerHeight={height}
          width={40}
          showScrollbar={false}
        />
      );
    }

    const { lastFrame, rerender } = render(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    act(() => {
      listRef!.scrollBy(-5);
    });
    rerender(<Wrapper />);
    await act(async () => {});

    // Shrink in place until the remnant fits: the released park at {0,0}
    // installs the positional mark.
    items = makeItems(8);
    rerender(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual(
      Array.from({ length: 8 }, (_, i) => `item-${i}`),
    );

    // Re-key the parked item (pending → commit re-key keeps the position).
    items = [{ id: 900, label: 'item-0' }, ...makeItems(8).slice(1)];
    rerender(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual(
      Array.from({ length: 8 }, (_, i) => `item-${i}`),
    );

    // The container shrink crosses the fitting remnant into overflow: the
    // parked signal must survive the re-key so follow re-engages.
    height = 6;
    rerender(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual(
      Array.from({ length: 6 }, (_, i) => `item-${i + 2}`),
    );
  });

  it('re-engages follow when growth lands on a live-bottom park (R18-1 F7)', async () => {
    // An in-place shrink of a scrolled-away (bottom-pixels) viewport parks
    // it at the live bottom and installs the park mark. The park is not a
    // user scroll, so the very next render must not latch sticking — but
    // once new content arrives the park is the bottom of a live multi-item
    // conversation, and follow must come back. The old mark suppressed
    // every re-follow path forever: the whole next reply streamed below the
    // fold until a manual scroll (#9305 review R18-1).
    type RefShape = VirtualizedListRef<Item>;
    let listRef: RefShape | null = null;
    const tall = (n: number, from = 0): Item[] =>
      Array.from({ length: n }, (_, i) => ({
        id: from + i,
        label: `X${from + i}-0\nX${from + i}-1\nX${from + i}-2`,
      }));
    let items = tall(12);

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
          containerHeight={10}
          width={40}
          showScrollbar={false}
        />
      );
    }

    const { lastFrame, rerender } = render(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    act(() => {
      listRef!.scrollBy(-1);
    });
    rerender(<Wrapper />);
    await act(async () => {});

    // In-place shrink below the viewport (new keys: cached heights do not
    // shrink under a stable key): the re-anchor clamp parks the viewport
    // at the live bottom of the remnant.
    items = [
      ...Array.from({ length: 8 }, (_, i) => ({
        id: 100 + i,
        label: `x${i}`,
      })),
      ...tall(1, 8),
      ...Array.from({ length: 3 }, (_, i) => ({
        id: 109 + i,
        label: `x${9 + i}`,
      })),
    ];
    rerender(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual([
      'x4',
      'x5',
      'x6',
      'x7',
      'X8-0',
      'X8-1',
      'X8-2',
      'x9',
      'x10',
      'x11',
    ]);

    // Growth must re-engage follow from the live-bottom park.
    items = [...items, { id: 120, label: 'g0' }];
    rerender(<Wrapper />);
    rerender(<Wrapper />);
    await act(async () => {});

    expect((lastFrame() ?? '').split('\n')).toEqual([
      'x5',
      'x6',
      'x7',
      'X8-0',
      'X8-1',
      'X8-2',
      'x9',
      'x10',
      'x11',
      'g0',
    ]);
  });
});

// Hoisted to module scope so every harness rerender hands VirtualizedList
// the same element type and in-window items reconcile in place, matching
// production's stable `renderVirtualItem` over `memo(HistoryItemDisplay)`
// (MainContent). A component type rebuilt per evaluation would remount the
// whole window on every rerender and skip the persistent-mount path.
const ThoughtItem = ({
  item,
  index,
  thoughtHeadId,
  onRenderIndex,
}: {
  item: HistoryItem;
  index: number;
  thoughtHeadId: number | undefined;
  onRenderIndex?: (index: number) => void;
}) => {
  onRenderIndex?.(index);
  return (
    <HistoryItemDisplay
      terminalWidth={80}
      mainAreaWidth={80}
      availableTerminalHeight={40}
      item={item}
      isPending={false}
      thoughtHeadId={thoughtHeadId}
    />
  );
};

describe('<VirtualizedList /> VP collapsed thought groups', () => {
  const settings = {
    merged: { ui: { useTerminalBuffer: true, mouseTracking: false } },
  } as unknown as LoadedSettings;

  const line = (n: number) => `thought line ${n}`.padEnd(40, '.');
  const body = (seed: string, rows = 12) =>
    Array.from({ length: rows }, (_, i) => `${seed} ${line(i)}`).join('\n');

  const HEAD_ID = 1;
  const thoughtHistory = (
    rows: number,
    answerRows = 0,
    continuations = 3,
  ): HistoryItem[] => {
    const items: HistoryItem[] = [
      { id: 0, type: 'user', text: 'hello' },
      {
        id: HEAD_ID,
        type: 'gemini_thought',
        text: body('head', rows),
        durationMs: 101_000,
      } as HistoryItem,
    ];
    for (let i = 0; i < continuations; i++) {
      items.push({
        id: 2 + i,
        type: 'gemini_thought_content',
        text: body(`c${i + 1}`, rows),
      } as HistoryItem);
    }
    items.push({
      id: 2 + continuations,
      type: 'gemini',
      text: answerRows > 0 ? body('answer', answerRows) : 'final answer',
    });
    return items;
  };

  // Mirror production wiring (MainContent, AgentChatContent): derive the
  // group → head-id map from the fixture's own data instead of a
  // hardcoded lookup, so these tests validate the wiring production
  // actually produces.
  const renderThoughtItem = (
    data: HistoryItem[],
    onRenderIndex?: (index: number) => void,
  ) => {
    const headIdMap = buildThoughtHeadIdMap(data);
    const renderItem = ({
      item,
      index,
    }: {
      item: HistoryItem;
      index: number;
    }) => (
      <ThoughtItem
        item={item}
        index={index}
        thoughtHeadId={headIdMap.get(item)}
        onRenderIndex={onRenderIndex}
      />
    );
    return renderItem;
  };

  const thoughtTree = (
    expandedHeadIds: ReadonlySet<number>,
    ref: RefObject<VirtualizedListRef<HistoryItem> | null>,
    data: HistoryItem[],
    initialScrollIndex?: number,
    onRenderIndex?: (index: number) => void,
    targetScrollIndex?: number,
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
              renderItem={renderThoughtItem(data, onRenderIndex)}
              estimatedItemHeight={() => 3}
              keyExtractor={(item) => `h-${item.id}`}
              isStaticItem={() => true}
              initialScrollIndex={initialScrollIndex}
              targetScrollIndex={targetScrollIndex}
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
    // Collapsed state must still render the head summary, not an empty
    // window (the assertions above also hold for a blank frame).
    expect(lines.some((l) => l.includes('Thought for 1m 41s'))).toBe(true);
    // Bottom-aligned (#9300): the released height becomes blank space at the
    // TOP, and the collapsed summary sits at the bottom of the full 40-row
    // container (last row is content, not a gap between content and the
    // composer).
    expect(lines.length).toBe(40);
    expect(lines[lines.length - 1]!.trim()).not.toBe('');
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
    const data = thoughtHistory(12, 0, 5);
    const ref: RefObject<VirtualizedListRef<HistoryItem> | null> = {
      current: null,
    };
    const harness = render(
      thoughtTree(new Set([HEAD_ID]), ref, data, SCROLL_TO_ITEM_END),
    );
    await tick();
    await tick();

    // Collapse while the group is still mounted so all five
    // continuations measure 0 and cache it, then grow the answer: the
    // bottom-stuck viewport moves below the collapsed group and the
    // cached zeros persist off-screen.
    harness.rerender(thoughtTree(new Set(), ref, data, SCROLL_TO_ITEM_END));
    await tick();
    await tick();
    const tallData = thoughtHistory(12, 60, 5);
    harness.rerender(thoughtTree(new Set(), ref, tallData, SCROLL_TO_ITEM_END));
    await tick();
    await tick();

    // Scroll while still collapsed: the viewport top lands exactly on
    // the coincident-offset run while the cached zeros are stable.
    // scrollToIndex lands on the run's own offset; scrollTo(2) lands
    // before the run and heals via a whole-list mount instead.
    act(() => {
      ref.current?.scrollToIndex({ index: 2 });
    });
    await tick();
    await tick();

    // Re-expand: the render pass computing the window from the cached
    // zeros must mount the run's FIRST item. Indices render ascending
    // per pass, so the first descending step ends that first pass; a
    // one-step (`if`) or missing walk-back starts the window mid-run
    // and heals the run one item per pass. A `<=` walk-back collapses
    // the window to index 0 and mounts the whole list.
    const rendered: number[] = [];
    harness.rerender(
      thoughtTree(new Set([HEAD_ID]), ref, tallData, SCROLL_TO_ITEM_END, (i) =>
        rendered.push(i),
      ),
    );
    const firstPass: number[] = [];
    for (const i of rendered) {
      if (firstPass.length > 0 && i <= firstPass[firstPass.length - 1]) break;
      firstPass.push(i);
    }
    expect(firstPass).toEqual([2, 3, 4, 5, 6, 7]);
    for (let i = 0; i < 10; i++) {
      await tick();
    }

    // Every cached zero must be healed in this one pass: each unhealed
    // continuation leaves scrollHeight 12 rows short of the fully
    // healed total.
    // 137 = user(2) + expanded head(14) + 5×12 continuation rows + answer(61)
    expect(ref.current!.getScrollState().scrollHeight).toBe(137);
  });

  it('anchors to the first item of a cached-zero run so re-expand stays visible', async () => {
    const data = thoughtHistory(12);
    const ref: RefObject<VirtualizedListRef<HistoryItem> | null> = {
      current: null,
    };
    const harness = render(
      thoughtTree(new Set([HEAD_ID]), ref, data, SCROLL_TO_ITEM_END),
    );
    await tick();
    await tick();

    // Collapse so the continuations cache 0, then grow the answer to pin
    // the viewport bottom-stuck below the collapsed group.
    harness.rerender(thoughtTree(new Set(), ref, data, SCROLL_TO_ITEM_END));
    await tick();
    await tick();
    const tallData = thoughtHistory(12, 60);
    harness.rerender(thoughtTree(new Set(), ref, tallData, SCROLL_TO_ITEM_END));
    await tick();
    await tick();

    // Land the viewport top exactly on the coincident-offset run.
    act(() => {
      ref.current?.scrollToIndex({ index: 2 });
    });
    await tick();
    await tick();
    // findLastLE alone resolves to the run's LAST index (the answer);
    // the anchor must walk back to the run's first item.
    expect(ref.current!.getScrollIndex()).toBe(2);

    // Re-expand: the healed heights must not push the group's content
    // above the viewport.
    harness.rerender(
      thoughtTree(new Set([HEAD_ID]), ref, tallData, SCROLL_TO_ITEM_END),
    );
    await tick();
    for (let i = 0; i < 10; i++) {
      await tick();
    }
    expect((harness.lastFrame() ?? '').includes('c1 thought line 0')).toBe(
      true,
    );
  });

  it('re-expands to a non-empty healed frame after collapsing while scrolled', async () => {
    // Keyboard path from the #8570 real-TUI verification: expand, PageUp
    // away from the bottom, collapse (Alt+T), re-expand (Alt+T). The
    // collapse cascade walks the anchor to the top and re-engages
    // sticking-to-bottom; the re-expanded window must still cover the
    // bottom-stuck viewport instead of stranding it over unmounted
    // cached-zero continuations (a persistent all-blank frame that only
    // a scroll healed).
    const data = thoughtHistory(30, 4, 4);
    const ref: RefObject<VirtualizedListRef<HistoryItem> | null> = {
      current: null,
    };
    const harness = render(
      thoughtTree(new Set([HEAD_ID]), ref, data, SCROLL_TO_ITEM_END),
    );
    await tick();
    await tick();

    // PageUp (ScrollableList scrolls by one containerHeight); the group
    // is taller than the viewport, so this stays inside it.
    act(() => {
      ref.current?.scrollBy(-40);
    });
    await tick();
    await tick();
    expect(ref.current!.getScrollState().scrollTop).toBeGreaterThan(0);

    // Collapse while scrolled: continuations cache 0 as the cascade
    // walks the window up, ending with the shrunken content fitting the
    // container.
    harness.rerender(thoughtTree(new Set(), ref, data, SCROLL_TO_ITEM_END));
    for (let i = 0; i < 10; i++) {
      await tick();
    }
    const collapsed = harness.lastFrame() ?? '';
    expect(collapsed.includes('Thought for 1m 41s')).toBe(true);
    expect(collapsed.includes('answer thought line 0')).toBe(true);

    // Re-expand: the frame must not blank, and every cached zero must
    // heal back to the full expanded total.
    harness.rerender(
      thoughtTree(new Set([HEAD_ID]), ref, data, SCROLL_TO_ITEM_END),
    );
    for (let i = 0; i < 15; i++) {
      await tick();
    }
    const lines = (harness.lastFrame() ?? '').split('\n');
    expect(lines.filter((l) => l.trim() !== '').length).toBeGreaterThan(0);
    expect(/thought line|answer/.test(harness.lastFrame() ?? '')).toBe(true);
    // 159 = user(2) + expanded head(32) + 4×30 continuation rows + answer(5)
    expect(ref.current!.getScrollState().scrollHeight).toBe(159);
  });

  it('walks a mid-run targetScrollIndex anchor back to the first item of the run', async () => {
    const data = thoughtHistory(12, 0, 5);
    const ref: RefObject<VirtualizedListRef<HistoryItem> | null> = {
      current: null,
    };
    const harness = render(
      thoughtTree(new Set([HEAD_ID]), ref, data, SCROLL_TO_ITEM_END),
    );
    await tick();
    await tick();

    // Collapse so the continuations cache 0, then grow the answer to pin
    // the viewport bottom-stuck below the collapsed group.
    harness.rerender(thoughtTree(new Set(), ref, data, SCROLL_TO_ITEM_END));
    await tick();
    await tick();
    const tallData = thoughtHistory(12, 60, 5);
    harness.rerender(thoughtTree(new Set(), ref, tallData, SCROLL_TO_ITEM_END));
    await tick();
    await tick();

    // Target mid-run (collapsed continuations 2..6 share one offset):
    // the anchor must resolve to the run's FIRST item like every other
    // anchor path, or healing jumps scrollTop past the healed rows.
    harness.rerender(
      thoughtTree(new Set(), ref, tallData, SCROLL_TO_ITEM_END, undefined, 4),
    );
    await tick();
    await tick();
    expect(ref.current!.getScrollIndex()).toBe(2);

    // Re-expand: the healed run must stay visible at the viewport top
    // instead of being stranded above it.
    harness.rerender(
      thoughtTree(
        new Set([HEAD_ID]),
        ref,
        tallData,
        SCROLL_TO_ITEM_END,
        undefined,
        4,
      ),
    );
    for (let i = 0; i < 10; i++) {
      await tick();
    }
    expect((harness.lastFrame() ?? '').includes('c1 thought line 0')).toBe(
      true,
    );
  });
});
