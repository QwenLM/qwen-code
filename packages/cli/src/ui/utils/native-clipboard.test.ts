/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  CLIPBOARD_BUSY_MESSAGE,
  CLIPBOARD_READ_MARKER,
  createNativeClipboardBridge,
  type HelperResult,
  type NativeClipboardBridgeDeps,
} from './native-clipboard.js';

function bridge(
  module: Awaited<ReturnType<NativeClipboardBridgeDeps['loadModule']>>,
  helperResult: HelperResult | null = null,
) {
  const runHelper = vi.fn().mockResolvedValue(helperResult);
  return {
    value: createNativeClipboardBridge({
      loadModule: vi.fn().mockResolvedValue(module),
      runHelper,
    }),
    runHelper,
  };
}

describe('native clipboard bridge', () => {
  it('always writes through the Node helper', async () => {
    const setClipboardText = vi.fn();
    const { value, runHelper } = bridge(
      { setClipboardText },
      {
        code: 0,
        stdout: 'Somebody else owns the clipboard now\n',
        stderr: '',
      },
    );

    await expect(value.copyText('hello')).resolves.toBe(true);
    // clipboard-rs prints ownership diagnostics to stdout; the child's pipe
    // keeps them out of the TUI, so the in-process write must stay unused.
    expect(setClipboardText).not.toHaveBeenCalled();
    expect(runHelper).toHaveBeenCalledWith(expect.any(String), 'hello');
  });

  it('returns false when the write helper is unavailable', async () => {
    const { value } = bridge(null, null);
    await expect(value.copyText('hello')).resolves.toBe(false);
  });

  it('reads and normalizes text from the in-process addon', async () => {
    const { value } = bridge({
      getClipboardText: () => 'one\r\ntwo\rthree',
    });
    await expect(value.readText()).resolves.toBe('one\ntwo\nthree');
  });

  it('reads the Node helper stdout when the addon is unavailable', async () => {
    const { value, runHelper } = bridge(null, {
      code: 0,
      stdout: `${CLIPBOARD_READ_MARKER}from\r\nnode`,
      stderr: '',
    });
    await expect(value.readText()).resolves.toBe('from\nnode');
    expect(runHelper).toHaveBeenCalledWith(expect.any(String), null);
  });

  it('discards addon noise printed before the read marker', async () => {
    const { value } = bridge(null, {
      code: 0,
      stdout: `Somebody else owns the clipboard now\n${CLIPBOARD_READ_MARKER}payload`,
      stderr: '',
    });
    await expect(value.readText()).resolves.toBe('payload');
  });

  it('returns null when the helper output overflows', async () => {
    const { value } = bridge(null, {
      code: 0,
      stdout: 'partial',
      stderr: '',
      overflow: true,
    });
    await expect(value.readText()).resolves.toBeNull();
  });

  it('returns null for an empty clipboard or a failed helper', async () => {
    await expect(
      bridge({ getClipboardText: () => '' }).value.readText(),
    ).resolves.toBeNull();
    await expect(
      bridge(null, { code: 1, stdout: '', stderr: 'nope' }).value.readText(),
    ).resolves.toBeNull();
  });

  it('never returns the clipboard-ownership error as content', async () => {
    await expect(
      bridge({
        getClipboardText: () => CLIPBOARD_BUSY_MESSAGE,
      }).value.readText(),
    ).resolves.toBeNull();
    await expect(
      bridge(null, {
        code: 0,
        stdout: CLIPBOARD_BUSY_MESSAGE,
        stderr: '',
      }).value.readText(),
    ).resolves.toBeNull();
  });
});
