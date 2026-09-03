/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Hook-level tests for useDialogSelect: the numeric quick-select timer
 * lifecycle and the resyncKey cursor re-sync.
 */

import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const handlers = vi.hoisted(
  () => [] as Array<(key: { name: string; sequence?: string }) => void>,
);

vi.mock('@opentui/react', () => ({
  useKeyboard: (
    handler: (key: { name: string; sequence?: string }) => void,
  ) => {
    handlers.push(handler);
  },
}));

// theme.ts builds a SyntaxStyle at module scope; the native FFI is
// unavailable in the test runtime.
vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));

import { useDialogSelect } from './dialogs-shared.js';
import { NUMBER_SELECT_TIMEOUT_MS } from './dialogs-core.js';

const items = Array.from({ length: 15 }, (_, i) => ({
  key: `item-${i}`,
  value: `item-${i}`,
}));

const press = (key: { name: string; sequence?: string }) => {
  const handler = handlers[handlers.length - 1];
  if (!handler) throw new Error('no keyboard handler registered');
  act(() => handler(key));
};

describe('useDialogSelect numeric quick-select', () => {
  beforeEach(() => {
    handlers.length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes the pending single-digit selection on timeout', () => {
    const onSelect = vi.fn();
    renderHook(() => useDialogSelect({ items, numbers: true, onSelect }));
    press({ name: '1', sequence: '1' });
    act(() => {
      vi.advanceTimersByTime(NUMBER_SELECT_TIMEOUT_MS + 10);
    });
    expect(onSelect).toHaveBeenCalledWith('item-0');
  });

  it('disarms the pending flush when a follow-up digit is invalid', () => {
    const onSelect = vi.fn();
    renderHook(() => useDialogSelect({ items, numbers: true, onSelect }));
    press({ name: '1', sequence: '1' });
    // '19' is out of range: the buffer resets and the pending timer must
    // not fire a stale commit of the pre-digit highlight.
    press({ name: '9', sequence: '9' });
    act(() => {
      vi.advanceTimersByTime(NUMBER_SELECT_TIMEOUT_MS + 10);
    });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('fires onSelect exactly once on the timeout flush (R2-1, StrictMode)', () => {
    const onSelect = vi.fn();
    const Wrapper = ({ children }: { children: React.ReactNode }) => (
      <React.StrictMode>{children}</React.StrictMode>
    );
    renderHook(() => useDialogSelect({ items, numbers: true, onSelect }), {
      wrapper: Wrapper,
    });
    press({ name: '1', sequence: '1' });
    act(() => {
      vi.advanceTimersByTime(NUMBER_SELECT_TIMEOUT_MS + 10);
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('item-0');
  });
});

describe('useDialogSelect setActiveIndex (ink SET_ACTIVE_INDEX parity)', () => {
  beforeEach(() => {
    handlers.length = 0;
  });

  it('setActiveIndex can land on a disabled row (R2-2)', () => {
    const mixed = [
      { key: 'a', value: 'a' },
      { key: 'b', value: 'b', disabled: true },
      { key: 'c', value: 'c' },
    ];
    const { result } = renderHook(() =>
      useDialogSelect({ items: mixed, numbers: false }),
    );
    expect(result.current.activeIndex).toBe(0);
    // A one-row step toward the disabled row must not get stuck — ink's
    // SET_ACTIVE_INDEX accepts any in-range index.
    act(() => result.current.setActiveIndex(1));
    expect(result.current.activeIndex).toBe(1);
    act(() => result.current.setActiveIndex(2));
    expect(result.current.activeIndex).toBe(2);
  });

  it('highlightIndex still skips disabled rows (arrow-key semantics)', () => {
    const mixed = [
      { key: 'a', value: 'a' },
      { key: 'b', value: 'b', disabled: true },
      { key: 'c', value: 'c' },
    ];
    const { result } = renderHook(() =>
      useDialogSelect({ items: mixed, numbers: false }),
    );
    act(() => result.current.highlightIndex(1));
    expect(result.current.activeIndex).toBe(0);
  });
});

describe('useDialogSelect resyncKey', () => {
  beforeEach(() => {
    handlers.length = 0;
  });

  it('re-applies initialIndex when the key changes, not on every render', () => {
    const onSelect = vi.fn();
    const { result, rerender } = renderHook(
      (props: { resyncKey: string; initialIndex: number }) =>
        useDialogSelect({ items, numbers: false, onSelect, ...props }),
      { initialProps: { resyncKey: 'mount', initialIndex: 0 } },
    );
    expect(result.current.activeIndex).toBe(0);

    rerender({ resyncKey: 'scope-select', initialIndex: 1 });
    expect(result.current.activeIndex).toBe(1);

    // The user moves within the re-synced view; same key must not reset.
    press({ name: 'down' });
    expect(result.current.activeIndex).toBe(2);
    rerender({ resyncKey: 'scope-select', initialIndex: 1 });
    expect(result.current.activeIndex).toBe(2);
  });

  it('disarms an armed numeric flush on view swap (R4-3)', () => {
    vi.useFakeTimers();
    try {
      const onSelect = vi.fn();
      const { rerender } = renderHook(
        (props: { resyncKey: string }) =>
          useDialogSelect({ items, numbers: true, onSelect, ...props }),
        { initialProps: { resyncKey: 'mount' } },
      );
      // Arm a digit flush in the first view.
      press({ name: '1', sequence: '1' });
      // Tab to another view before the flush timeout fires.
      rerender({ resyncKey: 'scope-select' });
      act(() => {
        vi.advanceTimersByTime(NUMBER_SELECT_TIMEOUT_MS + 10);
      });
      // The stale flush must not commit a selection in the new view.
      expect(onSelect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('useDialogSelect items re-sync (ink INITIALIZE parity)', () => {
  beforeEach(() => {
    handlers.length = 0;
  });

  it('clamps the cursor when the list shrinks below activeIndex', () => {
    const onSelect = vi.fn();
    const shrinking = items.slice(0, 3);
    const { result, rerender } = renderHook(
      (props: { items: typeof items }) =>
        useDialogSelect({ items: props.items, numbers: false, onSelect }),
      { initialProps: { items: shrinking } },
    );
    press({ name: 'down' });
    press({ name: 'down' });
    expect(result.current.activeIndex).toBe(2);

    // Uninstalling the last row: the cursor's item key is gone, ink falls
    // back to the initial index instead of stranding it past the end.
    rerender({ items: items.slice(0, 2) });
    expect(result.current.activeIndex).toBe(0);
    // Enter on the clamped cursor still selects a real row.
    press({ name: 'return' });
    expect(onSelect).toHaveBeenCalledWith('item-0');
  });

  it('follows the active item by key when the list is reordered', () => {
    const onSelect = vi.fn();
    const { result, rerender } = renderHook(
      (props: { items: typeof items }) =>
        useDialogSelect({ items: props.items, numbers: false, onSelect }),
      { initialProps: { items: items.slice(0, 3) } },
    );
    press({ name: 'down' });
    expect(result.current.activeIndex).toBe(1);

    // item-1 moves to the front; the cursor follows the item, not the slot.
    rerender({ items: [items[1]!, items[0]!, items[2]!] });
    expect(result.current.activeIndex).toBe(0);
  });

  it('keeps the slot when a new array has the same key at the same index', () => {
    const onSelect = vi.fn();
    const { result, rerender } = renderHook(
      (props: { items: typeof items }) =>
        useDialogSelect({ items: props.items, numbers: false, onSelect }),
      { initialProps: { items: items.slice(0, 3) } },
    );
    press({ name: 'down' });
    expect(result.current.activeIndex).toBe(1);

    rerender({ items: [...items.slice(0, 3)] });
    expect(result.current.activeIndex).toBe(1);
  });
});
