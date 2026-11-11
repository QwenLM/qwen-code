/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import { useRef, useState, useEffect } from 'react';
import { describe, expect, it } from 'vitest';
import { Box, Text, type DOMElement } from 'ink';
import { render } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';

const rows = (count: number) =>
  Array.from({ length: count }, (_, i) => <Text key={i}>row-{i}</Text>);

const visibleRows = (frame: string) =>
  frame
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

describe('<Box scrollTop>', () => {
  it('translates the content by the scrollTop prop', async () => {
    const { lastFrame, waitUntilReady, unmount } = await render(
      <Box overflowY="scroll" height={5} flexDirection="column" scrollTop={3}>
        <Box flexShrink={0} flexDirection="column">
          {rows(20)}
        </Box>
      </Box>,
    );
    await waitUntilReady();
    expect(visibleRows(lastFrame())).toEqual([
      'row-3',
      'row-4',
      'row-5',
      'row-6',
      'row-7',
    ]);
    unmount();
  });

  it('keeps a renderer-adjusted scrollTop until the prop value changes', async () => {
    let setLabel: (label: string) => void = () => {};
    let setScrollTop: (top: number) => void = () => {};
    let node: DOMElement | null = null;

    const Harness = () => {
      const ref = useRef<DOMElement>(null);
      const [label, setLabelState] = useState('a');
      const [scrollTop, setScrollTopState] = useState(3);
      setLabel = setLabelState;
      setScrollTop = setScrollTopState;
      useEffect(() => {
        node = ref.current;
      });
      return (
        <Box flexDirection="column">
          <Text>label-{label}</Text>
          <Box
            ref={ref}
            overflowY="scroll"
            height={5}
            flexDirection="column"
            scrollTop={scrollTop}
          >
            <Box flexShrink={0} flexDirection="column">
              {rows(20)}
            </Box>
          </Box>
        </Box>
      );
    };

    const { lastFrame, waitUntilReady, unmount } = await render(<Harness />);
    await waitUntilReady();
    expect(visibleRows(lastFrame())).toEqual([
      'label-a',
      'row-3',
      'row-4',
      'row-5',
      'row-6',
      'row-7',
    ]);

    // The renderer owns node.scrollTop between prop changes (clamping,
    // at-bottom follow). A commit that does not change the prop must not
    // re-assert the stale prop value over it.
    node!.scrollTop = 6;
    setLabel('b');
    await waitFor(() => {
      expect(lastFrame()).toContain('label-b');
    });
    await waitUntilReady();
    expect(visibleRows(lastFrame())).toEqual([
      'label-b',
      'row-6',
      'row-7',
      'row-8',
      'row-9',
      'row-10',
    ]);

    // A changed prop value wins again.
    setScrollTop(1);
    await waitFor(() => {
      expect(lastFrame()).toContain('row-1');
    });
    await waitUntilReady();
    expect(visibleRows(lastFrame())).toEqual([
      'label-b',
      'row-1',
      'row-2',
      'row-3',
      'row-4',
      'row-5',
    ]);
    unmount();
  });
});
