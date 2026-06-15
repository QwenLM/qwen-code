/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBatchedScroll } from './useBatchedScroll.js';

describe('useBatchedScroll', () => {
  it('returns the current scrollTop initially when no pending value is set', () => {
    const { result } = renderHook(() => useBatchedScroll(42));
    expect(result.current.getScrollTop()).toBe(42);
  });

  it('returns the pending value as soon as setPendingScrollTop is called within the same tick', () => {
    const { result } = renderHook(() => useBatchedScroll(10));
    act(() => {
      result.current.setPendingScrollTop(123);
    });
    expect(result.current.getScrollTop()).toBe(123);
  });

  it('clears the pending value after a commit, falling back to the latest currentScrollTop', () => {
    const { result, rerender } = renderHook(
      ({ scroll }: { scroll: number }) => useBatchedScroll(scroll),
      { initialProps: { scroll: 0 } },
    );
    act(() => {
      result.current.setPendingScrollTop(500);
    });
    expect(result.current.getScrollTop()).toBe(500);

    // Commit a new scrollTop: the layout effect must reset the pending value
    // so subsequent reads see the freshly-committed currentScrollTop.
    rerender({ scroll: 99 });
    expect(result.current.getScrollTop()).toBe(99);
  });

  it('keeps getScrollTop / setPendingScrollTop identity stable across rerenders', () => {
    const { result, rerender } = renderHook(
      ({ scroll }: { scroll: number }) => useBatchedScroll(scroll),
      { initialProps: { scroll: 0 } },
    );
    const firstGet = result.current.getScrollTop;
    const firstSet = result.current.setPendingScrollTop;
    rerender({ scroll: 1 });
    rerender({ scroll: 2 });
    expect(result.current.getScrollTop).toBe(firstGet);
    expect(result.current.setPendingScrollTop).toBe(firstSet);
  });
});
