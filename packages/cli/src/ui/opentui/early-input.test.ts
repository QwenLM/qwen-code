/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  decodeCapturedInput,
  drainCapturedInputAsText,
  injectCapturedInput,
} from './early-input.js';
import { resetCaptureState } from '../../utils/earlyInputCapture.js';

describe('decodeCapturedInput', () => {
  it('returns empty for an empty buffer', () => {
    expect(decodeCapturedInput(Buffer.alloc(0))).toBe('');
  });

  it('keeps printable text and spaces', () => {
    expect(decodeCapturedInput(Buffer.from('hello world'))).toBe('hello world');
  });

  it('keeps newlines but strips carriage returns', () => {
    expect(decodeCapturedInput(Buffer.from('line1\nline2\r'))).toBe(
      'line1\nline2',
    );
  });

  it('strips Ctrl+C and other C0 control bytes', () => {
    expect(decodeCapturedInput(Buffer.from('ab\x03cd\x7f'))).toBe('abcd');
  });

  it('strips CSI escape sequences (arrow keys, etc.)', () => {
    expect(decodeCapturedInput(Buffer.from('x\u001B[Ay\u001B[1;5Cz'))).toBe(
      'xyz',
    );
  });

  it('strips SS3 function-key sequences whole (F1-F4) instead of leaking the payload', () => {
    // The capture filter preserves ESC O P/Q/R/S as user input, so decoding
    // must remove the whole sequence: the C0 pass would otherwise drop only
    // the bare ESC and leave the O+letter in the composer (R1-74).
    expect(
      decodeCapturedInput(Buffer.from('a\u001BOPb\u001BOQc\u001BORd\u001BOSe')),
    ).toBe('abcde');
  });

  it('preserves multibyte (CJK) input', () => {
    expect(decodeCapturedInput(Buffer.from('你好，世界'))).toBe('你好，世界');
  });
});

describe('drainCapturedInputAsText', () => {
  afterEach(() => resetCaptureState());

  it('returns empty string when nothing was captured', () => {
    resetCaptureState();
    expect(drainCapturedInputAsText()).toBe('');
  });
});

describe('injectCapturedInput', () => {
  afterEach(() => vi.useRealTimers());

  it('injects text once the composer handle appears', () => {
    vi.useFakeTimers();
    const setTimeoutFn = (fn: () => void, ms: number) => setTimeout(fn, ms);
    const clearTimeoutFn = (h: unknown) =>
      clearTimeout(h as ReturnType<typeof setTimeout>);

    let handle: { setText: (t: string) => void } | null = null;
    const setText = vi.fn();

    injectCapturedInput(() => handle, 'hello', {
      intervalMs: 10,
      maxAttempts: 5,
      setTimeoutFn,
      clearTimeoutFn,
    });

    // Not attached yet: nothing written.
    vi.advanceTimersByTime(10);
    expect(setText).not.toHaveBeenCalled();

    handle = { setText };
    vi.advanceTimersByTime(10);
    expect(setText).toHaveBeenCalledWith('hello');
  });

  it('does nothing for empty text', () => {
    const setTimeoutFn = vi.fn();
    const dispose = injectCapturedInput(() => null, '', { setTimeoutFn });
    expect(setTimeoutFn).not.toHaveBeenCalled();
    dispose();
  });

  it('stops retrying after maxAttempts without a handle', () => {
    vi.useFakeTimers();
    const setTimeoutFn = (fn: () => void, ms: number) => setTimeout(fn, ms);
    const clearTimeoutFn = (h: unknown) =>
      clearTimeout(h as ReturnType<typeof setTimeout>);
    const dispose = injectCapturedInput(() => null, 'x', {
      intervalMs: 1,
      maxAttempts: 2,
      setTimeoutFn,
      clearTimeoutFn,
    });
    // Should not throw or loop forever; disposing is a no-op afterwards.
    vi.advanceTimersByTime(100);
    dispose();
  });
});
