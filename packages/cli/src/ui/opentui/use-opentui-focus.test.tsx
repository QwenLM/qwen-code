/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DISABLE_FOCUS_REPORTING,
  ENABLE_FOCUS_REPORTING,
  useOpenTuiFocus,
  type OpenTuiFocusHost,
} from './use-opentui-focus.js';

/** Fake renderer host capturing the focus/blur/keypress listeners. */
function createFakeRenderer(): OpenTuiFocusHost & {
  emit(event: 'focus' | 'blur' | 'keypress'): void;
  listenerCounts(): { focus: number; blur: number; keypress: number };
} {
  const listeners = {
    focus: new Set<() => void>(),
    blur: new Set<() => void>(),
    keypress: new Set<(key: unknown) => void>(),
  };
  return {
    on(event, listener) {
      listeners[event].add(listener as never);
      return this;
    },
    off(event, listener) {
      listeners[event].delete(listener as never);
      return this;
    },
    keyInput: {
      on(event, listener) {
        listeners[event].add(listener as never);
        return this;
      },
      off(event, listener) {
        listeners[event].delete(listener as never);
        return this;
      },
    },
    emit(event) {
      for (const listener of listeners[event]) {
        (listener as () => void)();
      }
    },
    listenerCounts() {
      return {
        focus: listeners.focus.size,
        blur: listeners.blur.size,
        keypress: listeners.keypress.size,
      };
    },
  };
}

describe('useOpenTuiFocus', () => {
  let stdoutWrites: string[];

  beforeEach(() => {
    stdoutWrites = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((data: string) => {
      stdoutWrites.push(data);
      return true;
    }) as typeof process.stdout.write);
  });

  it('defaults to focused and enables mode 1004 on mount', () => {
    const renderer = createFakeRenderer();
    const { result } = renderHook(() => useOpenTuiFocus(renderer));
    expect(result.current).toBe(true);
    expect(stdoutWrites).toContain(ENABLE_FOCUS_REPORTING);
  });

  it('tracks blur and focus events', () => {
    const renderer = createFakeRenderer();
    const { result } = renderHook(() => useOpenTuiFocus(renderer));
    act(() => renderer.emit('blur'));
    expect(result.current).toBe(false);
    act(() => renderer.emit('focus'));
    expect(result.current).toBe(true);
  });

  it('recovers focus on keypress (tmux workaround parity)', () => {
    const renderer = createFakeRenderer();
    const { result } = renderHook(() => useOpenTuiFocus(renderer));
    act(() => renderer.emit('blur'));
    expect(result.current).toBe(false);
    act(() => renderer.emit('keypress'));
    expect(result.current).toBe(true);
  });

  it('disables mode 1004 and unsubscribes on unmount', () => {
    const renderer = createFakeRenderer();
    const exitsBefore = process.listenerCount('exit');
    const { unmount } = renderHook(() => useOpenTuiFocus(renderer));
    expect(process.listenerCount('exit')).toBe(exitsBefore + 1);
    unmount();
    expect(stdoutWrites).toContain(DISABLE_FOCUS_REPORTING);
    expect(process.listenerCount('exit')).toBe(exitsBefore);
    expect(renderer.listenerCounts()).toEqual({
      focus: 0,
      blur: 0,
      keypress: 0,
    });
  });

  it('a broken stdout must not crash mount or teardown', () => {
    vi.mocked(process.stdout.write).mockImplementation((() => {
      throw new Error('EPIPE');
    }) as unknown as typeof process.stdout.write);
    const renderer = createFakeRenderer();
    const { unmount } = renderHook(() => useOpenTuiFocus(renderer));
    expect(() => unmount()).not.toThrow();
  });
});
