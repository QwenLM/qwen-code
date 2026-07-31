/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLocalStorage } from './useLocalStorage.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('useLocalStorage', () => {
  let container: HTMLDivElement;
  let root: Root;
  let hook: readonly [
    number,
    (value: number | ((val: number) => number)) => void,
  ];

  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement('div');
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    window.localStorage.clear();
  });

  async function renderHook(key: string, initial: number) {
    function HookHost() {
      hook = useLocalStorage<number>(key, initial);
      return null;
    }
    await act(async () => root.render(<HookHost />));
  }

  it('applies both functional updates batched in one render', async () => {
    await renderHook('counter', 0);

    // Two functional updates in the same batch. Against the previous
    // closed-over `storedValue`, both derive from 0 and the first is lost
    // (final value 1); routing through `prev` yields 2.
    act(() => {
      hook[1]((v) => v + 1);
      hook[1]((v) => v + 1);
    });

    expect(hook[0]).toBe(2);
    expect(window.localStorage.getItem('counter')).toBe('2');
  });

  it('still supports direct (non-functional) values', async () => {
    await renderHook('name', 0);

    act(() => {
      hook[1](42);
    });

    expect(hook[0]).toBe(42);
    expect(window.localStorage.getItem('name')).toBe('42');
  });

  it('hydrates the initial value from localStorage', async () => {
    window.localStorage.setItem('preset', '7');
    await renderHook('preset', 0);

    expect(hook[0]).toBe(7);
  });

  it('does not write to localStorage on mount', async () => {
    // The initial value must not be persisted until an actual setValue call,
    // preserving the hook's write-on-change-only contract.
    await renderHook('fresh', 42);

    expect(window.localStorage.getItem('fresh')).toBeNull();
  });

  it('falls back to initialValue when localStorage contains invalid JSON', async () => {
    window.localStorage.setItem('bad', 'not-valid-json');
    await renderHook('bad', 99);

    expect(hook[0]).toBe(99);
  });

  it('updates state even when localStorage.setItem throws', async () => {
    await renderHook('quota', 0);

    const setItemSpy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('quota exceeded');
      });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    act(() => {
      hook[1](5);
    });

    expect(hook[0]).toBe(5);

    setItemSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
