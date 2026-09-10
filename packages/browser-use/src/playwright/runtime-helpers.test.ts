/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Page } from 'playwright-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  pressKeyChord,
  selectOptions,
  withModifiers,
  withTimeout,
} from './runtime-helpers.js';

describe('evaluation deadlines', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps a zero timeout unlimited', async () => {
    vi.useFakeTimers();
    let resolve: (value: number) => void = () => undefined;
    const pending = new Promise<number>((done) => {
      resolve = done;
    });
    const result = withTimeout(pending, 0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    resolve(42);
    await expect(result).resolves.toBe(42);
  });

  it('preserves early results and errors and clears their timers', async () => {
    vi.useFakeTimers();
    await expect(withTimeout(Promise.resolve(42), 100)).resolves.toBe(42);
    expect(vi.getTimerCount()).toBe(0);
    const failure = new Error('script failed');
    await expect(withTimeout(Promise.reject(failure), 100)).rejects.toBe(
      failure,
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});

function fixture() {
  const keyboard = {
    down: vi.fn(async (_key: string) => undefined),
    up: vi.fn(async (_key: string) => undefined),
  };
  return { keyboard, page: { keyboard } as unknown as Page };
}

describe('modifier cleanup', () => {
  it('releases all attempted keys when keydown fails', async () => {
    const { page, keyboard } = fixture();
    const failure = new Error('keydown failed');
    keyboard.down.mockRejectedValueOnce(failure);
    await expect(
      withModifiers(page, ['Control', 'Shift'], vi.fn()),
    ).rejects.toBe(failure);
    expect(keyboard.up).toHaveBeenCalledExactlyOnceWith('Control');
  });

  it('continues releases after keyup fails and preserves the action error', async () => {
    const { page, keyboard } = fixture();
    const failure = new Error('action failed');
    keyboard.up.mockRejectedValueOnce(new Error('keyup failed'));
    await expect(
      withModifiers(page, ['Control', 'Shift'], async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(keyboard.up.mock.calls).toEqual([['Shift'], ['Control']]);
  });

  it('reports failed cleanup even when the action succeeded', async () => {
    const { page, keyboard } = fixture();
    const failure = new Error('keyup failed');
    keyboard.up.mockRejectedValueOnce(failure);
    await expect(
      withModifiers(page, ['Control', 'Shift'], async () => undefined),
    ).rejects.toBe(failure);
    expect(keyboard.up.mock.calls).toEqual([['Shift'], ['Control']]);
  });
});

describe('key chord press', () => {
  it('releases every modifier when a chord token is rejected', async () => {
    const keyboard = {
      up: vi.fn(async (_key: string) => undefined),
      press: vi.fn(async (_chord: string) => {
        throw new Error('Unknown key: "Bogus"');
      }),
    };
    const page = { keyboard } as unknown as Page;
    await expect(pressKeyChord(page, ['Control', 'Bogus'])).rejects.toThrow(
      'Unknown key',
    );
    expect(keyboard.press).toHaveBeenCalledExactlyOnceWith('Control+Bogus');
    expect(keyboard.up.mock.calls).toEqual([
      ['Shift'],
      ['Control'],
      ['Alt'],
      ['Meta'],
    ]);
  });

  it('leaves the keyboard untouched after a successful chord', async () => {
    const keyboard = {
      up: vi.fn(async (_key: string) => undefined),
      press: vi.fn(async (_chord: string) => undefined),
    };
    const page = { keyboard } as unknown as Page;
    await pressKeyChord(page, ['Control', 'a']);
    expect(keyboard.press).toHaveBeenCalledExactlyOnceWith('Control+a');
    expect(keyboard.up).not.toHaveBeenCalled();
  });
});

describe('select option values', () => {
  it('normalizes a mixed string/descriptor array for Playwright', () => {
    expect(selectOptions(['a', { label: 'B' }])).toEqual([
      { value: 'a' },
      { label: 'B' },
    ]);
  });

  it('keeps homogeneous arrays in their compact form', () => {
    expect(selectOptions(['a', 'b'])).toEqual(['a', 'b']);
    expect(selectOptions([{ value: 'a' }, { index: 2 }])).toEqual([
      { value: 'a' },
      { index: 2 },
    ]);
    expect(selectOptions('a')).toBe('a');
    expect(selectOptions({ index: 2 })).toEqual({ index: 2 });
  });
});
