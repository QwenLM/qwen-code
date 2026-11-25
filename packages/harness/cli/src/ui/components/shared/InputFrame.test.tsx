/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createElement, forwardRef } from 'react';
import { Text, useIsScreenReaderEnabled, type Box } from 'ink';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../test-utils/render.js';
import { theme } from '../../semantic-colors.js';
import { InputFrame, resolveInputFrameColor } from './InputFrame.js';

type BoxProps = React.ComponentProps<typeof Box>;

// The test renderer drops ANSI colors, so the label color is checked on the
// props the frame hands to Ink; render-border.test.ts covers the emitted codes.
const { boxProps } = vi.hoisted(() => ({
  boxProps: [] as Array<Record<string, unknown>>,
}));

vi.mock('ink', async () => {
  const actual = await vi.importActual<typeof import('ink')>('ink');
  const RecordingBox = forwardRef<unknown, Record<string, unknown>>(
    (props, ref) => {
      boxProps.push(props);
      return createElement(
        actual.Box as React.ComponentType<Record<string, unknown>>,
        { ...props, ref },
      );
    },
  );
  RecordingBox.displayName = 'RecordingBox';
  return {
    ...actual,
    Box: RecordingBox,
    useIsScreenReaderEnabled: vi.fn(() => false),
  };
});

describe('InputFrame', () => {
  beforeEach(() => {
    vi.mocked(useIsScreenReaderEnabled).mockReturnValue(false);
    boxProps.length = 0;
  });

  it('renders only top and bottom borders around transparent content', async () => {
    const { lastFrame, lastFrameRaw, unmount } = await renderWithProviders(
      <InputFrame width={20}>
        <Text>value</Text>
      </InputFrame>,
      { width: 20 },
    );

    const frame = lastFrame();
    const lines = frame.trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('─');
    expect(lines[1]).toContain('value');
    expect(lines[1]).not.toContain('│');
    expect(lines[2]).toContain('─');
    expect(lastFrameRaw()).not.toContain('\x1b[48;');
    unmount();
  });

  it('adds exactly two border rows around multiline content', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <InputFrame width={20}>
        <Text>{'first\nsecond'}</Text>
      </InputFrame>,
      { width: 20 },
    );

    expect(lastFrame().trimEnd().split('\n')).toHaveLength(4);
    unmount();
  });

  it('keeps content available without decorative borders for screen readers', async () => {
    vi.mocked(useIsScreenReaderEnabled).mockReturnValue(true);
    const { lastFrame, unmount } = await renderWithProviders(
      <InputFrame width={20}>
        <Text>accessible value</Text>
      </InputFrame>,
      { width: 20 },
    );

    expect(lastFrame()).toContain('accessible value');
    expect(lastFrame()).not.toContain('─');
    unmount();
  });

  it('embeds the title at the right end of the top border', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <InputFrame width={40} title="hello-world">
        <Text>value</Text>
      </InputFrame>,
      { width: 40 },
    );

    const top = lastFrame().split('\n')[0].trimEnd();
    expect(top).toHaveLength(40);
    expect(top.startsWith('─')).toBe(true);
    expect(top.endsWith('─ hello-world ─')).toBe(true);
    unmount();
  });

  it('colors the title with the accent color, not the border color', async () => {
    const { unmount } = await renderWithProviders(
      <InputFrame width={40} title="hello-world">
        <Text>value</Text>
      </InputFrame>,
      { width: 40 },
    );

    const frame = boxProps.find((props) => props['borderText']) as
      | BoxProps
      | undefined;
    expect(frame?.borderText).toMatchObject({
      content: 'hello-world',
      position: 'top',
      align: 'end',
      padding: 1,
      color: theme.text.accent,
    });
    expect(frame?.borderText?.color).not.toBe(frame?.borderColor);
    unmount();
  });

  it('truncates a long title and keeps a dash and a space on each side', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <InputFrame width={20} title="abcdefghijklmnopqrstuvwxyz0123">
        <Text>v</Text>
      </InputFrame>,
      { width: 20 },
    );

    expect(lastFrame().split('\n')[0].trimEnd()).toBe('─ abcdefghijklmno… ─');
    unmount();
  });

  it('draws a plain border when the frame is too narrow for a title', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <InputFrame width={4} title="hello-world">
        <Text>v</Text>
      </InputFrame>,
      { width: 4 },
    );

    expect(lastFrame().split('\n')[0].trimEnd()).toBe('────');
    unmount();
  });

  it('drops the title with the borders for screen readers', async () => {
    vi.mocked(useIsScreenReaderEnabled).mockReturnValue(true);
    const { lastFrame, unmount } = await renderWithProviders(
      <InputFrame width={40} title="hello-world">
        <Text>value</Text>
      </InputFrame>,
      { width: 40 },
    );

    expect(lastFrame()).toContain('value');
    expect(lastFrame()).not.toContain('hello-world');
    expect(lastFrame()).not.toContain('─');
    unmount();
  });

  it('resolves a visible low-color frame color', () => {
    expect(resolveInputFrameColor('black', true)).toMatch(/^#[0-9a-f]{6}$/i);
    expect(resolveInputFrameColor('white', true)).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
