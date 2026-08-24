/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Hook-level tests for useDialogSelect: the numeric quick-select timer
 * lifecycle and the resyncKey cursor re-sync.
 */

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
});
