/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `VpScrollRegion` composes the real ScrollableList (-> VirtualizedList) and
// the real ShowMoreLines exactly as MainContent.tsx's VP branch does, so
// this exercises the real render tree rather than a mocked ScrollableList
// (MainContent.test.tsx mocks ScrollableList to test data-wiring; it cannot
// exercise the height math these tests cover).

import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { VpScrollRegion } from './MainContent.js';
import type { HistoryItem } from '../types.js';
import {
  useOverflowActions,
  OverflowProvider,
} from '../contexts/OverflowContext.js';
import { StreamingContext } from '../contexts/StreamingContext.js';
import { KeypressProvider } from '../contexts/KeypressContext.js';
import { StreamingState } from '../types.js';

vi.mock('../selection/use-text-selection.js', () => ({
  TextSelectionController: () => null,
}));

// One-line stub per item. The item flagged `registersOverflow` calls the
// exact same `addOverflowingId` a real MaxSizedBox calls when ITS OWN
// content (e.g. a long /about block) is truncated to fit its per-item
// height budget — this is what makes <ShowMoreLines> render its hint.
function StubItem({
  item,
}: {
  item: { id: number; registersOverflow?: boolean };
}) {
  const overflowActions = useOverflowActions();
  useEffect(() => {
    if (item.registersOverflow) {
      overflowActions?.addOverflowingId(`item-${item.id}`);
    }
  }, [item.registersOverflow, overflowActions, item.id]);
  return <Text>{`HISTORY:${item.id}`}</Text>;
}

const renderVpScrollRegion = (data: HistoryItem[], containerHeight: number) =>
  render(
    <KeypressProvider kittyProtocolEnabled={false}>
      <StreamingContext.Provider value={StreamingState.Idle}>
        <OverflowProvider>
          <VpScrollRegion
            data={data}
            renderItem={({ item }) => (
              <StubItem
                item={
                  item as unknown as {
                    id: number;
                    registersOverflow?: boolean;
                  }
                }
              />
            )}
            hasFocus={true}
            containerHeight={containerHeight}
            measureAtFullHeight={false}
            showScrollbar={false}
            constrainHeight={true}
          />
        </OverflowProvider>
      </StreamingContext.Provider>
    </KeypressProvider>,
  );

describe('VpScrollRegion height budget (issue #8239)', () => {
  it('keeps total rendered rows within containerHeight when an item overflows and the ctrl-s hint shows', async () => {
    const BUDGET = 5;
    const data = Array.from({ length: 10 }, (_, i) => ({
      id: i,
      // The last item — guaranteed to be in the visible window once
      // scrolled to the end — registers overflow, mirroring a long /about
      // block sitting at the bottom of history.
      registersOverflow: i === 9,
    })) as unknown as HistoryItem[];

    const { lastFrame, rerender } = renderVpScrollRegion(data, BUDGET);
    // Let the mounted item's useEffect (addOverflowingId) flush and the
    // resulting re-render settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    rerender(
      <KeypressProvider kittyProtocolEnabled={false}>
        <StreamingContext.Provider value={StreamingState.Idle}>
          <OverflowProvider>
            <VpScrollRegion
              data={data}
              renderItem={({ item }) => (
                <StubItem
                  item={
                    item as unknown as {
                      id: number;
                      registersOverflow?: boolean;
                    }
                  }
                />
              )}
              hasFocus={true}
              containerHeight={BUDGET}
              measureAtFullHeight={false}
              showScrollbar={false}
              constrainHeight={true}
            />
          </OverflowProvider>
        </StreamingContext.Provider>
      </KeypressProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const frame = lastFrame() ?? '';
    const lines = frame.split('\n');

    // The contract AppContainer relies on: this region must never render
    // more than `containerHeight` rows, because AppContainer computed the
    // footer's position assuming exactly that many rows are consumed above
    // it, and VP mode's alternate screen has no scrollback to reveal a row
    // that does not fit.
    expect({
      lineCount: lines.length,
      containsHint: frame.includes('Press ctrl-s to show more lines'),
    }).toEqual({
      lineCount: BUDGET,
      containsHint: true,
    });
  });

  it('does not waste a row reserving for the hint when nothing overflows', () => {
    const BUDGET = 5;
    const data = Array.from({ length: 10 }, (_, i) => ({
      id: i,
    })) as unknown as HistoryItem[];

    const { lastFrame } = renderVpScrollRegion(data, BUDGET);
    const frame = lastFrame() ?? '';
    const lines = frame.split('\n');

    // No overflow registered, so <ShowMoreLines> never renders — the list
    // should get the full budget, not budget-minus-one.
    expect({
      lineCount: lines.length,
      containsHint: frame.includes('Press ctrl-s to show more lines'),
    }).toEqual({
      lineCount: BUDGET,
      containsHint: false,
    });
  });
});
