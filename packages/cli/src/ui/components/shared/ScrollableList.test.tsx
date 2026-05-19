/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { act } from '@testing-library/react';
import { Text } from 'ink';
import { ScrollableList } from './ScrollableList.js';
import { SCROLL_TO_ITEM_END } from './VirtualizedList.js';
import { KeypressProvider } from '../../contexts/KeypressContext.js';

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

describe('<ScrollableList /> mouse wheel', () => {
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

  it('does not move the rendered window on non-wheel mouse events', async () => {
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
      stdin.write(`${ESC}[<0;5;5M`); // left-press
      stdin.write(`${ESC}[<32;5;6M`); // drag
      stdin.write(`${ESC}[<0;5;6m`); // left-release
    });
    await act(async () => {});
    expect(lastFrame()).toBe(before);
  });
});
