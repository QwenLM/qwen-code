/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { MouseButton } from '@opentui/core';
import { handleTranscriptRightClick } from './transcript-mouse.js';

const event = (button: number) => ({
  button,
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
});

describe('handleTranscriptRightClick', () => {
  it('clears a scoped selection instead of pasting', () => {
    const e = event(MouseButton.RIGHT);
    const clearSelection = vi.fn();
    const pasteClipboard = vi.fn();

    expect(
      handleTranscriptRightClick(e, {
        hasSelection: true,
        clearSelection,
        pasteClipboard,
      }),
    ).toBe(true);
    expect(clearSelection).toHaveBeenCalledTimes(1);
    expect(pasteClipboard).not.toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(e.stopPropagation).toHaveBeenCalledTimes(1);
  });

  it('pastes when there is no selection', () => {
    const e = event(MouseButton.RIGHT);
    const clearSelection = vi.fn();
    const pasteClipboard = vi.fn();

    expect(
      handleTranscriptRightClick(e, {
        hasSelection: false,
        clearSelection,
        pasteClipboard,
      }),
    ).toBe(true);
    expect(pasteClipboard).toHaveBeenCalledTimes(1);
    expect(clearSelection).not.toHaveBeenCalled();
  });

  it('leaves left and middle clicks to their normal handlers', () => {
    const clearSelection = vi.fn();
    const pasteClipboard = vi.fn();
    for (const button of [MouseButton.LEFT, MouseButton.MIDDLE]) {
      const e = event(button);
      expect(
        handleTranscriptRightClick(e, {
          hasSelection: false,
          clearSelection,
          pasteClipboard,
        }),
      ).toBe(false);
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
    expect(clearSelection).not.toHaveBeenCalled();
    expect(pasteClipboard).not.toHaveBeenCalled();
  });
});
