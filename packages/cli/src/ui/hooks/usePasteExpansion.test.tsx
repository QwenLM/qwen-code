/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { renderHook } from '../../test-utils/render.js';
import { usePasteExpansion } from './usePasteExpansion.js';

describe('usePasteExpansion', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('initializes with no recent paste', async () => {
    const { result } = await renderHook(() => usePasteExpansion());
    expect(result.current.isRecentPaste()).toBe(false);
  });

  it('returns true when markUnsafePaste is called', async () => {
    const { result } = await renderHook(() => usePasteExpansion());
    act(() => {
      result.current.markUnsafePaste();
    });

    expect(result.current.isRecentPaste()).toBe(true);
  });

  it('auto-clears after the guard window', async () => {
    const { result } = await renderHook(() => usePasteExpansion());

    act(() => {
      result.current.markUnsafePaste();
    });
    expect(result.current.isRecentPaste()).toBe(true);

    act(() => {
      vi.advanceTimersByTime(40);
    });
    expect(result.current.isRecentPaste()).toBe(false);
  });

  it('resets the auto-clear timer on a second mark', async () => {
    const { result } = await renderHook(() => usePasteExpansion());

    act(() => {
      result.current.markUnsafePaste();
    });
    // 30ms elapses — still inside the window.
    act(() => {
      vi.advanceTimersByTime(30);
    });
    expect(result.current.isRecentPaste()).toBe(true);

    // Re-mark restarts the 40ms window.
    act(() => {
      result.current.markUnsafePaste();
    });
    expect(result.current.isRecentPaste()).toBe(true);

    // 30ms after the second mark — would have cleared if timer hadn't reset.
    act(() => {
      vi.advanceTimersByTime(30);
    });
    expect(result.current.isRecentPaste()).toBe(true);

    // 10ms more reaches the new window's end.
    act(() => {
      vi.advanceTimersByTime(10);
    });
    expect(result.current.isRecentPaste()).toBe(false);
  });
});
