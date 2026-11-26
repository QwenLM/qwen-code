/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Text } from 'ink';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../test-utils/render.js';
import type { TextBuffer } from './text-buffer.js';
import {
  InputField,
  resolveInlineSelectionInputLayout,
} from './InputField.js';

function createBuffer(text: string): TextBuffer {
  return {
    text,
    lines: [text],
    cursor: [0, text.length],
    visualCursor: [0, text.length],
    visualScrollRow: 0,
    viewportVisualLines: [text],
    pastedContent: {},
    handleInput: vi.fn(),
  } as unknown as TextBuffer;
}

describe('InputField', () => {
  it('resolves the shared selection-input viewport', () => {
    expect(resolveInlineSelectionInputLayout(100)).toEqual({
      fieldWidth: 60,
      viewport: { width: 60, height: 2 },
    });
    expect(resolveInlineSelectionInputLayout(20)).toEqual({
      fieldWidth: 20,
      viewport: { width: 20, height: 2 },
    });
  });

  it('composes a prefix and placeholder inside the shared frame', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <InputField
        buffer={createBuffer('')}
        focus={false}
        prefix={<Text>&gt; </Text>}
        placeholder="Type here"
      />,
      { width: 30 },
    );

    expect(lastFrame()).toContain('> Type here');
    expect(lastFrame().trimEnd().split('\n')).toHaveLength(3);
    unmount();
  });

  it('renders selection-embedded input without a frame', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <InputField
        variant="inline"
        buffer={createBuffer('')}
        focus={false}
        placeholder="Type here"
        width={20}
      />,
      { width: 30 },
    );

    expect(lastFrame()).toContain('Type here');
    expect(lastFrame()).not.toContain('─');
    expect(lastFrame()).toMatch(/^Type here/);
    expect(lastFrame().trimEnd().split('\n')).toHaveLength(1);
    unmount();
  });

  it('masks visible characters without changing the buffer value', async () => {
    const buffer = createBuffer('secret');
    const { lastFrame, unmount } = await renderWithProviders(
      <InputField buffer={buffer} focus={false} mask="*" />,
      { width: 30 },
    );

    expect(lastFrame()).toContain('******');
    expect(lastFrame()).not.toContain('secret');
    expect(buffer.text).toBe('secret');
    unmount();
  });

  it('submits the unmasked buffer value', async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = await renderWithProviders(
      <InputField
        buffer={createBuffer('secret')}
        mask="*"
        onSubmit={onSubmit}
      />,
      { width: 30 },
    );

    await act(async () => {
      stdin.write('\r');
    });

    expect(onSubmit).toHaveBeenCalledWith('secret');
    unmount();
  });
});
