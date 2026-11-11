/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '../../test-utils/render.js';
import {
  appEvents,
  AppEvent,
  TransientMessageType,
} from '../../utils/events.js';
import { useTransientMessage } from './useTransientMessage.js';

describe('useTransientMessage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows event messages and clears them after the default duration', async () => {
    const { result, unmount } = await renderHook(() =>
      useTransientMessage(3_000),
    );

    act(() => {
      appEvents.emit(AppEvent.TransientMessage, {
        message: 'Temporary warning',
        type: TransientMessageType.Warning,
      });
    });
    expect(result.current[0]).toMatchObject({
      text: 'Temporary warning',
      type: TransientMessageType.Warning,
    });

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(result.current[0]).toBeNull();
    unmount();
  });

  it('honors a message-specific duration', async () => {
    const { result, unmount } = await renderHook(() =>
      useTransientMessage(3_000),
    );

    act(() => {
      appEvents.emit(AppEvent.TransientMessage, {
        message: 'Long success',
        type: TransientMessageType.Success,
        durationMs: 10_000,
      });
      vi.advanceTimersByTime(3_000);
    });
    expect(result.current[0]?.text).toBe('Long success');

    act(() => {
      vi.advanceTimersByTime(7_000);
    });
    expect(result.current[0]).toBeNull();
    unmount();
  });

  it('clears only the active message with the matching id', async () => {
    const { result, unmount } = await renderHook(() =>
      useTransientMessage(3_000),
    );

    act(() => {
      appEvents.emit(AppEvent.TransientMessage, {
        id: 'credit-warning',
        message: 'Credits exhausted',
        type: TransientMessageType.Warning,
        persist: true,
      });
      appEvents.emit(AppEvent.TransientMessage, {
        id: 'unrelated',
        message: '',
        type: TransientMessageType.Warning,
      });
    });
    expect(result.current[0]?.text).toBe('Credits exhausted');

    act(() => {
      appEvents.emit(AppEvent.TransientMessage, {
        id: 'credit-warning',
        message: '',
        type: TransientMessageType.Warning,
      });
    });
    expect(result.current[0]).toBeNull();
    unmount();
  });

  it('does not let an older timer clear a replacement message', async () => {
    const { result, unmount } = await renderHook(() =>
      useTransientMessage(3_000),
    );

    act(() => {
      appEvents.emit(AppEvent.TransientMessage, {
        message: 'First',
        type: TransientMessageType.Hint,
        durationMs: 1_000,
      });
      appEvents.emit(AppEvent.TransientMessage, {
        message: 'Replacement',
        type: TransientMessageType.Success,
        persist: true,
      });
      vi.advanceTimersByTime(1_000);
    });

    expect(result.current[0]?.text).toBe('Replacement');
    unmount();
  });
});
