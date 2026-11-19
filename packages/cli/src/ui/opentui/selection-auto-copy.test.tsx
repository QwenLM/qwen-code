/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Selection } from '@opentui/core';
import { useSelectionAutoCopy } from './selection-auto-copy.js';

const copyText = vi.hoisted(() => vi.fn());
vi.mock('./clipboard.js', () => ({ copyText }));

beforeEach(() => {
  copyText.mockReset();
  copyText.mockResolvedValue(true);
});

function setup() {
  let handler: ((selection: Selection) => void) | null = null;
  const renderer = {
    on: vi.fn((event: string, callback: (selection: Selection) => void) => {
      if (event === 'selection') handler = callback;
    }),
    off: vi.fn(),
  };
  const onCopied = vi.fn();
  const hook = renderHook(() =>
    useSelectionAutoCopy(renderer as never, onCopied),
  );
  const emit = async (text: string) => {
    await act(async () => {
      handler?.({ getSelectedText: () => text } as Selection);
      await Promise.resolve();
    });
  };
  return { ...hook, renderer, emit, onCopied };
}

describe('useSelectionAutoCopy', () => {
  it('copies selections from any region and reports the text', async () => {
    const { emit, onCopied } = setup();
    await emit('footer or dialog text');
    expect(copyText).toHaveBeenCalledWith('footer or dialog text');
    expect(onCopied).toHaveBeenCalledWith('footer or dialog text');
  });

  it('ignores whitespace-only selections', async () => {
    const { emit, onCopied } = setup();
    await emit('  \n ');
    expect(copyText).not.toHaveBeenCalled();
    expect(onCopied).not.toHaveBeenCalled();
  });

  it('does not report a failed clipboard write', async () => {
    copyText.mockResolvedValue(false);
    const { emit, onCopied } = setup();
    await emit('selected');
    expect(onCopied).not.toHaveBeenCalled();
  });

  it('unsubscribes on unmount', () => {
    const { renderer, unmount } = setup();
    unmount();
    expect(renderer.off).toHaveBeenCalledWith(
      'selection',
      expect.any(Function),
    );
  });
});
