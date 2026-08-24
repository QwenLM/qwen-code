/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `VpScrollRegion` composes the real ScrollableList (-> VirtualizedList) and
// the real ShowMoreLines the way MainContent's VP branch does, so this
// exercises the real render tree rather than a mocked ScrollableList
// (MainContent.test.tsx mocks ScrollableList to test data-wiring; it cannot
// exercise the height math these tests cover).
//
// The overflow condition is produced by a real MaxSizedBox — the only
// component in the codebase that registers an overflow id — rather than by
// calling addOverflowingId directly, so these tests cannot pass on a
// condition production never creates.

import type React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Box, Text } from 'ink';
import { VpScrollRegion } from './MainContent.js';
import { MaxSizedBox } from './shared/MaxSizedBox.js';
import type { HistoryItem } from '../types.js';
import { OverflowProvider } from '../contexts/OverflowContext.js';
import { StreamingContext } from '../contexts/StreamingContext.js';
import { KeypressProvider } from '../contexts/KeypressContext.js';
import { StreamingState } from '../types.js';

vi.mock('../selection/use-text-selection.js', () => ({
  TextSelectionController: () => null,
}));

const BUDGET = 8;

// Enough one-line items that the list fills its whole height budget — the
// only regime in which the budget can be exceeded at all, since
// VirtualizedList collapses its root to the content height when the content
// is shorter than the budget.
const items = Array.from({ length: 12 }, (_, i) => ({
  id: i + 1,
  type: 'user',
  text: `item ${i + 1}`,
})) as unknown as HistoryItem[];

const OVERFLOWING_ITEM_ID = 12;

const renderRegion = (opts: { withOverflowingItem: boolean }) => {
  const tree = (
    <KeypressProvider kittyProtocolEnabled={false}>
      <StreamingContext.Provider value={StreamingState.Idle}>
        <OverflowProvider>
          <VpScrollRegion
            data={items}
            renderItem={({ item }) => {
              const id = (item as unknown as { id: number }).id;
              if (opts.withOverflowingItem && id === OVERFLOWING_ITEM_ID) {
                // Truncates its content, so it registers a real overflow id
                // and ShowMoreLines renders — exactly what a long tool
                // output does in a real session.
                return (
                  <MaxSizedBox maxHeight={3} maxWidth={60}>
                    {Array.from({ length: 20 }, (_, i) => (
                      <Box key={i}>
                        <Text>{`out ${i}`}</Text>
                      </Box>
                    ))}
                  </MaxSizedBox>
                );
              }
              return <Text>{`ITEM${id}`}</Text>;
            }}
            hasFocus={true}
            containerHeight={BUDGET}
            measureAtFullHeight={false}
            showScrollbar={false}
            constrainHeight={true}
          />
        </OverflowProvider>
      </StreamingContext.Provider>
    </KeypressProvider>
  );
  return { tree, ...render(tree) };
};

const settle = async (
  rerender: (t: React.ReactElement) => void,
  tree: React.ReactElement,
) => {
  const tick = () => new Promise<void>((r) => setImmediate(r));
  await tick();
  rerender(tree);
  await tick();
  await tick();
};

describe('VpScrollRegion height budget', () => {
  it('stays within containerHeight when a truncated item makes the ctrl-s hint render', async () => {
    const { tree, lastFrame, rerender } = renderRegion({
      withOverflowingItem: true,
    });
    await settle(rerender, tree);

    const frame = lastFrame() ?? '';
    const lines = frame.split('\n');

    // The hint must actually be on screen — otherwise this test would pass
    // trivially without exercising the reservation at all.
    expect(frame).toContain('Press ctrl-s to show more lines');
    // AppContainer positions the composer assuming this region consumes at
    // most `containerHeight` rows, and VP mode's alternate screen has no
    // scrollback to reveal a row that does not fit. Without the reservation
    // this renders BUDGET + 1.
    expect(lines.length).toBeLessThanOrEqual(BUDGET);
  });

  it('uses the full budget when nothing overflows', async () => {
    const { tree, lastFrame, rerender } = renderRegion({
      withOverflowingItem: false,
    });
    await settle(rerender, tree);

    const frame = lastFrame() ?? '';
    const lines = frame.split('\n');

    // No overflow registered, so no hint and no row reserved for one.
    expect(frame).not.toContain('Press ctrl-s to show more lines');
    expect(lines.length).toBe(BUDGET);
  });
});
