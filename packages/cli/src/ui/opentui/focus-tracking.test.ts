// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The OpenTUI leg's terminal-focus flag (ink useFocus parity): it owns the
 * `?1004` mode switch the renderer never writes, follows the renderer's
 * focus/blur events, and re-asserts focus on a keypress the way ink's tmux
 * workaround does. Without the mode switch a terminal sends no focus events
 * at all, so the away recap could never fire.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  // vi.hoisted runs before the module's imports, so the stub cannot be a node
  // EventEmitter; a plain registry is also what lets the tests assert the
  // unmount removed its listeners.
  const listeners: Record<string, Array<() => void>> = {};
  return {
    listeners,
    renderer: {
      on(event: string, fn: () => void): void {
        (listeners[event] ??= []).push(fn);
      },
      off(event: string, fn: () => void): void {
        listeners[event] = (listeners[event] ?? []).filter(
          (listener) => listener !== fn,
        );
      },
      emit(event: string): void {
        for (const fn of [...(listeners[event] ?? [])]) fn();
      },
    },
    keyHandler: null as null | (() => void),
    written: [] as string[],
  };
});

vi.mock('@opentui/react', () => ({
  useRenderer: () => mocks.renderer,
  useKeyboard: (handler: () => void) => {
    mocks.keyHandler = handler;
  },
}));
vi.mock('@opentui/core', () => ({
  CliRenderEvents: { FOCUS: 'focus', BLUR: 'blur' },
}));

import { useTerminalFocus } from './focus-tracking.js';

const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
  mocks.written.push(String(chunk));
  return true;
});

function renderFocus() {
  return renderHook(() => useTerminalFocus());
}

beforeEach(() => {
  for (const event of Object.keys(mocks.listeners))
    delete mocks.listeners[event];
  mocks.keyHandler = null;
  mocks.written.length = 0;
});

afterEach(() => {
  write.mockClear();
});

describe('useTerminalFocus', () => {
  it('switches focus reporting on for the mount and off for the unmount', () => {
    const { unmount } = renderFocus();
    expect(mocks.written).toEqual(['\x1b[?1004h']);
    unmount();
    expect(mocks.written).toEqual(['\x1b[?1004h', '\x1b[?1004l']);
  });

  it('starts focused and follows the renderer focus/blur events', () => {
    const { result } = renderFocus();
    expect(result.current).toBe(true);
    act(() => mocks.renderer.emit('blur'));
    expect(result.current).toBe(false);
    act(() => mocks.renderer.emit('focus'));
    expect(result.current).toBe(true);
  });

  it('re-asserts focus on a keypress, as ink does for tmux', () => {
    const { result } = renderFocus();
    act(() => mocks.renderer.emit('blur'));
    expect(result.current).toBe(false);
    act(() => mocks.keyHandler?.());
    expect(result.current).toBe(true);
  });

  it('detaches from the renderer once unmounted', () => {
    const { unmount } = renderFocus();
    expect(mocks.listeners['blur']).toHaveLength(1);
    unmount();
    expect(mocks.listeners['blur']).toHaveLength(0);
    expect(mocks.listeners['focus']).toHaveLength(0);
  });

  it('survives a stdout that throws on the mode write', () => {
    write.mockImplementationOnce(() => {
      throw new Error('ERR_STREAM_DESTROYED');
    });
    const { result } = renderFocus();
    expect(result.current).toBe(true);
    act(() => mocks.renderer.emit('blur'));
    expect(result.current).toBe(false);
  });
});
