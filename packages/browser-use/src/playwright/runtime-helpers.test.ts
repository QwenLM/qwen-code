/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Page } from 'playwright-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withModifiers, withTimeout } from './runtime-helpers.js';

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
