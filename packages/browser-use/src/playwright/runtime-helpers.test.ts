/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Page } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { withModifiers } from './runtime-helpers.js';

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
