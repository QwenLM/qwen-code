/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pins the idle-flush wiring: a notice deferred while a turn streams must
 * reach the transcript only when `streaming` flips false — flush is the only
 * drain of the handler's pendingNotifications (ink AppContainer parity).
 */

// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { updateEventEmitter } from '../../utils/updateEventEmitter.js';
import type { HistoryItemWithoutId } from '../types.js';
import { useUpdateNoticeFlush } from './use-update-notice-flush.js';

const added: string[] = [];
const addItem = vi.fn((item: HistoryItemWithoutId) => {
  const text = (item as { text?: string }).text;
  if (typeof text === 'string') added.push(text);
});
const setUpdateInfo = vi.fn();

afterEach(() => {
  added.length = 0;
  vi.clearAllMocks();
});

function boot(streaming: boolean, isIdle: boolean) {
  // Stable ref identity across renders, like the component's useRef.
  const isIdleRef = { current: isIdle };
  return renderHook(
    ({ streaming }) =>
      useUpdateNoticeFlush(addItem, setUpdateInfo, isIdleRef, streaming),
    { initialProps: { streaming } },
  );
}

describe('useUpdateNoticeFlush', () => {
  it('drains the deferred queue when streaming flips false', () => {
    const { rerender } = boot(true, false);
    act(() => {
      updateEventEmitter.emit('update-info', { message: 'Deferred notice' });
    });
    expect(added).toEqual([]);

    rerender({ streaming: false });
    expect(added).toEqual(['Deferred notice']);
  });

  it('delivers immediately when not streaming', () => {
    boot(false, true);
    act(() => {
      updateEventEmitter.emit('update-info', { message: 'Right away' });
    });
    expect(added).toEqual(['Right away']);
  });

  it('keeps the queue deferred across streaming rerenders', () => {
    const { rerender } = boot(true, false);
    act(() => {
      updateEventEmitter.emit('update-info', { message: 'Mid-turn notice' });
    });
    rerender({ streaming: true });
    expect(added).toEqual([]);

    rerender({ streaming: false });
    expect(added).toEqual(['Mid-turn notice']);
  });
});
