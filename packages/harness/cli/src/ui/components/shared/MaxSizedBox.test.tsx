/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { render, renderWithProviders } from '../../../test-utils/render.js';
import { OverflowProvider } from '../../contexts/OverflowContext.js';
import { MaxSizedBox } from './MaxSizedBox.js';
import { MarkdownDisplay } from '../../utils/MarkdownDisplay.js';
import { Box, Text } from 'ink';
import { act } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('<MaxSizedBox />', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders children without truncation when they fit', async () => {
    const { lastFrame, waitUntilReady, unmount } = await render(
      <OverflowProvider>
        <MaxSizedBox maxWidth={80} maxHeight={10}>
          <Box>
            <Text>Hello, World!</Text>
          </Box>
        </MaxSizedBox>
      </OverflowProvider>,
    );
    await act(async () => {
      vi.runAllTimers();
    });
    await waitUntilReady();
    expect(lastFrame()).toContain('Hello, World!');
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it('shows hidden indicator when additionalHiddenLinesCount is provided (top overflow)', async () => {
    const { lastFrame, waitUntilReady, unmount } = await render(
      <OverflowProvider>
        <MaxSizedBox maxWidth={80} maxHeight={2} additionalHiddenLinesCount={2}>
          <Box flexDirection="column">
            <Text>Line 1</Text>
          </Box>
        </MaxSizedBox>
      </OverflowProvider>,
    );
    await act(async () => {
      vi.runAllTimers();
    });
    await waitUntilReady();
    expect(lastFrame()).toContain(
      '... first 2 lines hidden (Ctrl+O to show) ...',
    );
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it('shows hidden indicator at the end when overflowDirection is bottom', async () => {
    const { lastFrame, waitUntilReady, unmount } = await render(
      <OverflowProvider>
        <MaxSizedBox
          maxWidth={80}
          maxHeight={2}
          overflowDirection="bottom"
          additionalHiddenLinesCount={2}
        >
          <Box flexDirection="column">
            <Text>Line 1</Text>
          </Box>
        </MaxSizedBox>
      </OverflowProvider>,
    );
    await act(async () => {
      vi.runAllTimers();
    });
    await waitUntilReady();
    expect(lastFrame()).toContain(
      '... last 2 lines hidden (Ctrl+O to show) ...',
    );
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it('shows plural "lines" when more than one line is hidden', async () => {
    const { lastFrame, waitUntilReady, unmount } = await render(
      <OverflowProvider>
        <MaxSizedBox maxWidth={80} maxHeight={2} additionalHiddenLinesCount={2}>
          <Box flexDirection="column">
            <Text>Line 1</Text>
          </Box>
        </MaxSizedBox>
      </OverflowProvider>,
    );
    await act(async () => {
      vi.runAllTimers();
    });
    await waitUntilReady();
    expect(lastFrame()).toContain(
      '... first 2 lines hidden (Ctrl+O to show) ...',
    );
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it('shows singular "line" when exactly one line is hidden', async () => {
    const { lastFrame, waitUntilReady, unmount } = await render(
      <OverflowProvider>
        <MaxSizedBox maxWidth={80} maxHeight={2} additionalHiddenLinesCount={1}>
          <Box flexDirection="column">
            <Text>Line 1</Text>
          </Box>
        </MaxSizedBox>
      </OverflowProvider>,
    );
    await act(async () => {
      vi.runAllTimers();
    });
    await waitUntilReady();
    expect(lastFrame()).toContain(
      '... first 1 line hidden (Ctrl+O to show) ...',
    );
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it('uses additionalHiddenLinesCount directly for the indicator', async () => {
    const { lastFrame, waitUntilReady, unmount } = await render(
      <OverflowProvider>
        <MaxSizedBox maxWidth={80} maxHeight={2} additionalHiddenLinesCount={5}>
          <Box flexDirection="column">
            <Text>Line 1</Text>
            <Text>Line 2</Text>
            <Text>Line 3</Text>
          </Box>
        </MaxSizedBox>
      </OverflowProvider>,
    );
    await act(async () => {
      vi.runAllTimers();
    });
    await waitUntilReady();
    expect(lastFrame()).toContain(
      '... first 5 lines hidden (Ctrl+O to show) ...',
    );
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it('wraps text that exceeds maxWidth', async () => {
    const { lastFrame, waitUntilReady, unmount } = await render(
      <OverflowProvider>
        <MaxSizedBox maxWidth={10} maxHeight={5}>
          <Box>
            <Text wrap="wrap">This is a long line of text</Text>
          </Box>
        </MaxSizedBox>
      </OverflowProvider>,
    );

    await act(async () => {
      vi.runAllTimers();
    });
    await waitUntilReady();
    expect(lastFrame()).toContain('This is a');
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it('does not truncate when maxHeight is undefined', async () => {
    const { lastFrame, waitUntilReady, unmount } = await render(
      <OverflowProvider>
        <MaxSizedBox maxWidth={80} maxHeight={undefined}>
          <Box flexDirection="column">
            <Text>Line 1</Text>
            <Text>Line 2</Text>
          </Box>
        </MaxSizedBox>
      </OverflowProvider>,
    );
    await act(async () => {
      vi.runAllTimers();
    });
    await waitUntilReady();
    expect(lastFrame()).toContain('Line 1');
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it('renders an empty box for empty children', async () => {
    const { lastFrame, waitUntilReady, unmount } = await render(
      <OverflowProvider>
        <MaxSizedBox maxWidth={80} maxHeight={10}></MaxSizedBox>
      </OverflowProvider>,
    );
    await act(async () => {
      vi.runAllTimers();
    });
    await waitUntilReady();
    expect(lastFrame({ allowEmpty: true })?.trim()).equals('');
    unmount();
  });

  it('handles React.Fragment as a child', async () => {
    const { lastFrame, waitUntilReady, unmount } = await render(
      <OverflowProvider>
        <MaxSizedBox maxWidth={80} maxHeight={10}>
          <Box flexDirection="column">
            <>
              <Text>Line 1 from Fragment</Text>
              <Text>Line 2 from Fragment</Text>
            </>
            <Text>Line 3 direct child</Text>
          </Box>
        </MaxSizedBox>
      </OverflowProvider>,
    );
    await act(async () => {
      vi.runAllTimers();
    });
    await waitUntilReady();
    expect(lastFrame()).toContain('Line 1 from Fragment');
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it('clips content via Yoga maxHeight and shows indicator from top', async () => {
    const { lastFrame, waitUntilReady, unmount } = await render(
      <OverflowProvider>
        <MaxSizedBox
          maxWidth={80}
          maxHeight={10}
          overflowDirection="top"
          additionalHiddenLinesCount={21}
        >
          <Box>
            <Text>Visible content</Text>
          </Box>
        </MaxSizedBox>
      </OverflowProvider>,
    );

    await act(async () => {
      vi.runAllTimers();
    });
    await waitUntilReady();
    expect(lastFrame()).toContain(
      '... first 21 lines hidden (Ctrl+O to show) ...',
    );
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it('clips content via Yoga maxHeight and shows indicator from bottom', async () => {
    const { lastFrame, waitUntilReady, unmount } = await render(
      <OverflowProvider>
        <MaxSizedBox
          maxWidth={80}
          maxHeight={10}
          overflowDirection="bottom"
          additionalHiddenLinesCount={21}
        >
          <Box>
            <Text>Visible content</Text>
          </Box>
        </MaxSizedBox>
      </OverflowProvider>,
    );

    await act(async () => {
      vi.runAllTimers();
    });
    await waitUntilReady();
    expect(lastFrame()).toContain(
      '... last 21 lines hidden (Ctrl+O to show) ...',
    );
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it('does not show indicator when additionalHiddenLinesCount is 0', async () => {
    const { lastFrame, waitUntilReady, unmount } = await render(
      <OverflowProvider>
        <MaxSizedBox maxWidth={80} maxHeight={2}>
          <Box flexDirection="column">
            <Text>Line 1</Text>
            <Text>Line 2</Text>
            <Text>Line 3</Text>
          </Box>
        </MaxSizedBox>
      </OverflowProvider>,
    );
    await act(async () => {
      vi.runAllTimers();
    });
    await waitUntilReady();
    // No indicator shown — Yoga clips visually but no "hidden" message
    expect(lastFrame()).not.toContain('hidden');
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it('does not leak content after hidden indicator with bottom overflow', async () => {
    const markdownContent = Array.from(
      { length: 20 },
      (_, i) => `- Step ${i + 1}: Do something important`,
    ).join('\n');
    const { lastFrame, waitUntilReady, unmount } = await renderWithProviders(
      <MaxSizedBox
        maxWidth={80}
        maxHeight={5}
        overflowDirection="bottom"
        additionalHiddenLinesCount={16}
      >
        <MarkdownDisplay
          text={`## Plan\n\n${markdownContent}`}
          isPending={false}
          terminalWidth={76}
        />
      </MaxSizedBox>,
      { width: 80 },
    );

    await act(async () => {
      vi.runAllTimers();
    });
    await waitUntilReady();
    expect(lastFrame()).toContain('... last');

    const frame = lastFrame();
    const lines = frame.trim().split('\n');
    const lastLine = lines[lines.length - 1];

    // The last line should only contain the hidden indicator, no leaked content
    expect(lastLine).toMatch(
      /^\.\.\. last \d+ lines? hidden \(Ctrl\+O to show\) \.\.\.$/,
    );
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });
});
