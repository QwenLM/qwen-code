/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTerminalSize } from './useTerminalSize.js';

// The hook reads terminal dimensions from `process.stdout`, which is not a TTY
// under vitest (columns/rows are inherited from the prototype as undefined).
// Override them with own-properties for the duration of a test and restore the
// original descriptor afterward so an override never leaks into a later test
// file via the module-level snapshot.
let originalColumns: PropertyDescriptor | undefined;
let originalRows: PropertyDescriptor | undefined;

function setStdoutProp(name: 'columns' | 'rows', value: number | undefined) {
  Object.defineProperty(process.stdout, name, { value, configurable: true });
}

function restoreStdoutProp(
  name: 'columns' | 'rows',
  original: PropertyDescriptor | undefined,
) {
  if (original) {
    Object.defineProperty(process.stdout, name, original);
  } else {
    delete (process.stdout as unknown as Record<string, unknown>)[name];
  }
}

describe('useTerminalSize', () => {
  beforeEach(() => {
    originalColumns = Object.getOwnPropertyDescriptor(
      process.stdout,
      'columns',
    );
    originalRows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  });

  afterEach(() => {
    restoreStdoutProp('columns', originalColumns);
    restoreStdoutProp('rows', originalRows);
  });

  it('returns the current terminal size on mount', () => {
    setStdoutProp('columns', 123);
    setStdoutProp('rows', 45);

    const { result } = renderHook(() => useTerminalSize());

    expect(result.current).toEqual({ columns: 123, rows: 45 });
  });

  it('falls back to 80x24 when the terminal size is unavailable', () => {
    setStdoutProp('columns', undefined);
    setStdoutProp('rows', undefined);

    const { result } = renderHook(() => useTerminalSize());

    expect(result.current).toEqual({ columns: 80, rows: 24 });
  });

  it('attaches exactly one resize listener no matter how many hooks mount', () => {
    const baseline = process.stdout.listenerCount('resize');
    const emitWarning = vi.spyOn(process, 'emitWarning');

    const hooks = Array.from({ length: 15 }, () =>
      renderHook(() => useTerminalSize()),
    );

    // A single shared listener backs all 15 consumers, so the count never
    // grows past one and Node's MaxListenersExceededWarning cannot fire.
    expect(process.stdout.listenerCount('resize')).toBe(baseline + 1);
    expect(
      emitWarning.mock.calls.some(
        ([warning]) =>
          warning instanceof Error &&
          warning.name === 'MaxListenersExceededWarning',
      ),
    ).toBe(false);

    hooks.forEach(({ unmount }) => unmount());

    // The last unmount drains the subscriber set and detaches the listener.
    expect(process.stdout.listenerCount('resize')).toBe(baseline);

    emitWarning.mockRestore();
  });

  it('propagates a resize to every mounted consumer', () => {
    setStdoutProp('columns', 100);
    setStdoutProp('rows', 40);

    const first = renderHook(() => useTerminalSize());
    const second = renderHook(() => useTerminalSize());

    expect(first.result.current).toEqual({ columns: 100, rows: 40 });
    expect(second.result.current).toEqual({ columns: 100, rows: 40 });

    setStdoutProp('columns', 200);
    setStdoutProp('rows', 60);
    act(() => {
      process.stdout.emit('resize');
    });

    expect(first.result.current).toEqual({ columns: 200, rows: 60 });
    expect(second.result.current).toEqual({ columns: 200, rows: 60 });
  });

  it('keeps the shared listener working after one of several consumers unmounts', () => {
    setStdoutProp('columns', 100);
    setStdoutProp('rows', 40);

    const baseline = process.stdout.listenerCount('resize');
    const first = renderHook(() => useTerminalSize());
    const second = renderHook(() => useTerminalSize());

    first.unmount();

    // One consumer remains, so the shared listener stays attached.
    expect(process.stdout.listenerCount('resize')).toBe(baseline + 1);

    setStdoutProp('columns', 175);
    setStdoutProp('rows', 55);
    act(() => {
      process.stdout.emit('resize');
    });

    expect(second.result.current).toEqual({ columns: 175, rows: 55 });

    second.unmount();
    expect(process.stdout.listenerCount('resize')).toBe(baseline);
  });
});
