// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeClipboardText } from './clipboard.js';

describe('writeClipboardText (issue #9485)', () => {
  let clipboardDescriptor: PropertyDescriptor | undefined;
  let originalExecCommand: Document['execCommand'] | undefined;

  afterEach(() => {
    if (clipboardDescriptor) {
      Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
      clipboardDescriptor = undefined;
    } else {
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
    if (originalExecCommand !== undefined) {
      document.execCommand = originalExecCommand;
      originalExecCommand = undefined;
    }
  });

  const captureClipboard = () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    clipboardDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      'clipboard',
    );
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    return writeText;
  };

  const captureExecCommand = () => {
    const execCommand = vi.fn().mockReturnValue(true);
    originalExecCommand = document.execCommand;
    document.execCommand = execCommand;
    return execCommand;
  };

  it('prefers the async Clipboard API when available', async () => {
    const writeText = captureClipboard();
    const execCommand = captureExecCommand();

    await writeClipboardText('hello');

    expect(writeText).toHaveBeenCalledWith('hello');
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('falls back to execCommand when the Clipboard API is missing', async () => {
    delete (navigator as { clipboard?: unknown }).clipboard;
    const execCommand = captureExecCommand();

    await writeClipboardText('hello fallback');

    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('falls back to execCommand when the Clipboard API rejects', async () => {
    clipboardDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      'clipboard',
    );
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockRejectedValue(new Error('denied')),
      },
    });
    const execCommand = captureExecCommand();

    await writeClipboardText('hello fallback');

    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('rejects with an actionable error when no mechanism works', async () => {
    delete (navigator as { clipboard?: unknown }).clipboard;
    originalExecCommand = document.execCommand;
    document.execCommand = vi.fn().mockReturnValue(false);

    await expect(writeClipboardText('hello')).rejects.toThrow(
      /secure context/i,
    );
  });
});
