/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { act } from '@testing-library/react';
import { Text } from 'ink';
import { ScrollableList } from './ScrollableList.js';
import { SCROLL_TO_ITEM_END } from './VirtualizedList.js';
import { KeypressProvider } from '../../contexts/KeypressContext.js';

vi.mock('../../utils/measure-element-position.js', () => ({
  measureElementPosition: () => ({ x: 0, y: 0, width: 40, height: 5 }),
}));

type Item = { id: number; label: string };

// `useKeypress` (called unconditionally inside ScrollableList) requires a
// KeypressProvider ancestor or it throws. Wrap every test render in one.
const withKeypress = (children: React.ReactNode) => (
  <KeypressProvider kittyProtocolEnabled={false}>{children}</KeypressProvider>
);

const makeItems = (n: number): Item[] =>
  Array.from({ length: n }, (_, i) => ({ id: i, label: `item-${i}` }));

const keyExtractor = (item: Item) => `k-${item.id}`;
const estimatedItemHeight = () => 1;

const ESC = '\x1b';
const wheelUp = (col = 1, row = 1) => `${ESC}[<64;${col};${row}M`;
const wheelDown = (col = 1, row = 1) => `${ESC}[<65;${col};${row}M`;
const leftPress = (col: number, row: number) => `${ESC}[<0;${col};${row}M`;
const leftDrag = (col: number, row: number) => `${ESC}[<32;${col};${row}M`;
const leftRelease = (col: number, row: number) => `${ESC}[<0;${col};${row}m`;

describe('<ScrollableList /> mouse scrolling', () => {
  it('routes wheel SGR events to viewport scroll (window shifts)', async () => {
    // When scrolled to top, item-0 is in the visible window; after enough
    // wheel-down events it should be scrolled out; wheel-up brings it back.
    const renderItem = ({ item }: { item: Item }) => <Text>{item.label}</Text>;

    const Wrapper = () => (
      <ScrollableList<Item>
        hasFocus
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

    const { stdin, lastFrame, rerender } = render(withKeypress(<Wrapper />));
    rerender(withKeypress(<Wrapper />));
    await act(async () => {});
    // Initially scrolled to top: item-0 .. item-4 visible.
    expect(lastFrame()).toContain('item-0');

    // Feed several wheel-down events.
    await act(async () => {
      for (let i = 0; i < 5; i++) stdin.write(wheelDown(5, 5));
    });
    await act(async () => {});
    // After scrolling down, item-0 should no longer be in the window.
    expect(lastFrame()).not.toContain('item-0');

    // Wheel back up to bring item-0 back into view.
    await act(async () => {
      for (let i = 0; i < 10; i++) stdin.write(wheelUp(5, 5));
    });
    await act(async () => {});
    expect(lastFrame()).toContain('item-0');
  });

  it('does not crash when hasFocus is false (mouse pipeline inactive)', () => {
    const renderItem = ({ item }: { item: Item }) => <Text>{item.label}</Text>;
    const Wrapper = () => (
      <ScrollableList<Item>
        hasFocus={false}
        data={makeItems(10)}
        renderItem={renderItem}
        estimatedItemHeight={estimatedItemHeight}
        keyExtractor={keyExtractor}
        containerHeight={5}
        width={40}
        showScrollbar={false}
      />
    );

    const { stdin, rerender } = render(withKeypress(<Wrapper />));
    rerender(withKeypress(<Wrapper />));
    expect(() => {
      stdin.write(wheelUp());
    }).not.toThrow();
  });

  it('does not move the rendered window on content-area clicks', async () => {
    const renderItem = ({ item }: { item: Item }) => <Text>{item.label}</Text>;
    const Wrapper = () => (
      <ScrollableList<Item>
        hasFocus
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

    const { stdin, lastFrame, rerender } = render(withKeypress(<Wrapper />));
    rerender(withKeypress(<Wrapper />));
    await act(async () => {});
    const before = lastFrame();

    await act(async () => {
      stdin.write(leftPress(5, 5));
      stdin.write(leftDrag(5, 6));
      stdin.write(leftRelease(5, 6));
    });
    await act(async () => {});
    expect(lastFrame()).toBe(before);
  });

  it('drags the scrollbar to scroll the viewport', async () => {
    const renderItem = ({ item }: { item: Item }) => <Text>{item.label}</Text>;
    const Wrapper = () => (
      <ScrollableList<Item>
        hasFocus
        data={makeItems(50)}
        renderItem={renderItem}
        estimatedItemHeight={estimatedItemHeight}
        keyExtractor={keyExtractor}
        initialScrollIndex={0}
        containerHeight={5}
        width={40}
        showScrollbar
      />
    );

    const { stdin, lastFrame, rerender } = render(withKeypress(<Wrapper />));
    rerender(withKeypress(<Wrapper />));
    await act(async () => {});
    expect(lastFrame()).toContain('item-0');

    await act(async () => {
      stdin.write(leftPress(40, 1));
      stdin.write(leftDrag(40, 5));
      stdin.write(leftRelease(40, 5));
    });
    await act(async () => {});

    expect(lastFrame()).not.toContain('item-0');
    expect(lastFrame()).toContain('item-49');
  });

  it('drags the scrollbar to an intermediate viewport position', async () => {
    const renderItem = ({ item }: { item: Item }) => <Text>{item.label}</Text>;
    const Wrapper = () => (
      <ScrollableList<Item>
        hasFocus
        data={makeItems(50)}
        renderItem={renderItem}
        estimatedItemHeight={estimatedItemHeight}
        keyExtractor={keyExtractor}
        initialScrollIndex={0}
        containerHeight={5}
        width={40}
        showScrollbar
      />
    );

    const { stdin, lastFrame, rerender } = render(withKeypress(<Wrapper />));
    rerender(withKeypress(<Wrapper />));
    await act(async () => {});
    expect(lastFrame()).toContain('item-0');

    await act(async () => {
      stdin.write(leftPress(40, 1));
      stdin.write(leftDrag(40, 3));
      stdin.write(leftRelease(40, 3));
    });
    await act(async () => {});

    expect(lastFrame()).not.toContain('item-0');
    expect(lastFrame()).toContain('item-23');
    expect(lastFrame()).not.toContain('item-49');
  });

  it('keeps dragging after the pointer leaves the scrollbar column', async () => {
    const renderItem = ({ item }: { item: Item }) => <Text>{item.label}</Text>;
    const Wrapper = () => (
      <ScrollableList<Item>
        hasFocus
        data={makeItems(50)}
        renderItem={renderItem}
        estimatedItemHeight={estimatedItemHeight}
        keyExtractor={keyExtractor}
        initialScrollIndex={0}
        containerHeight={5}
        width={40}
        showScrollbar
      />
    );

    const { stdin, lastFrame, rerender } = render(withKeypress(<Wrapper />));
    rerender(withKeypress(<Wrapper />));
    await act(async () => {});
    expect(lastFrame()).toContain('item-0');

    await act(async () => {
      stdin.write(leftPress(40, 1));
      stdin.write(leftDrag(35, 5));
      stdin.write(leftRelease(35, 5));
    });
    await act(async () => {});

    expect(lastFrame()).not.toContain('item-0');
    expect(lastFrame()).toContain('item-49');
  });

  it('does not start a scrollbar drag when content fits the viewport', async () => {
    const renderItem = ({ item }: { item: Item }) => <Text>{item.label}</Text>;
    const Wrapper = () => (
      <ScrollableList<Item>
        hasFocus
        data={makeItems(3)}
        renderItem={renderItem}
        estimatedItemHeight={estimatedItemHeight}
        keyExtractor={keyExtractor}
        initialScrollIndex={0}
        containerHeight={5}
        width={40}
        showScrollbar
      />
    );

    const { stdin, lastFrame, rerender } = render(withKeypress(<Wrapper />));
    rerender(withKeypress(<Wrapper />));
    await act(async () => {});
    const before = lastFrame();

    await act(async () => {
      stdin.write(leftPress(40, 1));
      stdin.write(leftDrag(40, 5));
      stdin.write(leftRelease(40, 5));
    });
    await act(async () => {});

    expect(lastFrame()).toBe(before);
  });
});

// ANSI escape sequences for keyboard scroll commands.
// Modifier encoding: CSI code ; (1 + modifier_bits) char
// shift = bit 0 → modifier param = 2; ctrl = bit 2 → modifier param = 5
const SHIFT_UP = `${ESC}[1;2A`;
const SHIFT_DOWN = `${ESC}[1;2B`;
const PAGE_UP = `${ESC}[5~`;
const PAGE_DOWN = `${ESC}[6~`;
const CTRL_HOME = `${ESC}[1;5H`;
const CTRL_END = `${ESC}[1;5F`;

describe('<ScrollableList /> keyboard scroll', () => {
  const renderItem = ({ item }: { item: Item }) => <Text>{item.label}</Text>;

  it('Shift+Up scrolls up by 1 line', async () => {
    const Wrapper = () => (
      <ScrollableList<Item>
        hasFocus
        data={makeItems(50)}
        renderItem={renderItem}
        estimatedItemHeight={estimatedItemHeight}
        keyExtractor={keyExtractor}
        initialScrollIndex={10}
        containerHeight={5}
        width={40}
        showScrollbar={false}
      />
    );

    const { stdin, lastFrame, rerender } = render(withKeypress(<Wrapper />));
    rerender(withKeypress(<Wrapper />));
    await act(async () => {});
    expect(lastFrame()).not.toContain('item-0');

    await act(async () => {
      for (let i = 0; i < 15; i++) stdin.write(SHIFT_UP);
    });
    await act(async () => {});
    expect(lastFrame()).toContain('item-0');
  });

  it('Shift+Down scrolls down by 1 line', async () => {
    const Wrapper = () => (
      <ScrollableList<Item>
        hasFocus
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

    const { stdin, lastFrame, rerender } = render(withKeypress(<Wrapper />));
    rerender(withKeypress(<Wrapper />));
    await act(async () => {});
    expect(lastFrame()).toContain('item-0');

    await act(async () => {
      for (let i = 0; i < 5; i++) stdin.write(SHIFT_DOWN);
    });
    await act(async () => {});
    expect(lastFrame()).not.toContain('item-0');
  });

  it('PageUp scrolls up by one page (containerHeight lines)', async () => {
    const Wrapper = () => (
      <ScrollableList<Item>
        hasFocus
        data={makeItems(50)}
        renderItem={renderItem}
        estimatedItemHeight={estimatedItemHeight}
        keyExtractor={keyExtractor}
        initialScrollIndex={20}
        containerHeight={5}
        width={40}
        showScrollbar={false}
      />
    );

    const { stdin, lastFrame, rerender } = render(withKeypress(<Wrapper />));
    rerender(withKeypress(<Wrapper />));
    await act(async () => {});
    expect(lastFrame()).not.toContain('item-0');

    // 4 PageUp with containerHeight=5 scrolls 20 lines → item-0 visible
    await act(async () => {
      for (let i = 0; i < 4; i++) stdin.write(PAGE_UP);
    });
    await act(async () => {});
    expect(lastFrame()).toContain('item-0');
  });

  it('PageDown scrolls down by one page', async () => {
    const Wrapper = () => (
      <ScrollableList<Item>
        hasFocus
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

    const { stdin, lastFrame, rerender } = render(withKeypress(<Wrapper />));
    rerender(withKeypress(<Wrapper />));
    await act(async () => {});
    expect(lastFrame()).toContain('item-0');

    await act(async () => {
      stdin.write(PAGE_DOWN);
    });
    await act(async () => {});
    expect(lastFrame()).not.toContain('item-0');
  });

  it('Ctrl+Home scrolls to the very top', async () => {
    const Wrapper = () => (
      <ScrollableList<Item>
        hasFocus
        data={makeItems(50)}
        renderItem={renderItem}
        estimatedItemHeight={estimatedItemHeight}
        keyExtractor={keyExtractor}
        initialScrollIndex={SCROLL_TO_ITEM_END}
        containerHeight={5}
        width={40}
        showScrollbar={false}
      />
    );

    const { stdin, lastFrame, rerender } = render(withKeypress(<Wrapper />));
    rerender(withKeypress(<Wrapper />));
    await act(async () => {});
    expect(lastFrame()).not.toContain('item-0');

    await act(async () => {
      stdin.write(CTRL_HOME);
    });
    await act(async () => {});
    expect(lastFrame()).toContain('item-0');
  });

  it('Ctrl+End scrolls to the very bottom', async () => {
    const Wrapper = () => (
      <ScrollableList<Item>
        hasFocus
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

    const { stdin, lastFrame, rerender } = render(withKeypress(<Wrapper />));
    rerender(withKeypress(<Wrapper />));
    await act(async () => {});
    expect(lastFrame()).toContain('item-0');

    await act(async () => {
      stdin.write(CTRL_END);
    });
    await act(async () => {});
    expect(lastFrame()).toContain('item-49');
  });
});
