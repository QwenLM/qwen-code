/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

/**
 * Hook-level tests for the mirror every dialog list reads inside a key burst:
 * useBatchSafeCursor for a numeric cursor, useBatchSafeState for any other
 * value.
 */

import { act, renderHook } from '@testing-library/react';
import { describe, it, expect } from 'vitest';

import { useBatchSafeCursor, useBatchSafeState } from './batch-cursor.js';

describe('useBatchSafeCursor', () => {
  it('publishes each write to the mirror before the next one reads it', () => {
    const { result } = renderHook(() => useBatchSafeCursor());
    // One React batch, the way the renderer delivers a held arrow: no
    // re-render lands between the writes.
    act(() => {
      result.current.setCursor(result.current.cursorRef.current + 1);
      result.current.setCursor(result.current.cursorRef.current + 1);
      result.current.setCursor(result.current.cursorRef.current + 1);
    });
    expect(result.current.cursor).toBe(3);
  });

  it('honours a lazy initial value', () => {
    const { result } = renderHook(() => useBatchSafeCursor(() => 7));
    expect(result.current.cursor).toBe(7);
    expect(result.current.cursorRef.current).toBe(7);
  });
});

describe('useBatchSafeState', () => {
  it('publishes a non-numeric write to the mirror before the next one reads it', () => {
    const { result } = renderHook(() =>
      useBatchSafeState<'a' | 'b' | 'c'>('a'),
    );
    const next = { a: 'b', b: 'c', c: 'a' } as const;
    act(() => {
      result.current.setValue(next[result.current.ref.current]);
      result.current.setValue(next[result.current.ref.current]);
    });
    // Stepping off the state value instead would stop at 'b': both writes
    // would read what the render before the burst held.
    expect(result.current.value).toBe('c');
  });

  it('honours a lazy initial value', () => {
    const { result } = renderHook(() =>
      useBatchSafeState<ReadonlySet<string>>(() => new Set(['a'])),
    );
    expect([...result.current.value]).toEqual(['a']);
    expect([...result.current.ref.current]).toEqual(['a']);
  });

  it('pulls a drifted mirror back to the value on the next render', () => {
    const { result, rerender } = renderHook(() => useBatchSafeState('keep'));
    act(() => {
      result.current.ref.current = 'drifted';
    });
    expect(result.current.ref.current).toBe('drifted');

    rerender();

    expect(result.current.ref.current).toBe('keep');
    expect(result.current.value).toBe('keep');
  });
});
